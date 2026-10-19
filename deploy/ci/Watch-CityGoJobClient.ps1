# Full-job client watchdog adapter. Original short canary script is unchanged.
# A locked exact job plan is mandatory for the larger PUBLIC two-archive ISO.
# No boot, connection, registration, key access or global configuration.
[CmdletBinding()]
param([string]$OperationId='',[string]$VmId='',[string]$ExpectedManifestSha256='',[string]$ExpectedNetworkSha256='',
    [string]$PrivateSwitchId='',[int]$ControllerPid=0,[string]$ControllerStartedAt='',[string]$DeadlineUtc='',
    [string]$PublicSeedPath='',[string]$ExpectedPublicSeedSha256='',[string]$ExpectedJobPlanSha256='',
    [switch]$Apply,[string]$Acknowledge='')
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'

function Open-CityGoJobClientPublicSeed {
    param([Collections.IDictionary]$Plan,[string]$Owner)
    # ONLY the explicitly PUBLIC, hash-bound ISO may carry native Hyper-V
    # storage read capabilities. No credentials may be put in these seeds.
    # This grants no ACE and does not weaken private helper/control guards.
    Assert-CityGoWatchdog ($Plan.jobPlanSha256-is[string]-and$Plan.jobPlanSha256-cmatch'^[a-f0-9]{64}$'-and
        $Plan.publicSeedPath-ceq('D:\CityGo-CI\seeds\'+$Plan.operationId+'\runner-cidata.iso')) 'full_job_public_seed_required'
    $j=Open-CityGoCanaryCleanupEvidence $Plan.jobPlanPath $Owner $Plan.jobPlanSha256
    try{$null=Get-CityGoWatchdogJobLease $j.value $Plan}finally{$j.stream.Dispose()}
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
        $maximum=320MB
        Assert-CityGoWatchdog ($stream.Length-ge32768-and$stream.Length-le$maximum) 'public_seed_size_invalid'
        $sha=[Security.Cryptography.SHA256]::Create()
        try{$actual=([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
        Assert-CityGoWatchdog ($actual-ceq$Plan.publicSeedSha256) 'public_seed_hash_invalid'
        return $stream
    }catch{$stream.Dispose();throw}
}

function Invoke-CityGoJobClientWatch {
    param([Collections.IDictionary]$Request)
    foreach($key in @('operationId','vmId')){
        if($Request[$key]-isnot[string]-or$Request[$key]-cnotmatch'^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'){throw 'ci_job_watch_identity'}
    }
    foreach($key in @('manifestSha256','networkSha256','jobPlanSha256','publicSeedSha256')){
        if($Request[$key]-isnot[string]-or$Request[$key]-cnotmatch'^[a-f0-9]{64}$'){throw 'ci_job_watch_hash'}
    }
    $ack='WATCH_JOB_CLIENT:'+$Request.vmId+':'+$Request.manifestSha256+':'+$Request.jobPlanSha256+':'+$Request.publicSeedSha256
    if(-not$Request.apply){return @{stage='plan_only_unverified';requiredAcknowledgement=$ack;ciJobsAdmitted=$false}}
    if($Request.acknowledge-cne$ack){throw 'ci_job_watch_acknowledgement'}
    $held=$null;$original=$null
    try{
        $path=Join-Path $PSScriptRoot 'Watch-CityGoOwnedCanary.ps1'
        $held=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
        if($held.Length-lt1-or$held.Length-gt131072){throw 'ci_job_watch_library_size'}
        $sha=[Security.Cryptography.SHA256]::Create()
        try{$actual=([BitConverter]::ToString($sha.ComputeHash($held))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
        if($actual-cne'f0c7ebff2673c66b0ea0bd3abc567abbb54c96b2950143b98ed4fba4fb413913'){throw 'ci_job_watch_library_pin'}
        $held.Position=0;$reader=[IO.StreamReader]::new($held,[Text.UTF8Encoding]::new($false,$true),$false,4096,$true)
        try{$source=$reader.ReadToEnd()}finally{$reader.Dispose()}
        $tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseInput($source,$path,[ref]$tokens,[ref]$errors)
        if($errors.Count){throw 'ci_job_watch_library_parse'}
        foreach($d in $ast.FindAll({param($n)$n-is[Management.Automation.Language.FunctionDefinitionAst]},$true)){
            if($d.Parent-isnot[Management.Automation.Language.NamedBlockAst]-or$d.Parameters.Count){throw 'ci_job_watch_library_definition'}
            Set-Item ('Function:script:'+$d.Name) -Value $d.Body.GetScriptBlock()
        }
        $owner=Get-CityGoWatchdogOwner
        # Reuse the original self-contained ACL/plain-path/source loader to
        # verify its own frozen bundle before ANY delegated native operation.
        $verified=Open-CityGoWatchdogLibrary $path $actual $owner
        $verified.Dispose()
        $original=(Get-Item Function:Open-CityGoWatchdogPublicSeed).ScriptBlock
        Set-Item Function:script:Open-CityGoWatchdogPublicSeed -Value (Get-Item Function:Open-CityGoJobClientPublicSeed).ScriptBlock
        $plan=Get-CityGoWatchdogPlan $Request
        $delegated=@{};foreach($key in $Request.Keys){$delegated[$key]=$Request[$key]}
        $delegated.acknowledge=$plan.requiredAcknowledgement
        return Invoke-CityGoOwnedWatchdog $delegated
    }finally{
        if($original){Set-Item Function:script:Open-CityGoWatchdogPublicSeed -Value $original}
        if($held){$held.Dispose()}
    }
}

try{
    $r=Invoke-CityGoJobClientWatch @{operationId=$OperationId;vmId=$VmId;manifestSha256=$ExpectedManifestSha256;networkSha256=$ExpectedNetworkSha256;
        privateSwitchId=$PrivateSwitchId;controllerPid=$ControllerPid;controllerStartedAt=$ControllerStartedAt;deadlineUtc=$DeadlineUtc;
        publicSeedPath=$PublicSeedPath;publicSeedSha256=$ExpectedPublicSeedSha256;jobPlanSha256=$ExpectedJobPlanSha256;apply=[bool]$Apply;acknowledge=$Acknowledge}
    $r|ConvertTo-Json -Depth 5 -Compress
    if($r.stage-like'failed*'){exit 1}
}catch{@{stage='refused';ciJobsAdmitted=$false}|ConvertTo-Json -Compress;exit 2}
