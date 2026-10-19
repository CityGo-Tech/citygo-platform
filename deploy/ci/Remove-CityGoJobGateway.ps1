# OFF-only cleanup of one complete gateway. No Stop, boot or network mutations.
# Same bounded disk/tree cleanup as a client, with a STRICT two-NIC profile guard.
[CmdletBinding()]
param([string]$OperationId='',[string]$ExpectedManifestSha256='',[string]$ExpectedGatewaySha256='',
    [switch]$Apply,[string]$Acknowledge='')
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'

function Get-CityGoJobGatewayCleanupPlan {
    param([Collections.IDictionary]$Request)
    if($Request.operationId-isnot[string]-or$Request.operationId-cnotmatch'^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'){throw 'ci_gateway_cleanup_identity'}
    foreach($key in @('manifestSha256','gatewaySha256')){if($Request[$key]-isnot[string]-or$Request[$key]-cnotmatch'^[a-f0-9]{64}$'){throw 'ci_gateway_cleanup_hash'}}
    $control='D:\CityGo-CI\control\'+$Request.operationId
    return [ordered]@{operationId=$Request.operationId;controlDirectory=$control;manifestPath=($control+'\canary-creation.json');gatewayPath=($control+'\gateway-creation.json');
        manifestSha256=$Request.manifestSha256;gatewaySha256=$Request.gatewaySha256;
        requiredAcknowledgement=('DELETE_OFF_JOB_GATEWAY:'+$Request.operationId+':'+$Request.manifestSha256+':'+$Request.gatewaySha256)}
}

function Open-CityGoJobGatewayCleanupLibrary {
    param([string]$Name,[string]$Hash)
    if($Name-cnotin@('Remove-CityGoCanaryVm.ps1','Convert-CityGoCanaryToGateway.ps1')){throw 'ci_gateway_cleanup_library_name'}
    $path=Join-Path $PSScriptRoot $Name
    $stream=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try{
        if($stream.Length-lt1-or$stream.Length-gt65536){throw 'ci_gateway_cleanup_library_size'}
        $hasher=[Security.Cryptography.SHA256]::Create()
        try{$actual=([BitConverter]::ToString($hasher.ComputeHash($stream))).Replace('-','').ToLowerInvariant()}finally{$hasher.Dispose()}
        if($actual-cne$Hash){throw 'ci_gateway_cleanup_library_pin'}
        $stream.Position=0;$reader=[IO.StreamReader]::new($stream,[Text.UTF8Encoding]::new($false,$true),$false,4096,$true)
        try{$source=$reader.ReadToEnd()}finally{$reader.Dispose()}
        $tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseInput($source,$path,[ref]$tokens,[ref]$errors)
        if($errors.Count){throw 'ci_gateway_cleanup_library_parse'}
        foreach($d in $ast.FindAll({param($n)$n-is[Management.Automation.Language.FunctionDefinitionAst]},$true)){
            if($d.Parent-isnot[Management.Automation.Language.NamedBlockAst]-or$d.Parameters.Count){throw 'ci_gateway_cleanup_library_definition'}
            Set-Item -Path ('Function:script:'+$d.Name) -Value $d.Body.GetScriptBlock()
        }
        return $stream
    }catch{$stream.Dispose();throw}
}

function Assert-CityGoJobGatewayReceipt {
    param($Receipt,$Binding,$Plan)
    $keys=@('schemaVersion','scope','operationId','stage','guestIsolationVerified','githubRunnerRegistered','ciJobsAdmitted',
        'vmId','vmName','vmPath','targetVhdx','diskIdentifier','wanMac','lanNicId','lanNicName','lanMac','wanNicId','wanNicName',
        'originalCreationManifestSha256','processorCount','memoryStartupBytes','automaticStopAction')
    $actual=@($Receipt.PSObject.Properties.Name)
    if($actual.Count-ne$keys.Count-or@($actual|Where-Object{$_-cnotin$keys}).Count-or$Receipt.schemaVersion-isnot[int]-or$Receipt.schemaVersion-ne1-or
        $Receipt.scope-cne'owned_trusted_gateway_profile'-or$Receipt.stage-cne'gateway_prepared_off_disconnected'-or
        $Receipt.originalCreationManifestSha256-cne$Plan.manifestSha256-or$Receipt.operationId-cne$Binding.operationId){throw 'ci_gateway_cleanup_profile_invalid'}
    foreach($name in @('vmId','vmName','vmPath','targetVhdx','diskIdentifier')){if($Receipt.$name-cne$Binding[$name]){throw 'ci_gateway_cleanup_profile_binding'}}
    if($Receipt.wanNicId-cne$Binding.nicId-or$Receipt.wanNicName-cne$Binding.nicName-or$Receipt.processorCount-isnot[int]-or$Receipt.processorCount-ne2-or
        $Receipt.memoryStartupBytes-isnot[long]-or$Receipt.memoryStartupBytes-ne2GB-or$Receipt.automaticStopAction-cne'TurnOff'){throw 'ci_gateway_cleanup_profile_resources'}
    foreach($name in @('guestIsolationVerified','githubRunnerRegistered','ciJobsAdmitted')){
        if($Receipt.$name-isnot[bool]-or$Receipt.$name){throw 'ci_gateway_cleanup_profile_scope'}
    }
    # Hyper-V preserves uppercase GUIDs in native NIC IDs on some hosts.
    # Accept only GUID case differences here; the complete native ID is still
    # retained and compared exactly against live inventory before any removal.
    $lanMatch=[regex]::Match([string]$Receipt.lanNicId,('^Microsoft:'+[regex]::Escape($Binding.vmId)+'\\([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$'),[Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if($Receipt.lanNicName-cne'CityGo-Gateway-LAN'-or$Receipt.lanNicId-isnot[string]-or
        -not$lanMatch.Success-or$lanMatch.Value-cne$Receipt.lanNicId-or
        $Receipt.lanNicId-ceq$Receipt.wanNicId){throw 'ci_gateway_cleanup_lan_identity'}
    foreach($name in @('wanMac','lanMac')){if($Receipt.$name-isnot[string]-or$Receipt.$name-cnotmatch'^02(?::[a-f0-9]{2}){5}$'){throw 'ci_gateway_cleanup_mac'}}
    if($Receipt.wanMac-ceq$Receipt.lanMac){throw 'ci_gateway_cleanup_mac'}
}

function Invoke-CityGoJobGatewayCleanup {
    param([Collections.IDictionary]$Request)
    $plan=Get-CityGoJobGatewayCleanupPlan $Request
    if(-not$Request.apply){return [ordered]@{stage='plan_only_unverified';resourcesRemoved=$false;plan=$plan}}
    if($Request.acknowledge-cne$plan.requiredAcknowledgement){throw 'ci_gateway_cleanup_acknowledgement'}
    $held=@();$phase='pinned_helpers';$original=$null
    try{
        $held+=,(Open-CityGoJobGatewayCleanupLibrary 'Remove-CityGoCanaryVm.ps1' '70f036f9b6c9885f6cfd15f5a362883b7bf72803dddf5d6fe28fc17c29bea098')
        $original=(Get-Item Function:Get-CityGoCanaryCleanupVm -ErrorAction Stop).ScriptBlock
        if($original-isnot[scriptblock]){throw 'ci_gateway_cleanup_inventory_missing'}
        $held+=,(Open-CityGoJobGatewayCleanupLibrary 'Convert-CityGoCanaryToGateway.ps1' 'cb1745726334e598f9c9e40df0ed0261e9a2901cccaccf01d69a73fd835eecff')
        $owner=Get-CityGoCanaryCleanupIdentity $true
        Assert-CityGoCanaryCleanupPlainPath $PSScriptRoot $true;Assert-CityGoCanaryCleanupPrivateAcl $PSScriptRoot $owner $true
        $m=Open-CityGoCanaryCleanupEvidence $plan.manifestPath $owner $plan.manifestSha256;$held+=,$m.stream
        $g=Open-CityGoCanaryCleanupEvidence $plan.gatewayPath $owner $plan.gatewaySha256;$held+=,$g.stream
        $binding=Get-CityGoCanaryCleanupPlan $m.value @{manifestPath=$plan.manifestPath;manifestSha256=$plan.manifestSha256}
        Assert-CityGoJobGatewayReceipt $g.value $binding $plan
        $profile=[ordered]@{};foreach($key in $binding.Keys){$profile[$key]=$binding[$key]}
        foreach($key in @('wanMac','lanMac','lanNicId','lanNicName')){$profile[$key]=$g.value.$key}
        # Override only this process's inventory adapter. It is a host-owned
        # closure, not a guest callback. All original tree/disk/foreign-chain,
        # durable intent, OFF-before-delete and absent readbacks stay unchanged.
        $script:ciJobGatewayBinding=$profile;$script:ciJobGatewayOriginalVm=$original
        Set-Item Function:script:Get-CityGoCanaryCleanupVm -Value {
            param($Plan)
            foreach($key in @('operationId','vmId','vmPath','targetVhdx','diskIdentifier')){
                if($Plan[$key]-cne$script:ciJobGatewayBinding[$key]){throw 'ci_gateway_cleanup_adapter_binding'}
            }
            $owned=@(Get-VM -ErrorAction Stop|Where-Object{$_.Id.ToString('D')-ceq$Plan.vmId})
            if($owned.Count-eq0){return (& $script:ciJobGatewayOriginalVm $Plan)}
            if($owned.Count-ne1){throw 'ci_gateway_cleanup_duplicate'}
            return Get-CityGoGatewayProfileVm $script:ciJobGatewayBinding $true
        }
        $phase='off_gateway_cleanup'
        return Invoke-CityGoCanaryCleanup $m.value @{manifestPath=$plan.manifestPath;manifestSha256=$plan.manifestSha256;apply=$true;acknowledge=$binding.requiredAcknowledgement}
    }catch{return [ordered]@{stage='failed_preserved';phase=$phase;code='ci_gateway_cleanup_not_verified';resourcesRemoved=$false}}
    finally{
        if($original){Set-Item Function:script:Get-CityGoCanaryCleanupVm -Value $original}
        $script:ciJobGatewayBinding=$null;$script:ciJobGatewayOriginalVm=$null
        foreach($stream in $held){$stream.Dispose()}
    }
}

try{
    $result=Invoke-CityGoJobGatewayCleanup @{operationId=$OperationId;manifestSha256=$ExpectedManifestSha256;gatewaySha256=$ExpectedGatewaySha256;apply=[bool]$Apply;acknowledge=$Acknowledge}
    $result|ConvertTo-Json -Depth 5 -Compress
    if($result.stage-like'failed*'){exit 1}
}catch{[ordered]@{stage='refused';resourcesRemoved=$false}|ConvertTo-Json -Compress;exit 2}
