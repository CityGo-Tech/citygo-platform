# Create ONE new Private Hyper-V switch. No host NIC, NAT, VM attachment,
# guest boot, firewall modification, runner registration or CI admission.
[CmdletBinding()]
param([string]$OperationId='', [switch]$Apply, [string]$Acknowledge='')
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'

function Assert-CityGoPrivateSwitch {
    param([bool]$Condition,[string]$Code)
    if (-not $Condition) { throw $Code }
}

function Get-CityGoPrivateSwitchPlan {
    param([string]$Id)
    $guid=[guid]::Empty
    Assert-CityGoPrivateSwitch ($Id.Length -eq 36 -and [guid]::TryParseExact($Id,'D',[ref]$guid) -and
        $guid -ne [guid]::Empty -and $guid.ToString('D') -ceq $Id) 'operation_invalid'
    $control='D:\CityGo-CI\control\'+$Id
    return [ordered]@{operationId=$Id;switchName=('CityGo-CI-Private-'+$Id);notes=('CityGo owned private CI network '+$Id);
        controlDirectory=$control;intentPath=($control+'\private-switch-intent.json');resultPath=($control+'\private-switch-result.json');
        requiredAcknowledgement=('CREATE_PRIVATE_CI_SWITCH:'+$Id)}
}

function Open-CityGoPrivateSwitchGuards {
    # Only definitions from the reviewed creator, never its entrypoint.
    $path=Join-Path $PSScriptRoot 'New-CityGoCanaryVm.ps1'
    $stream=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try {
        Assert-CityGoPrivateSwitch ($stream.Length -gt 0 -and $stream.Length -le 131072) 'guard_size_invalid'
        $sha=[Security.Cryptography.SHA256]::Create()
        try { $actual=([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
        Assert-CityGoPrivateSwitch ($actual -ceq 'cb625838a1f297dbfc3cd474a24c88f0abdf53d9912e913519b0fdc828f52026') 'guard_hash_mismatch'
        $stream.Position=0
        $reader=[IO.StreamReader]::new($stream,[Text.UTF8Encoding]::new($false,$true),$true,4096,$true)
        try { $source=$reader.ReadToEnd() } finally { $reader.Dispose() }
        $tokens=$null;$errors=$null
        $ast=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors)
        Assert-CityGoPrivateSwitch ($errors.Count -eq 0) 'guard_parse_invalid'
        foreach ($name in @('Assert-CityGoCanaryValue','Get-CityGoCanaryLocalPath','Assert-CityGoCanaryPlainPath',
            'Get-CityGoCanaryIdentity','Assert-CityGoCanaryPrivateAcl')) {
            $found=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst]},$true)|Where-Object{$_.Name -ceq $name})
            Assert-CityGoPrivateSwitch ($found.Count -eq 1 -and $found[0].Parent -is [Management.Automation.Language.NamedBlockAst]) 'guard_definition_invalid'
            Set-Item -LiteralPath ('Function:script:'+$name) -Value $found[0].Body.GetScriptBlock() -ErrorAction Stop
        }
        return $stream
    } catch { $stream.Dispose();throw }
}

function Get-CityGoPrivateSwitchSnapshot {
    $switches=@(Get-VMSwitch -ErrorAction Stop|ForEach-Object{
        Assert-CityGoPrivateSwitch ($_.Id -is [guid] -and $_.Id -ne [guid]::Empty) 'switch_inventory_invalid'
        [ordered]@{id=$_.Id.ToString('D');name=[string]$_.Name;type=[string]$_.SwitchType;notes=[string]$_.Notes}
    }|Sort-Object { $_.id })
    $nics=@(Get-VMNetworkAdapter -All -ErrorAction Stop|ForEach-Object{
        # Native management adapters expose null VMId despite the reflected
        # Guid property. That is valid ONLY with native IsManagementOs=true.
        Assert-CityGoPrivateSwitch ($_.IsManagementOs -is [bool]) 'nic_kind_unobserved'
        $isHost=$_.IsManagementOs
        if ($isHost) {
            Assert-CityGoPrivateSwitch ($null -eq $_.VMId -or ($_.VMId -is [guid] -and $_.VMId -eq [guid]::Empty)) 'host_nic_vm_identity_invalid'
            $vmId=''
        } else {
            Assert-CityGoPrivateSwitch ($_.VMId -is [guid] -and $_.VMId -ne [guid]::Empty) 'guest_nic_vm_identity_invalid'
            $vmId=$_.VMId.ToString('D')
        }
        Assert-CityGoPrivateSwitch ($null -eq $_.SwitchId -or $_.SwitchId -is [guid]) 'nic_switch_identity_invalid'
        [ordered]@{id=[string]$_.Id;vmId=$vmId;managementOS=$isHost;name=[string]$_.Name;
            switchId=$(if($_.SwitchId){$_.SwitchId.ToString('D')}else{''});mac=[string]$_.MacAddress}
    }|Sort-Object { $_.id })
    $nats=@(Get-NetNat -ErrorAction Stop|ForEach-Object{
        [ordered]@{name=[string]$_.Name;prefix=[string]$_.InternalIPInterfaceAddressPrefix;active=[bool]$_.Active}
    }|Sort-Object { $_.name })
    Assert-CityGoPrivateSwitch ($switches.Count -le 128 -and $nics.Count -le 1024 -and $nats.Count -le 128) 'inventory_too_large'
    return [ordered]@{switches=$switches;nics=$nics;nats=$nats}
}

function Write-CityGoPrivateSwitchEvidence {
    param([string]$Path,$Value,$Plan,[string]$Owner)
    Assert-CityGoPrivateSwitch ($Path -cin @($Plan.intentPath,$Plan.resultPath)) 'evidence_path_invalid'
    Assert-CityGoCanaryPlainPath $Plan.controlDirectory $true
    Assert-CityGoCanaryPrivateAcl $Plan.controlDirectory $Owner $true
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Value|ConvertTo-Json -Depth 5 -Compress))
    Assert-CityGoPrivateSwitch ($bytes.Length -le 262144) 'evidence_too_large'
    $stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try { $stream.Write($bytes,0,$bytes.Length);$stream.Flush($true) } finally { $stream.Dispose() }
    Assert-CityGoCanaryPrivateAcl $Path $Owner
}

function Assert-CityGoPrivateSwitchReadback {
    param($Before,$After,$Created,$Plan)
    Assert-CityGoPrivateSwitch ($null -ne $Created -and $Created.Id -is [guid] -and $Created.Id -ne [guid]::Empty) 'created_identity_invalid'
    $id=$Created.Id.ToString('D')
    Assert-CityGoPrivateSwitch (@($Before.switches|Where-Object{$_.id -ceq $id}).Count -eq 0) 'created_id_not_new'
    $owned=@($After.switches|Where-Object{$_.id -ceq $id})
    Assert-CityGoPrivateSwitch ($owned.Count -eq 1 -and $owned[0].name -ceq $Plan.switchName -and
        $owned[0].type -ceq 'Private' -and $owned[0].notes -ceq $Plan.notes -and
        @($After.switches|Where-Object{$_.name -ieq $Plan.switchName}).Count -eq 1) 'private_switch_readback_invalid'
    Assert-CityGoPrivateSwitch (@($After.nics|Where-Object{$_.switchId -ceq $id}).Count -eq 0) 'new_switch_has_attached_nic'
    $remaining=@($After.switches|Where-Object{$_.id -cne $id})
    Assert-CityGoPrivateSwitch ((ConvertTo-Json -InputObject @($Before.switches) -Depth 5 -Compress) -ceq
        (ConvertTo-Json -InputObject $remaining -Depth 5 -Compress)) 'existing_switches_changed'
    foreach ($key in @('nics','nats')) {
        Assert-CityGoPrivateSwitch ((ConvertTo-Json -InputObject @($Before[$key]) -Depth 5 -Compress) -ceq
            (ConvertTo-Json -InputObject @($After[$key]) -Depth 5 -Compress)) 'existing_network_changed'
    }
}

function Invoke-CityGoPrivateSwitch {
    param([string]$Id,[bool]$DoApply,[string]$Ack)
    $plan=Get-CityGoPrivateSwitchPlan $Id
    $result=[ordered]@{schemaVersion=1;scope='owned_private_ci_switch';operationId=$Id;stage='plan_only_unverified';
        switchId=$null;guestIsolationVerified=$false;githubRunnerRegistered=$false;ciJobsAdmitted=$false}
    if (-not $DoApply) { $result.plan=$plan;return $result }
    Assert-CityGoPrivateSwitch ($Ack -ceq $plan.requiredAcknowledgement) 'typed_acknowledgement_required'
    $held=$null;$phase='read_pinned_guards';$created=$null
    try {
        $held=Open-CityGoPrivateSwitchGuards
        $owner=Get-CityGoCanaryIdentity
        Assert-CityGoCanaryPlainPath $plan.controlDirectory $true
        Assert-CityGoCanaryPrivateAcl $plan.controlDirectory $owner $true
        $phase='refuse_existing_attempt'
        foreach ($path in @($plan.intentPath,$plan.resultPath)) {
            Assert-CityGoPrivateSwitch (-not (Test-Path -LiteralPath $path -ErrorAction Stop)) 'attempt_already_exists'
        }
        $phase='capture_existing_network'
        $before=Get-CityGoPrivateSwitchSnapshot
        Assert-CityGoPrivateSwitch (@($before.switches|Where-Object{$_.name -ieq $plan.switchName}).Count -eq 0) 'switch_namespace_exists'
        $phase='write_creation_intent'
        Write-CityGoPrivateSwitchEvidence $plan.intentPath ([ordered]@{schemaVersion=1;operationId=$Id;switchName=$plan.switchName;
            observedAt=[DateTime]::UtcNow.ToString('o');stage='private_switch_creation_intent';before=$before}) $plan $owner
        # Recheck after recording intent; a concurrent network change must not
        # be silently accepted as our operation's expected starting point.
        $phase='recheck_before_creation'
        $fresh=Get-CityGoPrivateSwitchSnapshot
        Assert-CityGoPrivateSwitch (($before|ConvertTo-Json -Depth 5 -Compress) -ceq ($fresh|ConvertTo-Json -Depth 5 -Compress)) 'network_changed_before_creation'
        $phase='create_one_new_private_switch'
        $created=@(New-VMSwitch -Name $plan.switchName -SwitchType Private -Notes $plan.notes -Confirm:$false -ErrorAction Stop)
        Assert-CityGoPrivateSwitch ($created.Count -eq 1) 'create_result_invalid'
        $phase='verify_native_private_switch'
        $after=Get-CityGoPrivateSwitchSnapshot
        Assert-CityGoPrivateSwitchReadback $before $after $created[0] $plan
        $result.switchId=$created[0].Id.ToString('D');$result.stage='private_switch_created_no_attached_nics'
        $result.switchName=$plan.switchName;$result.hostAdapterAbsent=$true;$result.existingNetworkUnchanged=$true
        $phase='write_creation_result'
        Write-CityGoPrivateSwitchEvidence $plan.resultPath $result $plan $owner
        return $result
    } catch {
        $result.stage='failed_preserved_requires_inspection';$result.failurePhase=$phase;$result.failureCode='private_switch_not_verified'
        # No deletion/retry/adoption. An ambiguous native creation is preserved
        # with its durable pre-mutation intent for an exact independent audit.
        return $result
    } finally { if ($null -ne $held) { $held.Dispose() } }
}

try {
    $result=Invoke-CityGoPrivateSwitch $OperationId ([bool]$Apply) $Acknowledge
    $result|ConvertTo-Json -Depth 4 -Compress
    if ($result.stage -like 'failed_*') { exit 1 }
} catch {
    [ordered]@{schemaVersion=1;scope='owned_private_ci_switch';stage='preconditions_not_met';
        guestIsolationVerified=$false;githubRunnerRegistered=$false;ciJobsAdmitted=$false}|ConvertTo-Json -Compress
    exit 2
}
