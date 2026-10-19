# Stages ONE stopped bootstrap VM. Never boots, networks or registers a runner.
# Default is an offline plan. Apply must run in a trusted elevated host context.
[CmdletBinding()]
param(
    [string]$BaseVhdxPath = '',
    [string]$ExpectedBaseSha256 = '',
    [string]$PreflightPath = '',
    [string]$ExpectedPreflightSha256 = '',
    [string]$OperationId = '',
    [switch]$Apply,
    [string]$Acknowledge = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
$VerbosePreference = 'SilentlyContinue'
$DebugPreference = 'SilentlyContinue'

function Get-CityGoLocalAbsolutePath {
    param([string]$Path)
    if ($Path -notmatch '^[A-Za-z]:\\' -or $Path.Length -gt 1024 -or
        $Path -match '[\x00-\x1f/*?\[\]]' -or $Path.Substring(2).Contains(':')) { throw 'path-invalid' }
    foreach ($part in $Path.Substring(3).Split('\')) {
        if (-not $part -or $part -in @('.', '..') -or $part -match '[. ]$') { throw 'path-invalid' }
    }
    $full = [IO.Path]::GetFullPath($Path)
    if (-not $full.Equals($Path, [StringComparison]::OrdinalIgnoreCase)) { throw 'path-not-canonical' }
    return $full
}

function Get-CityGoBootstrapPlan {
    param([System.Collections.IDictionary]$Request)
    if ($Request.operationId -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' -or
        [Guid]$Request.operationId -eq [Guid]::Empty) { throw 'operation-invalid' }
    foreach ($hash in @($Request.baseSha256, $Request.preflightSha256)) {
        if ($hash -cnotmatch '^[0-9a-f]{64}$') { throw 'expected-hash-required' }
    }
    $base = Get-CityGoLocalAbsolutePath $Request.basePath
    if ($base -notmatch '^D:\\CityGo-CI\\(?:images|base)\\.+\.vhdx$') { throw 'base-outside-approved-roots' }
    $preflight = Get-CityGoLocalAbsolutePath $Request.preflightPath
    $target = 'D:\CityGo-CI\bootstrap\' + $Request.operationId
    $control = 'D:\CityGo-CI\control\' + $Request.operationId
    if (-not [IO.Path]::GetDirectoryName($preflight).Equals($control, [StringComparison]::OrdinalIgnoreCase)) { throw 'preflight-must-be-control-sibling' }
    return [ordered]@{
        operationId = $Request.operationId
        vmName = 'citygo-ci-base-' + $Request.operationId
        basePath = $base
        baseSha256 = $Request.baseSha256
        preflightPath = $preflight
        preflightSha256 = $Request.preflightSha256
        targetDirectory = $target
        targetVhdx = $target + '\bootstrap.vhdx'
        controlDirectory = $control
        receiptPath = $control + '\bootstrap-receipt.json'
        requiredAcknowledgement = 'CREATE_OFFLINE_BOOTSTRAP_VM:' + $Request.operationId + ':' + $Request.baseSha256
    }
}

function Assert-CityGoPlainExistingPath {
    param([string]$Path, [bool]$Directory)
    $null = Get-CityGoLocalAbsolutePath $Path
    $cursor = $Path.Substring(0, 3)
    $root = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
    if (($root.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $root.PSProvider.Name -ne 'FileSystem' -or -not $root.PSIsContainer) { throw 'root-path-unverified' }
    foreach ($part in $Path.Substring(3).Split('\')) {
        $cursor = [IO.Path]::Combine($cursor, $part)
        $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.PSProvider.Name -ne 'FileSystem') { throw 'reparse-or-provider-refused' }
        if (-not $cursor.Equals($Path, [StringComparison]::OrdinalIgnoreCase) -and -not $item.PSIsContainer) { throw 'ancestor-not-directory' }
    }
    if ([bool]$item.PSIsContainer -ne $Directory) { throw 'wrong-path-kind' }
}

function Get-CityGoBootstrapIdentity {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'windows-required' }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    try {
        $principal = [Security.Principal.WindowsPrincipal]::new($identity)
        if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'administrator-required' }
        return $identity.User.Value
    } finally { $identity.Dispose() }
}

function Assert-CityGoPrivateAcl {
    param([string]$Path, [string]$OwnerSid)
    $allowed = @($OwnerSid, 'S-1-5-18', 'S-1-5-32-544')
    $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $allowed) { throw 'private-owner-required' }
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and $rule.IdentityReference.Value -notin $allowed) { throw 'private-acl-required' }
    }
}

function Set-CityGoPrivateDirectoryAcl {
    param([string]$Path, [string]$OwnerSid)
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $owner = [Security.Principal.SecurityIdentifier]::new($OwnerSid)
    $acl.SetOwner($owner)
    foreach ($sid in @($OwnerSid, 'S-1-5-18', 'S-1-5-32-544')) {
        $rule = [Security.AccessControl.FileSystemAccessRule]::new(
            [Security.Principal.SecurityIdentifier]::new($sid),
            [Security.AccessControl.FileSystemRights]::FullControl,
            ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),
            [Security.AccessControl.PropagationFlags]::None,
            [Security.AccessControl.AccessControlType]::Allow)
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $acl -ErrorAction Stop
    Assert-CityGoPrivateAcl $Path $OwnerSid
}

function Get-CityGoStreamSha256 {
    param([IO.Stream]$Stream)
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hash.ComputeHash($Stream))).Replace('-', '').ToLowerInvariant() }
    finally { $hash.Dispose() }
}

function Assert-CityGoBootstrapPreflight {
    param([System.Collections.IDictionary]$Plan, [string]$OwnerSid, [DateTimeOffset]$Now = [DateTimeOffset]::UtcNow)
    Assert-CityGoPlainExistingPath $Plan.preflightPath $false
    Assert-CityGoPrivateAcl $Plan.preflightPath $OwnerSid
    $stream = [IO.File]::Open($Plan.preflightPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        if ($stream.Length -lt 2 -or $stream.Length -gt 1048576) { throw 'preflight-size-invalid' }
        if ((Get-CityGoStreamSha256 $stream) -cne $Plan.preflightSha256) { throw 'preflight-hash-mismatch' }
        $stream.Position = 0
        $reader = [IO.StreamReader]::new($stream, [Text.UTF8Encoding]::new($false, $true), $true, 4096, $true)
        try { $report = $reader.ReadToEnd() | ConvertFrom-Json -ErrorAction Stop } finally { $reader.Dispose() }
    } finally { $stream.Dispose() }
    Assert-CityGoBootstrapPreflightContent $report $Now
}

function Assert-CityGoBootstrapPreflightContent {
    param($Report, [DateTimeOffset]$Now)
    if ($Report.version -ne 2 -or $Report.scope -cne 'elevated_read_only_host_inventory' -or
        $Report.status -cne 'observed-not-approved' -or $null -ne $Report.errorCode -or
        $Report.vmCreated -ne $false -or $Report.networkChanged -ne $false -or
        $Report.servicesChanged -ne $false -or $Report.runnerRegistered -ne $false) { throw 'preflight-envelope-invalid' }
    foreach ($field in @('vmCreated', 'networkChanged', 'servicesChanged', 'runnerRegistered')) {
        if ($Report.$field -isnot [bool]) { throw 'preflight-boolean-invalid' }
    }
    if ($Report.observedAt -isnot [string] -or $Report.observedAt -notmatch 'Z$') { throw 'preflight-time-invalid' }
    $at = [DateTimeOffset]::Parse($Report.observedAt, [Globalization.CultureInfo]::InvariantCulture)
    $age = ($Now - $at).TotalSeconds
    if ($age -lt 0 -or $age -gt 900) { throw 'preflight-expired' }
    $d = $Report.diagnostic
    foreach ($value in @($d.readyForVmProvisioning, $d.inventory.administrator, $d.guestIsolationVerified,
        $d.githubRunnerRegistered, $Report.management.inventoryReadSucceeded, $Report.management.guestIsolationVerified)) {
        if ($value -isnot [bool]) { throw 'preflight-boolean-invalid' }
    }
    if ($d.schemaVersion -ne 1 -or $d.scope -cne 'host_readiness_only' -or $d.readyForVmProvisioning -ne $true -or
        $null -eq $d.blockers -or @($d.blockers).Count -ne 0 -or $d.inventory.administrator -ne $true -or
        $d.inventory.hypervFeature -cne 'Enabled' -or $d.inventory.vmmsState -cne 'Running' -or
        $d.configuredResources.guestVcpu -lt 4 -or $d.configuredResources.guestMemoryGiB -lt 6 -or
        $d.guestIsolationVerified -ne $false -or $d.githubRunnerRegistered -ne $false -or
        $Report.management.inventoryReadSucceeded -ne $true -or $Report.management.guestIsolationVerified -ne $false) { throw 'preflight-readiness-invalid' }
}

function Assert-CityGoBootstrapDestinationsAbsent {
    param([System.Collections.IDictionary]$Plan)
    Assert-CityGoPlainExistingPath 'D:\CityGo-CI\bootstrap' $true
    if (Test-Path -LiteralPath $Plan.targetDirectory -ErrorAction Stop) { throw 'destination-exists' }
    # Enumerate only: a missing name is not confused with an inventory access error.
    foreach ($existing in @(Get-VM -ErrorAction Stop)) {
        if ([string]$existing.Name -ieq $Plan.vmName) { throw 'vm-name-exists' }
    }
}

function Assert-CityGoBootstrapControl {
    param([System.Collections.IDictionary]$Plan, [string]$OwnerSid)
    # Created privately by the trusted host wrapper, never by a guest or Hyper-V.
    # Do not place receipts beneath VM configuration folders: Hyper-V can add its
    # service/capability ACL entries there as part of normal VM registration.
    Assert-CityGoPlainExistingPath $Plan.controlDirectory $true
    Assert-CityGoPrivateAcl $Plan.controlDirectory $OwnerSid
    $acl = Get-Acl -LiteralPath $Plan.controlDirectory -ErrorAction Stop
    if ($acl.AreAccessRulesProtected -ne $true) { throw 'control-protected-acl-required' }
    if (Test-Path -LiteralPath $Plan.receiptPath -ErrorAction Stop) { throw 'control-receipt-exists' }
}

function Assert-CityGoPlainVhdx {
    param($Disk)
    if ([string]$Disk.VhdFormat -cne 'VHDX' -or [string]$Disk.VhdType -notin @('Fixed', 'Dynamic') -or
        $Disk.ParentPath -or $Disk.Attached -ne $false -or $Disk.Size -ne 96GB -or $Disk.FileSize -le 0) { throw 'standalone-unattached-96gib-vhdx-required' }
}

function Copy-CityGoVerifiedBootstrapDisk {
    param([IO.Stream]$Source, [System.Collections.IDictionary]$Plan)
    # CreateNew cannot overwrite a pre-existing file. Source remains locked against
    # write/delete from initial hash verification through the completed copy.
    $copy = [IO.File]::Open($Plan.targetVhdx, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try {
        $Source.Position = 0
        $Source.CopyTo($copy)
        $copy.Flush($true)
        $copy.Position = 0
        if ((Get-CityGoStreamSha256 $copy) -cne $Plan.baseSha256) { throw 'copied-vhdx-hash-mismatch' }
    } finally { $copy.Dispose() }
}

function Open-CityGoBootstrapSource {
    param([string]$Path)
    return [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
}

function Assert-CityGoStoppedBootstrapVm {
    param($Vm, [System.Collections.IDictionary]$Plan)
    $actual = Get-VM -Id $Vm.Id -ErrorAction Stop
    if ([string]$actual.Name -cne $Plan.vmName -or [string]$actual.State -cne 'Off' -or $actual.Generation -ne 2 -or
        $actual.ProcessorCount -ne 4 -or $actual.MemoryStartup -ne 6GB -or $actual.DynamicMemoryEnabled -ne $false -or
        [string]$actual.AutomaticStartAction -cne 'Nothing' -or [string]$actual.CheckpointType -cne 'Disabled' -or
        $actual.AutomaticCheckpointsEnabled -ne $false) { throw 'vm-state-unverified' }
    $disks = @(Get-VMHardDiskDrive -VM $actual -ErrorAction Stop)
    if ($disks.Count -ne 1 -or [string]$disks[0].Path -ine $Plan.targetVhdx -or $disks[0].DiskNumber) { throw 'vm-disk-unverified' }
    $adapters = @(Get-VMNetworkAdapter -VM $actual -ErrorAction Stop)
    if ($adapters.Count -ne 1) { throw 'vm-network-unverified' }
    if (($adapters[0].SwitchId -and [Guid]$adapters[0].SwitchId -ne [Guid]::Empty) -or
        $adapters[0].SwitchName -or [string]$adapters[0].MacAddressSpoofing -cne 'Off' -or
        [string]$adapters[0].DhcpGuard -cne 'On' -or [string]$adapters[0].RouterGuard -cne 'On') { throw 'vm-network-unverified' }
    $firmware = Get-VMFirmware -VM $actual -ErrorAction Stop
    if ([string]$firmware.SecureBoot -cne 'On' -or [string]$firmware.SecureBootTemplate -cne 'MicrosoftUEFICertificateAuthority') { throw 'vm-firmware-unverified' }
    return $actual
}

function Write-CityGoBootstrapReceipt {
    param([System.Collections.IDictionary]$Plan, [System.Collections.IDictionary]$Receipt, [string]$OwnerSid)
    Assert-CityGoBootstrapControl $Plan $OwnerSid
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Receipt | ConvertTo-Json -Depth 4 -Compress))
    $file = [IO.File]::Open($Plan.receiptPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $file.Write($bytes, 0, $bytes.Length); $file.Flush($true) } finally { $file.Dispose() }
    Assert-CityGoPrivateAcl $Plan.receiptPath $OwnerSid
}

function Invoke-CityGoBootstrapVm {
    param([System.Collections.IDictionary]$Request)
    $plan = Get-CityGoBootstrapPlan $Request
    $receipt = [ordered]@{
        schemaVersion = 1; scope = 'stopped_bootstrap_vm_only'; operationId = $plan.operationId
        vmName = $plan.vmName; vmId = $null; baseSha256 = $plan.baseSha256
        stage = 'plan_only_unverified'; guestIsolationVerified = $false; githubRunnerRegistered = $false
    }
    if (-not $Request.apply) { return $receipt }
    if ($Request.acknowledge -cne $plan.requiredAcknowledgement) { throw 'typed-acknowledgement-required' }
    $ownerSid = Get-CityGoBootstrapIdentity
    Assert-CityGoBootstrapControl $plan $ownerSid
    Assert-CityGoBootstrapPreflight $plan $ownerSid
    Assert-CityGoPlainExistingPath $plan.basePath $false
    Assert-CityGoPrivateAcl 'D:\CityGo-CI\bootstrap' $ownerSid
    Assert-CityGoBootstrapDestinationsAbsent $plan
    $source = Open-CityGoBootstrapSource $plan.basePath
    $failureStage = 'verify_base'
    try {
        if ((Get-CityGoStreamSha256 $source) -cne $plan.baseSha256) { throw 'base-vhdx-hash-mismatch' }
        Assert-CityGoPlainVhdx (Get-VHD -Path $plan.basePath -ErrorAction Stop)
        # Recheck fresh evidence and namespace immediately before the first write.
        Assert-CityGoBootstrapPreflight $plan $ownerSid
        Assert-CityGoBootstrapControl $plan $ownerSid
        Assert-CityGoBootstrapDestinationsAbsent $plan
        $failureStage = 'create_owned_directory'
        $null = New-Item -Path $plan.targetDirectory -ItemType Directory -ErrorAction Stop
        $failureStage = 'protect_owned_directory'
        Set-CityGoPrivateDirectoryAcl $plan.targetDirectory $ownerSid
        $failureStage = 'copy_verified_disk'
        Copy-CityGoVerifiedBootstrapDisk $source $plan
        Assert-CityGoPlainVhdx (Get-VHD -Path $plan.targetVhdx -ErrorAction Stop)
        $failureStage = 'create_vm'
        $vm = New-VM -Name $plan.vmName -Generation 2 -MemoryStartupBytes 6GB -VHDPath $plan.targetVhdx -Path $plan.targetDirectory -ErrorAction Stop
        $receipt.vmId = $vm.Id.ToString()
        $failureStage = 'set_boot_policy'
        $null = Set-VM -VM $vm -AutomaticStartAction Nothing -AutomaticCheckpointsEnabled $false -CheckpointType Disabled -ErrorAction Stop
        $failureStage = 'set_cpu'
        $null = Set-VMProcessor -VM $vm -Count 4 -ErrorAction Stop
        $failureStage = 'set_static_memory'
        $null = Set-VMMemory -VM $vm -DynamicMemoryEnabled $false -StartupBytes 6GB -ErrorAction Stop
        $failureStage = 'set_secure_boot'
        $null = Set-VMFirmware -VM $vm -EnableSecureBoot On -SecureBootTemplate MicrosoftUEFICertificateAuthority -ErrorAction Stop
        $failureStage = 'inspect_disconnected_nic'
        $adapters = @(Get-VMNetworkAdapter -VM $vm -ErrorAction Stop)
        if ($adapters.Count -ne 1 -or $adapters[0].SwitchName) { throw 'new-vm-network-unexpected' }
        $failureStage = 'protect_disconnected_nic'
        $null = Set-VMNetworkAdapter -VMNetworkAdapter $adapters[0] -MacAddressSpoofing Off -DhcpGuard On -RouterGuard On -ErrorAction Stop
        $failureStage = 'verify_stopped_vm'
        $null = Assert-CityGoStoppedBootstrapVm $vm $plan
        $receipt.stage = 'staged_verified_off_no_network'
        $failureStage = 'persist_receipt'
        Write-CityGoBootstrapReceipt $plan $receipt $ownerSid
        return $receipt
    } catch {
        # Never delete, stop, adopt or repair any VM/directory on failure. Preserve
        # exact owned resources for human inspection; do not echo exception details.
        $receipt.stage = 'failed_preserved_state_unverified'
        # The stage is a code constant, never an exception message or input. A
        # command can fail after creating a resource but before returning its ID.
        $receipt.failureStage = $failureStage
        $receipt.failureCode = 'bootstrap_stage_failed'
        try { Write-CityGoBootstrapReceipt $plan $receipt $ownerSid } catch { $receipt.stage = 'failed_preserved_receipt_unavailable' }
        return $receipt
    } finally { $source.Dispose() }
}

try {
    if (-not $OperationId) { $OperationId = [Guid]::NewGuid().ToString() }
    $result = Invoke-CityGoBootstrapVm ([ordered]@{
        basePath = $BaseVhdxPath; baseSha256 = $ExpectedBaseSha256
        preflightPath = $PreflightPath; preflightSha256 = $ExpectedPreflightSha256
        operationId = $OperationId; apply = [bool]$Apply; acknowledge = $Acknowledge
    })
    $result | ConvertTo-Json -Depth 4 -Compress
    if ($result.stage -like 'failed_*') { exit 1 }
} catch {
    # Preconditions fail closed without printing paths, raw reports or inputs.
    [ordered]@{ schemaVersion = 1; scope = 'stopped_bootstrap_vm_only'; stage = 'preconditions_not_met'; guestIsolationVerified = $false; githubRunnerRegistered = $false } | ConvertTo-Json -Compress
    exit 2
}
