# Host-side stop ONLY for one complete, manifest-owned disposable canary.
# Default plan is pure. This never deletes a VM/disk, changes networking, or
# grants CI admission. Stop-VM -Force is deliberately NOT used: its shutdown
# semantics differ from Remove-VM's confirmation-only Force switch.
[CmdletBinding()]
param(
    [string]$OperationId = '',
    [string]$VmId = '',
    [string]$ExpectedManifestSha256 = '',
    [switch]$ResumedCreation,
    [string]$SeedPath = '',
    [string]$ExpectedSeedSha256 = '',
    [int]$GraceSeconds = 30,
    [int]$TurnOffSeconds = 10,
    [switch]$Apply,
    [string]$Acknowledge = ''
)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$WarningPreference='SilentlyContinue'
$InformationPreference='SilentlyContinue'
$VerbosePreference='SilentlyContinue'
$DebugPreference='SilentlyContinue'

function Assert-CityGoCanaryStop {
    param([bool]$Condition,[string]$Code)
    if (-not $Condition) { throw $Code }
}

function Assert-CityGoCanaryStopGuid {
    param($Value)
    $guid=[guid]::Empty
    Assert-CityGoCanaryStop ($Value -is [string] -and $Value.Length -eq 36 -and
        [guid]::TryParseExact($Value,'D',[ref]$guid) -and $guid -ne [guid]::Empty -and
        $Value -ceq $guid.ToString('D')) 'identity_invalid'
}

function Get-CityGoCanaryStopPlan {
    param([Collections.IDictionary]$Request)
    Assert-CityGoCanaryStopGuid $Request.operationId
    Assert-CityGoCanaryStopGuid $Request.vmId
    Assert-CityGoCanaryStop ($Request.manifestSha256 -is [string] -and $Request.manifestSha256 -cmatch '^[a-f0-9]{64}$') 'manifest_hash_required'
    Assert-CityGoCanaryStop ($Request.resumedCreation -is [bool] -and
        $Request.graceSeconds -is [int] -and $Request.graceSeconds -ge 1 -and $Request.graceSeconds -le 120 -and
        $Request.turnOffSeconds -is [int] -and $Request.turnOffSeconds -ge 1 -and $Request.turnOffSeconds -le 60) 'deadline_invalid'
    $control='D:\CityGo-CI\control\'+$Request.operationId
    $seed=$null;$seedHash=$null
    if ($Request.seedPath -or $Request.seedSha256) {
        Assert-CityGoCanaryStop ($Request.seedPath -is [string] -and $Request.seedSha256 -is [string] -and
            $Request.seedSha256 -cmatch '^[a-f0-9]{64}$') 'seed_pair_required'
        $prefix='D:\CityGo-CI\seeds\'+$Request.operationId+'\'
        $allowed=@('offline-cidata.iso','network-cidata.iso','lifecycle-cidata.iso','runner-cidata.iso')
        Assert-CityGoCanaryStop (@($allowed|Where-Object{$Request.seedPath -ceq ($prefix+$_)}).Count -eq 1) 'seed_path_invalid'
        $seed=$Request.seedPath;$seedHash=$Request.seedSha256
    }
    return [ordered]@{operationId=$Request.operationId;vmId=$Request.vmId;controlDirectory=$control;
        manifestPath=($control+$(if($Request.resumedCreation){'\canary-resume-creation.json'}else{'\canary-creation.json'}));
        manifestSha256=$Request.manifestSha256;helperPath=($control+'\Remove-CityGoCanaryVm.ps1');
        helperSha256='70f036f9b6c9885f6cfd15f5a362883b7bf72803dddf5d6fe28fc17c29bea098';
        seedPath=$seed;seedSha256=$seedHash;graceSeconds=$Request.graceSeconds;turnOffSeconds=$Request.turnOffSeconds;
        intentPath=($control+'\canary-stop-intent.json');turnOffIntentPath=($control+'\canary-stop-turnoff-intent.json');
        resultPath=($control+'\canary-stop-result.json');
        requiredAcknowledgement=('STOP_OWNED_CANARY:'+$Request.vmId+':'+$Request.manifestSha256+':ALLOW_TURNOFF_AFTER_'+$Request.graceSeconds+'S')}
}

function Assert-CityGoCanaryStopPlainPath {
    param([string]$Path,[bool]$Directory)
    Assert-CityGoCanaryStop ($Path -cmatch '^[A-Za-z]:\\' -and $Path.Length -le 1024 -and
        $Path -notmatch '[\x00-\x1f/*?\[\]]' -and -not $Path.Substring(2).Contains(':') -and
        [IO.Path]::GetFullPath($Path).Equals($Path,[StringComparison]::OrdinalIgnoreCase)) 'path_invalid'
    $cursor=$Path.Substring(0,3)
    foreach ($part in @('')+$Path.Substring(3).Split('\')) {
        if ($part) {
            Assert-CityGoCanaryStop ($part -notin @('.','..') -and $part -notmatch '[. ]$') 'path_invalid'
            $cursor=[IO.Path]::Combine($cursor,$part)
        }
        $item=Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
        Assert-CityGoCanaryStop ($item.PSProvider.Name -ceq 'FileSystem' -and
            ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) 'path_not_plain'
        if (-not $cursor.Equals($Path,[StringComparison]::OrdinalIgnoreCase)) {
            Assert-CityGoCanaryStop ([bool]$item.PSIsContainer) 'ancestor_not_directory'
        }
    }
    Assert-CityGoCanaryStop ([bool]$item.PSIsContainer -eq $Directory) 'path_kind_invalid'
}

function Get-CityGoCanaryStopOwner {
    Assert-CityGoCanaryStop ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) 'windows_required'
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
    try {
        $principal=[Security.Principal.WindowsPrincipal]::new($identity)
        Assert-CityGoCanaryStop ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) 'administrator_required'
        return $identity.User.Value
    } finally { $identity.Dispose() }
}

function Assert-CityGoCanaryStopAcl {
    param([string]$Path,[string]$OwnerSid,[bool]$ProtectedDirectory=$false,[string]$SeedVmSid='')
    $allowed=@($OwnerSid,'S-1-5-18','S-1-5-32-544')
    $acl=Get-Acl -LiteralPath $Path -ErrorAction Stop
    Assert-CityGoCanaryStop ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -in $allowed -and
        (-not $ProtectedDirectory -or $acl.AreAccessRulesProtected)) 'acl_owner_or_protection_invalid'
    $readMask=[long][Security.AccessControl.FileSystemRights]::ReadAndExecute -bor [long][Security.AccessControl.FileSystemRights]::Synchronize
    foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { continue }
        if ($rule.IdentityReference.Value -in $allowed) { continue }
        Assert-CityGoCanaryStop ($SeedVmSid -and $rule.IdentityReference.Value -ceq $SeedVmSid -and
            ([long]$rule.FileSystemRights -band (-bnot $readMask)) -eq 0) 'acl_not_private'
    }
}

function Open-CityGoCanaryStopRaw {
    param([string]$Path,[string]$OwnerSid,[string]$ExpectedHash,[long]$MaximumBytes=65536,[string]$SeedVmSid='')
    Assert-CityGoCanaryStopPlainPath $Path $false
    Assert-CityGoCanaryStopPlainPath ([IO.Path]::GetDirectoryName($Path)) $true
    # The exact VM may read its public seed directory as well as its ISO.
    # Empty SeedVmSid is still mandatory for helper/control/evidence callers.
    Assert-CityGoCanaryStopAcl ([IO.Path]::GetDirectoryName($Path)) $OwnerSid $true $SeedVmSid
    Assert-CityGoCanaryStopAcl $Path $OwnerSid $false $SeedVmSid
    $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try {
        Assert-CityGoCanaryStop ($stream.Length -ge 2 -and $stream.Length -le $MaximumBytes) 'artifact_size_invalid'
        $sha=[Security.Cryptography.SHA256]::Create()
        try { $hash=([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
        Assert-CityGoCanaryStop ($hash -ceq $ExpectedHash) 'artifact_hash_mismatch'
        $stream.Position=0
        return $stream
    } catch { $stream.Dispose();throw }
}

function Import-CityGoCanaryStopReadOnlyGuards {
    param([Collections.IDictionary]$Plan,[string]$OwnerSid)
    $stream=Open-CityGoCanaryStopRaw $Plan.helperPath $OwnerSid $Plan.helperSha256
    try {
        $reader=[IO.StreamReader]::new($stream,[Text.UTF8Encoding]::new($false,$true),$true,4096,$true)
        try { $raw=$reader.ReadToEnd() } finally { $reader.Dispose() }
        $tokens=$null;$errors=$null
        $ast=[Management.Automation.Language.Parser]::ParseInput($raw,[ref]$tokens,[ref]$errors)
        Assert-CityGoCanaryStop ($errors.Count -eq 0) 'guard_source_invalid'
        $selected=@('Assert-CityGoCanaryCleanup','Get-CityGoCanaryCleanupPath','Assert-CityGoCanaryCleanupPlainPath',
            'Assert-CityGoCanaryCleanupPrivateAcl','ConvertFrom-CityGoCanaryCleanupJson','Open-CityGoCanaryCleanupEvidence',
            'Assert-CityGoCanaryCleanupGuid','Get-CityGoCanaryCreationFields','Get-CityGoCanaryCleanupPlan',
            'Assert-CityGoCanaryResumeCleanupEvidence','Assert-CityGoCanaryCleanupForeignDisk')
        foreach ($name in $selected) {
            $matches=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name},$true))
            Assert-CityGoCanaryStop ($matches.Count -eq 1) 'guard_definition_invalid'
            # The ONLY evaluated code is a named definition from the pinned,
            # private, read-locked reviewed source; never its entrypoint.
            Set-Item -LiteralPath ('Function:script:'+$name) -Value $matches[0].Body.GetScriptBlock() -ErrorAction Stop
        }
        return $stream
    } catch { $stream.Dispose();throw }
}

function Get-CityGoCanaryExpectedVmSid {
    param([string]$VmId)
    Assert-CityGoCanaryStopGuid $VmId
    # MS-DTYP 2.4.2.4: S-1-5-83-1 + four DWORDs of the VM container ID.
    # Derive the exact VM SID, not a broad virtual-machines group/prefix.
    Assert-CityGoCanaryStop ([BitConverter]::IsLittleEndian) 'unsupported_sid_byte_order'
    $bytes=([guid]$VmId).ToByteArray();$parts=@()
    foreach($offset in @(0,4,8,12)){$parts+=([BitConverter]::ToUInt32($bytes,$offset)).ToString([Globalization.CultureInfo]::InvariantCulture)}
    return ('S-1-5-83-1-'+($parts-join'-'))
}

function Get-CityGoCanaryStopVmSid {
    param([Collections.IDictionary]$Plan)
    $account=[Security.Principal.NTAccount]::new('NT VIRTUAL MACHINE',$Plan.vmId)
    $sid=$account.Translate([Security.Principal.SecurityIdentifier]).Value
    Assert-CityGoCanaryStop ($sid -ceq (Get-CityGoCanaryExpectedVmSid $Plan.vmId)) 'seed_vm_sid_invalid'
    return $sid
}

function Get-CityGoCanaryStopNative {
    param([Collections.IDictionary]$Plan,[switch]$ObserveStopping)
    # Stopping is permitted only for bounded read-only observations, including
    # the grace/fallback boundary. No shutdown may be dispatched in that state.
    # Initial admission still requires Running/Off.
    $allowedStates=@('Running','Off')
    if ($ObserveStopping) { $allowedStates+=@('Stopping') }
    $owned=$null
    foreach ($vm in @(Get-VM -ErrorAction Stop)) {
        $same=$vm.Id.ToString('D') -ceq $Plan.vmId
        Assert-CityGoCanaryStop ($same -or ($vm.Name -ine $Plan.vmName -and [string]$vm.Path -ine $Plan.vmPath)) 'foreign_namespace_collision'
        $drives=@(Get-VMHardDiskDrive -VM $vm -ErrorAction Stop)
        if (-not $same) {
            foreach ($drive in $drives) { Assert-CityGoCanaryCleanupForeignDisk $drive.Path $Plan }
            foreach ($dvd in @(Get-VMDvdDrive -VM $vm -ErrorAction Stop)) {
                Assert-CityGoCanaryStop (-not $Plan.seedPath -or [string]$dvd.Path -ine $Plan.seedPath) 'seed_referenced_by_other_vm'
            }
            continue
        }
        Assert-CityGoCanaryStop ($null -eq $owned -and $vm.Name -ceq $Plan.vmName -and [string]$vm.Path -ieq $Plan.vmPath -and
            [string]$vm.State -cin $allowedStates -and $vm.Generation -eq 2 -and
            $vm.ProcessorCount -eq 4 -and $vm.MemoryStartup -eq 6GB -and $vm.DynamicMemoryEnabled -eq $false -and
            [string]$vm.AutomaticStartAction -ceq 'Nothing' -and [string]$vm.CheckpointType -ceq 'Disabled' -and
            $vm.AutomaticCheckpointsEnabled -eq $false) 'owned_vm_changed_or_state_refused'
        Assert-CityGoCanaryCleanupPlainPath $Plan.targetDirectory $true
        Assert-CityGoCanaryCleanupPlainPath $Plan.vmPath $true
        Assert-CityGoCanaryStop ($drives.Count -eq 1 -and [string]$drives[0].Path -ieq $Plan.targetVhdx -and -not $drives[0].DiskNumber -and
            [string]$drives[0].ControllerType -ceq 'SCSI' -and $drives[0].ControllerNumber -eq 0 -and $drives[0].ControllerLocation -eq 0) 'disk_attachment_changed'
        Assert-CityGoCanaryCleanupPlainPath $Plan.targetVhdx $false
        $disks=@(Get-VHD -Path $Plan.targetVhdx -ErrorAction Stop)
        Assert-CityGoCanaryStop ($disks.Count -eq 1) 'disk_metadata_invalid'
        $disk=$disks[0];$diskId=[guid]::Empty
        Assert-CityGoCanaryStop ([string]$disk.VhdFormat -ceq 'VHDX' -and [string]$disk.VhdType -ceq $Plan.diskType -and
            -not $disk.ParentPath -and $disk.Attached -is [bool] -and
            ([string]$vm.State -cne 'Off' -or -not $disk.Attached) -and $disk.Size -eq 96GB -and $disk.FileSize -gt 0 -and
            ($disk.DiskIdentifier -is [string] -or $disk.DiskIdentifier -is [guid]) -and
            [guid]::TryParse([string]$disk.DiskIdentifier,[ref]$diskId) -and $diskId -ne [guid]::Empty -and
            $diskId.ToString('D') -ceq $Plan.diskIdentifier) 'disk_identity_or_state_changed'
        $firmware=Get-VMFirmware -VM $vm -ErrorAction Stop
        Assert-CityGoCanaryStop ([string]$firmware.SecureBoot -ceq 'On' -and
            [string]$firmware.SecureBootTemplate -ceq 'MicrosoftUEFICertificateAuthority') 'secure_boot_required'
        Assert-CityGoCanaryStop (@(Get-VMSnapshot -VM $vm -ErrorAction Stop).Count -eq 0 -and
            @(Get-VMAssignableDevice -VM $vm -ErrorAction Stop).Count -eq 0) 'snapshots_or_devices_refused'
        $nics=@(Get-VMNetworkAdapter -VM $vm -ErrorAction Stop)
        Assert-CityGoCanaryStop ($nics.Count -eq 1) 'nic_count_changed'
        $nic=$nics[0]
        Assert-CityGoCanaryStop ([string]$nic.Id -ceq $Plan.nicId -and $nic.VMId.ToString('D') -ceq $Plan.vmId -and
            $nic.Name -ceq $Plan.nicName -and [string]$nic.MacAddressSpoofing -ceq 'Off' -and
            [string]$nic.DhcpGuard -ceq 'On' -and [string]$nic.RouterGuard -ceq 'On' -and
            $nic.IovWeight -eq 0 -and $nic.IovQueuePairsAssigned -eq 0 -and $nic.IovUsage -eq 0 -and
            [string]$nic.PortMirroringMode -ceq 'None' -and [string]$nic.AllowTeaming -ceq 'Off') 'nic_identity_or_guards_changed'
        $sameNics=@(Get-VMNetworkAdapter -All -ErrorAction Stop|Where-Object{[string]$_.Id -ieq $Plan.nicId})
        Assert-CityGoCanaryStop ($sameNics.Count -eq 1 -and $sameNics[0].VMId.ToString('D') -ceq $Plan.vmId) 'nic_not_unique'
        $dvds=@(Get-VMDvdDrive -VM $vm -ErrorAction Stop)
        Assert-CityGoCanaryStop ($dvds.Count -le 1) 'dvd_count_changed'
        foreach ($dvd in $dvds) {
            Assert-CityGoCanaryStop ([string]$dvd.ControllerType -ceq 'SCSI' -and $dvd.ControllerNumber -eq 0 -and
                $dvd.ControllerLocation -eq 1 -and ((-not $Plan.seedPath -and -not $dvd.Path) -or
                ($Plan.seedPath -and [string]$dvd.Path -ieq $Plan.seedPath))) 'dvd_media_changed'
        }
        Assert-CityGoCanaryStop (-not $Plan.seedPath -or $dvds.Count -eq 1) 'expected_seed_missing'
        $owned=$vm
    }
    Assert-CityGoCanaryStop ($null -ne $owned) 'owned_vm_missing'
    return $owned
}

function Request-CityGoCanaryGracefulShutdown {
    param([Collections.IDictionary]$Plan,[DateTimeOffset]$Deadline)
    # Stop-VM -AsJob may silently power off if guest shutdown is unavailable.
    # The official exact-VM CIM method has NO such power-off fallback. Its
    # Force=false refers to guest applications, and is never supplied as true.
    # https://learn.microsoft.com/windows/win32/hyperv_v2/msvm-shutdowncomponent-initiateshutdown
    $vm=Get-CityGoCanaryStopNative $Plan
    if ([string]$vm.State -ceq 'Off' -or (Get-CityGoCanaryStopNow) -ge $Deadline) { return }
    $timeout=[int][Math]::Min(5,[Math]::Ceiling(($Deadline-(Get-CityGoCanaryStopNow)).TotalSeconds))
    if ($timeout -lt 1) { return }
    $components=@(Get-CimInstance -Namespace 'root/virtualization/v2' -ClassName 'Msvm_ShutdownComponent' -Filter ("SystemName = '"+$Plan.vmId+"'") -OperationTimeoutSec $timeout -ErrorAction Stop)
    Assert-CityGoCanaryStop ($components.Count -le 1) 'shutdown_component_not_unique'
    if ($components.Count -eq 0) { return }
    $component=$components[0];$status=@($component.OperationalStatus)
    $guidPattern='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
    # Microsoft's reference describes Microsoft:VMGUID\GUID; this Windows
    # build also returned Microsoft:GUID. Do not infer VM ownership from
    # either string: require the native system-device association below.
    $devicePattern='^Microsoft:(?:'+([regex]::Escape($Plan.vmId))+'\\)?'+$guidPattern+'$'
    Assert-CityGoCanaryStop ([string]$component.CimClass.CimClassName -ceq 'Msvm_ShutdownComponent' -and
        [string]$component.SystemCreationClassName -ceq 'Msvm_ComputerSystem' -and
        [string]$component.SystemName -ieq $Plan.vmId -and [string]$component.DeviceID -imatch $devicePattern) 'shutdown_component_binding_invalid'
    $componentGuid=([string]$component.DeviceID).Substring('Microsoft:'.Length).Split('\')[-1].ToLowerInvariant()
    Assert-CityGoCanaryStopGuid $componentGuid
    $systems=@(Get-CimAssociatedInstance -InputObject $component -Association 'Msvm_SystemDevice' -ResultClassName 'Msvm_ComputerSystem' -OperationTimeoutSec $timeout -ErrorAction Stop)
    Assert-CityGoCanaryStop ($systems.Count -eq 1 -and
        [string]$systems[0].CimClass.CimClassName -ceq 'Msvm_ComputerSystem' -and
        [string]$systems[0].Name -ieq $Plan.vmId) 'shutdown_system_association_invalid'
    # Missing/degraded integration cannot authorize an immediate hard stop.
    # Simply wait out the same durable grace period before permitted fallback.
    if (($component.EnabledState -isnot [uint16] -and $component.EnabledState -isnot [int]) -or
        $component.EnabledState -ne 2 -or $status.Count -eq 0 -or
        ($status[0] -isnot [uint16] -and $status[0] -isnot [int]) -or $status[0] -ne 2) { return }
    $vm=Get-CityGoCanaryStopNative $Plan
    if ([string]$vm.State -ceq 'Off' -or (Get-CityGoCanaryStopNow) -ge $Deadline) { return }
    try {
        $response=Invoke-CimMethod -InputObject $component -MethodName 'InitiateShutdown' -Arguments @{
            Force=$false;Reason='CityGo owned disposable canary shutdown'
        } -OperationTimeoutSec $timeout -ErrorAction Stop
        Assert-CityGoCanaryStop ($null -ne $response -and
            ($response.ReturnValue -is [uint32] -or $response.ReturnValue -is [int]) -and $response.ReturnValue -eq 0) 'guest_shutdown_not_confirmed'
    } catch {
        # No raw provider text or immediate power-off on not-ready/locked/timeout.
        # Later native Off readback, not this method's return, proves completion.
        return
    }
}

function Get-CityGoCanaryStopNow { return [DateTimeOffset]::UtcNow }

function New-CityGoCanaryStopReceipt {
    param([Collections.IDictionary]$Plan,[string]$Stage)
    return [ordered]@{schemaVersion=1;scope='owned_local_canary_stop';operationId=$Plan.operationId;vmId=$Plan.vmId;
        creationManifestSha256=$Plan.manifestSha256;cleanupHelperSha256=$Plan.helperSha256;diskIdentifier=$Plan.diskIdentifier;
        seedPath=$Plan.seedPath;seedSha256=$Plan.seedSha256;graceSeconds=$Plan.graceSeconds;turnOffSeconds=$Plan.turnOffSeconds;
        stage=$Stage;guestIsolationVerified=$false;githubRunnerRegistered=$false;ciJobsAdmitted=$false}
}

function Write-CityGoCanaryStopReceipt {
    param([string]$Path,$Receipt,[Collections.IDictionary]$Plan,[string]$OwnerSid)
    Assert-CityGoCanaryStop ($Path -cin @($Plan.intentPath,$Plan.turnOffIntentPath,$Plan.resultPath)) 'receipt_path_invalid'
    Assert-CityGoCanaryStopPlainPath $Plan.controlDirectory $true
    Assert-CityGoCanaryStopAcl $Plan.controlDirectory $OwnerSid $true
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Receipt|ConvertTo-Json -Depth 3 -Compress))
    $stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try { $stream.Write($bytes,0,$bytes.Length);$stream.Flush($true) } finally { $stream.Dispose() }
    Assert-CityGoCanaryStopAcl $Path $OwnerSid
}

function Assert-CityGoCanaryStopReceipt {
    param($Receipt,[Collections.IDictionary]$Plan,[string]$Stage)
    $expected=New-CityGoCanaryStopReceipt $Plan $Stage
    if ($Stage -ceq 'stop_intent_recorded') {
        foreach ($key in @('observedAt','graceDeadline','turnOffDeadline')) { $expected[$key]=$Receipt.$key }
    }
    if ($Stage -ceq 'stopped_off_verified') { $expected.vmOff=$true }
    $keys=@($Receipt.PSObject.Properties.Name)
    Assert-CityGoCanaryStop ($keys.Count -eq $expected.Count -and @($keys|Where-Object{$_ -cnotin $expected.Keys}).Count -eq 0) 'receipt_keys_invalid'
    foreach ($key in $expected.Keys) {
        $value=$Receipt.$key;$wanted=$expected[$key]
        if ($null -eq $wanted) {
            Assert-CityGoCanaryStop ($null -eq $value) 'receipt_binding_invalid'
        } elseif ($wanted -is [bool]) {
            Assert-CityGoCanaryStop ($value -is [bool] -and $value -eq $wanted) 'receipt_binding_invalid'
        } elseif ($wanted -is [int]) {
            Assert-CityGoCanaryStop (($value -is [int] -or $value -is [long]) -and $value -eq $wanted) 'receipt_binding_invalid'
        } else {
            Assert-CityGoCanaryStop ($value -is [string] -and $value -ceq $wanted) 'receipt_binding_invalid'
        }
    }
    if ($Stage -ceq 'stop_intent_recorded') {
        $times=@{}
        foreach ($key in @('observedAt','graceDeadline','turnOffDeadline')) {
            $time=[DateTimeOffset]::MinValue
            Assert-CityGoCanaryStop ($Receipt.$key -is [string] -and
                [DateTimeOffset]::TryParseExact($Receipt.$key,'yyyy-MM-ddTHH:mm:ss.fffffffZ',[Globalization.CultureInfo]::InvariantCulture,
                [Globalization.DateTimeStyles]::AssumeUniversal,[ref]$time)) 'receipt_deadline_invalid'
            $times[$key]=$time
        }
        Assert-CityGoCanaryStop ($times.observedAt -le (Get-CityGoCanaryStopNow) -and
            $times.graceDeadline -eq $times.observedAt.AddSeconds($Plan.graceSeconds) -and
            $times.turnOffDeadline -eq $times.graceDeadline.AddSeconds($Plan.turnOffSeconds)) 'receipt_deadline_invalid'
    }
}

function Wait-CityGoCanaryStopped {
    param([Collections.IDictionary]$Plan,[DateTimeOffset]$Deadline)
    # Also iteration-bounded so a wall-clock adjustment cannot cause a loop.
    for ($attempt=0;$attempt -le (($Plan.graceSeconds+$Plan.turnOffSeconds)*4);$attempt++) {
        $vm=Get-CityGoCanaryStopNative $Plan -ObserveStopping
        if ([string]$vm.State -ceq 'Off') { return $true }
        if ((Get-CityGoCanaryStopNow) -ge $Deadline) { return $false }
        Start-Sleep -Milliseconds 250
    }
    return $false
}

function Invoke-CityGoOwnedCanaryStop {
    param([Collections.IDictionary]$Request)
    $plan=Get-CityGoCanaryStopPlan $Request
    $result=[ordered]@{schemaVersion=1;scope='owned_local_canary_stop';operationId=$plan.operationId;vmId=$plan.vmId;
        stage='plan_only_unverified';vmOff=$false;guestIsolationVerified=$false;githubRunnerRegistered=$false;ciJobsAdmitted=$false}
    if (-not $Request.apply) { $result.plan=$plan;return $result }
    Assert-CityGoCanaryStop ($Request.acknowledge -ceq $plan.requiredAcknowledgement) 'typed_acknowledgement_required'
    $owner=Get-CityGoCanaryStopOwner
    $held=@();$jobs=@();$intentRecorded=$false;$phase='load_pinned_readonly_guards'
    try {
        $held+=,(Import-CityGoCanaryStopReadOnlyGuards $plan $owner)
        $phase='read_complete_creation_manifest'
        $manifest=Open-CityGoCanaryCleanupEvidence $plan.manifestPath $owner $plan.manifestSha256;$held+=,$manifest.stream
        $binding=Get-CityGoCanaryCleanupPlan $manifest.value ([ordered]@{manifestPath=$plan.manifestPath;manifestSha256=$plan.manifestSha256})
        Assert-CityGoCanaryStop ($binding.operationId -ceq $plan.operationId -and $binding.vmId -ceq $plan.vmId) 'manifest_identity_mismatch'
        foreach ($key in @('vmName','nicId','nicName','targetDirectory','targetVhdx','vmPath','diskIdentifier','diskType')) { $plan[$key]=$binding[$key] }
        if ($binding.resumedCreation) {
            $phase='verify_resumed_creation_evidence'
            $initial=Open-CityGoCanaryCleanupEvidence $binding.initialCreationReceiptPath $owner $binding.initialCreationReceiptSha256;$held+=,$initial.stream
            $proof=Open-CityGoCanaryCleanupEvidence $binding.resumeVerificationPath $owner $binding.resumeVerificationSha256;$held+=,$proof.stream
            Assert-CityGoCanaryResumeCleanupEvidence $initial.value $proof.value $manifest.value $binding
        }
        if ($plan.seedPath) {
            $phase='lock_exact_seed_artifact'
            $sid=Get-CityGoCanaryStopVmSid $plan
            $held+=,(Open-CityGoCanaryStopRaw $plan.seedPath $owner $plan.seedSha256 32MB $sid)
        }
        $phase='verify_initial_native_identity'
        $vm=Get-CityGoCanaryStopNative $plan
        if (Test-Path -LiteralPath $plan.resultPath -ErrorAction Stop) {
            $phase='verify_existing_stop_result'
            $complete=Open-CityGoCanaryCleanupEvidence $plan.resultPath $owner;$held+=,$complete.stream
            Assert-CityGoCanaryStopReceipt $complete.value $plan 'stopped_off_verified'
            Assert-CityGoCanaryStop ([string]$vm.State -ceq 'Off') 'vm_restarted_after_stop_receipt'
            return $complete.value
        }
        $phase='read_or_create_stop_intent'
        $resuming=Test-Path -LiteralPath $plan.intentPath -ErrorAction Stop
        if ($resuming) {
            $intent=Open-CityGoCanaryCleanupEvidence $plan.intentPath $owner;$held+=,$intent.stream
            Assert-CityGoCanaryStopReceipt $intent.value $plan 'stop_intent_recorded'
            $intentValue=$intent.value;$intentRecorded=$true
        } else {
            Assert-CityGoCanaryStop (-not (Test-Path -LiteralPath $plan.turnOffIntentPath -ErrorAction Stop)) 'orphan_turnoff_intent_refused'
            $now=Get-CityGoCanaryStopNow
            $intentValue=New-CityGoCanaryStopReceipt $plan 'stop_intent_recorded'
            $format='yyyy-MM-ddTHH:mm:ss.fffffffZ'
            $intentValue.observedAt=$now.UtcDateTime.ToString($format,[Globalization.CultureInfo]::InvariantCulture)
            $intentValue.graceDeadline=$now.AddSeconds($plan.graceSeconds).UtcDateTime.ToString($format,[Globalization.CultureInfo]::InvariantCulture)
            $intentValue.turnOffDeadline=$now.AddSeconds($plan.graceSeconds+$plan.turnOffSeconds).UtcDateTime.ToString($format,[Globalization.CultureInfo]::InvariantCulture)
            Write-CityGoCanaryStopReceipt $plan.intentPath $intentValue $plan $owner;$intentRecorded=$true
        }
        $turnOffRecorded=$false
        if (Test-Path -LiteralPath $plan.turnOffIntentPath -ErrorAction Stop) {
            $phase='verify_existing_turnoff_intent'
            $turnOff=Open-CityGoCanaryCleanupEvidence $plan.turnOffIntentPath $owner;$held+=,$turnOff.stream
            Assert-CityGoCanaryStopReceipt $turnOff.value $plan 'turnoff_dispatch_intent_recorded'
            $turnOffRecorded=$true
        }
        $graceDeadline=[DateTimeOffset]::Parse($intentValue.graceDeadline,[Globalization.CultureInfo]::InvariantCulture)
        $finalDeadline=[DateTimeOffset]::Parse($intentValue.turnOffDeadline,[Globalization.CultureInfo]::InvariantCulture)
        if ([string]$vm.State -ceq 'Running' -and -not $resuming) {
            $phase='recheck_before_graceful_shutdown'
            $vm=Get-CityGoCanaryStopNative $plan
            if ([string]$vm.State -ceq 'Running') {
                $phase='submit_graceful_shutdown_once'
                Request-CityGoCanaryGracefulShutdown $plan $graceDeadline
            }
        }
        $phase='wait_graceful_off_readback'
        $off=Wait-CityGoCanaryStopped $plan $graceDeadline
        if (-not $off) {
            $phase='recheck_before_authorized_turnoff'
            # Graceful shutdown may cross its grace deadline in Stopping.
            # Observe it within the original final deadline, never hard-stop
            # it or reset the window merely because shutdown is in progress.
            $vm=Get-CityGoCanaryStopNative $plan -ObserveStopping
            if ([string]$vm.State -ceq 'Running') {
                if ($turnOffRecorded) {
                    # A controller interruption after dispatch is ambiguous:
                    # only read back, never submit a second pending command.
                } else {
                    Assert-CityGoCanaryStop ((Get-CityGoCanaryStopNow) -ge $graceDeadline -and
                        (Get-CityGoCanaryStopNow) -lt $finalDeadline) 'turnoff_window_expired'
                    $phase='write_turnoff_dispatch_intent'
                    Write-CityGoCanaryStopReceipt $plan.turnOffIntentPath (New-CityGoCanaryStopReceipt $plan 'turnoff_dispatch_intent_recorded') $plan $owner
                    $phase='final_identity_recheck_before_turnoff'
                    $vm=Get-CityGoCanaryStopNative $plan -ObserveStopping
                    if ([string]$vm.State -ceq 'Running') {
                        $phase='submit_authorized_turnoff_once'
                        $jobs+=,(Stop-VM -VM $vm -TurnOff -AsJob -Confirm:$false -ErrorAction Stop)
                    }
                }
            }
            $phase='wait_turnoff_off_readback'
            Assert-CityGoCanaryStop (Wait-CityGoCanaryStopped $plan $finalDeadline) 'off_readback_deadline_exceeded'
        }
        $phase='verify_final_off_identity'
        $vm=Get-CityGoCanaryStopNative $plan
        Assert-CityGoCanaryStop ([string]$vm.State -ceq 'Off') 'final_off_readback_required'
        $result=New-CityGoCanaryStopReceipt $plan 'stopped_off_verified';$result.vmOff=$true
        $phase='write_stop_result'
        Write-CityGoCanaryStopReceipt $plan.resultPath $result $plan $owner
        return $result
    } catch {
        $result.stage='failed_preserved_requires_inspection';$result.vmOff=$false
        $result.stopIntentRecorded=$intentRecorded;$result.failurePhase=$phase;$result.failureCode='owned_canary_stop_failed'
        return $result
    } finally {
        # Never Stop-Job/Remove-Job -Force, enumerate global jobs, or remove a
        # pending native command. Only terminal jobs created by THIS call.
        foreach ($job in $jobs) {
            if ($job -is [Management.Automation.Job] -and [string]$job.State -cin @('Completed','Failed','Stopped')) {
                try { Remove-Job -Job $job -ErrorAction Stop } catch { }
            }
        }
        foreach ($stream in $held) { if ($null -ne $stream) { $stream.Dispose() } }
    }
}

try {
    $request=[ordered]@{operationId=$OperationId;vmId=$VmId;manifestSha256=$ExpectedManifestSha256;
        resumedCreation=[bool]$ResumedCreation;seedPath=$SeedPath;seedSha256=$ExpectedSeedSha256;
        graceSeconds=$GraceSeconds;turnOffSeconds=$TurnOffSeconds;apply=[bool]$Apply;acknowledge=$Acknowledge}
    $result=Invoke-CityGoOwnedCanaryStop $request
    $result|ConvertTo-Json -Depth 4 -Compress
    if ($result.stage -like 'failed_*') { exit 1 }
} catch {
    [ordered]@{schemaVersion=1;scope='owned_local_canary_stop';stage='preconditions_not_met';vmOff=$false;
        guestIsolationVerified=$false;githubRunnerRegistered=$false;ciJobsAdmitted=$false}|ConvertTo-Json -Compress
    exit 2
}
