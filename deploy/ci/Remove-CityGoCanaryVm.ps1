# Deletes only ONE complete, manifest-owned disposable canary. Default is plan.
# Never stops a running VM, deletes control/evidence, recurses or touches a base.
[CmdletBinding()]
param(
    [string]$ManifestPath = '',
    [string]$ExpectedManifestSha256 = '',
    [switch]$Apply,
    [string]$Acknowledge = ''
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
$VerbosePreference = 'SilentlyContinue'
$DebugPreference = 'SilentlyContinue'

function Assert-CityGoCanaryCleanup {
    param([bool]$Condition,[string]$Code)
    if (-not $Condition) { throw $Code }
}

function Get-CityGoCanaryCleanupPath {
    param([string]$Path)
    Assert-CityGoCanaryCleanup ($Path -cmatch '^[A-Za-z]:\\' -and $Path.Length -le 1024 -and
        $Path -notmatch '[\x00-\x1f/*?\[\]]' -and -not $Path.Substring(2).Contains(':')) 'path_invalid'
    foreach ($part in $Path.Substring(3).Split('\')) {
        Assert-CityGoCanaryCleanup ($part -and $part -notin @('.','..') -and $part -notmatch '[. ]$') 'path_invalid'
    }
    $full=[IO.Path]::GetFullPath($Path)
    Assert-CityGoCanaryCleanup ($full.Equals($Path,[StringComparison]::OrdinalIgnoreCase)) 'path_invalid'
    return $full
}

function Assert-CityGoCanaryCleanupPlainPath {
    param([string]$Path,[bool]$Directory)
    $null=Get-CityGoCanaryCleanupPath $Path
    $cursor=$Path.Substring(0,3)
    foreach ($part in @('')+$Path.Substring(3).Split('\')) {
        if ($part) { $cursor=[IO.Path]::Combine($cursor,$part) }
        $item=Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
        Assert-CityGoCanaryCleanup ($item.PSProvider.Name -ceq 'FileSystem' -and
            ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) 'path_not_plain'
        if (-not $cursor.Equals($Path,[StringComparison]::OrdinalIgnoreCase)) {
            Assert-CityGoCanaryCleanup ([bool]$item.PSIsContainer) 'ancestor_not_directory'
        }
    }
    Assert-CityGoCanaryCleanup ([bool]$item.PSIsContainer -eq $Directory) 'path_kind_invalid'
}

function Get-CityGoCanaryCleanupIdentity {
    param([bool]$RequireAdministrator)
    Assert-CityGoCanaryCleanup ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) 'windows_required'
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
    try {
        $principal=[Security.Principal.WindowsPrincipal]::new($identity)
        Assert-CityGoCanaryCleanup (-not $RequireAdministrator -or
            $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) 'administrator_required'
        return $identity.User.Value
    } finally { $identity.Dispose() }
}

function Assert-CityGoCanaryCleanupPrivateAcl {
    param([string]$Path,[string]$OwnerSid,[bool]$ProtectedDirectory=$false)
    $allowed=@($OwnerSid,'S-1-5-18','S-1-5-32-544')
    $acl=Get-Acl -LiteralPath $Path -ErrorAction Stop
    Assert-CityGoCanaryCleanup ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -in $allowed -and
        (-not $ProtectedDirectory -or $acl.AreAccessRulesProtected)) 'evidence_owner_or_protection_invalid'
    foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
        Assert-CityGoCanaryCleanup ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
            $rule.IdentityReference.Value -in $allowed) 'evidence_acl_not_private'
    }
}

function ConvertFrom-CityGoCanaryCleanupJson {
    param([string]$Raw)
    Assert-CityGoCanaryCleanup ($Raw.Length -ge 2 -and $Raw.Length -le 32768 -and
        $Raw.Trim().StartsWith('{') -and $Raw.Trim().EndsWith('}')) 'evidence_json_invalid'
    $syntax=[regex]::Replace($Raw,'"(?:[^"\\]|\\.)*"','""')
    Assert-CityGoCanaryCleanup ($syntax -notmatch '//|/\*|\*/|,\s*[}\]]') 'evidence_json_invalid'
    $value=ConvertFrom-Json -InputObject $Raw -ErrorAction Stop
    Assert-CityGoCanaryCleanup ($value -is [pscustomobject]) 'evidence_object_required'
    $keys=@([regex]::Matches($Raw,'"((?:[^"\\]|\\.)*)"\s*:')|ForEach-Object{$_.Groups[1].Value})
    $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($key in $keys) {
        Assert-CityGoCanaryCleanup ($key -cmatch '^[A-Za-z][A-Za-z0-9]*$' -and $seen.Add($key)) 'evidence_duplicate_or_escaped_key'
    }
    Assert-CityGoCanaryCleanup ($keys.Count -eq @($value.PSObject.Properties).Count) 'evidence_not_flat'
    foreach ($property in $value.PSObject.Properties) {
        Assert-CityGoCanaryCleanup ($property.Value -isnot [pscustomobject] -and $property.Value -isnot [array]) 'evidence_not_flat'
    }
    return $value
}

function Open-CityGoCanaryCleanupEvidence {
    param([string]$Path,[string]$OwnerSid,[string]$ExpectedHash='')
    Assert-CityGoCanaryCleanupPlainPath $Path $false
    Assert-CityGoCanaryCleanupPrivateAcl ([IO.Path]::GetDirectoryName($Path)) $OwnerSid $true
    Assert-CityGoCanaryCleanupPrivateAcl $Path $OwnerSid
    $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try {
        Assert-CityGoCanaryCleanup ($stream.Length -ge 2 -and $stream.Length -le 32768) 'evidence_size_invalid'
        if ($ExpectedHash) {
            $sha=[Security.Cryptography.SHA256]::Create()
            try { $hash=([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
            Assert-CityGoCanaryCleanup ($hash -ceq $ExpectedHash) 'evidence_hash_mismatch'
        }
        $stream.Position=0
        $reader=[IO.StreamReader]::new($stream,[Text.UTF8Encoding]::new($false,$true),$true,4096,$true)
        try { $value=ConvertFrom-CityGoCanaryCleanupJson $reader.ReadToEnd() } finally { $reader.Dispose() }
        return [ordered]@{value=$value;stream=$stream}
    } catch { $stream.Dispose();throw }
}

function Assert-CityGoCanaryCleanupGuid {
    param($Value)
    $guid=[guid]::Empty
    Assert-CityGoCanaryCleanup ($Value -is [string] -and $Value.Length -eq 36 -and
        [guid]::TryParseExact($Value,'D',[ref]$guid) -and $guid -ne [guid]::Empty -and
        $Value -ceq $guid.ToString('D')) 'identity_invalid'
}

function Get-CityGoCanaryCreationFields {
    return @('schemaVersion','scope','operationId','vmName','vmId','nicId','nicName','targetDirectory','targetVhdx','vmPath',
        'diskIdentifier','diskSizeBytes','diskFormat','diskType','controllerType','controllerNumber','controllerLocation',
        'sourceBaseSha256','sealedBaseEvidenceSha256','preflightSha256','stage','directoryCreated','diskVerified','vmCreated',
        'guestIsolationVerified','githubRunnerRegistered')
}

function Get-CityGoCanaryCleanupPlan {
    param($Manifest,[Collections.IDictionary]$Request)
    $resumed=$Request.manifestPath -is [string] -and $Request.manifestPath.EndsWith('\canary-resume-creation.json',[StringComparison]::Ordinal)
    $fields=@(Get-CityGoCanaryCreationFields)
    if ($resumed) { $fields+=@('initialCreationReceiptSha256','resumeVerificationSha256') }
    $actual=@($Manifest.PSObject.Properties.Name)
    Assert-CityGoCanaryCleanup ($actual.Count -eq $fields.Count -and @($actual|Where-Object{$_ -cnotin $fields}).Count -eq 0) 'manifest_keys_invalid'
    Assert-CityGoCanaryCleanup (($Manifest.schemaVersion -is [int] -or $Manifest.schemaVersion -is [long]) -and
        $Manifest.schemaVersion -eq 1 -and $Manifest.scope -ceq 'local_canary_creation' -and
        $Manifest.stage -ceq 'created_off_disconnected') 'complete_creation_manifest_required'
    foreach ($key in @('operationId','vmId','diskIdentifier')) { Assert-CityGoCanaryCleanupGuid $Manifest.$key }
    foreach ($key in @('directoryCreated','diskVerified','vmCreated')) {
        Assert-CityGoCanaryCleanup ($Manifest.$key -is [bool] -and $Manifest.$key) 'complete_creation_manifest_required'
    }
    foreach ($key in @('guestIsolationVerified','githubRunnerRegistered')) {
        Assert-CityGoCanaryCleanup ($Manifest.$key -is [bool] -and -not $Manifest.$key) 'manifest_scope_invalid'
    }
    foreach ($hash in @($Manifest.sourceBaseSha256,$Manifest.sealedBaseEvidenceSha256,$Manifest.preflightSha256,$Request.manifestSha256)) {
        Assert-CityGoCanaryCleanup ($hash -is [string] -and $hash.Length -eq 64 -and $hash -cmatch '^[a-f0-9]{64}$') 'expected_hash_required'
    }
    $directory='D:\CityGo-CI\canaries\'+$Manifest.operationId
    $vmName='citygo-ci-canary-'+$Manifest.operationId
    $control='D:\CityGo-CI\control\'+$Manifest.operationId
    $expectedManifest=$control+$(if($resumed){'\canary-resume-creation.json'}else{'\canary-creation.json'})
    foreach ($path in @($Manifest.targetDirectory,$Manifest.targetVhdx,$Manifest.vmPath,$Request.manifestPath)) { $null=Get-CityGoCanaryCleanupPath $path }
    Assert-CityGoCanaryCleanup ($Manifest.targetDirectory -ceq $directory -and $Manifest.targetVhdx -ceq ($directory+'\canary.vhdx') -and
        $Manifest.vmName -ceq $vmName -and $Manifest.vmPath -ceq ($directory+'\'+$vmName) -and
        $Request.manifestPath -ceq $expectedManifest) 'manifest_resource_paths_invalid'
    if ($resumed) {
        foreach ($hash in @($Manifest.initialCreationReceiptSha256,$Manifest.resumeVerificationSha256)) {
            Assert-CityGoCanaryCleanup ($hash -is [string] -and $hash -cmatch '^[a-f0-9]{64}$') 'resume_link_hash_required'
        }
    }
    Assert-CityGoCanaryCleanup ($Manifest.diskSizeBytes -is [long] -and $Manifest.diskSizeBytes -eq 96GB -and
        $Manifest.diskFormat -ceq 'VHDX' -and $Manifest.diskType -cin @('Fixed','Dynamic') -and $Manifest.controllerType -ceq 'SCSI') 'manifest_disk_invalid'
    foreach ($key in @('controllerNumber','controllerLocation')) {
        Assert-CityGoCanaryCleanup (($Manifest.$key -is [int] -or $Manifest.$key -is [long]) -and $Manifest.$key -eq 0) 'manifest_controller_invalid'
    }
    # Native Hyper-V IDs use uppercase GUIDs on some hosts. Preserve the full
    # native string for exact ownership readback; normalize only GUID parsing.
    $nicMatch=[regex]::Match([string]$Manifest.nicId,('^Microsoft:'+[regex]::Escape($Manifest.vmId)+'\\([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$'),[Text.RegularExpressions.RegexOptions]::IgnoreCase)
    Assert-CityGoCanaryCleanup ($nicMatch.Success -and $nicMatch.Value -ceq $Manifest.nicId) 'manifest_nic_invalid'
    Assert-CityGoCanaryCleanupGuid $nicMatch.Groups[1].Value.ToLowerInvariant()
    Assert-CityGoCanaryCleanup ($Manifest.nicName -is [string] -and $Manifest.nicName.Length -ge 1 -and $Manifest.nicName.Length -le 256 -and
        $Manifest.nicName.Trim().Length -ge 1 -and $Manifest.nicName -notmatch '\p{C}') 'manifest_nic_invalid'
    return [ordered]@{operationId=$Manifest.operationId;vmId=$Manifest.vmId;vmName=$vmName;nicId=$Manifest.nicId;nicName=$Manifest.nicName;
        targetDirectory=$directory;targetVhdx=$Manifest.targetVhdx;vmPath=$Manifest.vmPath;diskIdentifier=$Manifest.diskIdentifier;
        diskType=$Manifest.diskType;manifestSha256=$Request.manifestSha256;controlDirectory=$control;
        resumedCreation=[bool]$resumed;initialCreationReceiptPath=($control+'\canary-creation.json');
        initialCreationReceiptSha256=$(if($resumed){$Manifest.initialCreationReceiptSha256}else{$null});resumeVerificationPath=($control+'\canary-resume-verification.json');
        resumeVerificationSha256=$(if($resumed){$Manifest.resumeVerificationSha256}else{$null});
        intentPath=($control+'\canary-cleanup-intent.json');resultPath=($control+'\canary-cleanup-result.json');
        requiredAcknowledgement=('DELETE_OFFLINE_CANARY:'+$Manifest.vmId+':'+$Request.manifestSha256)}
}

function Assert-CityGoCanaryResumeCleanupEvidence {
    param($Initial,$Verification,$Manifest,[Collections.IDictionary]$Plan)
    $fields=@(Get-CityGoCanaryCreationFields)
    $names=@($Initial.PSObject.Properties.Name)
    Assert-CityGoCanaryCleanup ($names.Count -eq $fields.Count -and @($names|Where-Object{$_ -cnotin $fields}).Count -eq 0) 'initial_receipt_keys_invalid'
    Assert-CityGoCanaryCleanup (($Initial.schemaVersion -is [int] -or $Initial.schemaVersion -is [long]) -and
        $Initial.schemaVersion -eq 1 -and $Initial.scope -ceq 'local_canary_creation' -and
        $Initial.stage -ceq 'failed_preserved_state_unverified' -and $Initial.operationId -ceq $Plan.operationId -and
        $Initial.vmName -ceq $Plan.vmName -and $Initial.targetDirectory -ceq $Plan.targetDirectory -and
        $Initial.targetVhdx -ceq $Plan.targetVhdx -and $Initial.vmPath -ceq $Plan.vmPath) 'initial_receipt_binding_invalid'
    foreach ($key in @('vmId','nicId','nicName','diskIdentifier','diskType')) {
        Assert-CityGoCanaryCleanup ($null -eq $Initial.$key) 'initial_receipt_not_pre_vm_failure'
    }
    Assert-CityGoCanaryCleanup ($Initial.directoryCreated -is [bool] -and $Initial.directoryCreated) 'initial_receipt_not_pre_vm_failure'
    foreach ($key in @('diskVerified','vmCreated','guestIsolationVerified','githubRunnerRegistered')) {
        Assert-CityGoCanaryCleanup ($Initial.$key -is [bool] -and -not $Initial.$key) 'initial_receipt_not_pre_vm_failure'
    }
    Assert-CityGoCanaryCleanup ($Initial.diskSizeBytes -is [long] -and $Initial.diskSizeBytes -eq 96GB -and
        $Initial.diskFormat -ceq 'VHDX' -and $Initial.controllerType -ceq 'SCSI') 'initial_receipt_disk_invalid'
    foreach ($key in @('controllerNumber','controllerLocation')) {
        Assert-CityGoCanaryCleanup (($Initial.$key -is [int] -or $Initial.$key -is [long]) -and $Initial.$key -eq 0) 'initial_receipt_disk_invalid'
    }
    foreach ($key in @('sourceBaseSha256','sealedBaseEvidenceSha256','preflightSha256')) {
        Assert-CityGoCanaryCleanup ($Initial.$key -is [string] -and $Initial.$key -cmatch '^[a-f0-9]{64}$') 'initial_receipt_hash_invalid'
    }
    # A resumed attempt must use a fresh preflight; only that input may differ.
    Assert-CityGoCanaryCleanup ($Initial.sourceBaseSha256 -ceq $Manifest.sourceBaseSha256 -and
        $Initial.sealedBaseEvidenceSha256 -ceq $Manifest.sealedBaseEvidenceSha256) 'initial_source_binding_invalid'
    $proofFields=@('schemaVersion','scope','operationId','initialCreationReceiptSha256','sourceBaseSha256','targetSha256',
        'sourceDiskIdentifier','targetDiskIdentifier','noVmOrReferencesObserved','sourceVmOff','targetStandaloneUnattached',
        'targetTreeOnlyDisk','guestIsolationVerified','githubRunnerRegistered','ciJobsAdmitted')
    $proofNames=@($Verification.PSObject.Properties.Name)
    Assert-CityGoCanaryCleanup ($proofNames.Count -eq $proofFields.Count -and @($proofNames|Where-Object{$_ -cnotin $proofFields}).Count -eq 0) 'resume_verification_keys_invalid'
    foreach ($key in @('initialCreationReceiptSha256','sourceBaseSha256','targetSha256')) {
        Assert-CityGoCanaryCleanup ($Verification.$key -is [string] -and $Verification.$key -cmatch '^[a-f0-9]{64}$') 'resume_verification_hash_invalid'
    }
    Assert-CityGoCanaryCleanup (($Verification.schemaVersion -is [int] -or $Verification.schemaVersion -is [long]) -and
        $Verification.schemaVersion -eq 1 -and $Verification.scope -ceq 'verified_owned_copy_before_resume' -and
        $Verification.operationId -ceq $Plan.operationId -and $Verification.initialCreationReceiptSha256 -ceq $Plan.initialCreationReceiptSha256 -and
        $Verification.sourceBaseSha256 -ceq $Manifest.sourceBaseSha256 -and $Verification.targetSha256 -ceq $Manifest.sourceBaseSha256) 'resume_verification_binding_invalid'
    foreach ($key in @('sourceDiskIdentifier','targetDiskIdentifier')) { Assert-CityGoCanaryCleanupGuid $Verification.$key }
    Assert-CityGoCanaryCleanup ($Verification.sourceDiskIdentifier -ceq $Verification.targetDiskIdentifier -and
        $Manifest.diskIdentifier -cne $Verification.sourceDiskIdentifier) 'resume_disk_identity_binding_invalid'
    foreach ($key in @('noVmOrReferencesObserved','sourceVmOff','targetStandaloneUnattached','targetTreeOnlyDisk')) {
        Assert-CityGoCanaryCleanup ($Verification.$key -is [bool] -and $Verification.$key) 'resume_verification_step_unverified'
    }
    foreach ($key in @('guestIsolationVerified','githubRunnerRegistered','ciJobsAdmitted')) {
        Assert-CityGoCanaryCleanup ($Verification.$key -is [bool] -and -not $Verification.$key) 'resume_verification_admission_not_closed'
    }
}

function Assert-CityGoCanaryCleanupForeignDisk {
    param($Path,[Collections.IDictionary]$Plan)
    # A foreign AVHDX can still depend on the disposable disk. Walk metadata
    # only, refusing unknowns/cycles/bounds before any unregister or deletion.
    Assert-CityGoCanaryCleanup ($Path -is [string] -and $Path.Length -gt 0) 'foreign_disk_chain_unknown'
    $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    for ($depth=0;$depth -lt 16;$depth++) {
        $path=Get-CityGoCanaryCleanupPath $Path
        Assert-CityGoCanaryCleanup ($path -ine $Plan.targetVhdx) 'disk_referenced_by_other_vm'
        Assert-CityGoCanaryCleanup ($seen.Add($path)) 'foreign_disk_chain_cycle'
        Assert-CityGoCanaryCleanupPlainPath $path $false
        $metadata=@(Get-VHD -Path $path -ErrorAction Stop)
        Assert-CityGoCanaryCleanup ($metadata.Count -eq 1 -and [string]$metadata[0].VhdFormat -cin @('VHD','VHDX') -and
            [string]$metadata[0].VhdType -cin @('Fixed','Dynamic','Differencing') -and
            $null -ne $metadata[0].PSObject.Properties['ParentPath']) 'foreign_disk_chain_unknown'
        $parent=$metadata[0].ParentPath
        if ([string]$metadata[0].VhdType -cne 'Differencing') {
            Assert-CityGoCanaryCleanup ($null -eq $parent -or $parent -is [string] -and $parent.Length -eq 0) 'foreign_disk_chain_unknown'
            return
        }
        Assert-CityGoCanaryCleanup ($parent -is [string] -and $parent.Length -gt 0) 'foreign_disk_chain_unknown'
        $Path=$parent
    }
    throw 'foreign_disk_chain_bound_exceeded'
}

function Get-CityGoCanaryCleanupVm {
    param([Collections.IDictionary]$Plan)
    # Enumerating locally fails closed on inventory errors. Never infer absence
    # from Get-VM -Id throwing, and refuse any other VM referencing this disk.
    $owned=$null
    foreach ($vm in @(Get-VM -ErrorAction Stop)) {
        $sameId=$vm.Id.ToString('D') -ceq $Plan.vmId
        Assert-CityGoCanaryCleanup ($sameId -or ($vm.Name -ine $Plan.vmName -and [string]$vm.Path -ine $Plan.vmPath)) 'foreign_vm_namespace_collision'
        $disks=@(Get-VMHardDiskDrive -VM $vm -ErrorAction Stop)
        foreach ($disk in $disks) {
            if (-not $sameId) { Assert-CityGoCanaryCleanupForeignDisk $disk.Path $Plan }
        }
        if (-not $sameId) { continue }
        Assert-CityGoCanaryCleanup ($null -eq $owned -and $vm.Name -ceq $Plan.vmName -and [string]$vm.Path -ieq $Plan.vmPath -and
            [string]$vm.State -ceq 'Off' -and $vm.Generation -eq 2) 'owned_vm_changed_or_not_off'
        Assert-CityGoCanaryCleanupPlainPath $Plan.vmPath $true
        Assert-CityGoCanaryCleanup ($disks.Count -eq 1 -and [string]$disks[0].Path -ieq $Plan.targetVhdx -and -not $disks[0].DiskNumber -and
            [string]$disks[0].ControllerType -ceq 'SCSI' -and $disks[0].ControllerNumber -eq 0 -and $disks[0].ControllerLocation -eq 0) 'owned_disk_attachment_changed'
        $nics=@(Get-VMNetworkAdapter -VM $vm -ErrorAction Stop)
        Assert-CityGoCanaryCleanup ($nics.Count -eq 1 -and [string]$nics[0].Id -ceq $Plan.nicId -and
            $nics[0].VMId.ToString('D') -ceq $Plan.vmId -and $nics[0].Name -ceq $Plan.nicName) 'owned_nic_changed'
        Assert-CityGoCanaryCleanup (@(Get-VMSnapshot -VM $vm -ErrorAction Stop).Count -eq 0 -and
            @(Get-VMAssignableDevice -VM $vm -ErrorAction Stop).Count -eq 0) 'snapshots_or_devices_refused'
        $owned=$vm
    }
    return $owned
}

function Test-CityGoCanaryCleanupDisk {
    param([Collections.IDictionary]$Plan)
    if (-not (Test-Path -LiteralPath $Plan.targetVhdx -ErrorAction Stop)) { return $false }
    Assert-CityGoCanaryCleanupPlainPath $Plan.targetVhdx $false
    $disk=Get-VHD -Path $Plan.targetVhdx -ErrorAction Stop
    # Native Hyper-V exposes DiskIdentifier as System.String. Normalize only
    # this identifier; the immutable manifest and every other guard stay exact.
    $diskId=[guid]::Empty
    Assert-CityGoCanaryCleanup ([string]$disk.VhdFormat -ceq 'VHDX' -and [string]$disk.VhdType -ceq $Plan.diskType -and
        -not $disk.ParentPath -and $disk.Attached -is [bool] -and -not $disk.Attached -and $disk.Size -eq 96GB -and $disk.FileSize -gt 0 -and
        ($disk.DiskIdentifier -is [string] -or $disk.DiskIdentifier -is [guid]) -and
        [guid]::TryParse([string]$disk.DiskIdentifier,[ref]$diskId) -and $diskId -ne [guid]::Empty -and
        $diskId.ToString('D') -ceq $Plan.diskIdentifier) 'disk_identity_or_state_changed'
    return $true
}

function Get-CityGoCanaryCleanupDirectories {
    param([Collections.IDictionary]$Plan)
    return @($Plan.targetDirectory,$Plan.vmPath,($Plan.vmPath+'\Virtual Machines'),
        ($Plan.vmPath+'\Virtual Machines\'+$Plan.vmId),($Plan.vmPath+'\Snapshots'),
        ($Plan.vmPath+'\Virtual Hard Disks'),($Plan.vmPath+'\Planned Virtual Machines'))
}

function Assert-CityGoCanaryCleanupTree {
    param([Collections.IDictionary]$Plan)
    if (-not (Test-Path -LiteralPath $Plan.targetDirectory -ErrorAction Stop)) { return }
    $directories=@(Get-CityGoCanaryCleanupDirectories $Plan)
    $pending=[Collections.Generic.Queue[string]]::new();$pending.Enqueue($Plan.targetDirectory);$count=0
    while ($pending.Count -gt 0) {
        $directory=$pending.Dequeue()
        Assert-CityGoCanaryCleanupPlainPath $directory $true
        foreach ($item in @(Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop)) {
            $count++;Assert-CityGoCanaryCleanup ($count -le 32 -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) 'tree_unexpected_or_reparse'
            $path=[string]$item.FullName
            if ($item.PSIsContainer) {
                Assert-CityGoCanaryCleanup ($path -iin $directories) 'foreign_directory_preserved'
                $pending.Enqueue($path)
            } else {
                $native=@()
                foreach ($extension in @('vmcx','vmrs','vmgs')) {
                    $native+=($Plan.vmPath+'\Virtual Machines\'+$Plan.vmId+'.'+$extension)
                    $native+=($Plan.vmPath+'\Virtual Machines\'+$Plan.vmId+'\'+$Plan.vmId+'.'+$extension)
                }
                Assert-CityGoCanaryCleanup ($path -ieq $Plan.targetVhdx -or $path -iin $native) 'foreign_file_preserved'
            }
        }
    }
}

function Remove-CityGoCanaryEmptyDirectories {
    param([Collections.IDictionary]$Plan)
    # Explicit derived directories only. No -Recurse/-Force, native files are
    # left to Remove-VM; any surviving nonempty directory is preserved.
    foreach ($directory in @(Get-CityGoCanaryCleanupDirectories $Plan|Sort-Object Length -Descending)) {
        if (-not (Test-Path -LiteralPath $directory -ErrorAction Stop)) { continue }
        Assert-CityGoCanaryCleanupPlainPath $directory $true
        if (@(Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop).Count -eq 0) {
            Remove-Item -LiteralPath $directory -Confirm:$false -ErrorAction Stop
        }
    }
}

function New-CityGoCanaryCleanupReceipt {
    param([Collections.IDictionary]$Plan,[string]$Stage)
    return [ordered]@{schemaVersion=1;scope='local_canary_cleanup';operationId=$Plan.operationId;vmId=$Plan.vmId;
        diskIdentifier=$Plan.diskIdentifier;creationManifestSha256=$Plan.manifestSha256;stage=$Stage}
}

function Assert-CityGoCanaryCleanupReceipt {
    param($Receipt,[Collections.IDictionary]$Plan,[bool]$Final)
    $expected=New-CityGoCanaryCleanupReceipt $Plan $(if($Final){'cleanup_complete_resources_absent'}else{'cleanup_intent_recorded'})
    if ($Final) { $expected.vmAbsent=$true;$expected.diskAbsent=$true;$expected.ownedDirectoryAbsent=$Receipt.ownedDirectoryAbsent }
    $keys=@($Receipt.PSObject.Properties.Name)
    Assert-CityGoCanaryCleanup ($keys.Count -eq $expected.Count -and @($keys|Where-Object{$_ -cnotin $expected.Keys}).Count -eq 0) 'cleanup_receipt_keys_invalid'
    foreach ($key in $expected.Keys) {
        Assert-CityGoCanaryCleanup ($Receipt.$key -ceq $expected[$key]) 'cleanup_receipt_ownership_mismatch'
    }
    Assert-CityGoCanaryCleanup (($Receipt.schemaVersion -is [int] -or $Receipt.schemaVersion -is [long]) -and $Receipt.schemaVersion -eq 1) 'cleanup_receipt_version_invalid'
    if ($Final) {
        foreach ($key in @('vmAbsent','diskAbsent','ownedDirectoryAbsent')) {
            Assert-CityGoCanaryCleanup ($Receipt.$key -is [bool]) 'cleanup_receipt_boolean_invalid'
        }
    }
}

function Write-CityGoCanaryCleanupReceipt {
    param([string]$Path,$Receipt,[Collections.IDictionary]$Plan,[string]$OwnerSid)
    Assert-CityGoCanaryCleanup ($Path -ceq $Plan.intentPath -or $Path -ceq $Plan.resultPath) 'cleanup_receipt_path_invalid'
    Assert-CityGoCanaryCleanupPlainPath $Plan.controlDirectory $true
    Assert-CityGoCanaryCleanupPrivateAcl $Plan.controlDirectory $OwnerSid $true
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Receipt|ConvertTo-Json -Depth 4 -Compress))
    $stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try { $stream.Write($bytes,0,$bytes.Length);$stream.Flush($true) } finally { $stream.Dispose() }
    Assert-CityGoCanaryCleanupPrivateAcl $Path $OwnerSid
}

function Invoke-CityGoCanaryCleanup {
    param($Manifest,[Collections.IDictionary]$Request)
    $plan=Get-CityGoCanaryCleanupPlan $Manifest $Request
    $result=New-CityGoCanaryCleanupReceipt $plan 'plan_only_unverified'
    if (-not $Request.apply) { return $result }
    Assert-CityGoCanaryCleanup ($Request.acknowledge -ceq $plan.requiredAcknowledgement) 'typed_acknowledgement_required'
    $owner=Get-CityGoCanaryCleanupIdentity $true
    Assert-CityGoCanaryCleanupPlainPath $plan.controlDirectory $true
    Assert-CityGoCanaryCleanupPrivateAcl $plan.controlDirectory $owner $true
    $evidence=@();$intentRecorded=$false;$phase='validate_resume_evidence'
    try {
        if ($plan.resumedCreation) {
            # A complete resumed manifest is allowed only with both immutable,
            # raw-hash-pinned links held read-locked through the whole cleanup.
            $initial=Open-CityGoCanaryCleanupEvidence $plan.initialCreationReceiptPath $owner $plan.initialCreationReceiptSha256;$evidence+=,$initial
            $verification=Open-CityGoCanaryCleanupEvidence $plan.resumeVerificationPath $owner $plan.resumeVerificationSha256;$evidence+=,$verification
            Assert-CityGoCanaryResumeCleanupEvidence $initial.value $verification.value $Manifest $plan
        }
        $phase='check_complete_receipt'
        if (Test-Path -LiteralPath $plan.resultPath -ErrorAction Stop) {
            $phase='read_complete_receipt'
            $final=Open-CityGoCanaryCleanupEvidence $plan.resultPath $owner;$evidence+=,$final
            Assert-CityGoCanaryCleanupReceipt $final.value $plan $true
            $phase='verify_completed_resources_absent'
            Assert-CityGoCanaryCleanup ($null -eq (Get-CityGoCanaryCleanupVm $plan) -and
                -not (Test-CityGoCanaryCleanupDisk $plan)) 'resources_reappeared_after_cleanup'
            $directoryPresent=Test-Path -LiteralPath $plan.targetDirectory -ErrorAction Stop
            Assert-CityGoCanaryCleanup (-not $final.value.ownedDirectoryAbsent -or -not $directoryPresent) 'directory_reappeared_after_cleanup'
            if ($directoryPresent) { Assert-CityGoCanaryCleanupTree $plan }
            return $final.value
        }
        $phase='check_cleanup_intent'
        if (Test-Path -LiteralPath $plan.intentPath -ErrorAction Stop) {
            $phase='read_cleanup_intent'
            $intent=Open-CityGoCanaryCleanupEvidence $plan.intentPath $owner;$evidence+=,$intent
            Assert-CityGoCanaryCleanupReceipt $intent.value $plan $false
            $intentRecorded=$true
        }
        $phase='verify_initial_owned_tree'
        Assert-CityGoCanaryCleanupTree $plan
        $phase='read_initial_owned_vm'
        $vm=Get-CityGoCanaryCleanupVm $plan
        $phase='read_initial_owned_disk'
        $diskPresent=Test-CityGoCanaryCleanupDisk $plan
        Assert-CityGoCanaryCleanup ($null -eq $vm -or $diskPresent) 'owned_disk_missing_while_vm_exists'
        if (-not $intentRecorded) {
            $phase='write_cleanup_intent'
            Write-CityGoCanaryCleanupReceipt $plan.intentPath (New-CityGoCanaryCleanupReceipt $plan 'cleanup_intent_recorded') $plan $owner
            $intentRecorded=$true
        }
        if ($null -ne $vm) {
            $phase='reread_owned_vm_before_remove'
            $vm=Get-CityGoCanaryCleanupVm $plan
            $phase='reread_owned_disk_before_vm_remove'
            Assert-CityGoCanaryCleanup ($null -ne $vm -and (Test-CityGoCanaryCleanupDisk $plan)) 'resources_changed_before_vm_remove'
            $phase='remove_owned_vm'
            # Native Force suppresses Remove-VM's separate ShouldContinue
            # confirmation only; all exact identity/Off/disk guards ran above.
            Remove-VM -VM $vm -Force -Confirm:$false -ErrorAction Stop
        }
        $phase='verify_owned_vm_absent'
        Assert-CityGoCanaryCleanup ($null -eq (Get-CityGoCanaryCleanupVm $plan)) 'vm_removal_unverified'
        $phase='read_owned_disk_before_remove'
        if (Test-CityGoCanaryCleanupDisk $plan) {
            $phase='verify_owned_tree_before_disk_remove'
            Assert-CityGoCanaryCleanupTree $plan
            $phase='remove_owned_disk'
            Remove-Item -LiteralPath $plan.targetVhdx -Confirm:$false -ErrorAction Stop
        }
        $phase='verify_owned_disk_absent'
        Assert-CityGoCanaryCleanup (-not (Test-Path -LiteralPath $plan.targetVhdx -ErrorAction Stop)) 'disk_removal_unverified'
        $phase='verify_owned_tree_before_directory_cleanup'
        Assert-CityGoCanaryCleanupTree $plan
        $phase='remove_empty_owned_directories'
        Remove-CityGoCanaryEmptyDirectories $plan
        $result=New-CityGoCanaryCleanupReceipt $plan 'cleanup_complete_resources_absent'
        $result.vmAbsent=$true;$result.diskAbsent=$true
        $phase='verify_final_directory_state'
        $result.ownedDirectoryAbsent=-not (Test-Path -LiteralPath $plan.targetDirectory -ErrorAction Stop)
        $phase='write_complete_receipt'
        Write-CityGoCanaryCleanupReceipt $plan.resultPath $result $plan $owner
        return $result
    } catch {
        # No rollback/adoption/stop or cleanup of evidence. Durable intent lets a
        # later exact-manifest retry inspect VM-missing/disk-remaining crashes.
        $result.stage='failed_preserved_requires_inspection'
        $result.cleanupIntentRecorded=$intentRecorded
        # Fixed source-code diagnostics only, never raw native exception text.
        # Default plans and successful durable receipts keep their exact schema.
        $result.failurePhase=$phase;$result.failureCode='canary_cleanup_failed'
        return $result
    } finally { foreach ($entry in $evidence) { if ($entry.stream) { $entry.stream.Dispose() } } }
}

$manifestEvidence=$null
try {
    Assert-CityGoCanaryCleanup ($ExpectedManifestSha256.Length -eq 64 -and $ExpectedManifestSha256 -cmatch '^[a-f0-9]{64}$') 'expected_hash_required'
    $null=Get-CityGoCanaryCleanupPath $ManifestPath
    Assert-CityGoCanaryCleanup ($ManifestPath -cmatch '^D:\\CityGo-CI\\control\\[a-f0-9-]{36}\\canary-(?:resume-)?creation\.json$') 'manifest_path_invalid'
    $owner=Get-CityGoCanaryCleanupIdentity ([bool]$Apply)
    $manifestEvidence=Open-CityGoCanaryCleanupEvidence $ManifestPath $owner $ExpectedManifestSha256
    $result=Invoke-CityGoCanaryCleanup $manifestEvidence.value ([ordered]@{manifestPath=$ManifestPath;manifestSha256=$ExpectedManifestSha256;apply=[bool]$Apply;acknowledge=$Acknowledge})
    $result|ConvertTo-Json -Depth 4 -Compress
    if ($result.stage -like 'failed_*') { exit 1 }
} catch {
    [ordered]@{schemaVersion=1;scope='local_canary_cleanup';stage='preconditions_not_met';resourcesRemoved=$false}|ConvertTo-Json -Compress
    exit 2
} finally { if ($manifestEvidence -and $manifestEvidence.stream) { $manifestEvidence.stream.Dispose() } }
