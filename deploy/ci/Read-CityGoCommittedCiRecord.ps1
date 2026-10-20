# Trusted installed host library, no entrypoint or side effects on import.
# Requires the pinned cleanup/stop guards already loaded by the host controller.
# Return null ONLY while a record is absent or exclusively locked by its writer.
function Read-CityGoCommittedCiRecord {
    param([string]$OperationId,[string]$Name,[string]$OwnerSid)
    if($OperationId-cnotmatch'^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'-or
        $Name-cnotin@('watchdog-ready.json','watchdog-result.json','watchdog-failure.json')-or
        $OwnerSid-cnotmatch'^S-1-5-21-(?:[0-9]+-){3}[0-9]+$'){throw 'ci_committed_record_identity'}
    $directory='D:\CityGo-CI\control\'+$OperationId
    Assert-CityGoCanaryStopPlainPath $directory $true
    Assert-CityGoCanaryStopAcl $directory $OwnerSid $true
    $path=$directory+'\'+$Name
    if(-not(Test-Path -LiteralPath $path -ErrorAction Stop)){return $null}
    $evidence=$null
    try{
        $evidence=Open-CityGoCanaryCleanupEvidence $path $OwnerSid
        return $evidence.value
    }catch{
        # Exclusive writers expose a visible path before flush/close. A
        # sharing violation is NOT invalid JSON or an ownership/ACL failure.
        # The caller retains its original bounded wait/deadline; this helper
        # never sleeps, extends a lease, retries a write or admits a VM.
        $exception=$_.Exception
        for($depth=0;$depth-lt8-and$exception;$depth++){
            if($exception-is[IO.IOException]-and($exception.HResult-band0xffff)-in@(32,33)){return $null}
            $exception=$exception.InnerException
        }
        throw
    }finally{
        if($evidence-and$evidence.stream){$evidence.stream.Dispose()}
    }
}
