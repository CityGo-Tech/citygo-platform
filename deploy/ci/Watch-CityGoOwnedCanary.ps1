# Trusted host watchdog for ONE complete disposable client, never a gateway.
# Run in an independent highest-privilege scheduled task BEFORE client boot.
# Default plan is pure. No registration, credentials, boot or global policy.
[CmdletBinding()]
param(
    [string]$OperationId='', [string]$VmId='',
    [string]$ExpectedManifestSha256='', [string]$ExpectedNetworkSha256='',
    [string]$PrivateSwitchId='', [int]$ControllerPid=0,
    [string]$ControllerStartedAt='', [string]$DeadlineUtc='',
    [string]$PublicSeedPath='', [string]$ExpectedPublicSeedSha256='',
    [switch]$Apply, [string]$Acknowledge=''
)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'

function Assert-CityGoWatchdog {
    param([bool]$Condition,[string]$Code)
    if(-not $Condition){throw ('ci_watchdog_'+$Code)}
}

function Get-CityGoWatchdogPlan {
    param([Collections.IDictionary]$Request)
    foreach($name in @('operationId','vmId','privateSwitchId')){
        $id=[guid]::Empty;$value=$Request[$name]
        Assert-CityGoWatchdog ($value-is[string]-and[guid]::TryParseExact($value,'D',[ref]$id)-and$id-ne[guid]::Empty-and$value-ceq$id.ToString('D')) 'identity_invalid'
    }
    foreach($name in @('manifestSha256','networkSha256')){
        Assert-CityGoWatchdog ($Request[$name]-is[string]-and$Request[$name]-cmatch'^[a-f0-9]{64}$') 'hash_invalid'
    }
    Assert-CityGoWatchdog ($Request.controllerPid-is[int]-and$Request.controllerPid-gt0) 'controller_invalid'
    foreach($name in @('controllerStartedAt','deadlineUtc')){
        $parsed=[DateTimeOffset]::MinValue
        Assert-CityGoWatchdog ($Request[$name]-is[string]-and[DateTimeOffset]::TryParseExact($Request[$name],
            'yyyy-MM-ddTHH:mm:ss.fffffffZ',[Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::AssumeUniversal,[ref]$parsed)) 'time_invalid'
    }
    $dir='D:\CityGo-CI\control\'+$Request.operationId
    $seed='';$seedSha=''
    if($Request.publicSeedPath-or$Request.publicSeedSha256){
        $seedDir='D:\CityGo-CI\seeds\'+$Request.operationId+'\'
        Assert-CityGoWatchdog ($Request.publicSeedPath-is[string]-and$Request.publicSeedSha256-is[string]-and
            $Request.publicSeedSha256-cmatch'^[a-f0-9]{64}$'-and$Request.publicSeedPath-cin@(($seedDir+'network-cidata.iso'),($seedDir+'runner-cidata.iso'))) 'public_seed_invalid'
        $seed=$Request.publicSeedPath;$seedSha=$Request.publicSeedSha256
    }
    return [ordered]@{
        operationId=$Request.operationId;vmId=$Request.vmId;manifestSha256=$Request.manifestSha256;
        networkSha256=$Request.networkSha256;privateSwitchId=$Request.privateSwitchId;
        controllerPid=$Request.controllerPid;controllerStartedAt=$Request.controllerStartedAt;deadlineUtc=$Request.deadlineUtc;
        publicSeedPath=$seed;publicSeedSha256=$seedSha;
        controlDirectory=$dir;manifestPath=($dir+'\canary-creation.json');
        stopHelperPath=($dir+'\Stop-CityGoOwnedCanaryVm.ps1');
        stopHelperSha256='ce0117bb7e94af9a7610af3534bd16adc69e9e08b915a78af8072e546abe4f56';
        cleanupHelperPath=($dir+'\Remove-CityGoCanaryVm.ps1');
        cleanupHelperSha256='70f036f9b6c9885f6cfd15f5a362883b7bf72803dddf5d6fe28fc17c29bea098';
        requestPath=($dir+'\watchdog-request.json');
        requiredAcknowledgement=('WATCH_OWNED_CANARY:'+$Request.vmId+':'+$Request.manifestSha256+$(if($seed){':PUBLIC_SEED:'+$seedSha}else{''}))
    }
}

function Get-CityGoWatchdogOwner {
    $who=[Security.Principal.WindowsIdentity]::GetCurrent()
    try{
        Assert-CityGoWatchdog (([Security.Principal.WindowsPrincipal]::new($who)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) 'administrator_required'
        return $who.User.Value
    }finally{$who.Dispose()}
}

function Open-CityGoWatchdogLibrary {
    param([string]$Path,[string]$Hash,[string]$Owner)
    # Initial source loader is intentionally self-contained, before any import.
    $cursor=$Path.Substring(0,3)
    foreach($part in @('')+$Path.Substring(3).Split('\')){
        if($part){$cursor=[IO.Path]::Combine($cursor,$part)}
        $item=Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
        Assert-CityGoWatchdog (($item.Attributes-band[IO.FileAttributes]::ReparsePoint)-eq0-and$item.PSProvider.Name-ceq'FileSystem') 'library_not_plain'
    }
    foreach($entry in @(@{path=[IO.Path]::GetDirectoryName($Path);directory=$true},@{path=$Path;directory=$false})){
        $acl=Get-Acl -LiteralPath $entry.path -ErrorAction Stop;$allowed=@($Owner,'S-1-5-18','S-1-5-32-544')
        Assert-CityGoWatchdog ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value-cin$allowed-and(-not$entry.directory-or$acl.AreAccessRulesProtected)) 'library_owner_invalid'
        foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
            Assert-CityGoWatchdog ($rule.AccessControlType-ne[Security.AccessControl.AccessControlType]::Allow-or$rule.IdentityReference.Value-cin$allowed) 'library_not_private'
        }
    }
    $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try{
        Assert-CityGoWatchdog ($stream.Length-gt0-and$stream.Length-le131072) 'library_size_invalid'
        $sha=[Security.Cryptography.SHA256]::Create()
        try{$actual=([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
        Assert-CityGoWatchdog ($actual-ceq$Hash) 'library_hash_invalid'
        $stream.Position=0;$reader=[IO.StreamReader]::new($stream,[Text.UTF8Encoding]::new($false,$true),$false,4096,$true)
        try{$source=$reader.ReadToEnd()}finally{$reader.Dispose()}
        $tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors)
        Assert-CityGoWatchdog ($errors.Count-eq0) 'library_parse_invalid'
        foreach($definition in $ast.FindAll({param($node)$node-is[Management.Automation.Language.FunctionDefinitionAst]},$true)){
            Assert-CityGoWatchdog ($definition.Parent-is[Management.Automation.Language.NamedBlockAst]) 'nested_library_definition'
            # Full definition preserves inline parameters; never evaluate entrypoint.
            . ([scriptblock]::Create($definition.Extent.Text))
            Set-Item -Path ('Function:script:'+$definition.Name) -Value (Get-Item -Path ('Function:'+$definition.Name)).ScriptBlock
        }
        return $stream
    }catch{$stream.Dispose();throw}
}

function Write-CityGoWatchdogRecord {
    param([Collections.IDictionary]$Plan,[string]$Name,$Value,[string]$Owner)
    Assert-CityGoWatchdog ($Name-cin@('watchdog-ready.json','watchdog-network-close-intent.json','watchdog-network-closed.json',
        'watchdog-stop-observation.json','watchdog-cleanup-observation.json','watchdog-result.json','watchdog-failure.json',
        'watchdog-seed-detach-intent.json','watchdog-seed-detached.json')) 'record_name_invalid'
    Assert-CityGoCanaryStopPlainPath $Plan.controlDirectory $true
    Assert-CityGoCanaryStopAcl $Plan.controlDirectory $Owner $true
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Value|ConvertTo-Json -Depth 5 -Compress))
    Assert-CityGoWatchdog ($bytes.Length-le16384) 'record_too_large'
    $path=$Plan.controlDirectory+'\'+$Name
    $stream=[IO.File]::Open($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
    Assert-CityGoCanaryStopAcl $path $Owner
}

function Get-CityGoWatchdogNetworkHash {
    param([Collections.IDictionary]$Plan)
    # Both address families and ALL live routes. Fail closed on observations
    # disappearing; never silently classify VPN /0 as safe internet.
    $addresses=@(Get-NetIPAddress -ErrorAction Stop|ForEach-Object{
        @([string]$_.AddressFamily,[string]$_.InterfaceIndex,[string]$_.IPAddress,[string]$_.PrefixLength,[string]$_.AddressState)-join'|'
    }|Sort-Object)
    $routes=@(Get-NetRoute -PolicyStore ActiveStore -ErrorAction Stop|Where-Object{[string]$_.State-cne'Dead'}|ForEach-Object{
        @([string]$_.AddressFamily,[string]$_.InterfaceIndex,[string]$_.DestinationPrefix,[string]$_.NextHop,[string]$_.RouteMetric,[string]$_.Protocol)-join'|'
    }|Sort-Object)
    Assert-CityGoWatchdog ($addresses.Count-ge1-and$addresses.Count-le4096-and$routes.Count-ge1-and$routes.Count-le4096) 'network_inventory_invalid'
    $sw=Get-VMSwitch -Id ([guid]$Plan.privateSwitchId) -ErrorAction Stop
    Assert-CityGoWatchdog ($sw.Id.ToString('D')-ceq$Plan.privateSwitchId-and[string]$sw.SwitchType-ceq'Private') 'private_switch_changed'
    $vm=Get-VM -Id ([guid]$Plan.vmId) -ErrorAction Stop
    $nic=@(Get-VMNetworkAdapter -VM $vm -ErrorAction Stop)
    Assert-CityGoWatchdog ($nic.Count-eq1-and[string]$nic[0].Id-ceq$Plan.nicId-and$nic[0].VMId.ToString('D')-ceq$Plan.vmId) 'network_nic_changed'
    $attached=@(Get-VMNetworkAdapter -All -ErrorAction Stop|Where-Object{$_.SwitchId-and[guid]$_.SwitchId-eq[guid]$Plan.privateSwitchId})
    Assert-CityGoWatchdog ($attached.Count-le2-and@($attached|Where-Object{$_.IsManagementOs-eq$true}).Count-eq0) 'private_topology_invalid'
    $ports=@($attached|ForEach-Object{[string]$_.Id+'|'+[string]$_.VMId+'|'+[string]$_.MacAddress+'|'+[string]$_.SwitchId}|Sort-Object)
    $data=[ordered]@{addresses=$addresses;routes=$routes;privateSwitch=$sw.Id.ToString('D');ports=$ports;
        clientPort=([string]$nic[0].SwitchId+'|'+[string]$nic[0].MacAddress+'|'+[string]$nic[0].DynamicMacAddressEnabled)}
    $sha=[Security.Cryptography.SHA256]::Create()
    try{return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes(($data|ConvertTo-Json -Depth 4 -Compress))))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
}

function Test-CityGoWatchdogController {
    param([Collections.IDictionary]$Plan)
    $process=Get-Process -Id $Plan.controllerPid -ErrorAction SilentlyContinue
    if(-not$process){return $false}
    return $process.StartTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffffffZ',[Globalization.CultureInfo]::InvariantCulture)-ceq$Plan.controllerStartedAt
}

function Read-CityGoWatchdogRequest {
    param([Collections.IDictionary]$Plan,[string]$Owner)
    if(-not(Test-Path -LiteralPath $Plan.requestPath -ErrorAction Stop)){return ''}
    $evidence=Open-CityGoCanaryCleanupEvidence $Plan.requestPath $Owner
    try{
        $value=$evidence.value;$keys=@($value.PSObject.Properties.Name)
        Assert-CityGoWatchdog ($keys.Count-eq3-and@($keys|Where-Object{$_-cnotin@('operationId','vmId','action')}).Count-eq0-and
            $value.operationId-is[string]-and$value.vmId-is[string]-and$value.action-is[string]-and
            $value.operationId-ceq$Plan.operationId-and$value.vmId-ceq$Plan.vmId-and$value.action-cin@('cancel','complete')) 'request_invalid'
        return [string]$value.action
    }finally{$evidence.stream.Dispose()}
}

function Disconnect-CityGoWatchdogClient {
    param([Collections.IDictionary]$Plan,[string]$Owner)
    # Minimal exact identity lets a disk/guest-readback failure still close the
    # OWNED network port. This never adopts a replacement NIC or another VM.
    $vm=Get-VM -Id ([guid]$Plan.vmId) -ErrorAction Stop
    Assert-CityGoWatchdog ($vm.Id.ToString('D')-ceq$Plan.vmId-and$vm.Name-ceq$Plan.vmName-and[string]$vm.Path-ieq$Plan.vmPath-and$vm.Generation-eq2) 'disconnect_vm_changed'
    $nic=@(Get-VMNetworkAdapter -VM $vm -ErrorAction Stop)
    Assert-CityGoWatchdog ($nic.Count-eq1-and[string]$nic[0].Id-ceq$Plan.nicId-and$nic[0].VMId.ToString('D')-ceq$Plan.vmId-and$nic[0].Name-ceq$Plan.nicName) 'disconnect_nic_changed'
    Write-CityGoWatchdogRecord $Plan 'watchdog-network-close-intent.json' ([ordered]@{operationId=$Plan.operationId;vmId=$Plan.vmId;nicId=$Plan.nicId;stage='disconnect_exact_client_port'}) $Owner
    if($nic[0].SwitchId-and[guid]$nic[0].SwitchId-ne[guid]::Empty){Disconnect-VMNetworkAdapter -VMNetworkAdapter $nic[0] -ErrorAction Stop}
    for($attempt=0;$attempt-lt10;$attempt++){
        $freshVm=Get-VM -Id ([guid]$Plan.vmId) -ErrorAction Stop
        Assert-CityGoWatchdog ($freshVm.Name-ceq$Plan.vmName-and[string]$freshVm.Path-ieq$Plan.vmPath) 'disconnect_readback_vm_changed'
        $current=@(Get-VMNetworkAdapter -VM $freshVm -ErrorAction Stop)
        Assert-CityGoWatchdog ($current.Count-eq1-and[string]$current[0].Id-ceq$Plan.nicId-and$current[0].VMId.ToString('D')-ceq$Plan.vmId) 'disconnect_readback_identity'
        if(-not$current[0].SwitchName-and(-not$current[0].SwitchId-or[guid]$current[0].SwitchId-eq[guid]::Empty)){
            Write-CityGoWatchdogRecord $Plan 'watchdog-network-closed.json' ([ordered]@{operationId=$Plan.operationId;vmId=$Plan.vmId;clientNetworkDisconnected=$true}) $Owner
            return
        }
        Start-Sleep -Milliseconds 250
    }
    throw 'ci_watchdog_disconnect_not_verified'
}

function Get-CityGoWatchdogNow {return [DateTimeOffset]::UtcNow}
function Get-CityGoWatchdogTicks {return [Diagnostics.Stopwatch]::GetTimestamp()}

function Open-CityGoWatchdogPublicSeed {
    param([Collections.IDictionary]$Plan,[string]$Owner)
    # ONLY the explicitly PUBLIC, hash-bound ISO may carry native Hyper-V
    # storage read capabilities. No credentials may be put in these seeds.
    # This grants no ACE and does not weaken private helper/control guards.
    $path=$Plan.publicSeedPath;Assert-CityGoCanaryStopPlainPath $path $false
    $sid=Get-CityGoCanaryExpectedVmSid $Plan.vmId
    Assert-CityGoCanaryStopAcl ([IO.Path]::GetDirectoryName($path)) $Owner $true $sid
    $acl=Get-Acl -LiteralPath $path -ErrorAction Stop;$owners=@($Owner,'S-1-5-18','S-1-5-32-544')
    Assert-CityGoWatchdog ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value-cin$owners) 'public_seed_owner_invalid'
    $mask=[long][Security.AccessControl.FileSystemRights]::ReadAndExecute-bor[long][Security.AccessControl.FileSystemRights]::Synchronize
    foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
        if($rule.AccessControlType-ne[Security.AccessControl.AccessControlType]::Allow-or$rule.IdentityReference.Value-cin$owners){continue}
        Assert-CityGoWatchdog (($rule.IdentityReference.Value-ceq$sid-or$rule.IdentityReference.Value-cmatch'^S-1-15-3-1024-(?:[0-9]+-){7}[0-9]+$')-and
            ([long]$rule.FileSystemRights-band(-bnot$mask))-eq0) 'public_seed_write_or_foreign_ace'
    }
    $stream=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try{
        Assert-CityGoWatchdog ($stream.Length-ge32768-and$stream.Length-le4MB) 'public_seed_size_invalid'
        $sha=[Security.Cryptography.SHA256]::Create()
        try{$actual=([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
        Assert-CityGoWatchdog ($actual-ceq$Plan.publicSeedSha256) 'public_seed_hash_invalid'
        return $stream
    }catch{$stream.Dispose();throw}
}

function Disconnect-CityGoWatchdogPublicSeed {
    param([Collections.IDictionary]$Plan,[Collections.IDictionary]$StopPlan,[string]$Owner)
    if(-not$Plan.publicSeedPath){return}
    $vm=Get-CityGoCanaryStopNative $StopPlan -ObserveStopping
    $dvd=@(Get-VMDvdDrive -VM $vm -ErrorAction Stop)
    Assert-CityGoWatchdog ($dvd.Count-eq1-and[string]$dvd[0].Path-ieq$Plan.publicSeedPath) 'public_seed_changed'
    Write-CityGoWatchdogRecord $Plan 'watchdog-seed-detach-intent.json' ([ordered]@{operationId=$Plan.operationId;vmId=$Plan.vmId;publicSeedSha256=$Plan.publicSeedSha256}) $Owner
    Set-VMDvdDrive -VMDvdDrive $dvd[0] -Path $null -ErrorAction Stop
    for($attempt=0;$attempt-lt10;$attempt++){
        $fresh=Get-VM -Id ([guid]$Plan.vmId) -ErrorAction Stop
        Assert-CityGoWatchdog ($fresh.Name-ceq$Plan.vmName-and[string]$fresh.Path-ieq$Plan.vmPath) 'seed_readback_vm_changed'
        $current=@(Get-VMDvdDrive -VM $fresh -ErrorAction Stop)
        Assert-CityGoWatchdog ($current.Count-eq1-and(-not$current[0].Path-or[string]$current[0].Path-ieq$Plan.publicSeedPath)) 'foreign_seed_readback'
        if(-not$current[0].Path){
            $StopPlan.seedPath=$null;$StopPlan.seedSha256=$null
            # Independent Hyper-V cmdlets can expose different generations
            # just after a detach. Retry ONLY full read-only verification;
            # never repeat Set-VMDvdDrive or act on a failed/partial guard.
            try{$null=Get-CityGoCanaryStopNative $StopPlan -ObserveStopping}catch{
                if($attempt-ge9){throw}
                Start-Sleep -Milliseconds 250
                continue
            }
            Write-CityGoWatchdogRecord $Plan 'watchdog-seed-detached.json' ([ordered]@{operationId=$Plan.operationId;vmId=$Plan.vmId;dvdEmpty=$true}) $Owner
            return
        }
        Start-Sleep -Milliseconds 250
    }
    throw 'ci_watchdog_seed_detach_not_verified'
}

function Invoke-CityGoOwnedWatchdog {
    param([Collections.IDictionary]$Request)
    $plan=Get-CityGoWatchdogPlan $Request
    $result=[ordered]@{scope='owned_ci_host_watchdog';operationId=$plan.operationId;vmId=$plan.vmId;
        stage='plan_only_unverified';ciJobsAdmitted=$false;runnerRegistered=$false;guestIsolationVerified=$false}
    if(-not$Request.apply){$result.plan=$plan;return $result}
    Assert-CityGoWatchdog ($Request.acknowledge-ceq$plan.requiredAcknowledgement) 'acknowledgement_required'
    $owner=Get-CityGoWatchdogOwner;$held=@();$armed=$false;$phase='load_exact_helpers';$reason=''
    try{
        $held+=,(Open-CityGoWatchdogLibrary $plan.stopHelperPath $plan.stopHelperSha256 $owner)
        $held+=,(Open-CityGoWatchdogLibrary $plan.cleanupHelperPath $plan.cleanupHelperSha256 $owner)
        $evidence=Open-CityGoCanaryCleanupEvidence $plan.manifestPath $owner $plan.manifestSha256;$held+=,$evidence.stream
        $manifest=$evidence.value;$binding=Get-CityGoCanaryCleanupPlan $manifest @{manifestPath=$plan.manifestPath;manifestSha256=$plan.manifestSha256}
        Assert-CityGoWatchdog ($binding.vmId-ceq$plan.vmId-and$binding.operationId-ceq$plan.operationId-and-not$binding.resumedCreation) 'manifest_binding_invalid'
        foreach($key in @('vmName','nicId','nicName','vmPath')){$plan[$key]=$binding[$key]}
        $stopRequest=[ordered]@{operationId=$plan.operationId;vmId=$plan.vmId;manifestSha256=$plan.manifestSha256;
            resumedCreation=$false;seedPath='';seedSha256='';graceSeconds=30;turnOffSeconds=30;apply=$true;acknowledge=''}
        $stopPlan=Get-CityGoCanaryStopPlan $stopRequest
        foreach($key in @('vmName','nicId','nicName','targetDirectory','targetVhdx','vmPath','diskIdentifier','diskType')){$stopPlan[$key]=$binding[$key]}
        if($plan.publicSeedPath){
            $held+=,(Open-CityGoWatchdogPublicSeed $plan $owner)
            $stopPlan.seedPath=$plan.publicSeedPath;$stopPlan.seedSha256=$plan.publicSeedSha256
        }
        $phase='arm_only_off_pinned_dvd_private_client'
        $vm=Get-CityGoCanaryStopNative $stopPlan
        Assert-CityGoWatchdog ([string]$vm.State-ceq'Off') 'arm_requires_off'
        $nic=@(Get-VMNetworkAdapter -VM $vm -ErrorAction Stop)
        Assert-CityGoWatchdog ($nic.Count-eq1-and$nic[0].SwitchId-and[guid]$nic[0].SwitchId-eq[guid]$plan.privateSwitchId) 'arm_requires_private_switch'
        $now=Get-CityGoWatchdogNow;$deadline=[DateTimeOffset]::Parse($plan.deadlineUtc,[Globalization.CultureInfo]::InvariantCulture)
        $remaining=($deadline-$now).TotalSeconds
        Assert-CityGoWatchdog ($remaining-ge15-and$remaining-le3600-and(Test-CityGoWatchdogController $plan)-and
            (Get-CityGoWatchdogNetworkHash $plan)-ceq$plan.networkSha256-and-not(Test-Path -LiteralPath $plan.requestPath)) 'arm_precondition_failed'
        foreach($name in @('watchdog-ready.json','watchdog-result.json','watchdog-failure.json','canary-stop-intent.json','canary-cleanup-intent.json')){
            Assert-CityGoWatchdog (-not(Test-Path -LiteralPath ($plan.controlDirectory+'\'+$name))) 'existing_attempt_refused'
        }
        $start=Get-CityGoWatchdogTicks
        Write-CityGoWatchdogRecord $plan 'watchdog-ready.json' ([ordered]@{operationId=$plan.operationId;vmId=$plan.vmId;
            stage='armed_off_client';deadlineUtc=$plan.deadlineUtc;controllerPid=$plan.controllerPid;networkSha256=$plan.networkSha256;ciJobsAdmitted=$false}) $owner
        $armed=$true;$phase='independent_monitor'
        try{
            # Separate iteration + monotonic + UTC bounds. Never reset on drift.
            for($poll=0;$poll-le3601;$poll++){
                $elapsed=((Get-CityGoWatchdogTicks)-$start)/[Diagnostics.Stopwatch]::Frequency
                if((Get-CityGoWatchdogNow)-ge$deadline-or$elapsed-ge$remaining){$reason='deadline';break}
                if(-not(Test-CityGoWatchdogController $plan)){$reason='controller_exited';break}
                if((Get-CityGoWatchdogNetworkHash $plan)-cne$plan.networkSha256){$reason='network_changed';break}
                $action=Read-CityGoWatchdogRequest $plan $owner
                if($action){$reason=$action;break}
                Start-Sleep -Milliseconds 1000
            }
            if(-not$reason){$reason='iteration_limit'}
        }catch{$reason='observation_failed'}
        $phase='close_exact_client_network';Disconnect-CityGoWatchdogClient $plan $owner
        $phase='detach_exact_public_seed';Disconnect-CityGoWatchdogPublicSeed $plan $stopPlan $owner
        $phase='stop_exact_client'
        $stopRequest.acknowledge=$stopPlan.requiredAcknowledgement
        $stopped=Invoke-CityGoOwnedCanaryStop $stopRequest
        Write-CityGoWatchdogRecord $plan 'watchdog-stop-observation.json' $stopped $owner
        # Failed/ambiguous stops never authorize another native stop. A final
        # independently verified Off is still mandatory before any deletion.
        Assert-CityGoWatchdog ($stopped.stage-ceq'stopped_off_verified'-and$stopped.vmOff-is[bool]-and$stopped.vmOff) 'stop_not_verified'
        $vm=Get-CityGoCanaryStopNative $stopPlan
        Assert-CityGoWatchdog ([string]$vm.State-ceq'Off') 'cleanup_requires_off'
        $phase='remove_exact_off_client'
        $removed=Invoke-CityGoCanaryCleanup $manifest @{manifestPath=$plan.manifestPath;manifestSha256=$plan.manifestSha256;apply=$true;acknowledge=$binding.requiredAcknowledgement}
        Write-CityGoWatchdogRecord $plan 'watchdog-cleanup-observation.json' $removed $owner
        Assert-CityGoWatchdog ($removed.stage-ceq'cleanup_complete_resources_absent'-and$removed.vmAbsent-is[bool]-and$removed.vmAbsent-and$removed.diskAbsent-is[bool]-and$removed.diskAbsent) 'cleanup_not_verified'
        Assert-CityGoWatchdog (@(Get-VM -ErrorAction Stop|Where-Object{$_.Id.ToString('D')-ceq$plan.vmId}).Count-eq0-and-not(Test-Path -LiteralPath $binding.targetVhdx)) 'resources_remain'
        $result.stage='watchdog_cleanup_completed';$result.reason=$reason;$result.clientNetworkDisconnected=$true;$result.vmAbsent=$true;$result.diskAbsent=$true
        Write-CityGoWatchdogRecord $plan 'watchdog-result.json' $result $owner
        return $result
    }catch{
        $result.stage='failed_preserved_requires_inspection';$result.failurePhase=$phase;$result.armed=$armed;$result.reason=$reason
        $result.code='watchdog_native_failed'
        # No raw native exception, arbitrary process text or secret in evidence.
        try{Write-CityGoWatchdogRecord $plan 'watchdog-failure.json' $result $owner}catch{}
        return $result
    }finally{foreach($stream in $held){$stream.Dispose()}}
}

try{
    $request=[ordered]@{operationId=$OperationId;vmId=$VmId;manifestSha256=$ExpectedManifestSha256;networkSha256=$ExpectedNetworkSha256;
        privateSwitchId=$PrivateSwitchId;controllerPid=$ControllerPid;controllerStartedAt=$ControllerStartedAt;deadlineUtc=$DeadlineUtc;
        publicSeedPath=$PublicSeedPath;publicSeedSha256=$ExpectedPublicSeedSha256;apply=[bool]$Apply;acknowledge=$Acknowledge}
    $result=Invoke-CityGoOwnedWatchdog $request;$result|ConvertTo-Json -Depth 5 -Compress
    if($result.stage-like'failed_*'){exit 1}
}catch{Write-Output '{"stage":"preconditions_not_met","ciJobsAdmitted":false}';exit 2}
