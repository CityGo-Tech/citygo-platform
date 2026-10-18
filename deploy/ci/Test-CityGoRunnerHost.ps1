# Read-only inventory. No elevation, feature changes, VM creation or network I/O.
[CmdletBinding()]
param(
    [int]$GuestVcpu = 4,
    [int]$GuestMemoryGiB = 8,
    [int]$GuestDiskGiB = 96,
    [int]$HostMemoryReserveGiB = 8,
    [int]$DiskHeadroomGiB = 32
)

$ErrorActionPreference = 'Stop'
$WarningPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
$VerbosePreference = 'SilentlyContinue'
$DebugPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'

function Get-CityGoHostInventory {
    $observed = [ordered]@{
        windows = [System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT
        osVersion = $null
        osBuild = $null
        editionCode = $null
        os64Bit = [System.Environment]::Is64BitOperatingSystem
        totalMemoryBytes = $null
        freeMemoryBytes = $null
        logicalProcessors = $null
        dataVolumeFreeBytes = $null
        systemVolumeFreeBytes = $null
        administrator = $null
        hypervisorPresent = $null
        hypervFeature = 'Unknown'
        vmmsState = 'Unknown'
        hypervModuleAvailable = $null
        hypervCmdletsAvailable = $null
    }
    if (-not $observed.windows) { return $observed }

    try {
        $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
        try {
            $principal = [System.Security.Principal.WindowsPrincipal]::new($identity)
            $observed.administrator = $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
        } finally { $identity.Dispose() }
    } catch { }
    try {
        $os = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop
        if ([string]$os.Version -match '^\d+\.\d+\.\d+(?:\.\d+)?$') { $observed.osVersion = [string]$os.Version }
        if ([string]$os.BuildNumber -match '^\d+$') { $observed.osBuild = [int]$os.BuildNumber }
        if ($null -ne $os.OperatingSystemSKU) { $observed.editionCode = [int]$os.OperatingSystemSKU }
        if ($null -ne $os.FreePhysicalMemory) { $observed.freeMemoryBytes = [long]$os.FreePhysicalMemory * 1024L }
    } catch { }
    try {
        $computer = Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction Stop
        if ($null -ne $computer.TotalPhysicalMemory) { $observed.totalMemoryBytes = [long]$computer.TotalPhysicalMemory }
        if ($null -ne $computer.NumberOfLogicalProcessors) { $observed.logicalProcessors = [int]$computer.NumberOfLogicalProcessors }
        if ($null -ne $computer.HypervisorPresent) { $observed.hypervisorPresent = [bool]$computer.HypervisorPresent }
    } catch { }
    foreach ($volume in @(@{ id = 'D:'; field = 'dataVolumeFreeBytes' }, @{ id = 'C:'; field = 'systemVolumeFreeBytes' })) {
        try {
            $disk = Get-CimInstance -ClassName Win32_LogicalDisk -Filter ("DeviceID='{0}' and DriveType=3" -f $volume.id) -ErrorAction Stop
            if ($null -ne $disk.FreeSpace) { $observed[$volume.field] = [long]$disk.FreeSpace }
        } catch { }
    }
    if ($observed.administrator -eq $true) {
        try {
            $feature = Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All -ErrorAction Stop
            $state = [string]$feature.State
            if ($state -in @('Enabled', 'Disabled', 'EnablePending', 'DisablePending', 'DisabledWithPayloadRemoved')) { $observed.hypervFeature = $state }
        } catch { }
    }
    try {
        $service = Get-Service -Name vmms -ErrorAction Stop
        $state = [string]$service.Status
        if ($state -in @('Running', 'Stopped', 'StartPending', 'StopPending', 'Paused', 'ContinuePending', 'PausePending')) { $observed.vmmsState = $state }
    } catch { }
    try {
        $modules = @(Get-Module -ListAvailable -Name Hyper-V -ErrorAction Stop)
        $observed.hypervModuleAvailable = $modules.Count -gt 0
    } catch { }
    try {
        $available = $true
        foreach ($name in @('Get-VM', 'New-VM', 'Set-VM', 'Get-VMSwitch', 'Start-VM')) {
            $commands = @(Get-Command -Name $name -Module Hyper-V -CommandType Cmdlet -ErrorAction SilentlyContinue)
            if ($commands.Count -eq 0) { $available = $false }
        }
        $observed.hypervCmdletsAvailable = $available
    } catch { }
    return $observed
}

function Get-CityGoHostReadiness {
    param([System.Collections.IDictionary]$Inventory, [System.Collections.IDictionary]$Profile)
    $blockers = [System.Collections.Generic.List[string]]::new()
    $validProfile = $Profile.guestVcpu -ge 1 -and $Profile.guestVcpu -le 64 -and
        $Profile.guestMemoryGiB -ge 2 -and $Profile.guestMemoryGiB -le 128 -and
        $Profile.guestDiskGiB -ge 32 -and $Profile.guestDiskGiB -le 1024 -and
        $Profile.hostMemoryReserveGiB -ge 4 -and $Profile.hostMemoryReserveGiB -le 128 -and
        $Profile.diskHeadroomGiB -ge 8 -and $Profile.diskHeadroomGiB -le 256
    if (-not $validProfile) { $blockers.Add('resource_profile_invalid') }
    if ($Inventory.windows -ne $true) { $blockers.Add('windows_host_required') }
    if ($null -eq $Inventory.osVersion -or $null -eq $Inventory.osBuild -or $null -eq $Inventory.editionCode) { $blockers.Add('os_inventory_unverified') }
    if ($Inventory.os64Bit -ne $true) { $blockers.Add('64_bit_os_required') }
    if ($Inventory.administrator -ne $true) { $blockers.Add('admin_inventory_required') }
    if ($Inventory.hypervFeature -ne 'Enabled') { $blockers.Add('hyperv_not_enabled_or_unverified') }
    if ($Inventory.hypervFeature -in @('EnablePending', 'DisablePending') -or $Inventory.vmmsState -ne 'Running') { $blockers.Add('reboot_or_service_unready') }
    if ($Inventory.hypervModuleAvailable -ne $true) { $blockers.Add('hyperv_module_missing_or_unverified') }
    if ($Inventory.hypervCmdletsAvailable -ne $true) { $blockers.Add('hyperv_cmdlets_missing_or_unverified') }
    if ($Inventory.hypervisorPresent -ne $true) { $blockers.Add('hypervisor_not_running_or_unverified') }
    if ($null -eq $Inventory.logicalProcessors -or $Inventory.logicalProcessors -lt 1) { $blockers.Add('cpu_inventory_unverified') }
    elseif ($validProfile -and $Inventory.logicalProcessors -lt $Profile.guestVcpu) { $blockers.Add('insufficient_logical_processors') }
    if ($null -eq $Inventory.totalMemoryBytes -or $null -eq $Inventory.freeMemoryBytes -or $Inventory.totalMemoryBytes -le 0 -or $Inventory.freeMemoryBytes -lt 0) { $blockers.Add('memory_inventory_unverified') }
    elseif ($validProfile -and $Inventory.freeMemoryBytes -lt ([long]$Profile.guestMemoryGiB + $Profile.hostMemoryReserveGiB) * 1GB) { $blockers.Add('insufficient_free_memory_with_host_reserve') }
    if ($null -eq $Inventory.dataVolumeFreeBytes -or $Inventory.dataVolumeFreeBytes -lt 0) { $blockers.Add('data_volume_inventory_unverified') }
    elseif ($validProfile -and $Inventory.dataVolumeFreeBytes -lt ([long]$Profile.guestDiskGiB + $Profile.diskHeadroomGiB) * 1GB) { $blockers.Add('insufficient_data_volume_space') }
    if ($null -eq $Inventory.systemVolumeFreeBytes -or $Inventory.systemVolumeFreeBytes -lt 0) { $blockers.Add('system_volume_inventory_unverified') }

    return [ordered]@{
        schemaVersion = 1
        scope = 'host_readiness_only'
        configuredResources = $Profile
        resourceProfileStatus = 'engineering_starting_profile_not_user_approval'
        inventory = $Inventory
        readyForVmProvisioning = $blockers.Count -eq 0
        blockers = @($blockers.ToArray())
        guestIsolationVerified = $false
        githubRunnerRegistered = $false
        githubJobsAuthorized = $false
        changedHostConfiguration = $false
    }
}

$profile = [ordered]@{
    guestVcpu = $GuestVcpu
    guestMemoryGiB = $GuestMemoryGiB
    guestDiskGiB = $GuestDiskGiB
    hostMemoryReserveGiB = $HostMemoryReserveGiB
    diskHeadroomGiB = $DiskHeadroomGiB
    dataVolume = 'D'
}
$inventory = Get-CityGoHostInventory
$result = Get-CityGoHostReadiness -Inventory $inventory -Profile $profile
$result | ConvertTo-Json -Depth 6 -Compress
