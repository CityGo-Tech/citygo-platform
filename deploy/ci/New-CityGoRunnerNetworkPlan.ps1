# Pure offline proposal. Does NOT query or change Hyper-V, NAT, firewall or VMs.
# The caller must provide a private, independently captured inventory and raw SHA.
# Public HTTP(S) permits DoH/proxies: this is direct-IP filtering, not an egress
# proxy/SNI policy or a guarantee against indirect access to production.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$InventoryPath,
    [Parameter(Mandatory=$true)][string]$ExpectedInventorySha256
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Assert-CityGoNetworkValue {
    param([bool]$Condition, [string]$Code)
    if (-not $Condition) { throw $Code }
}

function ConvertTo-CityGoIPv4 {
    param($Address)
    Assert-CityGoNetworkValue ($Address -is [string] -and $Address -cmatch '^(0|[1-9][0-9]{0,2})(\.(0|[1-9][0-9]{0,2})){3}$') 'ipv4_not_canonical'
    $number = [uint64]0
    foreach ($part in $Address.Split('.')) {
        $octet = [int]$part
        Assert-CityGoNetworkValue ($octet -le 255) 'ipv4_not_canonical'
        $number = $number * 256 + $octet
    }
    return [uint64]$number
}

function ConvertTo-CityGoIPv4Text {
    param([uint64]$Number)
    return (@((($Number -shr 24) -band 255), (($Number -shr 16) -band 255), (($Number -shr 8) -band 255), ($Number -band 255)) -join '.')
}

function Get-CityGoIPv4Range {
    param($Cidr, [bool]$RequireNetwork = $true)
    Assert-CityGoNetworkValue ($Cidr -is [string] -and $Cidr -cmatch '^([^/]+)/([0-9]|[12][0-9]|3[0-2])$') 'cidr_not_canonical'
    $parts = $Cidr.Split('/')
    $address = ConvertTo-CityGoIPv4 $parts[0]
    $prefix = [int]$parts[1]
    $size = [uint64][math]::Pow(2, 32 - $prefix)
    $first = [uint64]([math]::Floor($address / $size) * $size)
    Assert-CityGoNetworkValue (-not $RequireNetwork -or $address -eq $first) 'cidr_host_bits_set'
    return [ordered]@{ address=$address; first=$first; last=($first + $size - 1); prefix=$prefix; network=((ConvertTo-CityGoIPv4Text $first) + '/' + $prefix) }
}

function Get-CityGoStringArray {
    param($Value, [string]$Kind, [int]$Minimum)
    Assert-CityGoNetworkValue ($Value -is [array] -and $Value.Count -ge $Minimum -and $Value.Count -le 256) 'inventory_array_invalid'
    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    $result = @()
    foreach ($item in $Value) {
        Assert-CityGoNetworkValue ($item -is [string] -and $seen.Add($item)) 'inventory_array_invalid'
        if ($Kind -eq 'prefix') {
            $range = Get-CityGoIPv4Range $item
            Assert-CityGoNetworkValue ($range.prefix -ne 0) 'default_route_not_lan_prefix'
        } else { $null = ConvertTo-CityGoIPv4 $item }
        $result += $item
    }
    return ,@($result | Sort-Object)
}

function Read-CityGoNetworkInventory {
    param([string]$Path, [string]$ExpectedHash)
    Assert-CityGoNetworkValue ($ExpectedHash -cmatch '^[a-f0-9]{64}$') 'inventory_sha_required'
    # UNC/device/drive-relative paths can cause network authentication or select
    # a different stream. Accept only a fully qualified local filesystem path.
    Assert-CityGoNetworkValue (($Path -cmatch '^[A-Za-z]:[\\/][^:]+$' -or $Path -cmatch '^/(?!/)') -and $Path -notmatch '^[\\/]{2}' -and [IO.Path]::IsPathRooted($Path) -and [IO.Path]::GetExtension($Path) -ieq '.json' -and $Path -notmatch '(^|[\\/])\.\.([\\/]|$)') 'inventory_path_invalid'
    $file = Get-Item -LiteralPath $Path -ErrorAction Stop
    Assert-CityGoNetworkValue (-not $file.PSIsContainer -and ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0 -and $file.Length -gt 0 -and $file.Length -le 32768) 'inventory_file_invalid'
    $bytes = [IO.File]::ReadAllBytes($file.FullName)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $actual = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
    Assert-CityGoNetworkValue ($actual -ceq $ExpectedHash) 'inventory_sha_mismatch'
    $utf8 = [Text.UTF8Encoding]::new($false, $true)
    $raw = $utf8.GetString($bytes)
    # This flat inventory has only ASCII GUID/IPv4/CIDR/enum/UTC strings. Reject
    # escapes, comments and trailing commas instead of accepting parser-specific
    # duplicate/escaped keys. No human names, paths, arbitrary text or secrets.
    Assert-CityGoNetworkValue ($raw -cnotmatch '[^\x09\x0a\x0d\x20-\x7e]' -and $raw -notmatch '\\|//|/\*|\*/|,\s*[}\]]') 'inventory_json_not_strict'
    $jsonOptions = @{ InputObject=$raw; ErrorAction='Stop' }
    if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) { $jsonOptions.DateKind='String' }
    $value = ConvertFrom-Json @jsonOptions
    Assert-CityGoNetworkValue ($null -ne $value -and $value -isnot [array] -and $value -isnot [string]) 'inventory_object_required'
    $properties = @($value.PSObject.Properties.Name)
    $keys = @([regex]::Matches($raw, '"([A-Za-z][A-Za-z0-9]*)"\s*:') | ForEach-Object { $_.Groups[1].Value })
    $unique = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($key in $keys) { Assert-CityGoNetworkValue ($unique.Add($key)) 'inventory_duplicate_key' }
    Assert-CityGoNetworkValue ($keys.Count -eq $properties.Count) 'inventory_json_not_flat'
    # Windows PowerShell may coerce ISO JSON strings to DateTime without an
    # opt-out parameter. Preserve only this literal canonical inventory string.
    $capturedToken = [regex]::Match($raw, '"capturedAt"\s*:\s*"([^"]+)"')
    if ($capturedToken.Success) { $value.capturedAt=$capturedToken.Groups[1].Value }
    return $value
}

function Add-CityGoNetworkRule {
    param($Rules, [string]$Name, [int]$Weight, [string]$Direction, [string]$Action,
          [string]$RemoteAddress, [string]$LocalAddress='ANY', [string]$Protocol='ANY',
          $RemotePort=$null, $LocalPort=$null, [bool]$Stateful=$false, $IdleSessionTimeout=$null)
    $Rules.Add([ordered]@{ name=$Name; weight=$Weight; direction=$Direction; action=$Action;
        remoteIPAddress=$RemoteAddress; localIPAddress=$LocalAddress; protocol=$Protocol;
        remotePort=$RemotePort; localPort=$LocalPort; stateful=$Stateful; idleSessionTimeout=$IdleSessionTimeout })
}

function Get-CityGoRunnerNetworkPlan {
    param($Inventory, [string]$InventorySha256, [datetime]$NowUtc)
    $fields = @('schemaVersion','capturedAt','switchId','switchType','switchKind','gatewayCidr','natVerified',
        'hostIPv4','lanVpnPrefixes','productionIPv4','inventoriesComplete','guestNicCount','guestAdapterId',
        'macSpoofingEnabled','dhcpGuardEnabled','routerGuardEnabled','sriovEnabled','devicePassthroughEnabled',
        'extendedAclSupported','statefulAclSupported','ipv6AclSupported','idleSessionTimeoutSupported','capturedDhcpServerIPv4')
    $names = @($Inventory.PSObject.Properties.Name)
    Assert-CityGoNetworkValue ($names.Count -eq $fields.Count -and @($names | Where-Object { $_ -cnotin $fields }).Count -eq 0) 'inventory_keys_invalid'
    Assert-CityGoNetworkValue (($Inventory.schemaVersion -is [int] -or $Inventory.schemaVersion -is [long]) -and $Inventory.schemaVersion -eq 1) 'inventory_version_invalid'
    Assert-CityGoNetworkValue ($Inventory.capturedAt -is [string] -and $Inventory.capturedAt -cmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?Z$') 'inventory_time_invalid'
    $captured = [datetime]::MinValue
    Assert-CityGoNetworkValue ([datetime]::TryParseExact($Inventory.capturedAt, [string[]]@('yyyy-MM-ddTHH:mm:ssZ','yyyy-MM-ddTHH:mm:ss.FFFFFFFZ'), [Globalization.CultureInfo]::InvariantCulture,
        ([Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal), [ref]$captured)) 'inventory_time_invalid'
    $age = ($NowUtc.ToUniversalTime() - $captured).TotalSeconds
    Assert-CityGoNetworkValue ($age -ge 0 -and $age -le 900) 'inventory_not_fresh'
    foreach ($field in @('switchId','guestAdapterId')) {
        $guid = [guid]::Empty
        Assert-CityGoNetworkValue ($Inventory.$field -is [string] -and [guid]::TryParseExact($Inventory.$field,'D',[ref]$guid) -and $guid -ne [guid]::Empty -and $guid.ToString('D') -ceq $Inventory.$field) 'inventory_identity_invalid'
    }
    Assert-CityGoNetworkValue ($Inventory.switchType -ceq 'Internal' -and $Inventory.switchKind -cin @('DefaultSwitch','ExplicitNat')) 'switch_not_isolated_nat'
    foreach ($field in @('natVerified','inventoriesComplete','dhcpGuardEnabled','routerGuardEnabled','extendedAclSupported','statefulAclSupported','ipv6AclSupported','idleSessionTimeoutSupported')) {
        Assert-CityGoNetworkValue ($Inventory.$field -is [bool] -and $Inventory.$field -eq $true) 'inventory_capability_unverified'
    }
    foreach ($field in @('macSpoofingEnabled','sriovEnabled','devicePassthroughEnabled')) {
        Assert-CityGoNetworkValue ($Inventory.$field -is [bool] -and $Inventory.$field -eq $false) 'guest_bypass_not_disabled'
    }
    Assert-CityGoNetworkValue (($Inventory.guestNicCount -is [int] -or $Inventory.guestNicCount -is [long]) -and $Inventory.guestNicCount -eq 1) 'guest_requires_one_nic'
    $gateway = Get-CityGoIPv4Range $Inventory.gatewayCidr $false
    Assert-CityGoNetworkValue ($gateway.prefix -ge 8 -and $gateway.prefix -le 30 -and $gateway.address -gt $gateway.first -and $gateway.address -lt $gateway.last) 'gateway_cidr_invalid'
    $private = $false
    foreach ($prefix in @('10.0.0.0/8','172.16.0.0/12','192.168.0.0/16')) {
        $range = Get-CityGoIPv4Range $prefix
        if ($gateway.address -ge $range.first -and $gateway.address -le $range.last) { $private=$true }
    }
    Assert-CityGoNetworkValue $private 'gateway_not_private'
    $hosts = Get-CityGoStringArray $Inventory.hostIPv4 'address' 1
    $lan = Get-CityGoStringArray $Inventory.lanVpnPrefixes 'prefix' 0
    $production = Get-CityGoStringArray $Inventory.productionIPv4 'address' 1
    Assert-CityGoNetworkValue ($hosts -ccontains ($Inventory.gatewayCidr.Split('/')[0])) 'gateway_not_captured_host'
    $dhcp = $null
    if ($Inventory.switchKind -ceq 'DefaultSwitch') {
        Assert-CityGoNetworkValue ($Inventory.capturedDhcpServerIPv4 -is [string]) 'dhcp_server_unverified'
        $dhcpNumber = ConvertTo-CityGoIPv4 $Inventory.capturedDhcpServerIPv4
        Assert-CityGoNetworkValue ($dhcpNumber -gt $gateway.first -and $dhcpNumber -lt $gateway.last) 'dhcp_server_outside_switch'
        $dhcp = $Inventory.capturedDhcpServerIPv4
    } else { Assert-CityGoNetworkValue ($null -eq $Inventory.capturedDhcpServerIPv4) 'explicit_nat_dhcp_not_admitted' }

    # Conservative superset of IANA special-purpose IPv4 entries (2025-10-09),
    # including globally reachable special exceptions; multicast is also denied.
    # Explicit Azure platform/metadata VIP is denied in addition to link-local.
    $blocked = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    foreach ($prefix in @('0.0.0.0/8','10.0.0.0/8','100.64.0.0/10','127.0.0.0/8','169.254.0.0/16','172.16.0.0/12',
        '192.0.0.0/24','192.0.2.0/24','192.31.196.0/24','192.52.193.0/24','192.88.99.0/24','192.168.0.0/16',
        '192.175.48.0/24','198.18.0.0/15','198.51.100.0/24','203.0.113.0/24','224.0.0.0/4','240.0.0.0/4','168.63.129.16/32')) { [void]$blocked.Add($prefix) }
    foreach ($prefix in $lan) { [void]$blocked.Add($prefix) }
    foreach ($address in @($hosts) + @($production)) { [void]$blocked.Add($address + '/32') }
    [void]$blocked.Add($gateway.network)
    $rules = [System.Collections.Generic.List[object]]::new()
    Add-CityGoNetworkRule $rules 'ipv6-inbound-deny' 1000000 'Inbound' 'Deny' '::/0'
    Add-CityGoNetworkRule $rules 'ipv6-outbound-deny' 999999 'Outbound' 'Deny' '::/0'
    if ($dhcp) {
        # Broadcast is not a normal stateful unicast flow. Only this documented
        # exception pair is proposed; real DHCP sender/readback remains unproven.
        Add-CityGoNetworkRule $rules 'dhcp-broadcast-request' 900001 'Outbound' 'Allow' '255.255.255.255/32' 'ANY' 'UDP' '67' '68'
        Add-CityGoNetworkRule $rules 'dhcp-exact-server-reply' 900000 'Inbound' 'Allow' ($dhcp + '/32') 'ANY' 'UDP' '67' '68'
    }
    $weight = 800000
    foreach ($prefix in @($blocked | Sort-Object)) {
        Add-CityGoNetworkRule $rules ('deny-outbound-' + $weight) $weight 'Outbound' 'Deny' $prefix
        $weight--
        Add-CityGoNetworkRule $rules ('deny-inbound-' + $weight) $weight 'Inbound' 'Deny' $prefix
        $weight--
    }
    $weight = 50000
    foreach ($port in @('80','443')) {
        Add-CityGoNetworkRule $rules ('public-tcp-' + $port) $weight 'Outbound' 'Allow' '0.0.0.0/0' $gateway.network 'TCP' $port $null $true 300
        $weight--
    }
    $weight = 40000
    foreach ($dns in @('1.1.1.1','8.8.8.8')) {
        foreach ($protocol in @('UDP','TCP')) {
            Add-CityGoNetworkRule $rules ('dns-' + $dns + '-' + $protocol) $weight 'Outbound' 'Allow' ($dns + '/32') $gateway.network $protocol '53' $null $true 30
            $weight--
        }
    }
    Add-CityGoNetworkRule $rules 'default-ipv4-inbound-deny' 2 'Inbound' 'Deny' '0.0.0.0/0'
    Add-CityGoNetworkRule $rules 'default-ipv4-outbound-deny' 1 'Outbound' 'Deny' '0.0.0.0/0'
    return [ordered]@{ schemaVersion=1; scope='offline_network_policy_proposal'; planValid=$true; readyForApply=$false;
        guestIsolationVerified=$false; changedHostConfiguration=$false; githubJobsAuthorized=$false;
        containsPrivateNetworkMetadata=$true; inventorySha256=$InventorySha256; capturedAt=$Inventory.capturedAt;
        switchId=$Inventory.switchId; guestAdapterId=$Inventory.guestAdapterId; target='exact_guest_vnic_not_management_os';
        ipv6='deny_all_at_host_vnic'; blockers=@(); rules=@($rules.ToArray());
        requiredAcceptance=@('trusted_inventory_source','host_acl_readback','stateful_reply_canary','ipv4_ipv6_host_lan_metadata_production_direct_deny','l2_spoof_guard_readback','single_job_disposal');
        limitations=@('No host or guest mutations were performed.','Stateful replies require real Hyper-V verification.',
            'Public HTTP(S) permits DoH and proxies; direct-IP deny does not prove indirect production isolation.',
            'SHA256 and caller capability claims are not proof of a trusted inventory or actual enforcement.');
        references=@('https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/create-security-policies-extended-port-access-control-lists',
            'https://learn.microsoft.com/en-us/powershell/module/hyper-v/add-vmnetworkadapterextendedacl',
            'https://www.iana.org/assignments/iana-ipv4-special-registry/') }
}

try {
    $inventory = Read-CityGoNetworkInventory $InventoryPath $ExpectedInventorySha256
    $plan = Get-CityGoRunnerNetworkPlan $inventory $ExpectedInventorySha256 ([datetime]::UtcNow)
    $plan | ConvertTo-Json -Depth 12 -Compress
} catch {
    $code = 'planner_input_unavailable'
    if ($_.Exception.Message -cmatch '^[a-z0-9_]{1,80}$') { $code=$_.Exception.Message }
    [ordered]@{ schemaVersion=1; scope='offline_network_policy_proposal'; planValid=$false; readyForApply=$false;
        guestIsolationVerified=$false; changedHostConfiguration=$false; githubJobsAuthorized=$false;
        blockers=@($code); rules=@() } | ConvertTo-Json -Depth 4 -Compress
    exit 1
}
