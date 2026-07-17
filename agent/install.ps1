# BasicRMM Windows agent installer
$ErrorActionPreference = "Stop"

$Server = if ($env:RMM_SERVER) { $env:RMM_SERVER } else { Read-Host "Enter server URL (e.g. http://rmm.example.com:8000)" }
$Token = if ($env:RMM_AGENT_TOKEN) { $env:RMM_AGENT_TOKEN } else { Read-Host "Enter agent token" }
$InstallDir = "$env:ProgramFiles\BasicRMM\Agent"

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

$reqUrl = "$Server/agent/requirements.txt"
$agentUrl = "$Server/agent/agent.py"

Invoke-WebRequest -Uri $reqUrl -OutFile "$InstallDir\requirements.txt" -UseBasicParsing
Invoke-WebRequest -Uri $agentUrl -OutFile "$InstallDir\agent.py" -UseBasicParsing

python -m pip install -r "$InstallDir\requirements.txt" --quiet

$svcName = "BasicRMMAgent"
$svc = Get-Service -Name $svcName -ErrorAction SilentlyContinue
if ($svc) {
    Stop-Service -Name $svcName -Force
    sc.exe delete $svcName
}

$nssm = "$InstallDir\nssm.exe"
if (-not (Test-Path $nssm)) {
    Invoke-WebRequest -Uri "https://nssm.cc/release/nssm-2.24.zip" -OutFile "$InstallDir\nssm.zip" -UseBasicParsing
    Expand-Archive -Path "$InstallDir\nssm.zip" -DestinationPath "$InstallDir\nssm" -Force
    Copy-Item "$InstallDir\nssm\nssm-2.24\win64\nssm.exe" $nssm -Force
}

& $nssm install $svcName "python" "`"$InstallDir\agent.py`"" | Out-Null
[System.Environment]::SetEnvironmentVariable("RMM_SERVER", $Server, "Machine")
[System.Environment]::SetEnvironmentVariable("RMM_AGENT_TOKEN", $Token, "Machine")
& $nssm set $svcName AppEnvironmentExtra "RMM_SERVER=$Server" "RMM_AGENT_TOKEN=$Token" | Out-Null
& $nssm start $svcName | Out-Null

Write-Host "BasicRMM agent installed and started."
