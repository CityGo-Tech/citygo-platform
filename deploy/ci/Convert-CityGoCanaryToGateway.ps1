# Convert only ONE complete, unbooted, disconnected canary into a dedicated
# trusted gateway profile. No switch attachment, boot, firewall, runner or base
# changes. Partial changes remain OFF for exact inspection, never auto-adopted.
[CmdletBinding()]
param([string]$ManifestPath='', [string]$ExpectedManifestSha256='',
    [string]$WanMac='', [string]$LanMac='', [switch]$Apply, [string]$Acknowledge='')
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'

function Assert-CityGoGatewayProfile {
    param([bool]$Condition,[string]$Code)
    if(-not $Condition){throw $Code}
}

function Get-CityGoGatewayProfilePlan {
    param([Collections.IDictionary]$Request)
    Assert-CityGoGatewayProfile ($Request.manifestPath -is [string] -and
        $Request.manifestPath -cmatch '^D:\\CityGo-CI\\control\\([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\\canary-creation\.json$') 'manifest_path_invalid'
    $op=$Matches[1]
    Assert-CityGoGatewayProfile ($Request.manifestSha256 -is [string] -and $Request.manifestSha256 -cmatch '^[a-f0-9]{64}$') 'manifest_hash_invalid'
    foreach($mac in @($Request.wanMac,$Request.lanMac)){
        Assert-CityGoGatewayProfile ($mac -is [string] -and $mac -cmatch '^02(?::[a-f0-9]{2}){5}$') 'mac_invalid'
    }
    Assert-CityGoGatewayProfile ($Request.wanMac -cne $Request.lanMac) 'mac_duplicate'
    $control='D:\CityGo-CI\control\'+$op
    return [ordered]@{operationId=$op;manifestPath=$Request.manifestPath;manifestSha256=$Request.manifestSha256;
        wanMac=$Request.wanMac;lanMac=$Request.lanMac;lanNicName='CityGo-Gateway-LAN';controlDirectory=$control;
        intentPath=($control+'\gateway-profile-intent.json');resultPath=($control+'\gateway-creation.json');
        requiredAcknowledgement=('PREPARE_OFF_GATEWAY_PROFILE:'+$op+':'+$Request.manifestSha256)}
}

function Open-CityGoGatewayProfileGuards {
    $path=Join-Path $PSScriptRoot 'Remove-CityGoCanaryVm.ps1'
    $stream=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try{
        Assert-CityGoGatewayProfile ($stream.Length -gt 0 -and $stream.Length -le 65536) 'guard_size_invalid'
        $sha=[Security.Cryptography.SHA256]::Create()
        try{$actual=([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
        Assert-CityGoGatewayProfile ($actual -ceq '70f036f9b6c9885f6cfd15f5a362883b7bf72803dddf5d6fe28fc17c29bea098') 'guard_hash_mismatch'
        $stream.Position=0;$reader=[IO.StreamReader]::new($stream,[Text.UTF8Encoding]::new($false,$true),$true,4096,$true)
        try{$source=$reader.ReadToEnd()}finally{$reader.Dispose()}
        $tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors)
        Assert-CityGoGatewayProfile ($errors.Count -eq 0) 'guard_parse_failed'
        foreach($name in @('Assert-CityGoCanaryCleanup','Get-CityGoCanaryCleanupPath','Assert-CityGoCanaryCleanupPlainPath',
            'Assert-CityGoCanaryCleanupPrivateAcl','Get-CityGoCanaryCleanupIdentity','ConvertFrom-CityGoCanaryCleanupJson',
            'Open-CityGoCanaryCleanupEvidence','Assert-CityGoCanaryCleanupGuid','Get-CityGoCanaryCreationFields',
            'Get-CityGoCanaryCleanupPlan','Assert-CityGoCanaryCleanupForeignDisk','Get-CityGoCanaryCleanupVm','Test-CityGoCanaryCleanupDisk')){
            $found=@($ast.FindAll({param($n)$n-is[Management.Automation.Language.FunctionDefinitionAst]},$true)|Where-Object{$_.Name-ceq$name})
            Assert-CityGoGatewayProfile ($found.Count -eq 1 -and $found[0].Parent -is [Management.Automation.Language.NamedBlockAst]) 'guard_definition_invalid'
            . ([scriptblock]::Create($found[0].Extent.Text));Set-Item -Path ('Function:script:'+$name) -Value (Get-Item -Path ('Function:'+$name)).ScriptBlock
        }
        return $stream
    }catch{$stream.Dispose();throw}
}

function Assert-CityGoGatewayNic {
    param($Nic,$Plan,[string]$Mac='')
    Assert-CityGoGatewayProfile ($Nic.VMId.ToString('D') -ceq $Plan.vmId -and -not $Nic.SwitchName -and
        (-not $Nic.SwitchId -or [guid]$Nic.SwitchId -eq [guid]::Empty) -and [string]$Nic.MacAddressSpoofing -ceq 'Off' -and
        [string]$Nic.DhcpGuard -ceq 'On' -and [string]$Nic.RouterGuard -ceq 'On' -and $Nic.IovWeight -eq 0 -and
        [string]$Nic.PortMirroringMode -ceq 'None' -and [string]$Nic.AllowTeaming -ceq 'Off' -and
        (-not $Mac -or ([string]$Nic.MacAddress -ieq $Mac.Replace(':','') -and $Nic.DynamicMacAddressEnabled -eq $false))) 'nic_profile_changed'
    $vlan=Get-VMNetworkAdapterVlan -VMNetworkAdapter $Nic -ErrorAction Stop
    $isolation=Get-VMNetworkAdapterIsolation -VMNetworkAdapter $Nic -ErrorAction Stop
    Assert-CityGoGatewayProfile ([string]$vlan.OperationMode -ceq 'Untagged' -and [string]$isolation.IsolationMode -ceq 'None' -and
        @(Get-VMNetworkAdapterAcl -VMNetworkAdapter $Nic -ErrorAction Stop).Count -eq 0 -and
        @(Get-VMNetworkAdapterExtendedAcl -VMNetworkAdapter $Nic -ErrorAction Stop).Count -eq 0) 'nic_extra_policy_refused'
}

function Get-CityGoGatewayProfileVm {
    param($Plan,[bool]$Converted)
    foreach($path in @($Plan.targetDirectory,$Plan.vmPath)){Assert-CityGoCanaryCleanupPlainPath $path $true}
    $all=@(Get-VM -ErrorAction Stop);$owned=$null
    foreach($vm in $all){
        if($vm.Id.ToString('D') -cne $Plan.vmId){
            Assert-CityGoGatewayProfile ($vm.Name -ine $Plan.vmName -and [string]$vm.Path -ine $Plan.vmPath) 'foreign_namespace_collision'
            foreach($drive in @(Get-VMHardDiskDrive -VM $vm -ErrorAction Stop)){Assert-CityGoCanaryCleanupForeignDisk $drive.Path $Plan}
            continue
        }
        Assert-CityGoGatewayProfile ($null -eq $owned -and $vm.Name -ceq $Plan.vmName -and [string]$vm.Path -ieq $Plan.vmPath -and
            [string]$vm.State -ceq 'Off' -and $vm.Generation -eq 2 -and $vm.DynamicMemoryEnabled -eq $false -and
            [string]$vm.AutomaticStartAction -ceq 'Nothing' -and [string]$vm.CheckpointType -ceq 'Disabled' -and
            $vm.AutomaticCheckpointsEnabled -eq $false -and $vm.ProcessorCount -eq $(if($Converted){2}else{4}) -and
            $vm.MemoryStartup -eq $(if($Converted){2GB}else{6GB})) 'owned_vm_profile_changed'
        if($Converted){Assert-CityGoGatewayProfile ([string]$vm.AutomaticStopAction -ceq 'TurnOff') 'automatic_stop_not_turnoff'}
        $drives=@(Get-VMHardDiskDrive -VM $vm -ErrorAction Stop)
        Assert-CityGoGatewayProfile ($drives.Count -eq 1 -and [string]$drives[0].Path -ieq $Plan.targetVhdx -and
            -not $drives[0].DiskNumber -and [string]$drives[0].ControllerType -ceq 'SCSI' -and
            $drives[0].ControllerNumber -eq 0 -and $drives[0].ControllerLocation -eq 0) 'disk_attachment_changed'
        Assert-CityGoGatewayProfile (Test-CityGoCanaryCleanupDisk $Plan) 'disk_missing'
        $firmware=Get-VMFirmware -VM $vm -ErrorAction Stop
        Assert-CityGoGatewayProfile ([string]$firmware.SecureBoot -ceq 'On' -and [string]$firmware.SecureBootTemplate -ceq 'MicrosoftUEFICertificateAuthority' -and
            @(Get-VMSnapshot -VM $vm -ErrorAction Stop).Count -eq 0 -and @(Get-VMAssignableDevice -VM $vm -ErrorAction Stop).Count -eq 0) 'firmware_or_devices_changed'
        $dvds=@(Get-VMDvdDrive -VM $vm -ErrorAction Stop)
        Assert-CityGoGatewayProfile ($dvds.Count -le 1 -and @($dvds|Where-Object{$_.Path}).Count -eq 0) 'dvd_media_refused'
        $nics=@(Get-VMNetworkAdapter -VM $vm -ErrorAction Stop)
        Assert-CityGoGatewayProfile ($nics.Count -eq $(if($Converted){2}else{1})) 'nic_count_changed'
        $wan=@($nics|Where-Object{[string]$_.Id -ceq $Plan.nicId -and $_.Name -ceq $Plan.nicName})
        Assert-CityGoGatewayProfile ($wan.Count -eq 1) 'original_nic_changed'
        if($Converted){
            Assert-CityGoGatewayNic $wan[0] $Plan $Plan.wanMac
            $lan=@($nics|Where-Object{[string]$_.Id -ceq $Plan.lanNicId -and $_.Name -ceq $Plan.lanNicName})
            Assert-CityGoGatewayProfile ($lan.Count -eq 1) 'lan_nic_changed'
            Assert-CityGoGatewayNic $lan[0] $Plan $Plan.lanMac
        }else{
            Assert-CityGoGatewayNic $wan[0] $Plan
        }
        $owned=$vm
    }
    Assert-CityGoGatewayProfile ($null -ne $owned) 'owned_vm_missing'
    return $owned
}

function Write-CityGoGatewayProfileEvidence {
    param([string]$Path,$Value,$Plan,[string]$Owner)
    Assert-CityGoGatewayProfile ($Path -cin @($Plan.intentPath,$Plan.resultPath)) 'evidence_path_invalid'
    Assert-CityGoCanaryCleanupPlainPath $Plan.controlDirectory $true
    Assert-CityGoCanaryCleanupPrivateAcl $Plan.controlDirectory $Owner $true
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Value|ConvertTo-Json -Depth 3 -Compress))
    $stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
    Assert-CityGoCanaryCleanupPrivateAcl $Path $Owner
}

function Invoke-CityGoGatewayProfile {
    param([Collections.IDictionary]$Request)
    $plan=Get-CityGoGatewayProfilePlan $Request
    $result=[ordered]@{schemaVersion=1;scope='owned_trusted_gateway_profile';operationId=$plan.operationId;stage='plan_only_unverified';
        guestIsolationVerified=$false;githubRunnerRegistered=$false;ciJobsAdmitted=$false}
    if(-not $Request.apply){$result.plan=$plan;return $result}
    Assert-CityGoGatewayProfile ($Request.acknowledge -ceq $plan.requiredAcknowledgement) 'typed_acknowledgement_required'
    $held=@();$phase='read_pinned_guards'
    try{
        $held+=,(Open-CityGoGatewayProfileGuards)
        $owner=Get-CityGoCanaryCleanupIdentity $true
        $manifest=Open-CityGoCanaryCleanupEvidence $plan.manifestPath $owner $plan.manifestSha256;$held+=,$manifest.stream
        $binding=Get-CityGoCanaryCleanupPlan $manifest.value @{manifestPath=$plan.manifestPath;manifestSha256=$plan.manifestSha256}
        Assert-CityGoGatewayProfile (-not $binding.resumedCreation -and $binding.operationId -ceq $plan.operationId) 'fresh_ordinary_creation_required'
        foreach($key in @('vmId','vmName','vmPath','nicId','nicName','targetVhdx','targetDirectory','diskIdentifier','diskType')){$plan[$key]=$binding[$key]}
        foreach($path in @($plan.intentPath,$plan.resultPath)){Assert-CityGoGatewayProfile (-not (Test-Path -LiteralPath $path -ErrorAction Stop)) 'profile_attempt_exists'}
        $phase='verify_initial_complete_off_identity'
        $vm=Get-CityGoGatewayProfileVm $plan $false
        $wanted=@($plan.wanMac.Replace(':',''),$plan.lanMac.Replace(':',''))
        Assert-CityGoGatewayProfile (@(Get-VMNetworkAdapter -All -ErrorAction Stop|Where-Object{[string]$_.MacAddress -iin $wanted}).Count -eq 0) 'mac_already_used'
        $phase='write_profile_intent'
        Write-CityGoGatewayProfileEvidence $plan.intentPath ([ordered]@{schemaVersion=1;operationId=$plan.operationId;vmId=$plan.vmId;
            originalCreationManifestSha256=$plan.manifestSha256;stage='gateway_profile_intent';wanMac=$plan.wanMac;lanMac=$plan.lanMac}) $plan $owner
        $phase='recheck_before_profile_changes';$vm=Get-CityGoGatewayProfileVm $plan $false
        $phase='set_owned_off_resources'
        $null=Set-VMProcessor -VM $vm -Count 2 -ErrorAction Stop
        $null=Set-VMMemory -VM $vm -DynamicMemoryEnabled $false -StartupBytes 2GB -ErrorAction Stop
        $null=Set-VM -VM $vm -AutomaticStopAction TurnOff -ErrorAction Stop
        $wan=@(Get-VMNetworkAdapter -VM $vm -ErrorAction Stop|Where-Object{[string]$_.Id -ceq $plan.nicId})
        Assert-CityGoGatewayProfile ($wan.Count -eq 1) 'original_nic_changed'
        $phase='set_owned_wan_mac';$null=Set-VMNetworkAdapter -VMNetworkAdapter $wan[0] -StaticMacAddress $plan.wanMac.Replace(':','') -ErrorAction Stop
        $phase='add_one_disconnected_lan_nic'
        $lan=@(Add-VMNetworkAdapter -VM $vm -Name $plan.lanNicName -StaticMacAddress $plan.lanMac.Replace(':','') -Passthru -ErrorAction Stop)
        Assert-CityGoGatewayProfile ($lan.Count -eq 1 -and $lan[0].VMId.ToString('D') -ceq $plan.vmId) 'new_lan_identity_invalid'
        $plan.lanNicId=[string]$lan[0].Id
        $null=Set-VMNetworkAdapter -VMNetworkAdapter $lan[0] -MacAddressSpoofing Off -DhcpGuard On -RouterGuard On -IovWeight 0 -AllowTeaming Off -PortMirroring None -ErrorAction Stop
        $phase='independent_gateway_profile_readback'
        $vm=Get-CityGoGatewayProfileVm $plan $true
        $macOwners=@(Get-VMNetworkAdapter -All -ErrorAction Stop|Where-Object{[string]$_.MacAddress -iin $wanted})
        Assert-CityGoGatewayProfile ($macOwners.Count -eq 2 -and @($macOwners|Where-Object{$_.VMId.ToString('D') -cne $plan.vmId}).Count -eq 0) 'mac_readback_collision'
        $result.stage='gateway_prepared_off_disconnected'
        foreach($key in @('vmId','vmName','vmPath','targetVhdx','diskIdentifier','wanMac','lanNicId','lanNicName','lanMac')){$result[$key]=$plan[$key]}
        $result.wanNicId=$plan.nicId;$result.wanNicName=$plan.nicName
        $result.originalCreationManifestSha256=$plan.manifestSha256;$result.processorCount=2;$result.memoryStartupBytes=2GB;$result.automaticStopAction='TurnOff'
        $phase='write_gateway_profile_result'
        Write-CityGoGatewayProfileEvidence $plan.resultPath $result $plan $owner
        return $result
    }catch{
        $result.stage='failed_preserved_requires_inspection';$result.failurePhase=$phase;$result.failureCode='gateway_profile_not_verified'
        return $result
    }finally{foreach($stream in $held){if($null -ne $stream){$stream.Dispose()}}}
}

try{
    $result=Invoke-CityGoGatewayProfile ([ordered]@{manifestPath=$ManifestPath;manifestSha256=$ExpectedManifestSha256;wanMac=$WanMac;lanMac=$LanMac;apply=[bool]$Apply;acknowledge=$Acknowledge})
    $result|ConvertTo-Json -Depth 4 -Compress
    if($result.stage -like 'failed_*'){exit 1}
}catch{
    [ordered]@{schemaVersion=1;scope='owned_trusted_gateway_profile';stage='preconditions_not_met';guestIsolationVerified=$false;githubRunnerRegistered=$false;ciJobsAdmitted=$false}|ConvertTo-Json -Compress
    exit 2
}
