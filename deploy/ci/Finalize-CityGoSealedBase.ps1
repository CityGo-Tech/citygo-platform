# Trusted bootstrap finalization ONLY. The guest seal and graceful poweroff are
# separate owner-authorized operations. Default plan performs no host I/O.
# Apply only detaches this owned VM's exact seed ISO and disconnects its NIC.
# No guest execution, VM start/stop, ACL removal, file deletion or CI admission.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$OperationId,
    [Parameter(Mandatory=$true)][string]$VmId,
    [Parameter(Mandatory=$true)][string]$GuestSealPath,
    [Parameter(Mandatory=$true)][string]$ExpectedGuestSealSha256,
    [Parameter(Mandatory=$true)][string]$ToolsReplayPath,
    [Parameter(Mandatory=$true)][string]$ExpectedToolsReplaySha256,
    [Parameter(Mandatory=$true)][string]$ExpectedSeedIsoSha256,
    [switch]$Apply,
    [string]$Acknowledge = ''
)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$WarningPreference='SilentlyContinue'
$InformationPreference='SilentlyContinue'
$VerbosePreference='SilentlyContinue'
$DebugPreference='SilentlyContinue'

function Assert-CityGoSealedValue {
    param([bool]$Condition,[string]$Code)
    if (-not $Condition) { throw $Code }
}

function Assert-CityGoSealedGuid {
    param($Value)
    $id=[guid]::Empty
    Assert-CityGoSealedValue ($Value -is [string] -and [guid]::TryParseExact($Value,'D',[ref]$id) -and
        $id -ne [guid]::Empty -and $Value -ceq $id.ToString('D')) 'identity_invalid'
}

function Get-CityGoSealedPlan {
    param([Collections.IDictionary]$Request)
    Assert-CityGoSealedGuid $Request.operationId
    Assert-CityGoSealedGuid $Request.vmId
    foreach ($field in @('guestSealSha256','toolsReplaySha256','seedIsoSha256')) {
        Assert-CityGoSealedValue ($Request.$field -is [string] -and $Request.$field -cmatch '^[a-f0-9]{64}$') 'evidence_hash_required'
    }
    $control='D:\CityGo-CI\control\'+$Request.operationId
    Assert-CityGoSealedValue ($Request.guestSealPath -is [string] -and $Request.guestSealPath -ieq ($control+'\guest-seal.json') -and
        $Request.toolsReplayPath -is [string] -and $Request.toolsReplayPath -ieq ($control+'\tools-replay.json')) 'evidence_path_mismatch'
    $vmName='citygo-ci-base-'+$Request.operationId
    $directory='D:\CityGo-CI\bootstrap\'+$Request.operationId
    return [ordered]@{operationId=$Request.operationId;vmId=$Request.vmId;vmName=$vmName;
        vmPath=($directory+'\'+$vmName);basePath=($directory+'\bootstrap.vhdx');controlDirectory=$control;
        guestSealPath=$Request.guestSealPath;guestSealSha256=$Request.guestSealSha256;
        toolsReplayPath=$Request.toolsReplayPath;toolsReplaySha256=$Request.toolsReplaySha256;
        seedPath=('D:\CityGo-CI\seeds\'+$Request.operationId+'\bootstrap-cidata.iso');seedIsoSha256=$Request.seedIsoSha256;
        receiptPath=($control+'\sealed-base.json');requiredAcknowledgement=('FINALIZE_SEALED_BASE:'+$Request.vmId+':'+$Request.guestSealSha256+':'+$Request.toolsReplaySha256+':'+$Request.seedIsoSha256)}
}

function Get-CityGoSealedOwnerSid {
    Assert-CityGoSealedValue ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) 'windows_required'
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
    try {
        $principal=[Security.Principal.WindowsPrincipal]::new($identity)
        Assert-CityGoSealedValue ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) 'administrator_required'
        return $identity.User.Value
    } finally { $identity.Dispose() }
}

function Assert-CityGoSealedPlainPath {
    param([string]$Path,[bool]$Directory)
    Assert-CityGoSealedValue ($Path -cmatch '^D:\\CityGo-CI\\' -and $Path.Length -le 1024 -and
        $Path -notmatch '[\x00-\x1f/*?\[\]]' -and -not $Path.Substring(2).Contains(':')) 'local_path_invalid'
    foreach ($part in $Path.Substring(3).Split('\')) {
        Assert-CityGoSealedValue ($part -and $part -notin @('.','..') -and $part -notmatch '[. ]$') 'local_path_invalid'
    }
    Assert-CityGoSealedValue ([IO.Path]::GetFullPath($Path).Equals($Path,[StringComparison]::OrdinalIgnoreCase)) 'local_path_invalid'
    $cursor=$Path.Substring(0,3)
    foreach ($part in @('')+$Path.Substring(3).Split('\')) {
        if ($part) { $cursor=[IO.Path]::Combine($cursor,$part) }
        $item=Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
        Assert-CityGoSealedValue ($item.PSProvider.Name -ceq 'FileSystem' -and
            ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) 'plain_path_required'
        if (-not $cursor.Equals($Path,[StringComparison]::OrdinalIgnoreCase)) {
            Assert-CityGoSealedValue ([bool]$item.PSIsContainer) 'plain_parent_required'
        }
    }
    Assert-CityGoSealedValue ([bool]$item.PSIsContainer -eq $Directory) 'path_type_invalid'
}

function Assert-CityGoSealedPrivateAcl {
    param([string]$Path,[string]$OwnerSid,[bool]$ProtectedDirectory=$false)
    $allowed=@($OwnerSid,'S-1-5-18','S-1-5-32-544')
    $acl=Get-Acl -LiteralPath $Path -ErrorAction Stop
    Assert-CityGoSealedValue ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -in $allowed -and
        (-not $ProtectedDirectory -or $acl.AreAccessRulesProtected)) 'private_owner_or_acl_required'
    foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
        Assert-CityGoSealedValue ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
            $rule.IdentityReference.Value -in $allowed) 'private_acl_required'
    }
}

function Get-CityGoSealedStreamSha {
    param([IO.Stream]$Stream)
    $Stream.Position=0
    $hash=[Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hash.ComputeHash($Stream))).Replace('-','').ToLowerInvariant() }
    finally { $hash.Dispose() }
}

function ConvertFrom-CityGoSealedJson {
    param([string]$Raw)
    Assert-CityGoSealedValue ($Raw.Length -ge 2 -and $Raw.Length -le 65536 -and $Raw.Trim().StartsWith('{') -and
        $Raw.Trim().EndsWith('}') -and $Raw -cnotmatch '[\x00-\x08\x0b\x0c\x0e-\x1f]') 'evidence_json_invalid'
    $syntax=[regex]::Replace($Raw,'"(?:[^"\\]|\\.)*"','""')
    Assert-CityGoSealedValue ($syntax -notmatch '//|/\*|\*/|,\s*[}\]]') 'evidence_json_invalid'
    # Scope duplicate detection per object; the nested replay legitimately uses
    # the same property name in different objects. Escaped property names fail.
    $stack=[Collections.Generic.List[object]]::new()
    foreach ($token in [regex]::Matches($Raw,'"(?:[^"\\]|\\.)*"|[{}\[\]:,]')) {
        $text=$token.Value
        if ($text -ceq '{' -or $text -ceq '[') {
            $stack.Add(@{kind=$text;key=($text -ceq '{');seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)})
        } elseif ($text -ceq '}' -or $text -ceq ']') {
            Assert-CityGoSealedValue ($stack.Count -gt 0 -and (($text -ceq '}' -and $stack[$stack.Count-1].kind -ceq '{') -or
                ($text -ceq ']' -and $stack[$stack.Count-1].kind -ceq '['))) 'evidence_json_invalid'
            $stack.RemoveAt($stack.Count-1)
        } elseif ($stack.Count -gt 0 -and $stack[$stack.Count-1].kind -ceq '{') {
            $frame=$stack[$stack.Count-1]
            if ($text -ceq ',') { $frame.key=$true }
            elseif ($text.StartsWith('"') -and $frame.key) {
                Assert-CityGoSealedValue ($text -cmatch '^"[A-Za-z][A-Za-z0-9]*"$' -and
                    $frame.seen.Add($text.Substring(1,$text.Length-2))) 'evidence_duplicate_or_invalid_key'
                $frame.key=$false
            }
        }
    }
    Assert-CityGoSealedValue ($stack.Count -eq 0) 'evidence_json_invalid'
    $value=ConvertFrom-Json -InputObject $Raw -ErrorAction Stop
    Assert-CityGoSealedValue ($value -is [pscustomobject]) 'evidence_object_required'
    return $value
}

function Open-CityGoSealedReadLock {
    param([string]$Path)
    return [IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
}

function Read-CityGoSealedEvidence {
    param([string]$Path,[string]$Expected,[string]$OwnerSid)
    Assert-CityGoSealedPlainPath $Path $false
    Assert-CityGoSealedPrivateAcl ([IO.Path]::GetDirectoryName($Path)) $OwnerSid $true
    Assert-CityGoSealedPrivateAcl $Path $OwnerSid
    $stream=Open-CityGoSealedReadLock $Path
    try {
        Assert-CityGoSealedValue ($stream.Length -ge 2 -and $stream.Length -le 65536 -and
            (Get-CityGoSealedStreamSha $stream) -ceq $Expected) 'evidence_size_or_hash_mismatch'
        $stream.Position=0
        $reader=[IO.StreamReader]::new($stream,[Text.UTF8Encoding]::new($false,$true),$false,4096,$true)
        try { $raw=$reader.ReadToEnd() } finally { $reader.Dispose() }
        if ($raw.Length -gt 0 -and $raw[0] -eq [char]0xfeff) { $raw=$raw.Substring(1) }
        return [ordered]@{value=(ConvertFrom-CityGoSealedJson $raw);stream=$stream}
    } catch { $stream.Dispose();throw }
}

function Assert-CityGoSealedBoolean {
    param($Value,[bool]$Expected)
    Assert-CityGoSealedValue ($Value -is [bool] -and $Value -eq $Expected) 'evidence_boolean_invalid'
}

function Assert-CityGoSealedGuestProof {
    param($Seal,[Collections.IDictionary]$Plan)
    Assert-CityGoSealedValue (($Seal.version -is [int] -or $Seal.version -is [long]) -and $Seal.version -eq 1 -and
        $Seal.scope -ceq 'trusted_bootstrap_auth_seal' -and $Seal.operationId -ceq $Plan.operationId -and
        $Seal.installerReportSha256 -is [string] -and $Seal.installerReportSha256 -cmatch '^[a-f0-9]{64}$' -and
        $Seal.code -ceq 'guest_auth_sealed_poweroff_required') 'guest_seal_binding_invalid'
    foreach ($field in @('ok','mutationsStarted','preflightPassed','bootstrapAuthorizedKeyAbsent','bootstrapSudoRuleRemovedOtherEntriesPreserved',
        'fixedHostKeysAbsent','persistentCloudArtifactsAbsent','machineIdUninitialized','cloudInitLogsAbsent','installerReportPreserved','volatileRuntimeDataMayRemainUntilPoweroff')) {
        Assert-CityGoSealedBoolean $Seal.$field $true
    }
    foreach ($field in @('vmPoweredOff','seedIsoDetached','guestIsolationVerified','githubJobsAuthorized','goldenImageSealed','freshCloneIdentityVerified')) {
        Assert-CityGoSealedBoolean $Seal.$field $false
    }
    foreach ($field in @('githubRunnerRegistered','ciJobsAdmitted')) {
        if ($null -ne $Seal.$field) { Assert-CityGoSealedBoolean $Seal.$field $false }
    }
}

function Assert-CityGoSealedToolsProof {
    param($Replay)
    Assert-CityGoSealedValue (($Replay.version -is [int] -or $Replay.version -is [long]) -and $Replay.version -eq 1 -and
        $Replay.scope -ceq 'trusted_bootstrap_tools_replay') 'tools_replay_binding_invalid'
    Assert-CityGoSealedBoolean $Replay.allSelectedChecksPassed $true
    foreach ($field in @('guestIsolationVerified','githubJobsAuthorized','goldenImageSealed')) { Assert-CityGoSealedBoolean $Replay.$field $false }
    foreach ($field in @('githubRunnerRegistered','ciJobsAdmitted')) {
        if ($null -ne $Replay.$field) { Assert-CityGoSealedBoolean $Replay.$field $false }
    }
    foreach ($name in @('node','pnpm')) {
        Assert-CityGoSealedBoolean $Replay.versions.$name.matchesExpected $true
        Assert-CityGoSealedValue ($Replay.versions.$name.state -ceq 'observed' -and
            $Replay.versions.$name.observed -ceq $(if ($name -ceq 'node') {'v24.22.0'} else {'10.15.0'})) 'tools_version_mismatch'
    }
    Assert-CityGoSealedBoolean $Replay.versions.python.matchesExpectedMajorMinor $true
    Assert-CityGoSealedValue ($Replay.versions.python.observed -is [string] -and $Replay.versions.python.observed -cmatch '^3\.12\.[0-9]+$') 'tools_version_mismatch'
    foreach ($name in @('compose','buildx')) {
        Assert-CityGoSealedValue ($Replay.$name.state -ceq 'observed' -and $Replay.$name.observedVersion -is [string] -and
            $Replay.$name.observedVersion -cmatch '^[0-9]+(\.[0-9]+){1,3}([-+~][A-Za-z0-9.+~_-]+)?$') 'tools_version_mismatch'
    }
    Assert-CityGoSealedBoolean $Replay.docker.nativeLinuxLayoutMatches $true
    Assert-CityGoSealedValue ($Replay.docker.state -ceq 'observed' -and $Replay.docker.osType -ceq 'linux' -and
        $Replay.docker.socketType -ceq 'unix_socket' -and $Replay.docker.endpoint -ceq 'unix:///var/run/docker.sock' -and
        $Replay.docker.rootDir -ceq '/var/lib/docker') 'native_docker_proof_invalid'
    Assert-CityGoSealedBoolean $Replay.mounts.noForbiddenTypesObserved $true
    Assert-CityGoSealedBoolean $Replay.mounts.provesHostIsolation $false
    Assert-CityGoSealedValue ($Replay.mounts.state -ceq 'observed' -and $null -ne $Replay.mounts.forbiddenTypesObserved -and
        @($Replay.mounts.forbiddenTypesObserved).Count -eq 0) 'mount_proof_invalid'
    Assert-CityGoSealedValue ($Replay.mounts.types -is [array] -and $Replay.mounts.types.Count -ge 1 -and $Replay.mounts.types.Count -le 256 -and
        @($Replay.mounts.types|Where-Object{$_ -isnot [string] -or $_ -cnotmatch '^[A-Za-z0-9._-]{1,40}$' -or
            $_ -cin @('9p','cifs','smb3','virtiofs','vboxsf','fuse.sshfs','nfs','nfs4')}).Count -eq 0) 'mount_proof_invalid'
    foreach ($field in @('ok','dataUriOnly','contextOffline')) { Assert-CityGoSealedBoolean $Replay.chromium.$field $true }
    foreach ($field in @('chromiumSandboxRequested','provesNetworkIsolation')) { Assert-CityGoSealedBoolean $Replay.chromium.$field $false }
    Assert-CityGoSealedValue ($Replay.chromium.code -ceq 'data_uri_smoke_passed' -and
        ($Replay.chromium.externalPageRequests -is [int] -or $Replay.chromium.externalPageRequests -is [long]) -and
        $Replay.chromium.externalPageRequests -eq 0 -and $Replay.chromium.browserVersion -is [string] -and
        $Replay.chromium.browserVersion -cmatch '^[0-9]+(\.[0-9]+){1,3}$') 'browser_replay_invalid'
}

function Assert-CityGoSealedVhd {
    param($Disk)
    Assert-CityGoSealedValue ([string]$Disk.VhdFormat -ceq 'VHDX' -and [string]$Disk.VhdType -cin @('Fixed','Dynamic') -and
        -not $Disk.ParentPath -and $Disk.Attached -is [bool] -and -not $Disk.Attached -and $Disk.Size -eq 96GB -and
        $Disk.FileSize -gt 0) 'standalone_unattached_96gib_vhdx_required'
}

function Assert-CityGoSealedNoOtherDiskReference {
    param([Collections.IDictionary]$Plan)
    # Include parent chains: an AVHDX attached elsewhere can reference this base
    # without its drive's Path being equal to the base path. Unknowns refuse.
    $all=@(Get-VM -ErrorAction Stop)
    Assert-CityGoSealedValue ($all.Count -le 256) 'vm_inventory_bound_exceeded'
    foreach ($vm in $all) {
        foreach ($drive in @(Get-VMHardDiskDrive -VM $vm -ErrorAction Stop)) {
            if (-not $drive.Path) { continue }
            $path=[string]$drive.Path;$depth=0
            while ($path) {
                if ($path.Equals($Plan.basePath,[StringComparison]::OrdinalIgnoreCase)) {
                    Assert-CityGoSealedValue ($vm.Id.ToString('D') -ceq $Plan.vmId -and $depth -eq 0) 'base_referenced_by_another_disk'
                    break
                }
                Assert-CityGoSealedValue ($depth -lt 16) 'disk_parent_inventory_unverified'
                $metadata=Get-VHD -Path $path -ErrorAction Stop
                $path=[string]$metadata.ParentPath;$depth++
            }
        }
    }
}

function Get-CityGoSealedNative {
    param([Collections.IDictionary]$Plan,[bool]$FinalReadback=$false)
    $vms=@(Get-VM -Id ([guid]$Plan.vmId) -ErrorAction Stop)
    Assert-CityGoSealedValue ($vms.Count -eq 1) 'owned_vm_missing'
    $vm=$vms[0]
    Assert-CityGoSealedValue ($vm.Id.ToString('D') -ceq $Plan.vmId -and $vm.Name -ceq $Plan.vmName -and
        [string]$vm.Path -ieq $Plan.vmPath -and [string]$vm.State -ceq 'Off' -and $vm.Generation -eq 2 -and
        $vm.ProcessorCount -eq 4 -and $vm.MemoryStartup -eq 6GB -and $vm.DynamicMemoryEnabled -eq $false -and
        [string]$vm.AutomaticStartAction -ceq 'Nothing' -and [string]$vm.CheckpointType -ceq 'Disabled' -and
        $vm.AutomaticCheckpointsEnabled -eq $false) 'owned_off_vm_required'
    $drives=@(Get-VMHardDiskDrive -VM $vm -ErrorAction Stop)
    Assert-CityGoSealedValue ($drives.Count -eq 1 -and [string]$drives[0].Path -ieq $Plan.basePath -and -not $drives[0].DiskNumber -and
        [string]$drives[0].ControllerType -ceq 'SCSI' -and $drives[0].ControllerNumber -eq 0 -and $drives[0].ControllerLocation -eq 0) 'owned_disk_invalid'
    Assert-CityGoSealedVhd (Get-VHD -Path $Plan.basePath -ErrorAction Stop)
    $firmware=Get-VMFirmware -VM $vm -ErrorAction Stop
    Assert-CityGoSealedValue ([string]$firmware.SecureBoot -ceq 'On' -and [string]$firmware.SecureBootTemplate -ceq 'MicrosoftUEFICertificateAuthority') 'secure_boot_required'
    Assert-CityGoSealedValue (@(Get-VMAssignableDevice -VM $vm -ErrorAction Stop).Count -eq 0) 'assigned_device_refused'
    $nics=@(Get-VMNetworkAdapter -VM $vm -ErrorAction Stop)
    Assert-CityGoSealedValue ($nics.Count -eq 1) 'owned_nic_count_invalid'
    $nic=$nics[0]
    $nicPattern='^Microsoft:'+([regex]::Escape($Plan.vmId))+'\\[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
    Assert-CityGoSealedValue ([string]$nic.Id -imatch $nicPattern -and $nic.VMId.ToString('D') -ceq $Plan.vmId -and
        [guid](([string]$nic.Id).Split('\')[-1]) -ne [guid]::Empty -and
        [string]$nic.MacAddressSpoofing -ceq 'Off' -and [string]$nic.DhcpGuard -ceq 'On' -and [string]$nic.RouterGuard -ceq 'On' -and
        $nic.IovWeight -eq 0 -and $nic.IovQueuePairsAssigned -eq 0 -and $nic.IovUsage -eq 0 -and
        [string]$nic.PortMirroringMode -ceq 'None' -and [string]$nic.AllowTeaming -ceq 'Off') 'owned_nic_invalid'
    $same=@(Get-VMNetworkAdapter -All -ErrorAction Stop|Where-Object{[string]$_.Id -ieq [string]$nic.Id})
    Assert-CityGoSealedValue ($same.Count -eq 1 -and $same[0].VMId.ToString('D') -ceq $Plan.vmId) 'nic_identity_not_unique'
    $disconnected=(-not $nic.SwitchId -or [guid]$nic.SwitchId -eq [guid]::Empty) -and -not $nic.SwitchName
    Assert-CityGoSealedValue ($disconnected -or (-not $FinalReadback -and $nic.SwitchName -ceq 'Default Switch' -and
        $nic.SwitchId -and [guid]$nic.SwitchId -ne [guid]::Empty)) 'owned_nic_switch_unexpected'
    $dvds=@(Get-VMDvdDrive -VM $vm -ErrorAction Stop)
    Assert-CityGoSealedValue ($dvds.Count -eq 1 -and (-not $dvds[0].Path -or (-not $FinalReadback -and
        [string]$dvds[0].Path -ieq $Plan.seedPath))) 'seed_dvd_unexpected'
    Assert-CityGoSealedNoOtherDiskReference $Plan
    return [ordered]@{vm=$vm;nic=$nic;dvd=$dvds[0];disconnected=[bool]$disconnected}
}

function Write-CityGoSealedReceipt {
    param([Collections.IDictionary]$Plan,[Collections.IDictionary]$Receipt,[string]$OwnerSid)
    Assert-CityGoSealedPlainPath $Plan.controlDirectory $true
    Assert-CityGoSealedPrivateAcl $Plan.controlDirectory $OwnerSid $true
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Receipt|ConvertTo-Json -Depth 3 -Compress))
    $file=[IO.File]::Open($Plan.receiptPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try { $file.Write($bytes,0,$bytes.Length);$file.Flush($true) } finally { $file.Dispose() }
    Assert-CityGoSealedPrivateAcl $Plan.receiptPath $OwnerSid
}

function Wait-CityGoSealedNativeReadback {
    param([Collections.IDictionary]$Plan)
    # Hyper-V may briefly return the original exact DVD/switch after a native
    # update. Only refresh reads are repeated: never repeat either write and
    # never tolerate foreign media, changed identity/state or extra devices.
    for ($attempt=0;$attempt -lt 10;$attempt++) {
        $observed=Get-CityGoSealedNative $Plan
        if (-not $observed.dvd.Path -and $observed.disconnected) {
            return (Get-CityGoSealedNative $Plan $true)
        }
        if ($attempt -lt 9) { Start-Sleep -Milliseconds 250 }
    }
    throw 'native_final_readback_not_settled'
}

function Invoke-CityGoSealedFinalization {
    param([Collections.IDictionary]$Request,[DateTimeOffset]$Now=[DateTimeOffset]::UtcNow)
    $plan=Get-CityGoSealedPlan $Request
    $result=[ordered]@{schemaVersion=1;scope='trusted_bootstrap_base_finalization';operationId=$plan.operationId;vmId=$plan.vmId;
        stage='plan_only_unverified';seedDetached=$false;nicDisconnected=$false;currentBaseSha256=$null;
        receiptWritten=$false;vmStarted=$false;guestIsolationVerified=$false;githubRunnerRegistered=$false;ciJobsAdmitted=$false}
    if (-not $Request.apply) { $result.plan=$plan;return $result }
    Assert-CityGoSealedValue ($Request.acknowledge -ceq $plan.requiredAcknowledgement) 'typed_acknowledgement_required'
    $owner=Get-CityGoSealedOwnerSid
    $held=@();$disk=$null;$iso=$null
    try {
        Assert-CityGoSealedPlainPath $plan.controlDirectory $true
        Assert-CityGoSealedPrivateAcl $plan.controlDirectory $owner $true
        Assert-CityGoSealedValue (-not (Test-Path -LiteralPath $plan.receiptPath -ErrorAction Stop)) 'sealed_receipt_already_exists'
        $seal=Read-CityGoSealedEvidence $plan.guestSealPath $plan.guestSealSha256 $owner;$held+=,$seal
        $replay=Read-CityGoSealedEvidence $plan.toolsReplayPath $plan.toolsReplaySha256 $owner;$held+=,$replay
        Assert-CityGoSealedGuestProof $seal.value $plan
        Assert-CityGoSealedToolsProof $replay.value
        $native=Get-CityGoSealedNative $plan
        Assert-CityGoSealedPlainPath $plan.seedPath $false
        $iso=Open-CityGoSealedReadLock $plan.seedPath
        # Opaque hashing only: do not parse, extract or output seed contents.
        Assert-CityGoSealedValue ($iso.Length -gt 0 -and $iso.Length -le 32MB -and
            (Get-CityGoSealedStreamSha $iso) -ceq $plan.seedIsoSha256) 'seed_iso_hash_mismatch'
        Assert-CityGoSealedPlainPath $plan.basePath $false
        $disk=Open-CityGoSealedReadLock $plan.basePath
        $metadata=Get-VHD -Path $plan.basePath -ErrorAction Stop
        Assert-CityGoSealedVhd $metadata
        Assert-CityGoSealedValue ($disk.Length -eq $metadata.FileSize) 'base_file_size_mismatch'
        # Refresh all ownership/Off checks under read locks before either write.
        $native=Get-CityGoSealedNative $plan
        if ($native.dvd.Path) { $null=Set-VMDvdDrive -VMDvdDrive $native.dvd -Path $null -ErrorAction Stop }
        $native=Get-CityGoSealedNative $plan
        if (-not $native.disconnected) { $null=Disconnect-VMNetworkAdapter -VMNetworkAdapter $native.nic -ErrorAction Stop }
        $native=Wait-CityGoSealedNativeReadback $plan
        $result.seedDetached=$true;$result.nicDisconnected=$true
        # This is the CURRENT stopped post-seal disk, never a historical SHA.
        $current=Get-CityGoSealedStreamSha $disk
        Assert-CityGoSealedValue ($current -cmatch '^[a-f0-9]{64}$') 'base_hash_invalid'
        $null=Get-CityGoSealedNative $plan $true
        $receipt=[ordered]@{schemaVersion=1;scope='sealed_base_for_local_canary_only';observedAt=$Now.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffffffZ');
            basePath=$plan.basePath;baseSha256=$current;diskSizeBytes=96GB;bootstrapAccessRemoved=$true;seedDetached=$true;
            cloudInitCacheRemoved=$true;sshHostKeysRemoved=$true;toolsReplayed=$true;sourceVmState='Off';githubRunnerRegistered=$false;
            checkoutPresent=$false;sharedHostMountsPresent=$false;guestIsolationVerified=$false;ciJobsAdmitted=$false}
        Write-CityGoSealedReceipt $plan $receipt $owner
        $result.currentBaseSha256=$current;$result.receiptWritten=$true;$result.stage='sealed_off_disconnected_clone_validation_pending'
        return $result
    } catch {
        $result.stage='failed_preserved_state_unverified'
        $result.errorCode='finalization_failed'
        if ($_.Exception.Message -cmatch '^[a-z0-9_]{1,80}$') { $result.errorCode=$_.Exception.Message }
        return $result
    } finally {
        if ($disk) { $disk.Dispose() };if ($iso) { $iso.Dispose() }
        foreach ($item in $held) { if ($item.stream) { $item.stream.Dispose() } }
    }
}

try {
    $result=Invoke-CityGoSealedFinalization ([ordered]@{operationId=$OperationId;vmId=$VmId;guestSealPath=$GuestSealPath;
        guestSealSha256=$ExpectedGuestSealSha256;toolsReplayPath=$ToolsReplayPath;toolsReplaySha256=$ExpectedToolsReplaySha256;
        seedIsoSha256=$ExpectedSeedIsoSha256;apply=[bool]$Apply;acknowledge=$Acknowledge})
    $result|ConvertTo-Json -Depth 6 -Compress
    if ($result.stage -like 'failed_*') { exit 1 }
} catch {
    $code='finalization_preconditions_not_met'
    if ($_.Exception.Message -cmatch '^[a-z0-9_]{1,80}$') { $code=$_.Exception.Message }
    [ordered]@{schemaVersion=1;scope='trusted_bootstrap_base_finalization';stage='preconditions_not_met';errorCode=$code;
        guestIsolationVerified=$false;githubRunnerRegistered=$false;ciJobsAdmitted=$false}|ConvertTo-Json -Compress
    exit 2
}
