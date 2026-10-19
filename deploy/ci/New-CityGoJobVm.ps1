# Trusted installed HOST bundle only. One fresh OFF/disconnected client/gateway.
# No boot, network connection, registration, key access or production changes.
[CmdletBinding()]
param([string]$OperationId='', [string]$Role='', [string]$BaseOperationId='', [string]$BaseVmId='',
    [string]$ExpectedBaseSha256='', [string]$ExpectedSealSha256='', [string]$WanMac='', [string]$LanMac='',
    [switch]$Apply, [string]$Acknowledge='')
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'

function Get-CityGoJobVmPlan {
    param([Collections.IDictionary]$Request)
    foreach($name in @('operationId','baseOperationId','baseVmId')){
        if($Request[$name]-isnot[string]-or$Request[$name]-cnotmatch'^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'){throw 'ci_job_vm_identity_invalid'}
    }
    if($Request.operationId-ceq$Request.baseOperationId-or$Request.role-cnotin@('client','gateway')){throw 'ci_job_vm_role_invalid'}
    foreach($name in @('baseSha256','sealSha256')){if($Request[$name]-isnot[string]-or$Request[$name]-cnotmatch'^[a-f0-9]{64}$'){throw 'ci_job_vm_hash_invalid'}}
    if($Request.role-ceq'gateway'){
        foreach($mac in @($Request.wanMac,$Request.lanMac)){if($mac-isnot[string]-or$mac-cnotmatch'^02(?::[a-f0-9]{2}){5}$'){throw 'ci_job_vm_mac_invalid'}}
        if($Request.wanMac-ceq$Request.lanMac){throw 'ci_job_vm_mac_invalid'}
    }elseif($Request.wanMac-or$Request.lanMac){throw 'ci_job_vm_mac_invalid'}
    return [ordered]@{operationId=$Request.operationId;role=$Request.role;baseVmId=$Request.baseVmId;
        controlDirectory=('D:\CityGo-CI\control\'+$Request.operationId);
        basePath=('D:\CityGo-CI\bootstrap\'+$Request.baseOperationId+'\bootstrap.vhdx');
        sealPath=('D:\CityGo-CI\control\'+$Request.baseOperationId+'\sealed-base.json');
        baseSha256=$Request.baseSha256;sealSha256=$Request.sealSha256;
        requiredAcknowledgement=('CREATE_JOB_VM:'+$Request.operationId+':'+$Request.role+':'+$Request.baseSha256+':'+$Request.sealSha256)}
}

function Open-CityGoJobVmLibrary {
    param([string]$Name,[string]$Hash)
    if($Name-cnotin@('New-CityGoCanaryVm.ps1','Convert-CityGoCanaryToGateway.ps1','Test-CityGoRunnerHost.ps1')){throw 'ci_job_vm_library_name'}
    $path=Join-Path $PSScriptRoot $Name
    $stream=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try{
        if($stream.Length-lt1-or$stream.Length-gt65536){throw 'ci_job_vm_library_bounds'}
        $hasher=[Security.Cryptography.SHA256]::Create()
        try{$actual=([BitConverter]::ToString($hasher.ComputeHash($stream))).Replace('-','').ToLowerInvariant()}finally{$hasher.Dispose()}
        if($actual-cne$Hash){throw 'ci_job_vm_library_pin'}
        $stream.Position=0;$reader=[IO.StreamReader]::new($stream,[Text.UTF8Encoding]::new($false,$true),$false,4096,$true)
        try{$source=$reader.ReadToEnd()}finally{$reader.Dispose()}
        $tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseInput($source,$path,[ref]$tokens,[ref]$errors)
        if($errors.Count){throw 'ci_job_vm_library_parse'}
        foreach($definition in $ast.FindAll({param($n)$n-is[Management.Automation.Language.FunctionDefinitionAst]},$true)){
            if($definition.Parent-isnot[Management.Automation.Language.NamedBlockAst]-or$definition.Parameters.Count){throw 'ci_job_vm_library_definition'}
            # Keep the verified source filename in the AST: string-recreating a
            # function drops PSScriptRoot and breaks its pinned sibling imports.
            # All admitted libraries declare parameters in their body, never
            # in the function header; refuse inline parameters rather than lose them.
            Set-Item -Path ('Function:script:'+$definition.Name) -Value $definition.Body.GetScriptBlock()
        }
        return $stream
    }catch{$stream.Dispose();throw}
}

function Write-CityGoJobVmEvidence {
    param($Plan,[string]$Name,$Value,[string]$Owner)
    if($Name-cnotin@('preflight.json','job-vm-intent.json','job-vm-result.json','job-vm-failure.json','gateway-profile-observation.json')){throw 'ci_job_vm_record_name'}
    Assert-CityGoCanaryPlainPath $Plan.controlDirectory $true
    Assert-CityGoCanaryPrivateAcl $Plan.controlDirectory $Owner $true
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Value|ConvertTo-Json -Depth 6 -Compress))
    if($bytes.Length-gt65536){throw 'ci_job_vm_record_bounds'}
    $stream=[IO.File]::Open(($Plan.controlDirectory+'\'+$Name),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
}

function Invoke-CityGoJobPreflight {
    & (Join-Path $PSScriptRoot 'Test-CityGoRunnerHost.ps1') -GuestVcpu 4 -GuestMemoryGiB 6 -GuestDiskGiB 96 -HostMemoryReserveGiB 8|ConvertFrom-Json
}

function Invoke-CityGoJobVm {
    param([Collections.IDictionary]$Request)
    $plan=Get-CityGoJobVmPlan $Request
    if(-not$Request.apply){return [ordered]@{stage='plan_only_unverified';role=$plan.role;vmCreated=$false;runnerRegistered=$false;plan=$plan}}
    if($Request.acknowledge-cne$plan.requiredAcknowledgement){throw 'ci_job_vm_acknowledgement_required'}
    $held=@();$phase='load_pinned_helpers';$owner=$null
    try{
        $held+=,(Open-CityGoJobVmLibrary 'New-CityGoCanaryVm.ps1' 'cb625838a1f297dbfc3cd474a24c88f0abdf53d9912e913519b0fdc828f52026')
        $owner=Get-CityGoCanaryIdentity
        Assert-CityGoCanaryPlainPath $PSScriptRoot $true;Assert-CityGoCanaryPrivateAcl $PSScriptRoot $owner $true
        Assert-CityGoCanaryPlainPath 'D:\CityGo-CI\control' $true;Assert-CityGoCanaryPrivateAcl 'D:\CityGo-CI\control' $owner $true
        if(Test-Path -LiteralPath $plan.controlDirectory){throw 'ci_job_vm_operation_exists'}
        $null=New-Item -Path $plan.controlDirectory -ItemType Directory
        Set-CityGoCanaryPrivateDirectory $plan.controlDirectory $owner
        $phase='base_off_disconnected'
        $base=Get-VM -Id ([guid]$plan.baseVmId) -ErrorAction Stop
        $disks=@(Get-VMHardDiskDrive -VM $base -ErrorAction Stop)
        if([string]$base.State-cne'Off'-or$disks.Count-ne1-or$disks[0].Path-ine$plan.basePath-or
            @(Get-VMNetworkAdapter -VM $base|Where-Object{$_.SwitchName-or($_.SwitchId-and[guid]$_.SwitchId-ne[guid]::Empty)}).Count-or
            @(Get-VMDvdDrive -VM $base|Where-Object{$_.Path}).Count){throw 'ci_job_vm_base_changed'}
        Write-CityGoJobVmEvidence $plan 'job-vm-intent.json' ([ordered]@{operationId=$plan.operationId;role=$plan.role;stage='create_fresh_off_vm'}) $owner
        $phase='fresh_read_only_preflight'
        $held+=,(Open-CityGoJobVmLibrary 'Test-CityGoRunnerHost.ps1' '9dc7da20dfd62888e1abcaf5c587427400bcbbd4b78130f6f5e6b00605464620')
        $diagnostic=Invoke-CityGoJobPreflight
        $null=@(Get-VM -ErrorAction Stop)
        Write-CityGoJobVmEvidence $plan 'preflight.json' ([ordered]@{version=2;scope='elevated_read_only_host_inventory';observedAt=[DateTime]::UtcNow.ToString('o');status='observed-not-approved';errorCode=$null;
            diagnostic=$diagnostic;management=[ordered]@{inventoryReadSucceeded=$true;guestIsolationVerified=$false};vmCreated=$false;networkChanged=$false;servicesChanged=$false;runnerRegistered=$false}) $owner
        $preflight=$plan.controlDirectory+'\preflight.json'
        $phase='create_one_standalone_vm'
        $created=Invoke-CityGoCanaryVm ([ordered]@{operationId=$plan.operationId;basePath=$plan.basePath;baseSha256=$plan.baseSha256;sealedBaseEvidencePath=$plan.sealPath;sealedBaseEvidenceSha256=$plan.sealSha256;
            preflightPath=$preflight;preflightSha256=(Get-FileHash -LiteralPath $preflight -Algorithm SHA256).Hash.ToLowerInvariant();apply=$true;
            acknowledge=('CREATE_OFFLINE_CANARY_VM:'+$plan.operationId+':'+$plan.baseSha256+':'+$plan.sealSha256)})
        if($created.stage-cne'created_off_disconnected'){throw 'ci_job_vm_creation_incomplete'}
        $manifest=$plan.controlDirectory+'\canary-creation.json';$manifestSha=(Get-FileHash -LiteralPath $manifest -Algorithm SHA256).Hash.ToLowerInvariant()
        $profile=$null
        if($plan.role-ceq'gateway'){
            $phase='convert_off_gateway_profile'
            $held+=,(Open-CityGoJobVmLibrary 'Convert-CityGoCanaryToGateway.ps1' 'cb1745726334e598f9c9e40df0ed0261e9a2901cccaccf01d69a73fd835eecff')
            $profile=Invoke-CityGoGatewayProfile ([ordered]@{manifestPath=$manifest;manifestSha256=$manifestSha;wanMac=$Request.wanMac;lanMac=$Request.lanMac;apply=$true;
                acknowledge=('PREPARE_OFF_GATEWAY_PROFILE:'+$plan.operationId+':'+$manifestSha)})
            Write-CityGoJobVmEvidence $plan 'gateway-profile-observation.json' $profile $owner
            if($profile.stage-cne'gateway_prepared_off_disconnected'){throw 'ci_job_vm_gateway_incomplete'}
        }
        $result=[ordered]@{stage='job_vm_prepared_off_disconnected';operationId=$plan.operationId;role=$plan.role;vmId=$created.vmId;creationManifestSha256=$manifestSha;
            gatewayProfileSha256=$(if($profile){(Get-FileHash -LiteralPath ($plan.controlDirectory+'\gateway-creation.json') -Algorithm SHA256).Hash.ToLowerInvariant()}else{$null});
            runnerRegistered=$false;guestBooted=$false;networkChanged=$false;productionChanged=$false}
        Write-CityGoJobVmEvidence $plan 'job-vm-result.json' $result $owner
        return $result
    }catch{
        $result=[ordered]@{stage='failed_preserved';phase=$phase;operationId=$plan.operationId;role=$plan.role;code='ci_job_vm_not_verified';productionChanged=$false}
        if($owner){try{Write-CityGoJobVmEvidence $plan 'job-vm-failure.json' $result $owner}catch{}}
        return $result
    }finally{foreach($stream in $held){$stream.Dispose()}}
}

try{
    $result=Invoke-CityGoJobVm ([ordered]@{operationId=$OperationId;role=$Role;baseOperationId=$BaseOperationId;baseVmId=$BaseVmId;baseSha256=$ExpectedBaseSha256;sealSha256=$ExpectedSealSha256;wanMac=$WanMac;lanMac=$LanMac;apply=[bool]$Apply;acknowledge=$Acknowledge})
    $result|ConvertTo-Json -Depth 5 -Compress
    if($result.stage-ceq'failed_preserved'){exit 1}
}catch{[ordered]@{stage='refused';vmCreated=$false;productionChanged=$false}|ConvertTo-Json -Compress;exit 2}
