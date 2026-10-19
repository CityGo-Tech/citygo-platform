# Creates ONE new local canary, Off and disconnected, from a sealed pinned base.
# Default is a pure plan. No Start, network connection, runner or cleanup occurs.
# A sealed-base record is a private operator attestation, not proof of CI safety.
[CmdletBinding()]
param(
    [string]$BaseVhdxPath='',
    [string]$ExpectedBaseSha256='',
    [string]$SealedBaseEvidencePath='',
    [string]$ExpectedSealedBaseEvidenceSha256='',
    [string]$PreflightPath='',
    [string]$ExpectedPreflightSha256='',
    [string]$OperationId='',
    [switch]$Apply,
    [string]$Acknowledge=''
)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$WarningPreference='SilentlyContinue'
$InformationPreference='SilentlyContinue'
$VerbosePreference='SilentlyContinue'
$DebugPreference='SilentlyContinue'

function Assert-CityGoCanaryValue {
    param([bool]$Condition,[string]$Code)
    if (-not $Condition) { throw $Code }
}

function Get-CityGoCanaryLocalPath {
    param([string]$Path)
    Assert-CityGoCanaryValue ($Path -match '^[A-Za-z]:\\' -and $Path.Length -le 1024 -and
        $Path -notmatch '[\x00-\x1f/*?\[\]]' -and -not $Path.Substring(2).Contains(':')) 'path-invalid'
    foreach ($part in $Path.Substring(3).Split('\')) {
        Assert-CityGoCanaryValue ($part -and $part -notin @('.','..') -and $part -notmatch '[. ]$') 'path-invalid'
    }
    $full=[IO.Path]::GetFullPath($Path)
    Assert-CityGoCanaryValue ($full.Equals($Path,[StringComparison]::OrdinalIgnoreCase)) 'path-not-canonical'
    return $full
}

function Get-CityGoCanaryPlan {
    param([Collections.IDictionary]$Request)
    Assert-CityGoCanaryValue ($Request.operationId -cmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' -and
        [guid]$Request.operationId -ne [guid]::Empty) 'operation-invalid'
    foreach ($key in @('baseSha256','sealedBaseEvidenceSha256','preflightSha256')) {
        Assert-CityGoCanaryValue ($Request.$key -cmatch '^[a-f0-9]{64}$') 'expected-hash-required'
    }
    $base=Get-CityGoCanaryLocalPath $Request.basePath
    Assert-CityGoCanaryValue ($base -imatch '^D:\\CityGo-CI\\(?:base|images|bootstrap)\\.+\.vhdx$') 'base-outside-approved-roots'
    $preflight=Get-CityGoCanaryLocalPath $Request.preflightPath
    $sealed=Get-CityGoCanaryLocalPath $Request.sealedBaseEvidencePath
    $control='D:\CityGo-CI\control\'+$Request.operationId
    Assert-CityGoCanaryValue ($preflight -ieq ($control+'\preflight.json')) 'preflight-operation-mismatch'
    Assert-CityGoCanaryValue ($sealed -imatch '^D:\\CityGo-CI\\control\\([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\\sealed-base\.json$' -and
        [guid]$Matches[1] -ne [guid]::Empty) 'sealed-evidence-path-invalid'
    $target='D:\CityGo-CI\canaries\'+$Request.operationId
    $name='citygo-ci-canary-'+$Request.operationId
    return [ordered]@{
        operationId=$Request.operationId;vmName=$name;basePath=$base;baseSha256=$Request.baseSha256
        preflightPath=$preflight;preflightSha256=$Request.preflightSha256
        sealedBaseEvidencePath=$sealed;sealedBaseEvidenceSha256=$Request.sealedBaseEvidenceSha256
        targetDirectory=$target;targetVhdx=($target+'\canary.vhdx');vmPath=($target+'\'+$name)
        controlDirectory=$control;receiptPath=($control+'\canary-creation.json')
        requiredAcknowledgement=('CREATE_OFFLINE_CANARY_VM:'+$Request.operationId+':'+$Request.baseSha256+':'+$Request.sealedBaseEvidenceSha256)
    }
}

function Assert-CityGoCanaryPlainPath {
    param([string]$Path,[bool]$Directory)
    $null=Get-CityGoCanaryLocalPath $Path
    $cursor=$Path.Substring(0,3)
    foreach ($part in @('')+$Path.Substring(3).Split('\')) {
        if ($part) { $cursor=[IO.Path]::Combine($cursor,$part) }
        $item=Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
        Assert-CityGoCanaryValue (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0 -and
            $item.PSProvider.Name -ceq 'FileSystem') 'plain-path-required'
        if (-not $cursor.Equals($Path,[StringComparison]::OrdinalIgnoreCase)) {
            Assert-CityGoCanaryValue ([bool]$item.PSIsContainer) 'plain-directory-required'
        }
    }
    Assert-CityGoCanaryValue ([bool]$item.PSIsContainer -eq $Directory) 'path-kind-invalid'
}

function Get-CityGoCanaryIdentity {
    Assert-CityGoCanaryValue ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) 'windows-required'
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
    try {
        $principal=[Security.Principal.WindowsPrincipal]::new($identity)
        Assert-CityGoCanaryValue ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) 'administrator-required'
        return $identity.User.Value
    } finally { $identity.Dispose() }
}

function Assert-CityGoCanaryPrivateAcl {
    param([string]$Path,[string]$OwnerSid,[bool]$ProtectedDirectory=$false)
    $allowed=@($OwnerSid,'S-1-5-18','S-1-5-32-544')
    $acl=Get-Acl -LiteralPath $Path -ErrorAction Stop
    Assert-CityGoCanaryValue ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -in $allowed) 'private-owner-required'
    Assert-CityGoCanaryValue (-not $ProtectedDirectory -or $acl.AreAccessRulesProtected) 'protected-directory-required'
    foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
        Assert-CityGoCanaryValue ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
            $rule.IdentityReference.Value -in $allowed) 'private-acl-required'
    }
}

function Set-CityGoCanaryPrivateDirectory {
    param([string]$Path,[string]$OwnerSid)
    $acl=[Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true,$false)
    $acl.SetOwner([Security.Principal.SecurityIdentifier]::new($OwnerSid))
    foreach ($sid in @($OwnerSid,'S-1-5-18','S-1-5-32-544')) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
            [Security.Principal.SecurityIdentifier]::new($sid),[Security.AccessControl.FileSystemRights]::FullControl,
            ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),
            [Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))
    }
    Set-Acl -LiteralPath $Path -AclObject $acl -ErrorAction Stop
    Assert-CityGoCanaryPrivateAcl $Path $OwnerSid $true
}

function Get-CityGoCanaryStreamSha {
    param([IO.Stream]$Stream)
    $hash=[Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hash.ComputeHash($Stream))).Replace('-','').ToLowerInvariant() }
    finally { $hash.Dispose() }
}

function Read-CityGoCanaryEvidence {
    param([string]$Path,[string]$Expected,[string]$OwnerSid,[int]$MaximumBytes)
    Assert-CityGoCanaryPlainPath $Path $false
    Assert-CityGoCanaryPrivateAcl ([IO.Path]::GetDirectoryName($Path)) $OwnerSid $true
    Assert-CityGoCanaryPrivateAcl $Path $OwnerSid
    $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try {
        Assert-CityGoCanaryValue ($stream.Length -ge 2 -and $stream.Length -le $MaximumBytes) 'evidence-size-invalid'
        Assert-CityGoCanaryValue ((Get-CityGoCanaryStreamSha $stream) -ceq $Expected) 'evidence-hash-mismatch'
        $stream.Position=0
        $reader=[IO.StreamReader]::new($stream,[Text.UTF8Encoding]::new($false,$true),$false,4096,$true)
        try { $raw=$reader.ReadToEnd() } finally { $reader.Dispose() }
        if ($raw.Length -gt 0 -and $raw[0] -eq [char]0xfeff) { $raw=$raw.Substring(1) }
        $options=@{InputObject=$raw;ErrorAction='Stop'}
        if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) { $options.DateKind='String' }
        $value=ConvertFrom-Json @options
        foreach ($key in @('observedAt')) {
            $token=[regex]::Match($raw,('"'+$key+'"\s*:\s*"([^"\\]+)"'))
            if ($token.Success) { $value.$key=$token.Groups[1].Value }
        }
        return [ordered]@{value=$value;raw=$raw;stream=$stream}
    } catch { $stream.Dispose();throw }
}

function Get-CityGoCanaryUtcTime {
    param($Value)
    Assert-CityGoCanaryValue ($Value -is [string] -and $Value -cmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?Z$') 'evidence-time-invalid'
    $at=[DateTimeOffset]::MinValue
    Assert-CityGoCanaryValue ([DateTimeOffset]::TryParseExact($Value,[string[]]@('yyyy-MM-ddTHH:mm:ssZ','yyyy-MM-ddTHH:mm:ss.FFFFFFFZ'),
        [Globalization.CultureInfo]::InvariantCulture,([Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal),[ref]$at)) 'evidence-time-invalid'
    return $at
}

function Assert-CityGoCanaryPreflightContent {
    param($Report,[DateTimeOffset]$Now=[DateTimeOffset]::UtcNow)
    Assert-CityGoCanaryValue (($Report.version -is [int] -or $Report.version -is [long]) -and $Report.version -eq 2 -and
        $Report.scope -ceq 'elevated_read_only_host_inventory' -and $Report.status -ceq 'observed-not-approved' -and
        $null -eq $Report.errorCode) 'preflight-envelope-invalid'
    foreach ($field in @('vmCreated','networkChanged','servicesChanged','runnerRegistered')) {
        Assert-CityGoCanaryValue ($Report.$field -is [bool] -and -not $Report.$field) 'preflight-boolean-invalid'
    }
    $age=($Now-(Get-CityGoCanaryUtcTime $Report.observedAt)).TotalSeconds
    Assert-CityGoCanaryValue ($age -ge 0 -and $age -le 900) 'preflight-not-fresh'
    $d=$Report.diagnostic
    foreach ($value in @($d.readyForVmProvisioning,$d.inventory.administrator,$d.guestIsolationVerified,
        $d.githubRunnerRegistered,$Report.management.inventoryReadSucceeded,$Report.management.guestIsolationVerified)) {
        Assert-CityGoCanaryValue ($value -is [bool]) 'preflight-boolean-invalid'
    }
    Assert-CityGoCanaryValue ($d.schemaVersion -eq 1 -and $d.scope -ceq 'host_readiness_only' -and $d.readyForVmProvisioning -eq $true -and
        $null -ne $d.blockers -and @($d.blockers).Count -eq 0 -and $d.inventory.administrator -eq $true -and
        $d.inventory.hypervFeature -ceq 'Enabled' -and $d.inventory.vmmsState -ceq 'Running' -and
        $d.configuredResources.guestVcpu -ge 4 -and $d.configuredResources.guestMemoryGiB -ge 6 -and
        $d.configuredResources.guestDiskGiB -ge 96 -and -not $d.guestIsolationVerified -and -not $d.githubRunnerRegistered -and
        $Report.management.inventoryReadSucceeded -eq $true -and -not $Report.management.guestIsolationVerified) 'preflight-not-ready'
}

function Assert-CityGoCanarySealContent {
    param($Evidence,[string]$Raw,[Collections.IDictionary]$Plan,[DateTimeOffset]$Now=[DateTimeOffset]::UtcNow)
    $fields=@('schemaVersion','scope','observedAt','basePath','baseSha256','diskSizeBytes','bootstrapAccessRemoved','seedDetached',
        'cloudInitCacheRemoved','sshHostKeysRemoved','toolsReplayed','sourceVmState','githubRunnerRegistered','checkoutPresent',
        'sharedHostMountsPresent','guestIsolationVerified','ciJobsAdmitted')
    $names=@($Evidence.PSObject.Properties.Name)
    Assert-CityGoCanaryValue ($names.Count -eq $fields.Count -and @($names|Where-Object{$_ -cnotin $fields}).Count -eq 0) 'seal-keys-invalid'
    $syntax=[regex]::Replace($Raw,'"(?:[^"\\]|\\.)*"','""')
    Assert-CityGoCanaryValue ($Raw.Trim().StartsWith('{') -and $Raw.Trim().EndsWith('}') -and
        $syntax -notmatch '//|/\*|\*/|,\s*[}\]]') 'seal-json-invalid'
    $keys=@([regex]::Matches($Raw,'"([A-Za-z][A-Za-z0-9]*)"\s*:')|ForEach-Object{$_.Groups[1].Value})
    $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($key in $keys) { Assert-CityGoCanaryValue ($seen.Add($key)) 'seal-duplicate-key' }
    Assert-CityGoCanaryValue ($keys.Count -eq $fields.Count -and @($keys|Where-Object{$_ -cnotin $fields}).Count -eq 0) 'seal-json-invalid'
    Assert-CityGoCanaryValue (($Evidence.schemaVersion -is [int] -or $Evidence.schemaVersion -is [long]) -and
        $Evidence.schemaVersion -eq 1 -and $Evidence.scope -ceq 'sealed_base_for_local_canary_only' -and
        $Evidence.basePath -is [string] -and $Evidence.basePath.Equals($Plan.basePath,[StringComparison]::OrdinalIgnoreCase) -and
        $Evidence.baseSha256 -ceq $Plan.baseSha256 -and ($Evidence.diskSizeBytes -is [long] -or $Evidence.diskSizeBytes -is [int]) -and
        $Evidence.diskSizeBytes -eq 96GB -and $Evidence.sourceVmState -ceq 'Off') 'seal-binding-invalid'
    Assert-CityGoCanaryValue (($Now-(Get-CityGoCanaryUtcTime $Evidence.observedAt)).TotalSeconds -ge 0) 'seal-time-in-future'
    foreach ($key in @('bootstrapAccessRemoved','seedDetached','cloudInitCacheRemoved','sshHostKeysRemoved','toolsReplayed')) {
        Assert-CityGoCanaryValue ($Evidence.$key -is [bool] -and $Evidence.$key) 'seal-required-step-unverified'
    }
    foreach ($key in @('githubRunnerRegistered','checkoutPresent','sharedHostMountsPresent','guestIsolationVerified','ciJobsAdmitted')) {
        Assert-CityGoCanaryValue ($Evidence.$key -is [bool] -and -not $Evidence.$key) 'seal-admission-not-closed'
    }
}

function Assert-CityGoCanaryControl {
    param([Collections.IDictionary]$Plan,[string]$OwnerSid)
    Assert-CityGoCanaryPlainPath $Plan.controlDirectory $true
    Assert-CityGoCanaryPrivateAcl $Plan.controlDirectory $OwnerSid $true
    Assert-CityGoCanaryValue (-not (Test-Path -LiteralPath $Plan.receiptPath -ErrorAction Stop)) 'canary-receipt-exists'
}

function Assert-CityGoCanaryDestinationsAbsent {
    param([Collections.IDictionary]$Plan,[string]$OwnerSid)
    Assert-CityGoCanaryPlainPath 'D:\CityGo-CI\canaries' $true
    Assert-CityGoCanaryPrivateAcl 'D:\CityGo-CI\canaries' $OwnerSid $true
    Assert-CityGoCanaryValue (-not (Test-Path -LiteralPath $Plan.targetDirectory -ErrorAction Stop)) 'canary-destination-exists'
    foreach ($existing in @(Get-VM -ErrorAction Stop)) {
        Assert-CityGoCanaryValue ([string]$existing.Name -ine $Plan.vmName) 'canary-name-exists'
    }
}

function Assert-CityGoCanaryVhd {
    param($Disk)
    Assert-CityGoCanaryValue ([string]$Disk.VhdFormat -ceq 'VHDX' -and [string]$Disk.VhdType -cin @('Fixed','Dynamic') -and
        -not $Disk.ParentPath -and $Disk.Attached -is [bool] -and -not $Disk.Attached -and
        $Disk.Size -eq 96GB -and $Disk.FileSize -gt 0) 'standalone-unattached-96gib-vhdx-required'
    $id=[guid]::Empty
    Assert-CityGoCanaryValue ([guid]::TryParse([string]$Disk.DiskIdentifier,[ref]$id) -and $id -ne [guid]::Empty) 'vhd-disk-identity-invalid'
    return $id.ToString('D')
}

function Open-CityGoCanarySource {
    param([string]$Path)
    return [IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
}

function Copy-CityGoVerifiedCanaryDisk {
    param([IO.Stream]$Source,[Collections.IDictionary]$Plan)
    $copy=[IO.File]::Open($Plan.targetVhdx,[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    try {
        $Source.Position=0;$Source.CopyTo($copy);$copy.Flush($true);$copy.Position=0
        Assert-CityGoCanaryValue ((Get-CityGoCanaryStreamSha $copy) -ceq $Plan.baseSha256) 'copied-canary-disk-hash-mismatch'
    } finally { $copy.Dispose() }
}

function Assert-CityGoStoppedCanary {
    param($Vm,[Collections.IDictionary]$Plan,[string]$DiskIdentifier)
    $actual=Get-VM -Id $Vm.Id -ErrorAction Stop
    Assert-CityGoCanaryValue ($actual.Id -eq $Vm.Id -and [string]$actual.Name -ceq $Plan.vmName -and
        [string]$actual.Path -ieq $Plan.vmPath -and [string]$actual.State -ceq 'Off' -and $actual.Generation -eq 2 -and
        $actual.ProcessorCount -eq 4 -and $actual.MemoryStartup -eq 6GB -and $actual.DynamicMemoryEnabled -eq $false -and
        [string]$actual.AutomaticStartAction -ceq 'Nothing' -and [string]$actual.CheckpointType -ceq 'Disabled' -and
        $actual.AutomaticCheckpointsEnabled -eq $false) 'canary-state-unverified'
    $disks=@(Get-VMHardDiskDrive -VM $actual -ErrorAction Stop)
    Assert-CityGoCanaryValue ($disks.Count -eq 1 -and [string]$disks[0].Path -ieq $Plan.targetVhdx -and -not $disks[0].DiskNumber -and
        [string]$disks[0].ControllerType -ceq 'SCSI' -and $disks[0].ControllerNumber -eq 0 -and $disks[0].ControllerLocation -eq 0) 'canary-disk-unverified'
    $nativeDisk=Get-VHD -Path $Plan.targetVhdx -ErrorAction Stop
    Assert-CityGoCanaryValue ((Assert-CityGoCanaryVhd $nativeDisk) -ceq $DiskIdentifier) 'canary-disk-identity-changed'
    $adapters=@(Get-VMNetworkAdapter -VM $actual -ErrorAction Stop)
    Assert-CityGoCanaryValue ($adapters.Count -eq 1) 'canary-nic-count-invalid'
    $nic=$adapters[0];$vmId=$actual.Id.ToString('D')
    Assert-CityGoCanaryValue ([guid]$actual.Id -ne [guid]::Empty) 'canary-vm-identity-invalid'
    $nicPattern='^Microsoft:'+([regex]::Escape($vmId))+'\\[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
    Assert-CityGoCanaryValue ([string]$nic.Id -imatch $nicPattern -and $nic.VMId -eq $actual.Id -and
        [guid](([string]$nic.Id).Split('\')[-1]) -ne [guid]::Empty -and
        $nic.Name -is [string] -and $nic.Name.Trim().Length -ge 1 -and $nic.Name.Length -le 256 -and $nic.Name -notmatch '\p{C}' -and
        (-not $nic.SwitchId -or [guid]$nic.SwitchId -eq [guid]::Empty) -and -not $nic.SwitchName -and
        [string]$nic.MacAddressSpoofing -ceq 'Off' -and [string]$nic.DhcpGuard -ceq 'On' -and [string]$nic.RouterGuard -ceq 'On' -and
        $nic.IovWeight -eq 0 -and [string]$nic.AllowTeaming -ceq 'Off' -and [string]$nic.PortMirroringMode -ceq 'None') 'canary-nic-unverified'
    Assert-CityGoCanaryValue (@(Get-VMNetworkAdapterExtendedAcl -VMNetworkAdapter $nic -ErrorAction Stop).Count -eq 0 -and
        @(Get-VMNetworkAdapterAcl -VMNetworkAdapter $nic -ErrorAction Stop).Count -eq 0 -and
        @(Get-VMAssignableDevice -VM $actual -ErrorAction Stop).Count -eq 0) 'canary-extra-resource-unexpected'
    $dvds=@(Get-VMDvdDrive -VM $actual -ErrorAction Stop)
    Assert-CityGoCanaryValue ($dvds.Count -le 1 -and ($dvds.Count -eq 0 -or -not $dvds[0].Path)) 'canary-seed-not-empty'
    $firmware=Get-VMFirmware -VM $actual -ErrorAction Stop
    Assert-CityGoCanaryValue ([string]$firmware.SecureBoot -ceq 'On' -and
        [string]$firmware.SecureBootTemplate -ceq 'MicrosoftUEFICertificateAuthority') 'canary-firmware-unverified'
    return $nic
}

function Write-CityGoCanaryCreation {
    param([Collections.IDictionary]$Plan,[Collections.IDictionary]$Receipt,[string]$OwnerSid)
    # Outside the Hyper-V-managed VM directory; never grant its service SIDs here.
    Assert-CityGoCanaryControl $Plan $OwnerSid
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Receipt|ConvertTo-Json -Depth 4 -Compress))
    $file=[IO.File]::Open($Plan.receiptPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try { $file.Write($bytes,0,$bytes.Length);$file.Flush($true) } finally { $file.Dispose() }
    Assert-CityGoCanaryPrivateAcl $Plan.receiptPath $OwnerSid
}

function Invoke-CityGoCanaryVm {
    param([Collections.IDictionary]$Request)
    $plan=Get-CityGoCanaryPlan $Request
    $receipt=[ordered]@{
        schemaVersion=1;scope='local_canary_creation';operationId=$plan.operationId;vmName=$plan.vmName
        vmId=$null;nicId=$null;nicName=$null;targetDirectory=$plan.targetDirectory;targetVhdx=$plan.targetVhdx;vmPath=$plan.vmPath
        diskIdentifier=$null;diskSizeBytes=96GB;diskFormat='VHDX';diskType=$null
        controllerType='SCSI';controllerNumber=0;controllerLocation=0;sourceBaseSha256=$plan.baseSha256
        sealedBaseEvidenceSha256=$plan.sealedBaseEvidenceSha256;preflightSha256=$plan.preflightSha256
        stage='plan_only_unverified';directoryCreated=$false;diskVerified=$false;vmCreated=$false
        guestIsolationVerified=$false;githubRunnerRegistered=$false
    }
    if (-not $Request.apply) { return $receipt }
    Assert-CityGoCanaryValue ($Request.acknowledge -ceq $plan.requiredAcknowledgement) 'typed-acknowledgement-required'
    $ownerSid=Get-CityGoCanaryIdentity
    Assert-CityGoCanaryControl $plan $ownerSid
    $source=$null;$handles=@()
    try {
        $preflight=Read-CityGoCanaryEvidence $plan.preflightPath $plan.preflightSha256 $ownerSid 1048576;$handles+=,$preflight
        Assert-CityGoCanaryPreflightContent $preflight.value
        $seal=Read-CityGoCanaryEvidence $plan.sealedBaseEvidencePath $plan.sealedBaseEvidenceSha256 $ownerSid 65536;$handles+=,$seal
        Assert-CityGoCanarySealContent $seal.value $seal.raw $plan
        Assert-CityGoCanaryPlainPath $plan.basePath $false
        Assert-CityGoCanaryDestinationsAbsent $plan $ownerSid
        $source=Open-CityGoCanarySource $plan.basePath
        Assert-CityGoCanaryValue ((Get-CityGoCanaryStreamSha $source) -ceq $plan.baseSha256) 'base-vhdx-hash-mismatch'
        $sourceDisk=Get-VHD -Path $plan.basePath -ErrorAction Stop
        $sourceId=Assert-CityGoCanaryVhd $sourceDisk
        Assert-CityGoCanaryPreflightContent $preflight.value
        Assert-CityGoCanaryControl $plan $ownerSid
        Assert-CityGoCanaryDestinationsAbsent $plan $ownerSid
        $null=New-Item -Path $plan.targetDirectory -ItemType Directory -ErrorAction Stop
        $receipt.directoryCreated=$true
        Set-CityGoCanaryPrivateDirectory $plan.targetDirectory $ownerSid
        Copy-CityGoVerifiedCanaryDisk $source $plan
        Assert-CityGoCanaryPlainPath $plan.targetVhdx $false
        $copied=Get-VHD -Path $plan.targetVhdx -ErrorAction Stop
        Assert-CityGoCanaryValue ((Assert-CityGoCanaryVhd $copied) -ceq $sourceId) 'copied-disk-identity-unexpected'
        # Only this new, fully verified copy is changed. Source stays read-locked.
        $null=Set-VHD -Path $plan.targetVhdx -ResetDiskIdentifier -ErrorAction Stop
        $canaryDisk=Get-VHD -Path $plan.targetVhdx -ErrorAction Stop
        $canaryId=Assert-CityGoCanaryVhd $canaryDisk
        Assert-CityGoCanaryValue ($canaryId -cne $sourceId) 'canary-disk-identity-not-unique'
        $receipt.diskIdentifier=$canaryId;$receipt.diskType=[string]$canaryDisk.VhdType;$receipt.diskVerified=$true
        Assert-CityGoCanaryPreflightContent $preflight.value
        $vm=New-VM -Name $plan.vmName -Generation 2 -MemoryStartupBytes 6GB -VHDPath $plan.targetVhdx -Path $plan.targetDirectory -ErrorAction Stop
        $receipt.vmId=$vm.Id.ToString('D');$receipt.vmCreated=$true
        $null=Set-VM -VM $vm -AutomaticStartAction Nothing -AutomaticCheckpointsEnabled $false -CheckpointType Disabled -ErrorAction Stop
        $null=Set-VMProcessor -VM $vm -Count 4 -ErrorAction Stop
        $null=Set-VMMemory -VM $vm -DynamicMemoryEnabled $false -StartupBytes 6GB -ErrorAction Stop
        $null=Set-VMFirmware -VM $vm -EnableSecureBoot On -SecureBootTemplate MicrosoftUEFICertificateAuthority -ErrorAction Stop
        $adapters=@(Get-VMNetworkAdapter -VM $vm -ErrorAction Stop)
        Assert-CityGoCanaryValue ($adapters.Count -eq 1 -and -not $adapters[0].SwitchName -and
            (-not $adapters[0].SwitchId -or [guid]$adapters[0].SwitchId -eq [guid]::Empty)) 'new-canary-nic-unexpected'
        $receipt.nicId=[string]$adapters[0].Id;$receipt.nicName=[string]$adapters[0].Name
        $null=Set-VMNetworkAdapter -VMNetworkAdapter $adapters[0] -MacAddressSpoofing Off -DhcpGuard On -RouterGuard On -IovWeight 0 -AllowTeaming Off -PortMirroring None -ErrorAction Stop
        $nic=Assert-CityGoStoppedCanary $vm $plan $canaryId
        Assert-CityGoCanaryValue ([string]$nic.Id -ceq $receipt.nicId -and [string]$nic.Name -ceq $receipt.nicName) 'canary-nic-identity-changed'
        $receipt.stage='created_off_disconnected'
        Write-CityGoCanaryCreation $plan $receipt $ownerSid
        return $receipt
    } catch {
        # No adoption, stop, delete, repair or cleanup of partial resources.
        # Incomplete receipts cannot authorize automatic cleanup of an unknown VM.
        $receipt.stage='failed_preserved_state_unverified'
        try { Write-CityGoCanaryCreation $plan $receipt $ownerSid } catch { $receipt.stage='failed_preserved_receipt_unavailable' }
        return $receipt
    } finally {
        if ($source) { $source.Dispose() }
        foreach ($item in $handles) { if ($item.stream) { $item.stream.Dispose() } }
    }
}

try {
    if (-not $OperationId) { $OperationId=[guid]::NewGuid().ToString('D') }
    $result=Invoke-CityGoCanaryVm ([ordered]@{
        basePath=$BaseVhdxPath;baseSha256=$ExpectedBaseSha256;sealedBaseEvidencePath=$SealedBaseEvidencePath
        sealedBaseEvidenceSha256=$ExpectedSealedBaseEvidenceSha256;preflightPath=$PreflightPath;preflightSha256=$ExpectedPreflightSha256
        operationId=$OperationId;apply=[bool]$Apply;acknowledge=$Acknowledge
    })
    $result|ConvertTo-Json -Depth 4 -Compress
    if ($result.stage -like 'failed_*') { exit 1 }
} catch {
    [ordered]@{schemaVersion=1;scope='local_canary_creation';stage='preconditions_not_met';guestIsolationVerified=$false;githubRunnerRegistered=$false}|ConvertTo-Json -Compress
    exit 2
}
