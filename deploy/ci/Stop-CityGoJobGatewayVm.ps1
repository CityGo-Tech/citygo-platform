# Trusted HOST only: stop one complete two-NIC disposable gateway, no deletion.
# Empty DVD and both exact ports disconnected are mandatory before shutdown.
# Reuses pinned durable shutdown/CIM/fallback protocol; never changes a base.
[CmdletBinding()]
param([string]$OperationId='',[string]$VmId='',[string]$ExpectedManifestSha256='',[string]$ExpectedGatewaySha256='',
    [int]$GraceSeconds=30,[int]$TurnOffSeconds=30,[switch]$Apply,[string]$Acknowledge='')
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'

function Get-CityGoJobGatewayStopPlan {
    param([Collections.IDictionary]$Request)
    foreach($key in @('operationId','vmId')){
        if($Request[$key]-isnot[string]-or$Request[$key]-cnotmatch'^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'){throw 'ci_gateway_stop_identity'}
    }
    foreach($key in @('manifestSha256','gatewaySha256')){
        if($Request[$key]-isnot[string]-or$Request[$key]-cnotmatch'^[a-f0-9]{64}$'){throw 'ci_gateway_stop_hash'}
    }
    if($Request.graceSeconds-isnot[int]-or$Request.graceSeconds-lt1-or$Request.graceSeconds-gt120-or
        $Request.turnOffSeconds-isnot[int]-or$Request.turnOffSeconds-lt1-or$Request.turnOffSeconds-gt60){throw 'ci_gateway_stop_bounds'}
    $dir='D:\CityGo-CI\control\'+$Request.operationId
    return [ordered]@{operationId=$Request.operationId;vmId=$Request.vmId;manifestSha256=$Request.manifestSha256;gatewaySha256=$Request.gatewaySha256;
        graceSeconds=$Request.graceSeconds;turnOffSeconds=$Request.turnOffSeconds;controlDirectory=$dir;
        manifestPath=($dir+'\canary-creation.json');gatewayPath=($dir+'\gateway-creation.json');bindingPath=($dir+'\gateway-stop-binding.json');
        requiredAcknowledgement=('STOP_JOB_GATEWAY:'+$Request.vmId+':'+$Request.manifestSha256+':'+$Request.gatewaySha256+':ALLOW_TURNOFF_AFTER_'+$Request.graceSeconds+'S')}
}

function Open-CityGoJobGatewayStopLibrary {
    param([string]$Name,[string]$Hash)
    $pins=@{
        'Stop-CityGoOwnedCanaryVm.ps1'='ce0117bb7e94af9a7610af3534bd16adc69e9e08b915a78af8072e546abe4f56';
        'Remove-CityGoCanaryVm.ps1'='70f036f9b6c9885f6cfd15f5a362883b7bf72803dddf5d6fe28fc17c29bea098';
        'Remove-CityGoJobGateway.ps1'='26cd73f88b65582a1efadfbbe22904233644bc9277863fb90a2dd5d69d552203'
    }
    if(-not$pins.ContainsKey($Name)-or$pins[$Name]-cne$Hash){throw 'ci_gateway_stop_library_not_allowed'}
    $path=Join-Path $PSScriptRoot $Name
    $stream=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try{
        if($stream.Length-lt1-or$stream.Length-gt131072){throw 'ci_gateway_stop_library_size'}
        $sha=[Security.Cryptography.SHA256]::Create()
        try{$actual=([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
        if($actual-cne$Hash){throw 'ci_gateway_stop_library_pin'}
        $stream.Position=0;$reader=[IO.StreamReader]::new($stream,[Text.UTF8Encoding]::new($false,$true),$false,4096,$true)
        try{$source=$reader.ReadToEnd()}finally{$reader.Dispose()}
        $tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseInput($source,$path,[ref]$tokens,[ref]$errors)
        if($errors.Count){throw 'ci_gateway_stop_library_parse'}
        foreach($d in $ast.FindAll({param($n)$n-is[Management.Automation.Language.FunctionDefinitionAst]},$true)){
            if($d.Parent-isnot[Management.Automation.Language.NamedBlockAst]-or$d.Parameters.Count){throw 'ci_gateway_stop_library_definition'}
            Set-Item ('Function:script:'+$d.Name) -Value $d.Body.GetScriptBlock()
        }
        return $stream
    }catch{$stream.Dispose();throw}
}

function Set-CityGoJobGatewayStopBinding {
    param($Plan,[string]$Owner)
    $expected=[ordered]@{version=1;scope='owned_gateway_stop_binding';operationId=$Plan.operationId;vmId=$Plan.vmId;
        manifestSha256=$Plan.manifestSha256;gatewaySha256=$Plan.gatewaySha256;graceSeconds=$Plan.graceSeconds;turnOffSeconds=$Plan.turnOffSeconds}
    if(Test-Path -LiteralPath $Plan.bindingPath){
        $record=Open-CityGoCanaryCleanupEvidence $Plan.bindingPath $Owner
        try{
            $keys=@($record.value.PSObject.Properties.Name)
            if($keys.Count-ne$expected.Count-or@($keys|Where-Object{$_-cnotin$expected.Keys}).Count){throw 'ci_gateway_stop_binding_changed'}
            foreach($key in $expected.Keys){
                $value=$record.value.$key;$wanted=$expected[$key]
                if($wanted-is[int]){
                    if(($value-isnot[int]-and$value-isnot[long])-or$value-ne$wanted){throw 'ci_gateway_stop_binding_changed'}
                }elseif($value-isnot[string]-or$value-cne$wanted){throw 'ci_gateway_stop_binding_changed'}
            }
        }finally{$record.stream.Dispose()}
        return
    }
    # A legacy/partial unbound shutdown attempt is never adopted as a gateway.
    foreach($name in @('canary-stop-intent.json','canary-stop-turnoff-intent.json','canary-stop-result.json')){
        if(Test-Path -LiteralPath ($Plan.controlDirectory+'\'+$name)){throw 'ci_gateway_stop_unbound_attempt'}
    }
    Assert-CityGoCanaryStopPlainPath $Plan.controlDirectory $true
    Assert-CityGoCanaryStopAcl $Plan.controlDirectory $Owner $true
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($expected|ConvertTo-Json -Compress))
    $stream=[IO.File]::Open($Plan.bindingPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
}

function Get-CityGoJobGatewayStopNative {
    param([Collections.IDictionary]$Plan,[switch]$ObserveStopping,[switch]$AllowConnected)
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
            $vm.ProcessorCount -eq 2 -and $vm.MemoryStartup -eq 2GB -and $vm.DynamicMemoryEnabled -eq $false -and
            [string]$vm.AutomaticStopAction -ceq 'TurnOff' -and [string]$vm.AutomaticStartAction -ceq 'Nothing' -and [string]$vm.CheckpointType -ceq 'Disabled' -and
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
        Assert-CityGoCanaryStop ($nics.Count -eq 2) 'gateway_nic_count_changed'
        foreach($role in @('wan','lan')){
            if($role-ceq'wan'){$id=$Plan.nicId;$name=$Plan.nicName;$mac=$Plan.wanMac;$switch=$Plan.wanSwitchId}
            else{$id=$Plan.lanNicId;$name=$Plan.lanNicName;$mac=$Plan.lanMac;$switch=$Plan.privateSwitchId}
            $found=@($nics|Where-Object{[string]$_.Id-ceq$id})
            Assert-CityGoCanaryStop ($found.Count-eq1) 'gateway_nic_changed'
            $nic=$found[0]
            Assert-CityGoCanaryStop ($nic.VMId.ToString('D')-ceq$Plan.vmId-and$nic.Name-ceq$name-and
                [string]$nic.MacAddress-ieq$mac.Replace(':','')-and$nic.DynamicMacAddressEnabled-eq$false-and
                [string]$nic.MacAddressSpoofing-ceq'Off'-and[string]$nic.DhcpGuard-ceq'On'-and[string]$nic.RouterGuard-ceq'On'-and
                $nic.IovWeight-eq0-and$nic.IovQueuePairsAssigned-eq0-and$nic.IovUsage-eq0-and
                [string]$nic.PortMirroringMode-ceq'None'-and[string]$nic.AllowTeaming-ceq'Off') 'gateway_nic_guards_changed'
            $connected=$nic.SwitchId-and[guid]$nic.SwitchId-ne[guid]::Empty
            Assert-CityGoCanaryStop ((-not$connected-and-not$nic.SwitchName)-or
                ($AllowConnected-and$connected-and$switch-is[string]-and([guid]$nic.SwitchId).ToString('D')-ceq$switch)) 'gateway_port_not_closed'
            $sameNics=@(Get-VMNetworkAdapter -All -ErrorAction Stop|Where-Object{[string]$_.Id-ieq$id})
            Assert-CityGoCanaryStop ($sameNics.Count-eq1-and$sameNics[0].VMId.ToString('D')-ceq$Plan.vmId) 'gateway_nic_not_unique'
            $vlan=Get-VMNetworkAdapterVlan -VMNetworkAdapter $nic -ErrorAction Stop
            $isolation=Get-VMNetworkAdapterIsolation -VMNetworkAdapter $nic -ErrorAction Stop
            Assert-CityGoCanaryStop ([string]$vlan.OperationMode-ceq'Untagged'-and[string]$isolation.IsolationMode-ceq'None') 'gateway_extra_isolation_refused'
        }
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

function Invoke-CityGoJobGatewayStop {
    param([Collections.IDictionary]$Request)
    $plan=Get-CityGoJobGatewayStopPlan $Request
    if(-not$Request.apply){return @{stage='plan_only_unverified';vmOff=$false;plan=$plan}}
    if($Request.acknowledge-cne$plan.requiredAcknowledgement){throw 'ci_gateway_stop_acknowledgement'}
    $held=@();$original=$null;$phase='pinned_libraries'
    try{
        foreach($entry in @(
            @('Stop-CityGoOwnedCanaryVm.ps1','ce0117bb7e94af9a7610af3534bd16adc69e9e08b915a78af8072e546abe4f56'),
            @('Remove-CityGoCanaryVm.ps1','70f036f9b6c9885f6cfd15f5a362883b7bf72803dddf5d6fe28fc17c29bea098'),
            @('Remove-CityGoJobGateway.ps1','26cd73f88b65582a1efadfbbe22904233644bc9277863fb90a2dd5d69d552203'))){
            $held+=,(Open-CityGoJobGatewayStopLibrary $entry[0] $entry[1])
        }
        $owner=Get-CityGoCanaryStopOwner
        Assert-CityGoCanaryStopPlainPath $PSScriptRoot $true;Assert-CityGoCanaryStopAcl $PSScriptRoot $owner $true
        $phase='complete_gateway_evidence'
        $m=Open-CityGoCanaryCleanupEvidence $plan.manifestPath $owner $plan.manifestSha256;$held+=,$m.stream
        $g=Open-CityGoCanaryCleanupEvidence $plan.gatewayPath $owner $plan.gatewaySha256;$held+=,$g.stream
        $binding=Get-CityGoCanaryCleanupPlan $m.value @{manifestPath=$plan.manifestPath;manifestSha256=$plan.manifestSha256}
        if($binding.vmId-cne$plan.vmId){throw 'ci_gateway_stop_vm_changed'}
        Assert-CityGoJobGatewayReceipt $g.value $binding $plan
        $profile=[ordered]@{};foreach($key in $binding.Keys){$profile[$key]=$binding[$key]}
        foreach($key in @('wanMac','lanMac','lanNicId','lanNicName')){$profile[$key]=$g.value.$key}
        $profile.seedPath=$null
        $phase='initial_off_or_running_closed_gateway'
        $null=Get-CityGoJobGatewayStopNative $profile
        $phase='durable_gateway_stop_binding';Set-CityGoJobGatewayStopBinding $plan $owner
        $original=(Get-Item Function:Get-CityGoCanaryStopNative -ErrorAction Stop).ScriptBlock
        if($original-isnot[scriptblock]){throw 'ci_gateway_stop_inventory_missing'}
        $script:ciJobGatewayStopProfile=$profile
        Set-Item Function:script:Get-CityGoCanaryStopNative -Value {
            param([Collections.IDictionary]$Plan,[switch]$ObserveStopping)
            foreach($key in @('operationId','vmId','vmPath','targetVhdx','diskIdentifier')){
                if($Plan[$key]-cne$script:ciJobGatewayStopProfile[$key]){throw 'ci_gateway_stop_adapter_binding'}
            }
            if($Plan.seedPath){throw 'ci_gateway_stop_requires_empty_dvd'}
            $native=[ordered]@{};foreach($key in $Plan.Keys){$native[$key]=$Plan[$key]}
            foreach($key in @('wanMac','lanMac','lanNicId','lanNicName')){$native[$key]=$script:ciJobGatewayStopProfile[$key]}
            return Get-CityGoJobGatewayStopNative $native -ObserveStopping:$ObserveStopping
        }
        $phase='durable_gateway_shutdown'
        $stop=@{operationId=$plan.operationId;vmId=$plan.vmId;manifestSha256=$plan.manifestSha256;resumedCreation=$false;seedPath='';seedSha256='';
            graceSeconds=$plan.graceSeconds;turnOffSeconds=$plan.turnOffSeconds;apply=$true;acknowledge=''}
        $stop.acknowledge=(Get-CityGoCanaryStopPlan $stop).requiredAcknowledgement
        return Invoke-CityGoOwnedCanaryStop $stop
    }catch{return @{stage='failed_preserved_requires_inspection';phase=$phase;vmOff=$false;code='ci_gateway_stop_not_verified'}}
    finally{
        if($original){Set-Item Function:script:Get-CityGoCanaryStopNative -Value $original}
        $script:ciJobGatewayStopProfile=$null
        foreach($stream in $held){$stream.Dispose()}
    }
}

try{
    $result=Invoke-CityGoJobGatewayStop @{operationId=$OperationId;vmId=$VmId;manifestSha256=$ExpectedManifestSha256;gatewaySha256=$ExpectedGatewaySha256;
        graceSeconds=$GraceSeconds;turnOffSeconds=$TurnOffSeconds;apply=[bool]$Apply;acknowledge=$Acknowledge}
    $result|ConvertTo-Json -Depth 5 -Compress
    if($result.stage-like'failed*'){exit 1}
}catch{@{stage='refused';vmOff=$false}|ConvertTo-Json -Compress;exit 2}
