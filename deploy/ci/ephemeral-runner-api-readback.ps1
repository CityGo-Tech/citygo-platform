# Pure repository-runner observation. This is NOT authorization to run PR code.
# --no-default-labels can produce API os=unknown. The repository REST response
# may omit ephemeral entirely; do not manufacture that proof from a missing key.
function Get-CityGoRunnerApiReadback {
    param($Record,[string]$OperationId,[long]$ExpectedAgentId=0)
    $id=[guid]::Empty
    if(-not[guid]::TryParseExact($OperationId,'D',[ref]$id)-or$id-eq[guid]::Empty-or$OperationId-cne$id.ToString('D')){throw 'ci_runner_api_operation_invalid'}
    $hash=[Security.Cryptography.SHA256]::Create()
    try{$suffix=([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::ASCII.GetBytes($OperationId)))).Replace('-','').ToLowerInvariant().Substring(0,16)}finally{$hash.Dispose()}
    if($null-eq$Record-or($Record.id-isnot[int]-and$Record.id-isnot[long])-or$Record.id-lt1-or
       $Record.name-cne('citygo-ci-canary-'+$OperationId)-or$Record.os-cnotin@('linux','unknown')-or
       $Record.status-cnotin@('online','offline')-or$Record.busy-isnot[bool]-or
       @($Record.labels).Count-ne1-or$Record.labels[0].name-cne('citygo-ci-canary-'+$suffix)-or$Record.labels[0].type-cne'custom'-or
       ($ExpectedAgentId-ne0-and$Record.id-ne$ExpectedAgentId)){throw 'ci_runner_api_identity_invalid'}
    $field=@($Record.PSObject.Properties|Where-Object{$_.Name-ceq'ephemeral'})
    if($field.Count-gt1-or($field.Count-eq1-and($field[0].Value-isnot[bool]-or-not$field[0].Value))){throw 'ci_runner_api_ephemeral_false_or_invalid'}
    return [ordered]@{runnerId=$Record.id;name=$Record.name;status=$Record.status;busy=$Record.busy;apiOs=$Record.os;
        ephemeralAttributePresent=($field.Count-eq1);linuxOrEphemeralReadinessProven=$false}
}
