# Independent trusted HOST watchdog for one complete disposable gateway.
# Arm before boot. No boot, connect, registration, key access or global changes.
# On faults close BOTH exact ports, detach only pinned PUBLIC media, stop, delete.
[CmdletBinding()]
param([string]$OperationId='',[string]$VmId='',[string]$ExpectedManifestSha256='',[string]$ExpectedGatewaySha256='',
    [string]$ExpectedNetworkSha256='',[string]$PrivateSwitchId='',[string]$WanSwitchId='',
    [int]$ControllerPid=0,[string]$ControllerStartedAt='',[string]$DeadlineUtc='',
    [string]$ExpectedJobPlanSha256='',[string]$PublicSeedPath='',[string]$ExpectedPublicSeedSha256='',
    [switch]$Apply,[string]$Acknowledge='')
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'

function Assert-CityGoGatewayWatch {
    param([bool]$Condition,[string]$Code)
    if(-not$Condition){throw ('ci_gateway_watch_'+$Code)}
}
function Get-CityGoGatewayWatchPlan {
    param([Collections.IDictionary]$Request)
    foreach($key in @('operationId','vmId','privateSwitchId','wanSwitchId')){
        $id=[guid]::Empty;$v=$Request[$key]
        Assert-CityGoGatewayWatch ($v-is[string]-and[guid]::TryParseExact($v,'D',[ref]$id)-and$id-ne[guid]::Empty-and$v-ceq$id.ToString('D')) 'identity'
    }
    Assert-CityGoGatewayWatch ($Request.privateSwitchId-cne$Request.wanSwitchId-and$Request.controllerPid-is[int]-and$Request.controllerPid-gt0) 'controller_or_switch'
    foreach($key in @('manifestSha256','gatewaySha256','networkSha256')){
        Assert-CityGoGatewayWatch ($Request[$key]-is[string]-and$Request[$key]-cmatch'^[a-f0-9]{64}$') 'hash'
    }
    foreach($key in @('controllerStartedAt','deadlineUtc')){
        $time=[DateTimeOffset]::MinValue
        Assert-CityGoGatewayWatch ($Request[$key]-is[string]-and[DateTimeOffset]::TryParseExact($Request[$key],'yyyy-MM-ddTHH:mm:ss.fffffffZ',
            [Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::AssumeUniversal,[ref]$time)) 'time'
    }
    $job='';if($Request.jobPlanSha256){
        Assert-CityGoGatewayWatch ($Request.jobPlanSha256-is[string]-and$Request.jobPlanSha256-cmatch'^[a-f0-9]{64}$') 'job_hash'
        $job=$Request.jobPlanSha256
    }
    $seed='';$seedSha=''
    if($Request.publicSeedPath-or$Request.publicSeedSha256){
        Assert-CityGoGatewayWatch ($Request.publicSeedPath-is[string]-and$Request.publicSeedSha256-is[string]-and
            $Request.publicSeedPath-ceq('D:\CityGo-CI\seeds\'+$Request.operationId+'\gateway-cidata.iso')-and
            $Request.publicSeedSha256-cmatch'^[a-f0-9]{64}$') 'public_seed'
        $seed=$Request.publicSeedPath;$seedSha=$Request.publicSeedSha256
    }
    $dir='D:\CityGo-CI\control\'+$Request.operationId
    return [ordered]@{operationId=$Request.operationId;vmId=$Request.vmId;manifestSha256=$Request.manifestSha256;gatewaySha256=$Request.gatewaySha256;
        networkSha256=$Request.networkSha256;privateSwitchId=$Request.privateSwitchId;wanSwitchId=$Request.wanSwitchId;
        controllerPid=$Request.controllerPid;controllerStartedAt=$Request.controllerStartedAt;deadlineUtc=$Request.deadlineUtc;
        jobPlanSha256=$job;publicSeedPath=$seed;publicSeedSha256=$seedSha;controlDirectory=$dir;
        manifestPath=($dir+'\canary-creation.json');gatewayPath=($dir+'\gateway-creation.json');jobPlanPath=($dir+'\job-plan.json');
        requestPath=($dir+'\gateway-watch-request.json');
        requiredAcknowledgement=('WATCH_JOB_GATEWAY:'+$Request.vmId+':'+$Request.manifestSha256+':'+$Request.gatewaySha256+':'+$Request.networkSha256+
            $(if($job){':JOB_PLAN:'+$job}else{''})+$(if($seed){':PUBLIC_SEED:'+$seedSha}else{''}))}
}
function Get-CityGoGatewayWatchOwner {
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
    try{
        Assert-CityGoGatewayWatch (([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) 'administrator_required'
        return $identity.User.Value
    }finally{$identity.Dispose()}
}
function Open-CityGoGatewayWatchLibrary {
    param([string]$Name,[string]$Hash,[string]$Owner)
    $pins=@{
        'Stop-CityGoOwnedCanaryVm.ps1'='ce0117bb7e94af9a7610af3534bd16adc69e9e08b915a78af8072e546abe4f56';
        'Remove-CityGoCanaryVm.ps1'='70f036f9b6c9885f6cfd15f5a362883b7bf72803dddf5d6fe28fc17c29bea098';
        'Remove-CityGoJobGateway.ps1'='26cd73f88b65582a1efadfbbe22904233644bc9277863fb90a2dd5d69d552203';
        'Stop-CityGoJobGatewayVm.ps1'='45aed6dd0f93ac2740698097ec2aa098df2de019a2c2d87f01fdaf650e29bec9';
        'Watch-CityGoOwnedCanary.ps1'='f0c7ebff2673c66b0ea0bd3abc567abbb54c96b2950143b98ed4fba4fb413913'
    }
    Assert-CityGoGatewayWatch ($pins.ContainsKey($Name)-and$pins[$Name]-ceq$Hash) 'library_not_allowed'
    $Path=Join-Path $PSScriptRoot $Name
    # Initial source loader is intentionally self-contained, before any import.
    $cursor=$Path.Substring(0,3)
    foreach($part in @('')+$Path.Substring(3).Split('\')){
        if($part){$cursor=[IO.Path]::Combine($cursor,$part)}
        $item=Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
        Assert-CityGoGatewayWatch (($item.Attributes-band[IO.FileAttributes]::ReparsePoint)-eq0-and$item.PSProvider.Name-ceq'FileSystem') 'library_not_plain'
    }
    foreach($entry in @(@{path=[IO.Path]::GetDirectoryName($Path);directory=$true},@{path=$Path;directory=$false})){
        $acl=Get-Acl -LiteralPath $entry.path -ErrorAction Stop;$allowed=@($Owner,'S-1-5-18','S-1-5-32-544')
        Assert-CityGoGatewayWatch ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value-cin$allowed-and(-not$entry.directory-or$acl.AreAccessRulesProtected)) 'library_owner_invalid'
        foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
            Assert-CityGoGatewayWatch ($rule.AccessControlType-ne[Security.AccessControl.AccessControlType]::Allow-or$rule.IdentityReference.Value-cin$allowed) 'library_not_private'
        }
    }
    $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try{
        Assert-CityGoGatewayWatch ($stream.Length-gt0-and$stream.Length-le131072) 'library_size_invalid'
        $sha=[Security.Cryptography.SHA256]::Create()
        try{$actual=([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
        Assert-CityGoGatewayWatch ($actual-ceq$Hash) 'library_hash_invalid'
        $stream.Position=0;$reader=[IO.StreamReader]::new($stream,[Text.UTF8Encoding]::new($false,$true),$false,4096,$true)
        try{$source=$reader.ReadToEnd()}finally{$reader.Dispose()}
        $tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseInput($source,$Path,[ref]$tokens,[ref]$errors)
        Assert-CityGoGatewayWatch ($errors.Count-eq0) 'library_parse_invalid'
        foreach($definition in $ast.FindAll({param($node)$node-is[Management.Automation.Language.FunctionDefinitionAst]},$true)){
            Assert-CityGoGatewayWatch ($definition.Parent-is[Management.Automation.Language.NamedBlockAst]-and-not$definition.Parameters.Count) 'nested_library_definition'
            Set-Item -Path ('Function:script:'+$definition.Name) -Value $definition.Body.GetScriptBlock()
        }
        return $stream
    }catch{$stream.Dispose();throw}
}

function Write-CityGoGatewayWatchRecord {
    param($Plan,[string]$Name,$Value,[string]$Owner)
    Assert-CityGoGatewayWatch ($Name-cin@('gateway-watch-ready.json','gateway-watch-close-intent.json','gateway-watch-closed.json',
        'gateway-watch-detach-intent.json','gateway-watch-detached.json','gateway-watch-stop.json','gateway-watch-cleanup.json',
        'gateway-watch-result.json','gateway-watch-failure.json')) 'record_name'
    Assert-CityGoCanaryStopPlainPath $Plan.controlDirectory $true;Assert-CityGoCanaryStopAcl $Plan.controlDirectory $Owner $true
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Value|ConvertTo-Json -Depth 6 -Compress))
    Assert-CityGoGatewayWatch ($bytes.Length-le16384) 'record_size'
    $stream=[IO.File]::Open(($Plan.controlDirectory+'\'+$Name),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
}
function Get-CityGoGatewayWatchPorts {
    param($Plan)
    $vm=Get-VM -Id ([guid]$Plan.vmId) -ErrorAction Stop
    Assert-CityGoGatewayWatch ($vm.Id.ToString('D')-ceq$Plan.vmId-and$vm.Name-ceq$Plan.vmName-and[string]$vm.Path-ieq$Plan.vmPath-and$vm.Generation-eq2) 'port_vm_changed'
    $nics=@(Get-VMNetworkAdapter -VM $vm -ErrorAction Stop)
    Assert-CityGoGatewayWatch ($nics.Count-eq2) 'port_count_changed'
    foreach($role in @('wan','lan')){
        if($role-ceq'wan'){$id=$Plan.nicId;$name=$Plan.nicName}else{$id=$Plan.lanNicId;$name=$Plan.lanNicName}
        $found=@($nics|Where-Object{[string]$_.Id-ceq$id-and$_.Name-ceq$name-and$_.VMId.ToString('D')-ceq$Plan.vmId})
        Assert-CityGoGatewayWatch ($found.Count-eq1) 'port_identity_changed'
    }
    return $nics
}
function Get-CityGoGatewayWatchNetworkHash {
    param($Plan)
    $addresses=@(Get-NetIPAddress -ErrorAction Stop|ForEach-Object{
        @([string]$_.AddressFamily,[string]$_.InterfaceIndex,[string]$_.IPAddress,[string]$_.PrefixLength,[string]$_.AddressState)-join'|'
    }|Sort-Object)
    $routes=@(Get-NetRoute -PolicyStore ActiveStore -ErrorAction Stop|Where-Object{[string]$_.State-cne'Dead'}|ForEach-Object{
        @([string]$_.AddressFamily,[string]$_.InterfaceIndex,[string]$_.DestinationPrefix,[string]$_.NextHop,[string]$_.RouteMetric,[string]$_.Protocol)-join'|'
    }|Sort-Object)
    Assert-CityGoGatewayWatch ($addresses.Count-ge1-and$addresses.Count-le4096-and$routes.Count-ge1-and$routes.Count-le4096) 'inventory'
    $private=Get-VMSwitch -Id ([guid]$Plan.privateSwitchId) -ErrorAction Stop
    $wan=Get-VMSwitch -Id ([guid]$Plan.wanSwitchId) -ErrorAction Stop
    Assert-CityGoGatewayWatch ($private.Id.ToString('D')-ceq$Plan.privateSwitchId-and[string]$private.SwitchType-ceq'Private'-and
        $wan.Id.ToString('D')-ceq$Plan.wanSwitchId-and[string]$wan.SwitchType-ceq'Internal') 'switch_changed'
    $nics=@(Get-CityGoGatewayWatchPorts $Plan)
    foreach($nic in $nics){
        $expected=$(if([string]$nic.Id-ceq$Plan.nicId){$Plan.wanSwitchId}else{$Plan.privateSwitchId})
        Assert-CityGoGatewayWatch ((-not$nic.SwitchId-or[guid]$nic.SwitchId-eq[guid]::Empty)-or([guid]$nic.SwitchId).ToString('D')-ceq$expected) 'port_switch_changed'
    }
    $attached=@(Get-VMNetworkAdapter -All -ErrorAction Stop|Where-Object{$_.SwitchId-and[guid]$_.SwitchId-eq[guid]$Plan.privateSwitchId})
    Assert-CityGoGatewayWatch ($attached.Count-le2-and@($attached|Where-Object{$_.IsManagementOs-eq$true}).Count-eq0) 'private_topology'
    $ports=@($attached|ForEach-Object{[string]$_.Id+'|'+[string]$_.VMId+'|'+[string]$_.MacAddress+'|'+[string]$_.SwitchId}|Sort-Object)
    $gateway=@($nics|ForEach-Object{[string]$_.Id+'|'+[string]$_.SwitchId+'|'+[string]$_.MacAddress+'|'+[string]$_.DynamicMacAddressEnabled}|Sort-Object)
    $data=[ordered]@{addresses=$addresses;routes=$routes;privateSwitch=$private.Id.ToString('D');wanSwitch=$wan.Id.ToString('D');ports=$ports;gatewayPorts=$gateway}
    $sha=[Security.Cryptography.SHA256]::Create()
    try{return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes(($data|ConvertTo-Json -Depth 4 -Compress))))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
}
function Close-CityGoGatewayWatchPorts {
    param($Plan,[string]$Owner)
    $nics=@(Get-CityGoGatewayWatchPorts $Plan)
    Write-CityGoGatewayWatchRecord $Plan 'gateway-watch-close-intent.json' @{operationId=$Plan.operationId;vmId=$Plan.vmId;wanNicId=$Plan.nicId;lanNicId=$Plan.lanNicId} $Owner
    foreach($id in @($Plan.nicId,$Plan.lanNicId)){
        # Re-read exact VM/ports before EACH dispatch; no replacement adoption.
        $current=@(Get-CityGoGatewayWatchPorts $Plan|Where-Object{[string]$_.Id-ceq$id})
        if($current[0].SwitchId-and[guid]$current[0].SwitchId-ne[guid]::Empty){
            try{Disconnect-VMNetworkAdapter -VMNetworkAdapter $current[0] -ErrorAction Stop}catch{
                # Never repeat an ambiguous dispatch. Still try the other OWNED
                # port, then accept only independently observed closed ports.
            }
        }
    }
    for($i=0;$i-lt10;$i++){
        $fresh=@(Get-CityGoGatewayWatchPorts $Plan)
        if(@($fresh|Where-Object{$_.SwitchName-or($_.SwitchId-and[guid]$_.SwitchId-ne[guid]::Empty)}).Count-eq0){
            Write-CityGoGatewayWatchRecord $Plan 'gateway-watch-closed.json' @{operationId=$Plan.operationId;vmId=$Plan.vmId;bothPortsDisconnected=$true} $Owner
            return
        }
        Start-Sleep -Milliseconds 250
    }
    throw 'ci_gateway_watch_ports_not_closed'
}
function Disconnect-CityGoGatewayWatchSeed {
    param($Plan,$Profile,[string]$Owner)
    if(-not$Plan.publicSeedPath){return}
    $null=Get-CityGoGatewayWatchPorts $Plan
    $vm=Get-VM -Id ([guid]$Plan.vmId) -ErrorAction Stop
    $dvd=@(Get-VMDvdDrive -VM $vm -ErrorAction Stop)
    Assert-CityGoGatewayWatch ($dvd.Count-le1-and@($dvd|Where-Object{$_.Path-and[string]$_.Path-ine$Plan.publicSeedPath}).Count-eq0) 'foreign_media'
    if($dvd.Count-eq0-or-not$dvd[0].Path){
        $Profile.seedPath=$null;$null=Get-CityGoJobGatewayStopNative $Profile -ObserveStopping
        return
    }
    $null=Get-CityGoJobGatewayStopNative $Profile -ObserveStopping
    Write-CityGoGatewayWatchRecord $Plan 'gateway-watch-detach-intent.json' @{operationId=$Plan.operationId;vmId=$Plan.vmId;publicSeedSha256=$Plan.publicSeedSha256} $Owner
    Set-VMDvdDrive -VMDvdDrive $dvd[0] -Path $null -ErrorAction Stop
    $end=[DateTimeOffset]::UtcNow.AddSeconds(20)
    for($i=0;$i-lt80-and[DateTimeOffset]::UtcNow-lt$end;$i++){
        $null=Get-CityGoGatewayWatchPorts $Plan
        $vm=Get-VM -Id ([guid]$Plan.vmId) -ErrorAction Stop;$fresh=@(Get-VMDvdDrive -VM $vm -ErrorAction Stop)
        Assert-CityGoGatewayWatch ($fresh.Count-le1-and@($fresh|Where-Object{$_.Path-and[string]$_.Path-ine$Plan.publicSeedPath}).Count-eq0) 'foreign_media'
        if($fresh.Count-eq0-or-not$fresh[0].Path){
            $Profile.seedPath=$null
            try{$null=Get-CityGoJobGatewayStopNative $Profile -ObserveStopping}catch{Start-Sleep -Milliseconds 250;continue}
            Write-CityGoGatewayWatchRecord $Plan 'gateway-watch-detached.json' @{operationId=$Plan.operationId;vmId=$Plan.vmId;dvdEmpty=$true} $Owner
            return
        }
        Start-Sleep -Milliseconds 250
    }
    throw 'ci_gateway_watch_detach_not_verified'
}
function Invoke-CityGoGatewayWatch {
    param([Collections.IDictionary]$Request)
    $plan=Get-CityGoGatewayWatchPlan $Request
    $result=[ordered]@{scope='owned_gateway_watchdog';operationId=$plan.operationId;vmId=$plan.vmId;stage='plan_only_unverified';
        ciJobsAdmitted=$false;runnerRegistered=$false;nativeFactoryAccepted=$false}
    if(-not$Request.apply){$result.plan=$plan;return $result}
    Assert-CityGoGatewayWatch ($Request.acknowledge-ceq$plan.requiredAcknowledgement) 'acknowledgement'
    $owner=Get-CityGoGatewayWatchOwner;$held=@();$armed=$false;$phase='pinned_sources';$reason=''
    try{
        foreach($entry in @(
            @('Stop-CityGoOwnedCanaryVm.ps1','ce0117bb7e94af9a7610af3534bd16adc69e9e08b915a78af8072e546abe4f56'),
            @('Remove-CityGoCanaryVm.ps1','70f036f9b6c9885f6cfd15f5a362883b7bf72803dddf5d6fe28fc17c29bea098'),
            @('Remove-CityGoJobGateway.ps1','26cd73f88b65582a1efadfbbe22904233644bc9277863fb90a2dd5d69d552203'),
            @('Stop-CityGoJobGatewayVm.ps1','45aed6dd0f93ac2740698097ec2aa098df2de019a2c2d87f01fdaf650e29bec9'),
            @('Watch-CityGoOwnedCanary.ps1','f0c7ebff2673c66b0ea0bd3abc567abbb54c96b2950143b98ed4fba4fb413913'))){
            $held+=,(Open-CityGoGatewayWatchLibrary $entry[0] $entry[1] $owner)
        }
        Assert-CityGoCanaryStopPlainPath $PSScriptRoot $true;Assert-CityGoCanaryStopAcl $PSScriptRoot $owner $true
        $phase='complete_gateway_profile'
        $m=Open-CityGoCanaryCleanupEvidence $plan.manifestPath $owner $plan.manifestSha256;$held+=,$m.stream
        $g=Open-CityGoCanaryCleanupEvidence $plan.gatewayPath $owner $plan.gatewaySha256;$held+=,$g.stream
        $binding=Get-CityGoCanaryCleanupPlan $m.value @{manifestPath=$plan.manifestPath;manifestSha256=$plan.manifestSha256}
        Assert-CityGoGatewayWatch ($binding.vmId-ceq$plan.vmId-and-not$binding.resumedCreation) 'manifest_binding'
        Assert-CityGoJobGatewayReceipt $g.value $binding $plan
        foreach($key in @('vmName','vmPath','nicId','nicName','lanNicId','lanNicName')){$plan[$key]=$(if($binding.Contains($key)){$binding[$key]}else{$g.value.$key})}
        $profile=[ordered]@{};foreach($key in $binding.Keys){$profile[$key]=$binding[$key]}
        foreach($key in @('wanMac','lanMac','lanNicId','lanNicName')){$profile[$key]=$g.value.$key}
        $profile.privateSwitchId=$plan.privateSwitchId;$profile.wanSwitchId=$plan.wanSwitchId;$profile.seedPath=$null
        $maximum=900;$lease=$null
        if($plan.jobPlanSha256){
            $phase='pinned_full_job_lease'
            $j=Open-CityGoCanaryCleanupEvidence $plan.jobPlanPath $owner $plan.jobPlanSha256;$held+=,$j.stream
            Assert-CityGoGatewayWatch ($j.value.gatewayOperationId-ceq$plan.operationId-and$j.value.operationId-is[string]-and
                $j.value.operationId-cmatch'^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$') 'job_gateway_binding'
            $lease=Get-CityGoWatchdogJobLease $j.value @{operationId=$j.value.operationId;deadlineUtc=$plan.deadlineUtc}
            $maximum=$lease.maximumSeconds
        }
        if($plan.publicSeedPath){$held+=,(Open-CityGoWatchdogPublicSeed $plan $owner);$profile.seedPath=$plan.publicSeedPath}
        $phase='arm_before_boot'
        $vm=Get-CityGoJobGatewayStopNative $profile -AllowConnected
        Assert-CityGoGatewayWatch ([string]$vm.State-ceq'Off') 'arm_requires_off'
        foreach($name in @('gateway-watch-ready.json','gateway-watch-result.json','gateway-watch-failure.json','gateway-watch-close-intent.json',
            'gateway-stop-binding.json','canary-stop-intent.json','canary-cleanup-intent.json')){
            Assert-CityGoGatewayWatch (-not(Test-Path -LiteralPath ($plan.controlDirectory+'\'+$name))) 'existing_attempt'
        }
        $now=Get-CityGoWatchdogNow;$deadline=[DateTimeOffset]::Parse($plan.deadlineUtc,[Globalization.CultureInfo]::InvariantCulture)
        $remaining=($deadline-$now).TotalSeconds
        Assert-CityGoGatewayWatch ($remaining-ge15-and$remaining-le$maximum-and($null-eq$lease-or$now-ge$lease.createdAt)-and
            (Test-CityGoWatchdogController $plan)-and(Get-CityGoGatewayWatchNetworkHash $plan)-ceq$plan.networkSha256-and
            -not(Test-Path -LiteralPath $plan.requestPath)) 'arm_precondition'
        $start=Get-CityGoWatchdogTicks;$lastTicks=$start;$lastNow=$now
        Write-CityGoGatewayWatchRecord $plan 'gateway-watch-ready.json' @{operationId=$plan.operationId;vmId=$plan.vmId;stage='armed_off_gateway';
            deadlineUtc=$plan.deadlineUtc;networkSha256=$plan.networkSha256;fullJobLeaseVerified=($null-ne$lease);ciJobsAdmitted=$false} $owner
        $armed=$true;$phase='independent_monitor'
        try{
            for($poll=0;$poll-le($maximum+1);$poll++){
                $current=Get-CityGoWatchdogNow;$ticks=Get-CityGoWatchdogTicks
                if($current-lt$lastNow-or$ticks-lt$lastTicks){$reason='clock_rollback';break}
                $lastNow=$current;$lastTicks=$ticks
                if($current-ge$deadline-or($ticks-$start)/[Diagnostics.Stopwatch]::Frequency-ge$remaining){$reason='deadline';break}
                if(-not(Test-CityGoWatchdogController $plan)){$reason='controller_exited';break}
                if((Get-CityGoGatewayWatchNetworkHash $plan)-cne$plan.networkSha256){$reason='network_changed';break}
                $action=Read-CityGoWatchdogRequest $plan $owner
                if($action){$reason=$action;break}
                Start-Sleep -Milliseconds 1000
            }
            if(-not$reason){$reason='iteration_limit'}
        }catch{$reason='observation_failed'}
        $phase='close_both_owned_ports';Close-CityGoGatewayWatchPorts $plan $owner
        $phase='detach_public_seed';Disconnect-CityGoGatewayWatchSeed $plan $profile $owner
        $phase='stop_owned_gateway'
        $stop=@{operationId=$plan.operationId;vmId=$plan.vmId;manifestSha256=$plan.manifestSha256;gatewaySha256=$plan.gatewaySha256;
            graceSeconds=30;turnOffSeconds=30;apply=$true;acknowledge=''}
        $stop.acknowledge=(Get-CityGoJobGatewayStopPlan $stop).requiredAcknowledgement
        $stopped=Invoke-CityGoJobGatewayStop $stop
        Write-CityGoGatewayWatchRecord $plan 'gateway-watch-stop.json' $stopped $owner
        Assert-CityGoGatewayWatch ($stopped.stage-ceq'stopped_off_verified'-and$stopped.vmOff-is[bool]-and$stopped.vmOff) 'stop_unverified'
        $profile.seedPath=$null;$vm=Get-CityGoJobGatewayStopNative $profile
        Assert-CityGoGatewayWatch ([string]$vm.State-ceq'Off') 'cleanup_requires_off'
        $phase='delete_exact_off_gateway'
        $remove=@{operationId=$plan.operationId;manifestSha256=$plan.manifestSha256;gatewaySha256=$plan.gatewaySha256;apply=$true;acknowledge=''}
        $remove.acknowledge=(Get-CityGoJobGatewayCleanupPlan $remove).requiredAcknowledgement
        $removed=Invoke-CityGoJobGatewayCleanup $remove
        Write-CityGoGatewayWatchRecord $plan 'gateway-watch-cleanup.json' $removed $owner
        Assert-CityGoGatewayWatch ($removed.stage-ceq'cleanup_complete_resources_absent'-and$removed.vmAbsent-is[bool]-and$removed.vmAbsent-and
            $removed.diskAbsent-is[bool]-and$removed.diskAbsent-and@(Get-VM|Where-Object{$_.Id.ToString('D')-ceq$plan.vmId}).Count-eq0-and
            -not(Test-Path -LiteralPath $binding.targetVhdx)) 'cleanup_unverified'
        $result.stage='gateway_watchdog_cleanup_completed';$result.reason=$reason;$result.bothPortsDisconnected=$true;$result.vmAbsent=$true;$result.diskAbsent=$true
        Write-CityGoGatewayWatchRecord $plan 'gateway-watch-result.json' $result $owner
        return $result
    }catch{
        $result.stage='failed_preserved_requires_inspection';$result.phase=$phase;$result.armed=$armed;$result.reason=$reason;$result.code='gateway_watch_not_verified'
        try{Write-CityGoGatewayWatchRecord $plan 'gateway-watch-failure.json' $result $owner}catch{}
        return $result
    }finally{foreach($stream in $held){$stream.Dispose()}}
}
try{
    $r=Invoke-CityGoGatewayWatch @{operationId=$OperationId;vmId=$VmId;manifestSha256=$ExpectedManifestSha256;gatewaySha256=$ExpectedGatewaySha256;
        networkSha256=$ExpectedNetworkSha256;privateSwitchId=$PrivateSwitchId;wanSwitchId=$WanSwitchId;controllerPid=$ControllerPid;
        controllerStartedAt=$ControllerStartedAt;deadlineUtc=$DeadlineUtc;jobPlanSha256=$ExpectedJobPlanSha256;publicSeedPath=$PublicSeedPath;
        publicSeedSha256=$ExpectedPublicSeedSha256;apply=[bool]$Apply;acknowledge=$Acknowledge}
    $r|ConvertTo-Json -Depth 6 -Compress
    if($r.stage-like'failed*'){exit 1}
}catch{@{stage='refused';ciJobsAdmitted=$false}|ConvertTo-Json -Compress;exit 2}
