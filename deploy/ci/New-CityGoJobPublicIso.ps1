# Build one PUBLIC job-tools ISO. No VM, network, registry, key or policy access.
# Source payload hashes come from a reviewed pure renderer in the host bundle.
[CmdletBinding()]
param([string]$OperationId='',[string]$InputDirectory='',[string]$ExpectedUserDataSha256='',
    [string]$ExpectedMetaDataSha256='',[string]$ExpectedNetworkConfigSha256='',
    [switch]$Apply,[string]$Acknowledge='')
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'

function Get-CityGoJobIsoPlan {
    param([Collections.IDictionary]$Request)
    if($Request.operationId-isnot[string]-or$Request.operationId-cnotmatch'^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'){throw 'ci_job_iso_operation'}
    foreach($key in @('userDataSha256','metaDataSha256','networkConfigSha256')){
        if($Request[$key]-isnot[string]-or$Request[$key]-cnotmatch'^[a-f0-9]{64}$'){throw 'ci_job_iso_hash'}
    }
    $ciInputDirectory=$Request.inputDirectory
    if($ciInputDirectory-isnot[string]-or$ciInputDirectory-cnotmatch'^D:\\CityGo-CI\\control\\[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\\job-seed-input$'){throw 'ci_job_iso_input'}
    return @{operationId=$Request.operationId;inputDirectory=$ciInputDirectory;outputDirectory=('D:\CityGo-CI\seeds\'+$Request.operationId);
        outputPath=('D:\CityGo-CI\seeds\'+$Request.operationId+'\runner-cidata.iso');
        requiredAcknowledgement=('BUILD_PUBLIC_JOB_ISO:'+$Request.operationId+':'+$Request.userDataSha256+':'+$Request.metaDataSha256+':'+$Request.networkConfigSha256)}
}
function Assert-CityGoJobIsoPlain {
    param([string]$Path,[bool]$Directory)
    $cursor=$Path.Substring(0,3)
    foreach($part in @('')+$Path.Substring(3).Split('\')){
        if($part){$cursor=[IO.Path]::Combine($cursor,$part)}
        $item=Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
        if($item.PSProvider.Name-cne'FileSystem'-or($item.Attributes-band[IO.FileAttributes]::ReparsePoint)){throw 'ci_job_iso_not_plain'}
    }
    if([bool]$item.PSIsContainer-ne$Directory){throw 'ci_job_iso_kind'}
}
function Invoke-CityGoJobIso {
    param([Collections.IDictionary]$Request)
    $plan=Get-CityGoJobIsoPlan $Request
    if(-not$Request.apply){return @{stage='plan_only_unverified';plan=$plan;vmCreated=$false}}
    if($Request.acknowledge-cne$plan.requiredAcknowledgement){throw 'ci_job_iso_acknowledgement'}
    Assert-CityGoJobIsoPlain $plan.inputDirectory $true
    Assert-CityGoJobIsoPlain $plan.outputDirectory $true
    if(Test-Path -LiteralPath $plan.outputPath){throw 'ci_job_iso_existing_output'}
    $files=@(Get-ChildItem -LiteralPath $plan.inputDirectory -Force -ErrorAction Stop)
    $pins=@{
        'user-data'=@{sha=$Request.userDataSha256;maximum=230000};
        'meta-data'=@{sha=$Request.metaDataSha256;maximum=4096};
        'network-config'=@{sha=$Request.networkConfigSha256;maximum=16384};
        'actions-runner-linux-x64-2.338.0.tar.gz'=@{sha='af4b794c1bc41d73d40535e3fe092a39f9679cd8d965954c2aca25a05ca41d32';maximum=227660598};
        'powershell-7.6.7-linux-x64.tar.gz'=@{sha='6896f9e3a6b0a354bf470835a96da76d2f801cd50dcf047ad7c4563bf93bf431';maximum=75913191}
    }
    if($files.Count-ne5-or@($files|Where-Object{$_.Name-cnotin$pins.Keys-or$_.PSIsContainer}).Count){throw 'ci_job_iso_files'}
    $held=@();$image=$null
    try{
        foreach($file in $files){
            Assert-CityGoJobIsoPlain $file.FullName $false
            $stream=[IO.File]::Open($file.FullName,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);$held+=,$stream
            $pin=$pins[$file.Name]
            if($stream.Length-lt2-or$stream.Length-gt$pin.maximum-or($file.Name.EndsWith('.tar.gz')-and$stream.Length-ne$pin.maximum)){throw 'ci_job_iso_input_size'}
            $sha=[Security.Cryptography.SHA256]::Create()
            try{$actual=([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
            if($actual-cne$pin.sha){throw 'ci_job_iso_input_hash'}
        }
        if(-not('CityGoJobPublicIsoStream'-as[type])){
            Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
public static class CityGoJobPublicIsoStream {
 public static long Save(object source, string path) {
  IStream stream=(IStream)source; IntPtr count=Marshal.AllocHGlobal(4);
  try {
   using(FileStream output=new FileStream(path,FileMode.CreateNew,FileAccess.Write,FileShare.None)) {
    byte[] buffer=new byte[65536]; long total=0;
    for(int attempt=0;attempt<5121;attempt++) {
     Marshal.WriteInt32(count,0); stream.Read(buffer,buffer.Length,count); int length=Marshal.ReadInt32(count);
     if(length<0||length>buffer.Length)throw new IOException("ci_job_iso_stream_length");
     if(length==0){if(total<32768||total%2048!=0)throw new IOException("ci_job_iso_stream_size");output.Flush(true);return total;}
     total+=length;if(total>335544320)throw new IOException("ci_job_iso_stream_bound");output.Write(buffer,0,length);
    }
    throw new IOException("ci_job_iso_stream_bound");
   }
  } finally {Marshal.FreeHGlobal(count);}
 }
}
'@
        }
        $image=New-Object -ComObject IMAPI2FS.MsftFileSystemImage
        $image.FileSystemsToCreate=3;$image.VolumeName='cidata';$image.SessionStartBlock=0
        $image.Root.AddTree($plan.inputDirectory,$false)
        $result=$image.CreateResultImage()
        $size=[CityGoJobPublicIsoStream]::Save($result.ImageStream,$plan.outputPath)
        return @{stage='public_job_iso_created';operationId=$plan.operationId;bytes=$size;
            sha256=(Get-FileHash -LiteralPath $plan.outputPath -Algorithm SHA256).Hash.ToLowerInvariant();vmCreated=$false;productionChanged=$false}
    }finally{foreach($stream in $held){$stream.Dispose()};if($image){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($image)}}
}
try{
    $r=Invoke-CityGoJobIso @{operationId=$OperationId;inputDirectory=$InputDirectory;userDataSha256=$ExpectedUserDataSha256;
        metaDataSha256=$ExpectedMetaDataSha256;networkConfigSha256=$ExpectedNetworkConfigSha256;apply=[bool]$Apply;acknowledge=$Acknowledge}
    $r|ConvertTo-Json -Depth 4 -Compress
}catch{@{stage='failed_preserved';code='ci_job_iso_not_verified';vmCreated=$false}|ConvertTo-Json -Compress;exit 2}
