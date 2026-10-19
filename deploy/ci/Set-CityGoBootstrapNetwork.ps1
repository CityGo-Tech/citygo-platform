# Trusted one-time bootstrap only: no PR/job code or runner registration.
# Default is an offline plan. Apply adds ACLs to ONE owned, stopped vNIC before
# connecting it to the existing Default Switch. Never starts a VM or changes NAT,
# the host firewall, management adapters, switches, disks, keys or other VMs.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$InventoryPath,
    [Parameter(Mandatory=$true)][string]$ExpectedInventorySha256,
    [Parameter(Mandatory=$true)][string]$CreationReceiptPath,
    [Parameter(Mandatory=$true)][string]$ExpectedCreationReceiptSha256,
    [Parameter(Mandatory=$true)][string]$VerificationPath,
    [Parameter(Mandatory=$true)][string]$ExpectedVerificationSha256,
    [switch]$Apply,
    [string]$Acknowledge = ''
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
$VerbosePreference = 'SilentlyContinue'
$DebugPreference = 'SilentlyContinue'

function Assert-CityGoBootstrapNetwork {
    param([bool]$Condition, [string]$Code)
    if (-not $Condition) { throw $Code }
}

function Get-CityGoNetworkLocalPath {
    param([string]$Path)
    Assert-CityGoBootstrapNetwork ($Path -cmatch '^[A-Za-z]:\\' -and $Path.Length -le 1024 -and
        $Path -notmatch '[\x00-\x1f/*?\[\]]' -and -not $Path.Substring(2).Contains(':')) 'evidence_path_invalid'
    foreach ($part in $Path.Substring(3).Split('\')) {
        Assert-CityGoBootstrapNetwork ($part -and $part -notin @('.','..') -and $part -notmatch '[. ]$') 'evidence_path_invalid'
    }
    $full = [IO.Path]::GetFullPath($Path)
    Assert-CityGoBootstrapNetwork ($full.Equals($Path,[StringComparison]::OrdinalIgnoreCase)) 'evidence_path_invalid'
    return $full
}

function Assert-CityGoNetworkPlainPath {
    param([string]$Path)
    $null = Get-CityGoNetworkLocalPath $Path
    $cursor = $Path.Substring(0,3)
    foreach ($part in @('') + $Path.Substring(3).Split('\')) {
        if ($part) { $cursor=[IO.Path]::Combine($cursor,$part) }
        $item=Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
        Assert-CityGoBootstrapNetwork (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0 -and
            $item.PSProvider.Name -ceq 'FileSystem') 'evidence_path_not_plain'
        if (-not $cursor.Equals($Path,[StringComparison]::OrdinalIgnoreCase)) {
            Assert-CityGoBootstrapNetwork ([bool]$item.PSIsContainer) 'evidence_parent_invalid'
        }
    }
    return $item
}

function Get-CityGoNetworkOwnerSid {
    param([bool]$RequireAdministrator)
    Assert-CityGoBootstrapNetwork ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) 'windows_required'
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
    try {
        $principal=[Security.Principal.WindowsPrincipal]::new($identity)
        Assert-CityGoBootstrapNetwork (-not $RequireAdministrator -or $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) 'administrator_required'
        return $identity.User.Value
    } finally { $identity.Dispose() }
}

function Assert-CityGoNetworkPrivateAcl {
    param([string]$Path,[string]$OwnerSid,[bool]$ProtectedDirectory=$false)
    $allowed=@($OwnerSid,'S-1-5-18','S-1-5-32-544')
    $acl=Get-Acl -LiteralPath $Path -ErrorAction Stop
    Assert-CityGoBootstrapNetwork ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -in $allowed) 'evidence_owner_invalid'
    Assert-CityGoBootstrapNetwork (-not $ProtectedDirectory -or $acl.AreAccessRulesProtected) 'evidence_directory_not_protected'
    foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
        Assert-CityGoBootstrapNetwork ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
            $rule.IdentityReference.Value -in $allowed) 'evidence_acl_not_private'
    }
}

function Read-CityGoBootstrapNetworkEvidence {
    param([string]$Path,[string]$ExpectedHash,[string]$OwnerSid)
    Assert-CityGoBootstrapNetwork ($ExpectedHash -cmatch '^[a-f0-9]{64}$') 'evidence_hash_required'
    $null=Get-CityGoNetworkLocalPath $Path
    Assert-CityGoBootstrapNetwork ($Path -imatch '^D:\\CityGo-CI\\control\\[a-f0-9-]{36}\\[a-z-]+\.json$') 'evidence_outside_control'
    $item=Assert-CityGoNetworkPlainPath $Path
    Assert-CityGoBootstrapNetwork (-not $item.PSIsContainer -and $item.Length -ge 2 -and $item.Length -le 65536) 'evidence_file_invalid'
    Assert-CityGoNetworkPrivateAcl ([IO.Path]::GetDirectoryName($Path)) $OwnerSid $true
    Assert-CityGoNetworkPrivateAcl $Path $OwnerSid
    $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try {
        Assert-CityGoBootstrapNetwork ($stream.Length -ge 2 -and $stream.Length -le 65536) 'evidence_file_invalid'
        $sha=[Security.Cryptography.SHA256]::Create()
        try { $actual=([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
        Assert-CityGoBootstrapNetwork ($actual -ceq $ExpectedHash) 'evidence_hash_mismatch'
        $stream.Position=0
        $reader=[IO.StreamReader]::new($stream,[Text.UTF8Encoding]::new($false,$true),$false,4096,$true)
        try { $raw=$reader.ReadToEnd() } finally { $reader.Dispose() }
        if ($raw.Length -gt 0 -and $raw[0] -eq [char]0xfeff) { $raw=$raw.Substring(1) }
        $value=ConvertFrom-CityGoBootstrapNetworkJson $raw
        return [ordered]@{value=$value;stream=$stream}
    } catch { $stream.Dispose(); throw }
}

function ConvertFrom-CityGoBootstrapNetworkJson {
    param([string]$Raw)
    Assert-CityGoBootstrapNetwork ($Raw.Length -ge 2 -and $Raw.Length -le 65536 -and
        $Raw.Trim().StartsWith('{') -and $Raw.Trim().EndsWith('}') -and
        $Raw -cnotmatch '[\x00-\x08\x0b\x0c\x0e-\x1f]') 'evidence_json_invalid'
    # Names may be printable Unicode data (e.g. a localized default vNIC name).
    # Reject comments/trailing commas outside strings, not harmless string data.
    $syntax=[regex]::Replace($Raw,'"(?:[^"\\]|\\.)*"','""')
    Assert-CityGoBootstrapNetwork ($syntax -notmatch '//|/\*|\*/|,\s*[}\]]') 'evidence_json_invalid'
    $options=@{InputObject=$Raw;ErrorAction='Stop'}
    if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) { $options.DateKind='String' }
    $value=ConvertFrom-Json @options
    Assert-CityGoBootstrapNetwork ($null -ne $value -and $value -is [pscustomobject]) 'evidence_object_required'
    $keys=@([regex]::Matches($Raw,'"([A-Za-z][A-Za-z0-9]*)"\s*:')|ForEach-Object{$_.Groups[1].Value})
    $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($key in $keys) { Assert-CityGoBootstrapNetwork ($seen.Add($key)) 'evidence_duplicate_key' }
    Assert-CityGoBootstrapNetwork ($keys.Count -eq @($value.PSObject.Properties).Count) 'evidence_not_flat'
    foreach ($property in $value.PSObject.Properties) {
        Assert-CityGoBootstrapNetwork ($property.Value -isnot [pscustomobject]) 'evidence_not_flat'
        if ($property.Value -is [array]) {
            Assert-CityGoBootstrapNetwork (@($property.Value|Where-Object{$_ -isnot [string]}).Count -eq 0) 'evidence_not_flat'
        }
    }
    foreach ($key in @('capturedAt','observedAt')) {
        $token=[regex]::Match($Raw,('"'+$key+'"\s*:\s*"([^"\\]+)"'))
        if ($token.Success) { $value.$key=$token.Groups[1].Value }
    }
    return $value
}

function Assert-CityGoNetworkInteger {
    param($Value,[long]$Expected)
    Assert-CityGoBootstrapNetwork (($Value -is [int] -or $Value -is [long]) -and $Value -eq $Expected) 'evidence_integer_invalid'
}

function Assert-CityGoNetworkKeys {
    param($Value,[string[]]$Keys)
    $actual=@($Value.PSObject.Properties.Name)
    Assert-CityGoBootstrapNetwork ($actual.Count -eq $Keys.Count -and @($actual|Where-Object{$_ -cnotin $Keys}).Count -eq 0) 'evidence_keys_invalid'
}

function Assert-CityGoNetworkGuid {
    param($Value)
    $id=[guid]::Empty
    Assert-CityGoBootstrapNetwork ($Value -is [string] -and [guid]::TryParseExact($Value,'D',[ref]$id) -and
        $id -ne [guid]::Empty -and $Value -ceq $id.ToString('D')) 'evidence_identity_invalid'
}

function ConvertTo-CityGoBootstrapIPv4 {
    param($Address)
    Assert-CityGoBootstrapNetwork ($Address -is [string] -and $Address -cmatch '^(0|[1-9][0-9]{0,2})(\.(0|[1-9][0-9]{0,2})){3}$') 'ipv4_invalid'
    $number=[uint64]0
    foreach ($part in $Address.Split('.')) {
        Assert-CityGoBootstrapNetwork ([int]$part -le 255) 'ipv4_invalid'
        $number=$number*256+[int]$part
    }
    return $number
}

function Get-CityGoBootstrapRange {
    param($Cidr,[bool]$NetworkOnly=$true)
    Assert-CityGoBootstrapNetwork ($Cidr -is [string] -and $Cidr -cmatch '^([^/]+)/([0-9]|[12][0-9]|3[0-2])$') 'cidr_invalid'
    $parts=$Cidr.Split('/');$address=ConvertTo-CityGoBootstrapIPv4 $parts[0];$prefix=[int]$parts[1]
    $size=[uint64][math]::Pow(2,32-$prefix);$first=[uint64]([math]::Floor($address/$size)*$size)
    Assert-CityGoBootstrapNetwork (-not $NetworkOnly -or $first -eq $address) 'cidr_host_bits'
    $text=@((($first -shr 24)-band 255),(($first -shr 16)-band 255),(($first -shr 8)-band 255),($first-band 255))-join'.'
    return [ordered]@{address=$address;first=$first;last=($first+$size-1);prefix=$prefix;network=($text+'/'+$prefix)}
}

function Get-CityGoBootstrapAddresses {
    param($Value,[bool]$Prefixes,[int]$Minimum)
    Assert-CityGoBootstrapNetwork ($Value -is [array] -and $Value.Count -ge $Minimum -and $Value.Count -le 256) 'addresses_invalid'
    $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($item in $Value) {
        Assert-CityGoBootstrapNetwork ($item -is [string] -and $seen.Add($item)) 'addresses_invalid'
        if ($Prefixes) { $range=Get-CityGoBootstrapRange $item;Assert-CityGoBootstrapNetwork ($range.prefix -gt 0) 'default_route_not_lan' }
        else { $null=ConvertTo-CityGoBootstrapIPv4 $item }
    }
    return ,@($Value|Sort-Object)
}

function Add-CityGoBootstrapRule {
    param($Rules,[int]$Weight,[string]$Direction,[string]$Action,[string]$RemoteAddress,
        [string]$LocalAddress='ANY',[string]$Protocol='ANY',$RemotePort=$null,$LocalPort=$null,[bool]$Stateful=$false,[int]$Timeout=0)
    # The cmdlet parameter is Int32, but the Hyper-V MOF Weight is UInt16.
    Assert-CityGoBootstrapNetwork ($Weight -ge 1 -and $Weight -le 65535 -and $Timeout -ge 0 -and $Timeout -le 65535) 'native_acl_range_invalid'
    $Rules.Add([ordered]@{Weight=$Weight;Direction=$Direction;Action=$Action;RemoteIPAddress=$RemoteAddress;
        LocalIPAddress=$LocalAddress;Protocol=$Protocol;RemotePort=$RemotePort;LocalPort=$LocalPort;
        Stateful=$Stateful;IdleSessionTimeout=$Timeout;IsolationID=0})
}

function Get-CityGoBootstrapNetworkPlan {
    param($Inventory,$Creation,$Verification,[Collections.IDictionary]$Request,[datetime]$NowUtc)
    Assert-CityGoNetworkKeys $Inventory @('schemaVersion','capturedAt','operationId','vmId','vmName','guestAdapterId','guestAdapterName',
        'switchId','switchName','switchType','switchKind','gatewayCidr','capturedDhcpServerIPv4','bootstrapCandidateDhcpMode','bootstrapCandidateDhcpIPv4','hostIPv4','lanVpnPrefixes',
        'productionIPv4','inventoriesComplete','guestNicCount','macSpoofingEnabled','dhcpGuardEnabled','routerGuardEnabled',
        'sriovEnabled','devicePassthroughEnabled','extendedAclSupported','statefulAclSupported','ipv6AclSupported','idleSessionTimeoutSupported','natVerified')
    Assert-CityGoNetworkKeys $Creation @('schemaVersion','scope','operationId','vmName','vmId','baseSha256','stage','guestIsolationVerified','githubRunnerRegistered')
    Assert-CityGoNetworkKeys $Verification @('version','scope','observedAt','operationId','vmId','state','generation','vCpu','memoryGiB','vhdxGiB',
        'vhdxSha256','secureBoot','secureBootTemplate','nicCount','switchConnected','stage','guestIsolationVerified','githubRunnerRegistered',
        'hostConfigurationChanged','historicalFailedStagingReceiptPreserved')
    Assert-CityGoNetworkInteger $Inventory.schemaVersion 1
    Assert-CityGoNetworkInteger $Inventory.guestNicCount 1
    Assert-CityGoNetworkInteger $Creation.schemaVersion 1
    foreach ($entry in @(@('version',1),@('generation',2),@('vCpu',4),@('memoryGiB',6),@('vhdxGiB',96),@('nicCount',1))) {
        Assert-CityGoNetworkInteger $Verification.($entry[0]) $entry[1]
    }
    foreach ($key in @('operationId','vmId','switchId')) { Assert-CityGoNetworkGuid $Inventory.$key }
    Assert-CityGoBootstrapNetwork ($Inventory.schemaVersion -is [ValueType] -and $Inventory.schemaVersion -eq 1 -and
        $Inventory.vmName -ceq ('citygo-ci-base-'+$Inventory.operationId)) 'inventory_identity_invalid'
    Assert-CityGoBootstrapNetwork ($Inventory.guestAdapterId -is [string] -and $Inventory.guestAdapterId.Length -ge 1 -and
        $Inventory.guestAdapterId.Length -le 256 -and $Inventory.guestAdapterId -cmatch '^[A-Za-z0-9{}: _\\.-]+$') 'adapter_identity_invalid'
    Assert-CityGoBootstrapNetwork ($Inventory.guestAdapterName -is [string] -and $Inventory.guestAdapterName.Trim().Length -ge 1 -and
        $Inventory.guestAdapterName.Length -le 256 -and $Inventory.guestAdapterName -notmatch '\p{C}') 'adapter_name_invalid'
    Assert-CityGoBootstrapNetwork ($Creation.schemaVersion -eq 1 -and $Creation.scope -ceq 'stopped_bootstrap_vm_only' -and
        $Creation.stage -cin @('staged_verified_off_no_network','failed_preserved_state_unverified','failed_preserved_receipt_unavailable') -and
        $Creation.operationId -ceq $Inventory.operationId -and $Creation.vmId -ceq $Inventory.vmId -and
        $Creation.vmName -ceq $Inventory.vmName -and $Creation.baseSha256 -cmatch '^[a-f0-9]{64}$') 'creation_chain_invalid'
    Assert-CityGoBootstrapNetwork ($Verification.version -eq 1 -and $Verification.scope -ceq 'independent_readonly_bootstrap_verification' -and
        $Verification.stage -ceq 'verified_off_disconnected_bootstrap_only' -and $Verification.operationId -ceq $Inventory.operationId -and
        $Verification.vmId -ceq $Inventory.vmId -and $Verification.state -ceq 'Off' -and $Verification.generation -eq 2 -and
        $Verification.vCpu -eq 4 -and $Verification.memoryGiB -eq 6 -and $Verification.vhdxGiB -eq 96 -and
        $Verification.vhdxSha256 -ceq $Creation.baseSha256 -and $Verification.secureBoot -ceq 'On' -and
        $Verification.secureBootTemplate -ceq 'MicrosoftUEFICertificateAuthority' -and $Verification.nicCount -eq 1) 'independent_verification_invalid'
    foreach ($object in @($Creation,$Verification)) {
        foreach ($key in @('guestIsolationVerified','githubRunnerRegistered')) {
            Assert-CityGoBootstrapNetwork ($object.$key -is [bool] -and -not $object.$key) 'historical_admission_not_closed'
        }
    }
    foreach ($key in @('switchConnected','hostConfigurationChanged')) {
        Assert-CityGoBootstrapNetwork ($Verification.$key -is [bool] -and -not $Verification.$key) 'independent_verification_invalid'
    }
    Assert-CityGoBootstrapNetwork ($Verification.historicalFailedStagingReceiptPreserved -is [bool] -and
        $Verification.historicalFailedStagingReceiptPreserved) 'creation_history_not_preserved'
    foreach ($key in @('inventoriesComplete','dhcpGuardEnabled','routerGuardEnabled','extendedAclSupported','statefulAclSupported','ipv6AclSupported','idleSessionTimeoutSupported','natVerified')) {
        Assert-CityGoBootstrapNetwork ($Inventory.$key -is [bool] -and $Inventory.$key) 'inventory_capability_unverified'
    }
    foreach ($key in @('macSpoofingEnabled','sriovEnabled','devicePassthroughEnabled')) {
        Assert-CityGoBootstrapNetwork ($Inventory.$key -is [bool] -and -not $Inventory.$key) 'inventory_bypass_not_disabled'
    }
    Assert-CityGoBootstrapNetwork ($Inventory.guestNicCount -is [ValueType] -and $Inventory.guestNicCount -eq 1 -and
        $Inventory.switchType -ceq 'Internal' -and $Inventory.switchKind -ceq 'DefaultSwitch' -and
        $Inventory.switchName -ceq 'Default Switch') 'default_switch_required'
    Assert-CityGoBootstrapNetwork ($Inventory.capturedAt -is [string] -and $Inventory.capturedAt -cmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?Z$') 'inventory_time_invalid'
    $at=[datetime]::MinValue
    Assert-CityGoBootstrapNetwork ([datetime]::TryParseExact($Inventory.capturedAt,[string[]]@('yyyy-MM-ddTHH:mm:ssZ','yyyy-MM-ddTHH:mm:ss.FFFFFFFZ'),
        [Globalization.CultureInfo]::InvariantCulture,([Globalization.DateTimeStyles]::AssumeUniversal-bor[Globalization.DateTimeStyles]::AdjustToUniversal),[ref]$at)) 'inventory_time_invalid'
    $age=($NowUtc.ToUniversalTime()-$at).TotalSeconds
    Assert-CityGoBootstrapNetwork ($age -ge 0 -and $age -le 900) 'inventory_not_fresh'
    $gateway=Get-CityGoBootstrapRange $Inventory.gatewayCidr $false
    Assert-CityGoBootstrapNetwork ($gateway.prefix -ge 8 -and $gateway.prefix -le 30 -and $gateway.address -gt $gateway.first -and $gateway.address -lt $gateway.last) 'gateway_invalid'
    $private=$false
    foreach ($cidr in @('10.0.0.0/8','172.16.0.0/12','192.168.0.0/16')) {
        $range=Get-CityGoBootstrapRange $cidr
        if ($gateway.address -ge $range.first -and $gateway.address -le $range.last) { $private=$true }
    }
    Assert-CityGoBootstrapNetwork $private 'gateway_not_private'
    $hosts=Get-CityGoBootstrapAddresses $Inventory.hostIPv4 $false 1
    $lan=Get-CityGoBootstrapAddresses $Inventory.lanVpnPrefixes $true 0
    $production=Get-CityGoBootstrapAddresses $Inventory.productionIPv4 $false 1
    $gatewayIp=$Inventory.gatewayCidr.Split('/')[0]
    Assert-CityGoBootstrapNetwork ($hosts -ccontains $gatewayIp) 'gateway_not_captured_host'
    $dhcpAddress=$null;$dhcpEvidence='captured_exact_server'
    if ($Inventory.bootstrapCandidateDhcpMode -ceq 'disabled') {
        Assert-CityGoBootstrapNetwork ($Inventory.capturedDhcpServerIPv4 -is [string] -and $null -eq $Inventory.bootstrapCandidateDhcpIPv4) 'dhcp_exact_server_unknown'
        $dhcpAddress=$Inventory.capturedDhcpServerIPv4
    } elseif ($Inventory.bootstrapCandidateDhcpMode -ceq 'hns_gateway_candidate') {
        # Owner-approved, trusted first boot only. HNS gateway is a candidate,
        # not evidence of an actual DHCP server. Never admitted for CI jobs.
        Assert-CityGoBootstrapNetwork ($null -eq $Inventory.capturedDhcpServerIPv4 -and
            $Inventory.bootstrapCandidateDhcpIPv4 -is [string] -and $Inventory.bootstrapCandidateDhcpIPv4 -ceq $gatewayIp) 'dhcp_candidate_invalid'
        $dhcpAddress=$Inventory.bootstrapCandidateDhcpIPv4;$dhcpEvidence='hns_gateway_candidate_not_verified'
    } else { throw 'dhcp_mode_unknown' }
    $dhcp=ConvertTo-CityGoBootstrapIPv4 $dhcpAddress
    Assert-CityGoBootstrapNetwork ($dhcp -gt $gateway.first -and $dhcp -lt $gateway.last) 'dhcp_server_outside_switch'
    $control='D:\CityGo-CI\control\'+$Inventory.operationId
    foreach ($key in @('inventoryPath','creationReceiptPath','verificationPath')) { $null=Get-CityGoNetworkLocalPath $Request.$key }
    # A fresh resume inventory can rebuild the exact policy for read-only
    # comparison. This does not relax Apply's existing-result/ACL guards.
    Assert-CityGoBootstrapNetwork (($Request.inventoryPath -ieq ($control+'\network-inventory.json') -or
        $Request.inventoryPath -ieq ($control+'\network-resume-inventory.json')) -and
        $Request.creationReceiptPath -ieq ($control+'\result.json') -and
        $Request.verificationPath -ieq ($control+'\independent-verification.json')) 'evidence_operation_path_mismatch'
    foreach ($key in @('inventorySha256','creationReceiptSha256','verificationSha256')) {
        Assert-CityGoBootstrapNetwork ($Request.$key -cmatch '^[a-f0-9]{64}$') 'evidence_hash_required'
    }
    $blocked=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($cidr in @('0.0.0.0/8','10.0.0.0/8','100.64.0.0/10','127.0.0.0/8','169.254.0.0/16','172.16.0.0/12',
        '192.0.0.0/24','192.0.2.0/24','192.31.196.0/24','192.52.193.0/24','192.88.99.0/24','192.168.0.0/16','192.175.48.0/24',
        '198.18.0.0/15','198.51.100.0/24','203.0.113.0/24','224.0.0.0/4','240.0.0.0/4','168.63.129.16/32')) { [void]$blocked.Add($cidr) }
    foreach ($cidr in $lan) { [void]$blocked.Add($cidr) }
    foreach ($address in @($hosts)+@($production)) { [void]$blocked.Add($address+'/32') }
    [void]$blocked.Add($gateway.network)
    $rules=[Collections.Generic.List[object]]::new()
    Add-CityGoBootstrapRule $rules 65535 'Inbound' 'Deny' '::/0'
    Add-CityGoBootstrapRule $rules 65534 'Outbound' 'Deny' '::/0'
    Add-CityGoBootstrapRule $rules 65000 'Inbound' 'Allow' ($gatewayIp+'/32') $gateway.network 'TCP' $null '22' $true 300
    Add-CityGoBootstrapRule $rules 64002 'Outbound' 'Allow' '255.255.255.255/32' 'ANY' 'UDP' '67' '68'
    Add-CityGoBootstrapRule $rules 64001 'Outbound' 'Allow' ($dhcpAddress+'/32') $gateway.network 'UDP' '67' '68'
    Add-CityGoBootstrapRule $rules 64000 'Inbound' 'Allow' ($dhcpAddress+'/32') 'ANY' 'UDP' '67' '68'
    $weight=60000
    foreach ($cidr in @($blocked|Sort-Object)) {
        Add-CityGoBootstrapRule $rules $weight 'Outbound' 'Deny' $cidr;$weight--
        Add-CityGoBootstrapRule $rules $weight 'Inbound' 'Deny' $cidr;$weight--
    }
    $weight=5000
    foreach ($port in @('80','443')) { Add-CityGoBootstrapRule $rules $weight 'Outbound' 'Allow' '0.0.0.0/0' $gateway.network 'TCP' $port $null $true 300;$weight-- }
    $weight=4000
    foreach ($dns in @('1.1.1.1','8.8.8.8')) {
        foreach ($protocol in @('UDP','TCP')) { Add-CityGoBootstrapRule $rules $weight 'Outbound' 'Allow' ($dns+'/32') $gateway.network $protocol '53' $null $true 30;$weight-- }
    }
    Add-CityGoBootstrapRule $rules 2 'Inbound' 'Deny' '0.0.0.0/0'
    Add-CityGoBootstrapRule $rules 1 'Outbound' 'Deny' '0.0.0.0/0'
    return [ordered]@{schemaVersion=1;scope='trusted_bootstrap_network_only';operationId=$Inventory.operationId;vmId=$Inventory.vmId;
        vmName=$Inventory.vmName;adapterId=$Inventory.guestAdapterId;adapterName=$Inventory.guestAdapterName;
        switchId=$Inventory.switchId;switchName=$Inventory.switchName;targetDirectory=('D:\CityGo-CI\bootstrap\'+$Inventory.operationId);
        vmConfigurationPath=('D:\CityGo-CI\bootstrap\'+$Inventory.operationId+'\'+$Inventory.vmName);remainingFreshSeconds=(900-$age);
        targetVhdx=('D:\CityGo-CI\bootstrap\'+$Inventory.operationId+'\bootstrap.vhdx');baseSha256=$Creation.baseSha256;
        resultPath=($control+'\bootstrap-network-result.json');inventorySha256=$Request.inventorySha256;dhcpAdmission=$dhcpEvidence;
        creationReceiptSha256=$Request.creationReceiptSha256;verificationSha256=$Request.verificationSha256;
        requiredAcknowledgement=('CONNECT_TRUSTED_BOOTSTRAP_ONLY:'+$Inventory.vmId+':'+$Request.inventorySha256);
        rules=@($rules.ToArray());guestIsolationVerified=$false;githubJobsAuthorized=$false;
        limitations=@('Trusted OS bootstrap only; no PR/job or runner registration is authorized.',
            'Stateful reply behavior and direct IPv4/IPv6 deny still require guest canaries.',
            'Public HTTP(S) can reach proxies/DoH; this is not indirect production isolation.')}
}

function Get-CityGoOwnedBootstrapNetworkAdapter {
    param([Collections.IDictionary]$Plan,[bool]$Connected)
    $vms=@(Get-VM -Id ([guid]$Plan.vmId) -ErrorAction Stop)
    Assert-CityGoBootstrapNetwork ($vms.Count -eq 1) 'owned_vm_missing'
    $vm=$vms[0]
    Assert-CityGoBootstrapNetwork ($vm.Id.ToString('D') -ceq $Plan.vmId -and $vm.Name -ceq $Plan.vmName -and
        [string]$vm.State -ceq 'Off' -and $vm.Generation -eq 2 -and $vm.ProcessorCount -eq 4 -and $vm.MemoryStartup -eq 6GB -and
        $vm.DynamicMemoryEnabled -eq $false -and [string]$vm.AutomaticStartAction -ceq 'Nothing' -and
        [string]$vm.CheckpointType -ceq 'Disabled' -and $vm.AutomaticCheckpointsEnabled -eq $false -and
        [string]$vm.Path -ieq $Plan.vmConfigurationPath) 'owned_vm_state_invalid'
    $disks=@(Get-VMHardDiskDrive -VM $vm -ErrorAction Stop)
    Assert-CityGoBootstrapNetwork ($disks.Count -eq 1 -and $disks[0].Path -ieq $Plan.targetVhdx -and -not $disks[0].DiskNumber) 'owned_disk_invalid'
    $firmware=Get-VMFirmware -VM $vm -ErrorAction Stop
    Assert-CityGoBootstrapNetwork ([string]$firmware.SecureBoot -ceq 'On' -and
        [string]$firmware.SecureBootTemplate -ceq 'MicrosoftUEFICertificateAuthority') 'owned_firmware_invalid'
    Assert-CityGoBootstrapNetwork (@(Get-VMAssignableDevice -VM $vm -ErrorAction Stop).Count -eq 0) 'assigned_device_refused'
    $adapters=@(Get-VMNetworkAdapter -VM $vm -ErrorAction Stop)
    Assert-CityGoBootstrapNetwork ($adapters.Count -eq 1) 'owned_nic_count_invalid'
    $nic=$adapters[0]
    Assert-CityGoBootstrapNetwork ([string]$nic.Id -ceq $Plan.adapterId -and $nic.VMId.ToString('D') -ceq $Plan.vmId -and
        $nic.Name -ceq $Plan.adapterName -and [string]$nic.MacAddressSpoofing -ceq 'Off' -and
        [string]$nic.DhcpGuard -ceq 'On' -and [string]$nic.RouterGuard -ceq 'On' -and
        $nic.IovQueuePairsAssigned -eq 0 -and $nic.IovUsage -eq 0 -and [string]$nic.PortMirroringMode -ceq 'None' -and
        [string]$nic.AllowTeaming -ceq 'Off') 'owned_nic_invalid'
    if ($Connected) {
        Assert-CityGoBootstrapNetwork ($nic.SwitchId -and $nic.SwitchId.ToString('D') -ceq $Plan.switchId -and
            $nic.SwitchName -ceq $Plan.switchName) 'owned_switch_not_connected'
    } else {
        Assert-CityGoBootstrapNetwork ((-not $nic.SwitchId -or [guid]$nic.SwitchId -eq [guid]::Empty) -and -not $nic.SwitchName) 'owned_nic_not_disconnected'
    }
    $vlan=Get-VMNetworkAdapterVlan -VMNetworkAdapter $nic -ErrorAction Stop
    $isolation=Get-VMNetworkAdapterIsolation -VMNetworkAdapter $nic -ErrorAction Stop
    Assert-CityGoBootstrapNetwork ([string]$vlan.OperationMode -ceq 'Untagged' -and [string]$isolation.IsolationMode -ceq 'None') 'owned_nic_isolation_unexpected'
    Assert-CityGoBootstrapNetwork (@(Get-VMNetworkAdapterAcl -VMNetworkAdapter $nic -ErrorAction Stop).Count -eq 0) 'legacy_acl_present'
    return $nic
}

function Get-CityGoBootstrapRuleKey {
    param($Rule)
    $addresses=@()
    foreach ($field in @('LocalIPAddress','RemoteIPAddress')) {
        $value=[string]$Rule.$field
        if ($value -ceq '' -or $value -ieq 'ANY') { $value='ANY' }
        elseif ($value -ceq '::/0') { $value='::/0' }
        elseif ($value.Contains('/')) { $null=Get-CityGoBootstrapRange $value }
        else { $null=ConvertTo-CityGoBootstrapIPv4 $value;$value+='/32' }
        $addresses+=$value
    }
    $ports=@()
    foreach ($field in @('LocalPort','RemotePort')) {
        $value=[string]$Rule.$field
        if ($value -ceq '' -or $value -ieq 'ANY') { $value='' }
        else { Assert-CityGoBootstrapNetwork ($value -cmatch '^[0-9]{1,5}$' -and [int]$value -ge 1 -and [int]$value -le 65535) 'acl_port_unexpected';$value=([int]$value).ToString() }
        $ports+=$value
    }
    $protocol=[string]$Rule.Protocol
    if (-not $protocol -or $protocol -ieq 'ANY' -or $protocol -ceq '256') { $protocol='ANY' }
    elseif ($protocol -ceq '6' -or $protocol -ieq 'TCP') { $protocol='TCP' }
    elseif ($protocol -ceq '17' -or $protocol -ieq 'UDP') { $protocol='UDP' }
    else { throw 'acl_protocol_unexpected' }
    Assert-CityGoBootstrapNetwork ([string]$Rule.Direction -cin @('Inbound','Outbound') -and [string]$Rule.Action -cin @('Allow','Deny') -and
        $Rule.Stateful -is [bool] -and $Rule.IsolationID -eq 0) 'acl_shape_invalid'
    # Stateless timeout is unused; the native MOF defaults to 255 when omitted.
    $timeout=0;if ($Rule.Stateful) { $timeout=$Rule.IdleSessionTimeout }
    return (@([string]$Rule.Direction,[string]$Rule.Action,$addresses[0],$addresses[1],$ports[0],$ports[1],$protocol,
        [string]$Rule.Weight,[string]$Rule.Stateful,[string]$timeout,[string]$Rule.IsolationID)-join'|')
}

function Assert-CityGoBootstrapAclReadback {
    param($Adapter,[Collections.IDictionary]$Plan)
    $actual=@(Get-VMNetworkAdapterExtendedAcl -VMNetworkAdapter $Adapter -ErrorAction Stop)
    Assert-CityGoBootstrapNetwork ($actual.Count -eq $Plan.rules.Count) 'acl_readback_count_mismatch'
    $expected=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($rule in $Plan.rules) { Assert-CityGoBootstrapNetwork ($expected.Add((Get-CityGoBootstrapRuleKey $rule))) 'acl_plan_duplicate' }
    foreach ($rule in $actual) {
        Assert-CityGoBootstrapNetwork ($null -ne $rule.ParentAdapter -and [string]$rule.ParentAdapter.Id -ceq $Plan.adapterId -and
            $rule.ParentAdapter.VMId.ToString('D') -ceq $Plan.vmId -and $rule.IsTemplate -eq $false -and $rule.IsDeleted -eq $false) 'acl_readback_owner_invalid'
        Assert-CityGoBootstrapNetwork ($expected.Remove((Get-CityGoBootstrapRuleKey $rule))) 'acl_readback_mismatch'
    }
    Assert-CityGoBootstrapNetwork ($expected.Count -eq 0) 'acl_readback_missing'
}

function Add-CityGoBootstrapNativeAcl {
    param($Adapter,$Rule)
    $parameters=@{VMNetworkAdapter=$Adapter;Action=$Rule.Action;Direction=$Rule.Direction;
        LocalIPAddress=$Rule.LocalIPAddress;RemoteIPAddress=$Rule.RemoteIPAddress;Weight=$Rule.Weight;Stateful=$Rule.Stateful;ErrorAction='Stop'}
    if ($Rule.Protocol -cne 'ANY') { $parameters.Protocol=$Rule.Protocol }
    if ($null -ne $Rule.LocalPort) { $parameters.LocalPort=$Rule.LocalPort }
    if ($null -ne $Rule.RemotePort) { $parameters.RemotePort=$Rule.RemotePort }
    if ($Rule.Stateful) { $parameters.IdleSessionTimeout=$Rule.IdleSessionTimeout }
    $null=Add-VMNetworkAdapterExtendedAcl @parameters
}

function Disconnect-CityGoExactOwnedBootstrapNic {
    param([Collections.IDictionary]$Plan)
    # Recovery does not require Off: disconnect an externally started owned VM
    # too, but never identify an adapter merely by its display name.
    $vms=@(Get-VM -Id ([guid]$Plan.vmId) -ErrorAction Stop)
    Assert-CityGoBootstrapNetwork ($vms.Count -eq 1 -and $vms[0].Name -ceq $Plan.vmName -and
        $vms[0].Path -ieq $Plan.vmConfigurationPath) 'cleanup_owner_unverified'
    $matches=@(Get-VMNetworkAdapter -VM $vms[0] -ErrorAction Stop|Where-Object{
        [string]$_.Id -ceq $Plan.adapterId -and $_.VMId.ToString('D') -ceq $Plan.vmId -and $_.Name -ceq $Plan.adapterName})
    Assert-CityGoBootstrapNetwork ($matches.Count -eq 1) 'cleanup_nic_unverified'
    $null=Disconnect-VMNetworkAdapter -VMNetworkAdapter $matches[0] -ErrorAction Stop
    $after=@(Get-VMNetworkAdapter -VM $vms[0] -ErrorAction Stop|Where-Object{[string]$_.Id -ceq $Plan.adapterId -and $_.VMId.ToString('D') -ceq $Plan.vmId})
    Assert-CityGoBootstrapNetwork ($after.Count -eq 1 -and (-not $after[0].SwitchId -or [guid]$after[0].SwitchId -eq [guid]::Empty) -and
        -not $after[0].SwitchName) 'cleanup_disconnect_unverified'
}

function Write-CityGoBootstrapNetworkResult {
    param([Collections.IDictionary]$Plan,$Result,[string]$OwnerSid)
    $directory=[IO.Path]::GetDirectoryName($Plan.resultPath)
    $null=Assert-CityGoNetworkPlainPath $directory
    Assert-CityGoNetworkPrivateAcl $directory $OwnerSid $true
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Result|ConvertTo-Json -Depth 5 -Compress))
    $file=[IO.File]::Open($Plan.resultPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try { $file.Write($bytes,0,$bytes.Length);$file.Flush($true) } finally { $file.Dispose() }
    Assert-CityGoNetworkPrivateAcl $Plan.resultPath $OwnerSid
}

function Invoke-CityGoBootstrapNetwork {
    param($Inventory,$Creation,$Verification,[Collections.IDictionary]$Request,[datetime]$NowUtc=[datetime]::UtcNow)
    $elapsed=[Diagnostics.Stopwatch]::StartNew()
    $plan=Get-CityGoBootstrapNetworkPlan $Inventory $Creation $Verification $Request $NowUtc
    $result=[ordered]@{schemaVersion=1;scope=$plan.scope;operationId=$plan.operationId;vmId=$plan.vmId;
        adapterId=$plan.adapterId;inventorySha256=$plan.inventorySha256;creationReceiptSha256=$plan.creationReceiptSha256;
        verificationSha256=$plan.verificationSha256;dhcpAdmission=$plan.dhcpAdmission;stage='plan_only_unverified';vmStarted=$false;guestNetworkChanged=$false;
        globalNetworkChanged=$false;guestIsolationVerified=$false;githubRunnerRegistered=$false;githubJobsAuthorized=$false}
    if (-not $Request.apply) { $result.rules=$plan.rules;$result.limitations=$plan.limitations;return $result }
    Assert-CityGoBootstrapNetwork ($Request.acknowledge -ceq $plan.requiredAcknowledgement) 'typed_acknowledgement_required'
    $ownerSid=Get-CityGoNetworkOwnerSid $true
    $null=Assert-CityGoNetworkPlainPath ([IO.Path]::GetDirectoryName($plan.resultPath))
    Assert-CityGoNetworkPrivateAcl ([IO.Path]::GetDirectoryName($plan.resultPath)) $ownerSid $true
    Assert-CityGoBootstrapNetwork (-not (Test-Path -LiteralPath $plan.resultPath -ErrorAction Stop)) 'network_result_already_exists'
    $adapter=Get-CityGoOwnedBootstrapNetworkAdapter $plan $false
    $disk=Assert-CityGoNetworkPlainPath $plan.targetVhdx
    Assert-CityGoBootstrapNetwork (-not $disk.PSIsContainer -and
        (Get-FileHash -LiteralPath $plan.targetVhdx -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant() -ceq $plan.baseSha256) 'owned_disk_hash_changed'
    Assert-CityGoBootstrapNetwork (@(Get-VMNetworkAdapterExtendedAcl -VMNetworkAdapter $adapter -ErrorAction Stop).Count -eq 0) 'existing_extended_acl_refused'
    $switches=@(Get-VMSwitch -Id ([guid]$plan.switchId) -ErrorAction Stop)
    Assert-CityGoBootstrapNetwork ($switches.Count -eq 1 -and $switches[0].Id.ToString('D') -ceq $plan.switchId -and
        $switches[0].Name -ceq 'Default Switch' -and [string]$switches[0].SwitchType -ceq 'Internal' -and
        $switches[0].IovEnabled -eq $false) 'default_switch_readback_invalid'
    # Do not trust a stale host inventory after a VPN/adapter change.
    $currentIps=@(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop|ForEach-Object{[string]$_.IPAddress}|Sort-Object -Unique)
    $capturedIps=@($Inventory.hostIPv4|Sort-Object -Unique)
    Assert-CityGoBootstrapNetwork (($currentIps-join'|') -ceq ($capturedIps-join'|')) 'host_ipv4_inventory_changed'
    $mutated=$false
    try {
        # Ownership and Off/disconnected state are refreshed just before writes.
        $adapter=Get-CityGoOwnedBootstrapNetworkAdapter $plan $false
        Assert-CityGoBootstrapNetwork ($elapsed.Elapsed.TotalSeconds -le $plan.remainingFreshSeconds) 'inventory_expired_before_acl'
        foreach ($rule in $plan.rules) { $mutated=$true;Add-CityGoBootstrapNativeAcl $adapter $rule }
        Assert-CityGoBootstrapAclReadback $adapter $plan
        $adapter=Get-CityGoOwnedBootstrapNetworkAdapter $plan $false
        Assert-CityGoBootstrapNetwork ($elapsed.Elapsed.TotalSeconds -le $plan.remainingFreshSeconds) 'inventory_expired_before_connect'
        $null=Connect-VMNetworkAdapter -VMNetworkAdapter $adapter -VMSwitch $switches[0] -ErrorAction Stop
        $adapter=Get-CityGoOwnedBootstrapNetworkAdapter $plan $true
        Assert-CityGoBootstrapAclReadback $adapter $plan
        $result.stage='bootstrap_connected_vm_off_canaries_pending';$result.guestNetworkChanged=$true
        Write-CityGoBootstrapNetworkResult $plan $result $ownerSid
        return $result
    } catch {
        $result.guestNetworkChanged=$mutated;$result.stage='failed_preserved_disconnect_unverified'
        if ($mutated) {
            try { Disconnect-CityGoExactOwnedBootstrapNic $plan;$result.stage='failed_disconnected_acl_preserved' } catch { }
        }
        try { Write-CityGoBootstrapNetworkResult $plan $result $ownerSid } catch { $result.stage='failed_preserved_result_unavailable' }
        return $result
    }
}

$evidence=@()
try {
    $ownerSid=Get-CityGoNetworkOwnerSid ([bool]$Apply)
    $inventoryEvidence=Read-CityGoBootstrapNetworkEvidence $InventoryPath $ExpectedInventorySha256 $ownerSid;$evidence+=,$inventoryEvidence
    $creationEvidence=Read-CityGoBootstrapNetworkEvidence $CreationReceiptPath $ExpectedCreationReceiptSha256 $ownerSid;$evidence+=,$creationEvidence
    $verificationEvidence=Read-CityGoBootstrapNetworkEvidence $VerificationPath $ExpectedVerificationSha256 $ownerSid;$evidence+=,$verificationEvidence
    $result=Invoke-CityGoBootstrapNetwork $inventoryEvidence.value $creationEvidence.value $verificationEvidence.value ([ordered]@{
        inventoryPath=$InventoryPath;inventorySha256=$ExpectedInventorySha256;creationReceiptPath=$CreationReceiptPath;
        creationReceiptSha256=$ExpectedCreationReceiptSha256;verificationPath=$VerificationPath;verificationSha256=$ExpectedVerificationSha256;
        apply=[bool]$Apply;acknowledge=$Acknowledge})
    $result|ConvertTo-Json -Depth 8 -Compress
    if ($result.stage -like 'failed_*') { exit 1 }
} catch {
    $code='bootstrap_network_precondition_failed'
    if ($_.Exception.Message -cmatch '^[a-z0-9_]{1,80}$') { $code=$_.Exception.Message }
    [ordered]@{schemaVersion=1;scope='trusted_bootstrap_network_only';stage='preconditions_not_met';errorCode=$code;
        guestIsolationVerified=$false;githubRunnerRegistered=$false;githubJobsAuthorized=$false}|ConvertTo-Json -Compress
    exit 2
} finally {
    foreach ($item in $evidence) { if ($item.stream) { $item.stream.Dispose() } }
}
