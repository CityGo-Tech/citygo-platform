# Host-vNIC direct-IP policy for ONE complete, owned, stopped canary.
# Default is an offline plan, NOT evidence that connected isolation works.
# Apply never starts a guest, registers a runner, alters NAT/global firewall,
# replaces existing ACLs, changes a base or touches another VM's configuration.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$InventoryPath,
    [Parameter(Mandatory=$true)][string]$ExpectedInventorySha256,
    [Parameter(Mandatory=$true)][string]$ManifestPath,
    [Parameter(Mandatory=$true)][string]$ExpectedManifestSha256,
    [switch]$Apply,
    [string]$Acknowledge = ''
)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$WarningPreference='SilentlyContinue'
$InformationPreference='SilentlyContinue'
$VerbosePreference='SilentlyContinue'
$DebugPreference='SilentlyContinue'

function Assert-CityGoCanaryNetwork {
    param([bool]$Condition,[string]$Code)
    if (-not $Condition) { throw $Code }
}

function Get-CityGoCanaryNetworkLibraries {
    # Immutable source pins; only these selected function definitions are
    # loaded. No public helper entrypoint, arbitrary path or dot-source runs.
    return @(
        @{name='New-CityGoRunnerNetworkPlan.ps1';sha='d844e37e691d0d3621d62df5447ccdb7b9312153155ffac72ec650ff02b78f69';functions=@(
            'Assert-CityGoNetworkValue','ConvertTo-CityGoIPv4','ConvertTo-CityGoIPv4Text','Get-CityGoIPv4Range',
            'Get-CityGoStringArray','Add-CityGoNetworkRule','Get-CityGoRunnerNetworkPlan')},
        @{name='Set-CityGoBootstrapNetwork.ps1';sha='196de5768a48a983959376ea49347b005752a5cd02822c4d0f0df3b355d2fc83';functions=@(
            'Assert-CityGoBootstrapNetwork','Get-CityGoNetworkLocalPath','Assert-CityGoNetworkPlainPath','Get-CityGoNetworkOwnerSid',
            'Assert-CityGoNetworkPrivateAcl','Read-CityGoBootstrapNetworkEvidence','ConvertFrom-CityGoBootstrapNetworkJson',
            'Assert-CityGoNetworkKeys','Assert-CityGoNetworkGuid','ConvertTo-CityGoBootstrapIPv4','Get-CityGoBootstrapRange',
            'Get-CityGoBootstrapRuleKey','Assert-CityGoBootstrapAclReadback','Add-CityGoBootstrapNativeAcl',
            'Disconnect-CityGoExactOwnedBootstrapNic','Write-CityGoBootstrapNetworkResult')},
        @{name='Remove-CityGoCanaryVm.ps1';sha='70f036f9b6c9885f6cfd15f5a362883b7bf72803dddf5d6fe28fc17c29bea098';functions=@(
            'Assert-CityGoCanaryCleanup','Get-CityGoCanaryCleanupPath','Assert-CityGoCanaryCleanupPlainPath',
            'Assert-CityGoCanaryCleanupGuid','Get-CityGoCanaryCreationFields','Get-CityGoCanaryCleanupPlan',
            'Assert-CityGoCanaryResumeCleanupEvidence','Assert-CityGoCanaryCleanupForeignDisk',
            'Get-CityGoCanaryCleanupVm','Test-CityGoCanaryCleanupDisk')}
    )
}

function Open-CityGoCanaryNetworkLibrary {
    param([string]$Directory,$Library)
    Assert-CityGoCanaryNetwork ($Directory -cmatch '^[A-Za-z]:\\' -and [IO.Path]::IsPathRooted($Directory) -and
        $Library.name -cin @('New-CityGoRunnerNetworkPlan.ps1','Set-CityGoBootstrapNetwork.ps1','Remove-CityGoCanaryVm.ps1') -and
        $Library.sha -cmatch '^[a-f0-9]{64}$') 'library_path_invalid'
    $path=[IO.Path]::Combine($Directory,$Library.name)
    $file=Get-Item -LiteralPath $path -ErrorAction Stop
    Assert-CityGoCanaryNetwork (-not $file.PSIsContainer -and $file.PSProvider.Name -ceq 'FileSystem' -and
        ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) 'library_file_not_plain'
    # A public checkout may have a OneDrive ancestor. Its bytes are untrusted
    # until the exact reviewed SHA matches; source is never executed as a file.
    $stream=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try {
        Assert-CityGoCanaryNetwork ($stream.Length -gt 0 -and $stream.Length -le 131072) 'library_size_invalid'
        $sha=[Security.Cryptography.SHA256]::Create()
        try { $hash=([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
        Assert-CityGoCanaryNetwork ($hash -ceq $Library.sha) 'library_hash_mismatch'
        $stream.Position=0
        $reader=[IO.StreamReader]::new($stream,[Text.UTF8Encoding]::new($false,$true),$true,4096,$true)
        try { $source=$reader.ReadToEnd() } finally { $reader.Dispose() }
        $tokens=$null;$errors=$null
        $ast=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors)
        Assert-CityGoCanaryNetwork ($errors.Count -eq 0) 'library_parse_failed'
        $definitions=@()
        foreach ($name in $Library.functions) {
            $matches=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst]},$true)|Where-Object{$_.Name -ceq $name})
            Assert-CityGoCanaryNetwork ($matches.Count -eq 1 -and $matches[0].Parent -is [Management.Automation.Language.NamedBlockAst]) 'library_function_invalid'
            $definitions+=,$matches[0].Extent.Text
        }
        return [ordered]@{stream=$stream;definitions=$definitions}
    } catch { $stream.Dispose();throw }
}

function Get-CityGoCanaryNetworkInventoryFields {
    return @('schemaVersion','capturedAt','operationId','vmId','guestAdapterId','guestAdapterName','switchId','switchName',
        'switchType','switchKind','gatewayCidr','capturedDhcpServerIPv4','hostIPv4','lanVpnPrefixes','productionIPv4',
        'productionDnsIPv4','productionDnsIPv6','routeFingerprintSha256','inventoriesComplete','guestNicCount','natVerified',
        'macSpoofingEnabled','dhcpGuardEnabled','routerGuardEnabled','sriovEnabled','devicePassthroughEnabled',
        'extendedAclSupported','statefulAclSupported','ipv6AclSupported','idleSessionTimeoutSupported')
}

function Get-CityGoCanaryNetworkPlan {
    param($Inventory,$Manifest,[Collections.IDictionary]$Request,[datetime]$NowUtc)
    Assert-CityGoNetworkKeys $Inventory (Get-CityGoCanaryNetworkInventoryFields)
    $ownership=Get-CityGoCanaryCleanupPlan $Manifest ([ordered]@{manifestPath=$Request.manifestPath;manifestSha256=$Request.manifestSha256})
    Assert-CityGoCanaryNetwork ($Inventory.operationId -ceq $ownership.operationId -and $Inventory.vmId -ceq $ownership.vmId -and
        $Inventory.guestAdapterId -ceq $ownership.nicId -and $Inventory.guestAdapterName -ceq $ownership.nicName) 'inventory_creation_binding_mismatch'
    Assert-CityGoCanaryNetwork ($Inventory.switchKind -ceq 'DefaultSwitch' -and $Inventory.switchName -ceq 'Default Switch') 'only_existing_default_switch_admitted'
    Assert-CityGoCanaryNetwork ($Inventory.routeFingerprintSha256 -is [string] -and $Inventory.routeFingerprintSha256 -cmatch '^[a-f0-9]{64}$') 'route_fingerprint_required'
    $production=Get-CityGoStringArray $Inventory.productionIPv4 'address' 1
    $dns4=Get-CityGoStringArray $Inventory.productionDnsIPv4 'address' 1
    foreach ($address in $dns4) { Assert-CityGoCanaryNetwork ($production -ccontains $address) 'production_dns_not_denied' }
    Assert-CityGoCanaryNetwork ($Inventory.productionDnsIPv6 -is [array] -and $Inventory.productionDnsIPv6.Count -le 64) 'production_dns_ipv6_invalid'
    $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($address in $Inventory.productionDnsIPv6) {
        $parsed=$null
        Assert-CityGoCanaryNetwork ($address -is [string] -and [Net.IPAddress]::TryParse($address,[ref]$parsed) -and
            $parsed.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetworkV6 -and $address -ceq $parsed.ToString() -and
            $seen.Add($address)) 'production_dns_ipv6_invalid'
    }
    # Convert only the already-manifest-bound NIC tail to the pure planner's
    # original GUID field. Native operations always retain the full exact ID.
    $tail=$ownership.nicId.Substring($ownership.nicId.LastIndexOf('\')+1).ToLowerInvariant()
    $pure=[ordered]@{}
    foreach ($field in @('schemaVersion','capturedAt','switchId','switchType','switchKind','gatewayCidr','natVerified',
        'hostIPv4','lanVpnPrefixes','productionIPv4','inventoriesComplete','guestNicCount','macSpoofingEnabled',
        'dhcpGuardEnabled','routerGuardEnabled','sriovEnabled','devicePassthroughEnabled','extendedAclSupported',
        'statefulAclSupported','ipv6AclSupported','idleSessionTimeoutSupported','capturedDhcpServerIPv4')) { $pure[$field]=$Inventory.$field }
    $pure.guestAdapterId=$tail
    $proposal=Get-CityGoRunnerNetworkPlan ([pscustomobject]$pure) $Request.inventorySha256 $NowUtc
    # DHCP deliberately outranks host-subnet denies. Never permit the narrow
    # DHCP exception to override a contradictory production address denial.
    Assert-CityGoCanaryNetwork ($production -cnotcontains $Inventory.capturedDhcpServerIPv4) 'dhcp_production_collision'
    foreach ($hash in @($Request.inventorySha256,$Request.manifestSha256)) { Assert-CityGoCanaryNetwork ($hash -cmatch '^[a-f0-9]{64}$') 'evidence_hash_required' }
    $control=$ownership.controlDirectory
    Assert-CityGoCanaryNetwork ($Request.inventoryPath -ceq ($control+'\canary-network-inventory.json')) 'inventory_path_binding_invalid'
    $ownership.adapterId=$ownership.nicId;$ownership.adapterName=$ownership.nicName;$ownership.vmConfigurationPath=$ownership.vmPath
    $ownership.switchId=$Inventory.switchId;$ownership.switchName=$Inventory.switchName
    $ownership.inventorySha256=$Request.inventorySha256;$ownership.resultPath=$control+'\canary-network-result.json'
    $ownership.scope='owned_canary_direct_ip_network_policy'
    $ownership.rules=@($proposal.rules|ForEach-Object{
        [ordered]@{Weight=$_.weight;Direction=$_.direction;Action=$_.action;RemoteIPAddress=$_.remoteIPAddress;
            LocalIPAddress=$_.localIPAddress;Protocol=$_.protocol;RemotePort=$_.remotePort;LocalPort=$_.localPort;
            Stateful=$_.stateful;IdleSessionTimeout=$_.idleSessionTimeout;IsolationID=0}
    })
    $ownership.remainingFreshSeconds=900-($NowUtc.ToUniversalTime()-[datetime]::Parse($Inventory.capturedAt,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::AdjustToUniversal)).TotalSeconds
    $ownership.requiredAcknowledgement='CONNECT_OWNED_CANARY_CI_POLICY:'+$ownership.vmId+':'+$Request.inventorySha256+':'+$Request.manifestSha256
    return $ownership
}

function Get-CityGoCanaryRouteFingerprint {
    # Include both families and all active-store route rows, not only prefixes
    # heuristically called LAN. VPN/full-tunnel classification is external.
    $rows=@(Get-NetRoute -PolicyStore ActiveStore -ErrorAction Stop|Where-Object{[string]$_.State -cne 'Dead'}|ForEach-Object{
        Assert-CityGoCanaryNetwork ([string]$_.AddressFamily -cin @('IPv4','IPv6') -and $_.InterfaceIndex -gt 0 -and
            [string]$_.DestinationPrefix -cmatch '^[a-fA-F0-9.:/]+$' -and [string]$_.NextHop -cmatch '^[a-fA-F0-9.:]+$' -and
            $_.RouteMetric -ge 0 -and [string]$_.Protocol -cmatch '^[A-Za-z0-9]+$') 'route_readback_invalid'
        (@([string]$_.AddressFamily,[string]$_.InterfaceIndex,[string]$_.DestinationPrefix,[string]$_.NextHop,[string]$_.RouteMetric,[string]$_.Protocol)-join'|')
    }|Sort-Object)
    Assert-CityGoCanaryNetwork ($rows.Count -ge 1 -and $rows.Count -le 4096) 'route_inventory_size_invalid'
    $sha=[Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes(($rows-join"`n"))))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
}

function Assert-CityGoCanaryFreshNetwork {
    param($Inventory,[Collections.IDictionary]$Plan,[datetime]$NowUtc=[datetime]::UtcNow)
    $captured=[datetime]::Parse($Inventory.capturedAt,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::AdjustToUniversal)
    $age=($NowUtc.ToUniversalTime()-$captured).TotalSeconds
    Assert-CityGoCanaryNetwork ($age -ge 0 -and $age -le 900) 'inventory_expired'
    $ips=@(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop|ForEach-Object{[string]$_.IPAddress}|Sort-Object -Unique)
    Assert-CityGoCanaryNetwork (($ips-join'|') -ceq (@($Inventory.hostIPv4|Sort-Object -Unique)-join'|')) 'host_ipv4_changed'
    Assert-CityGoCanaryNetwork ((Get-CityGoCanaryRouteFingerprint) -ceq $Inventory.routeFingerprintSha256) 'host_routes_changed'
    $switches=@(Get-VMSwitch -Id ([guid]$Plan.switchId) -ErrorAction Stop)
    Assert-CityGoCanaryNetwork ($switches.Count -eq 1 -and $switches[0].Id.ToString('D') -ceq $Plan.switchId -and
        $switches[0].Name -ceq 'Default Switch' -and [string]$switches[0].SwitchType -ceq 'Internal' -and
        $switches[0].IovEnabled -is [bool] -and -not $switches[0].IovEnabled) 'default_switch_changed'
    $hns=@(Get-HnsNetwork -ErrorAction Stop|Where-Object{[string]$_.ID -ieq $Plan.switchId})
    Assert-CityGoCanaryNetwork ($hns.Count -eq 1 -and $hns[0].Name -ceq 'Default Switch' -and $hns[0].Type -ceq 'ICS' -and
        @($hns[0].Subnets).Count -eq 1) 'hns_network_changed'
    $range=Get-CityGoIPv4Range $Inventory.gatewayCidr $false
    Assert-CityGoCanaryNetwork ([string]$hns[0].Subnets[0].AddressPrefix -ceq $range.network -and
        [string]$hns[0].Subnets[0].GatewayAddress -ceq $Inventory.gatewayCidr.Split('/')[0]) 'hns_subnet_changed'
    $dns4=@();$dns6=@()
    # Project-controlled literals only. No production HTTP/SSH/API request.
    foreach ($name in @('app.xn--c1ajazlh.xn--p1ai','pilot.xn--c1ajazlh.xn--p1ai')) {
        $answers=@(Resolve-DnsName -Name $name -Type A_AAAA -DnsOnly -NoHostsFile -ErrorAction Stop|Where-Object{[string]$_.Type -cin @('A','AAAA')})
        Assert-CityGoCanaryNetwork ($answers.Count -ge 1 -and $answers.Count -le 64) 'production_dns_unavailable'
        foreach ($answer in $answers) {
            $address=$null
            Assert-CityGoCanaryNetwork ([Net.IPAddress]::TryParse([string]$answer.IPAddress,[ref]$address)) 'production_dns_invalid'
            if ($address.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetwork) { $dns4+=,$address.ToString() }
            elseif ($address.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetworkV6) { $dns6+=,$address.ToString() }
            else { throw 'production_dns_invalid' }
        }
    }
    Assert-CityGoCanaryNetwork ((@($dns4|Sort-Object -Unique)-join'|') -ceq (@($Inventory.productionDnsIPv4|Sort-Object)-join'|') -and
        (@($dns6|Sort-Object -Unique)-join'|') -ceq (@($Inventory.productionDnsIPv6|Sort-Object)-join'|')) 'production_dns_changed'
    return $switches[0]
}

function Get-CityGoCanaryNetworkAdapter {
    param([Collections.IDictionary]$Plan,[bool]$Connected)
    # Reuse the complete manifest/native disk/foreign-parent-chain safeguards,
    # never the cleanup mutator or an existence inferred from an exception.
    $vm=Get-CityGoCanaryCleanupVm $Plan
    Assert-CityGoCanaryNetwork ($null -ne $vm -and (Test-CityGoCanaryCleanupDisk $Plan)) 'owned_canary_unavailable'
    Assert-CityGoCanaryNetwork ($vm.ProcessorCount -eq 4 -and $vm.MemoryStartup -eq 6GB -and
        $vm.DynamicMemoryEnabled -is [bool] -and -not $vm.DynamicMemoryEnabled -and
        [string]$vm.AutomaticStartAction -ceq 'Nothing' -and [string]$vm.CheckpointType -ceq 'Disabled' -and
        $vm.AutomaticCheckpointsEnabled -is [bool] -and -not $vm.AutomaticCheckpointsEnabled) 'owned_canary_configuration_changed'
    $firmware=Get-VMFirmware -VM $vm -ErrorAction Stop
    Assert-CityGoCanaryNetwork ([string]$firmware.SecureBoot -ceq 'On' -and
        [string]$firmware.SecureBootTemplate -ceq 'MicrosoftUEFICertificateAuthority') 'owned_canary_firmware_changed'
    $nics=@(Get-VMNetworkAdapter -VM $vm -ErrorAction Stop)
    Assert-CityGoCanaryNetwork ($nics.Count -eq 1) 'owned_canary_nic_count_changed'
    $nic=$nics[0]
    Assert-CityGoCanaryNetwork ([string]$nic.Id -ceq $Plan.adapterId -and $nic.VMId.ToString('D') -ceq $Plan.vmId -and
        $nic.Name -ceq $Plan.adapterName -and [string]$nic.MacAddressSpoofing -ceq 'Off' -and [string]$nic.DhcpGuard -ceq 'On' -and
        [string]$nic.RouterGuard -ceq 'On' -and $nic.IovQueuePairsAssigned -eq 0 -and $nic.IovUsage -eq 0 -and
        [string]$nic.PortMirroringMode -ceq 'None' -and [string]$nic.AllowTeaming -ceq 'Off') 'owned_canary_nic_changed'
    if ($Connected) {
        Assert-CityGoCanaryNetwork ($nic.SwitchId -and $nic.SwitchId.ToString('D') -ceq $Plan.switchId -and $nic.SwitchName -ceq $Plan.switchName) 'owned_canary_wrong_switch'
    } else { Assert-CityGoCanaryNetwork ((-not $nic.SwitchId -or [guid]$nic.SwitchId -eq [guid]::Empty) -and -not $nic.SwitchName) 'owned_canary_already_connected' }
    $vlan=Get-VMNetworkAdapterVlan -VMNetworkAdapter $nic -ErrorAction Stop
    $isolation=Get-VMNetworkAdapterIsolation -VMNetworkAdapter $nic -ErrorAction Stop
    Assert-CityGoCanaryNetwork ([string]$vlan.OperationMode -ceq 'Untagged' -and [string]$isolation.IsolationMode -ceq 'None' -and
        @(Get-VMNetworkAdapterAcl -VMNetworkAdapter $nic -ErrorAction Stop).Count -eq 0) 'owned_canary_vlan_or_legacy_acl_changed'
    return $nic
}

function Assert-CityGoCanaryNetworkCapabilities {
    $command=Get-Command Add-VMNetworkAdapterExtendedAcl -ErrorAction Stop
    foreach ($name in @('VMNetworkAdapter','Action','Direction','LocalIPAddress','RemoteIPAddress','Weight','Stateful','Protocol','LocalPort','RemotePort','IdleSessionTimeout')) {
        Assert-CityGoCanaryNetwork ($command.Parameters.ContainsKey($name)) 'native_extended_acl_capability_missing'
    }
    foreach ($name in @('Get-VMNetworkAdapterExtendedAcl','Connect-VMNetworkAdapter','Disconnect-VMNetworkAdapter','Get-HnsNetwork')) {
        $null=Get-Command $name -ErrorAction Stop
    }
}

function Invoke-CityGoCanaryNetwork {
    param($Inventory,$Manifest,[Collections.IDictionary]$Request,[datetime]$NowUtc=[datetime]::UtcNow)
    $plan=Get-CityGoCanaryNetworkPlan $Inventory $Manifest $Request $NowUtc
    $result=[ordered]@{schemaVersion=1;scope=$plan.scope;operationId=$plan.operationId;vmId=$plan.vmId;adapterId=$plan.adapterId;
        inventorySha256=$plan.inventorySha256;creationManifestSha256=$plan.manifestSha256;stage='plan_only_unverified';
        vmStarted=$false;guestNetworkChanged=$false;globalNetworkChanged=$false;guestIsolationVerified=$false;
        githubRunnerRegistered=$false;githubJobsAuthorized=$false}
    $evidence=@()
    try {
        $owner=Get-CityGoNetworkOwnerSid ([bool]$Request.apply)
        if ($plan.resumedCreation) {
            $initial=Read-CityGoBootstrapNetworkEvidence $plan.initialCreationReceiptPath $plan.initialCreationReceiptSha256 $owner;$evidence+=,$initial
            $verification=Read-CityGoBootstrapNetworkEvidence $plan.resumeVerificationPath $plan.resumeVerificationSha256 $owner;$evidence+=,$verification
            Assert-CityGoCanaryResumeCleanupEvidence $initial.value $verification.value $Manifest $plan
        }
        if (-not $Request.apply) { $result.rules=$plan.rules;return $result }
        Assert-CityGoCanaryNetwork ($Request.acknowledge -ceq $plan.requiredAcknowledgement) 'typed_acknowledgement_required'
        $null=Assert-CityGoNetworkPlainPath $plan.controlDirectory
        Assert-CityGoNetworkPrivateAcl $plan.controlDirectory $owner $true
        foreach ($path in @($plan.resultPath,$plan.intentPath,($plan.controlDirectory+'\canary-cleanup-result.json'))) {
            Assert-CityGoCanaryNetwork (-not (Test-Path -LiteralPath $path -ErrorAction Stop)) 'network_or_cleanup_already_recorded'
        }
        Assert-CityGoCanaryNetworkCapabilities
        $adapter=Get-CityGoCanaryNetworkAdapter $plan $false
        Assert-CityGoCanaryNetwork (@(Get-VMNetworkAdapterExtendedAcl -VMNetworkAdapter $adapter -ErrorAction Stop).Count -eq 0) 'existing_extended_acl_refused'
        $null=Assert-CityGoCanaryFreshNetwork $Inventory $plan
        $mutated=$false;$phase='before_acl'
        try {
            $adapter=Get-CityGoCanaryNetworkAdapter $plan $false
            $phase='add_owned_acl'
            foreach ($rule in $plan.rules) { $mutated=$true;Add-CityGoBootstrapNativeAcl $adapter $rule }
            $phase='readback_owned_acl';Assert-CityGoBootstrapAclReadback $adapter $plan
            $adapter=Get-CityGoCanaryNetworkAdapter $plan $false
            $switch=Assert-CityGoCanaryFreshNetwork $Inventory $plan
            $phase='connect_exact_owned_nic'
            $null=Connect-VMNetworkAdapter -VMNetworkAdapter $adapter -VMSwitch $switch -ErrorAction Stop
            $phase='readback_connected_policy'
            $adapter=Get-CityGoCanaryNetworkAdapter $plan $true
            Assert-CityGoBootstrapAclReadback $adapter $plan
            $null=Assert-CityGoCanaryFreshNetwork $Inventory $plan
            $result.stage='ci_policy_connected_vm_off_acceptance_pending';$result.guestNetworkChanged=$true
            $phase='write_result';Write-CityGoBootstrapNetworkResult $plan $result $owner
            return $result
        } catch {
            $result.guestNetworkChanged=$mutated;$result.stage='failed_preserved_disconnect_unverified'
            $result.failurePhase=$phase;$result.failureCode='owned_network_apply_failed'
            if ($_.Exception.Message -cmatch '^[a-z0-9_]{1,80}$') { $result.failureCode=$_.Exception.Message }
            if ($mutated) {
                try { Disconnect-CityGoExactOwnedBootstrapNic $plan;$result.stage='failed_disconnected_acl_preserved' } catch { }
            }
            try { Write-CityGoBootstrapNetworkResult $plan $result $owner } catch { $result.stage='failed_preserved_result_unavailable' }
            return $result
        }
    } finally { foreach ($item in $evidence) { if ($item.stream) { $item.stream.Dispose() } } }
}

$locks=@()
try {
    # Imports are exact reviewed byte snapshots, held locked until completion.
    foreach ($library in @(Get-CityGoCanaryNetworkLibraries)) {
        $loaded=Open-CityGoCanaryNetworkLibrary $PSScriptRoot $library;$locks+=,$loaded
        foreach ($definition in $loaded.definitions) { . ([scriptblock]::Create($definition)) }
    }
    $owner=Get-CityGoNetworkOwnerSid ([bool]$Apply)
    $inventory=Read-CityGoBootstrapNetworkEvidence $InventoryPath $ExpectedInventorySha256 $owner;$locks+=,$inventory
    $manifest=Read-CityGoBootstrapNetworkEvidence $ManifestPath $ExpectedManifestSha256 $owner;$locks+=,$manifest
    $result=Invoke-CityGoCanaryNetwork $inventory.value $manifest.value ([ordered]@{
        inventoryPath=$InventoryPath;inventorySha256=$ExpectedInventorySha256;manifestPath=$ManifestPath;
        manifestSha256=$ExpectedManifestSha256;apply=[bool]$Apply;acknowledge=$Acknowledge})
    $result|ConvertTo-Json -Depth 8 -Compress
    if ($result.stage -like 'failed_*') { exit 1 }
} catch {
    $code='canary_network_precondition_failed'
    if ($_.Exception.Message -cmatch '^[a-z0-9_]{1,80}$') { $code=$_.Exception.Message }
    [ordered]@{schemaVersion=1;scope='owned_canary_direct_ip_network_policy';stage='preconditions_not_met';errorCode=$code;
        guestIsolationVerified=$false;githubRunnerRegistered=$false;githubJobsAuthorized=$false}|ConvertTo-Json -Compress
    exit 2
} finally { foreach ($item in $locks) { if ($item.stream) { $item.stream.Dispose() } } }
