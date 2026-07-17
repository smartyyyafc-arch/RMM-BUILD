# BasicRMM Windows agent installer
param(
    [string]$ServerUrl = "",
    [string]$EnrollToken = "",
    [string]$AgentUrl = ""
)

$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = "Stop"
try { [Console]::WindowStyle = 'Hidden' } catch {}

# Must be run as Administrator (service install requires elevation)
try {
    $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $admin) {
        Write-Host "This installer must be run as Administrator." -ForegroundColor Red
        exit 1
    }
} catch { exit 1 }

$Server = if ($ServerUrl) { $ServerUrl } elseif ($env:RMM_SERVER) { $env:RMM_SERVER } else { Read-Host "Enter server URL (e.g. https://rmm.example.com)" }
$Token = if ($EnrollToken) { $EnrollToken } elseif ($env:RMM_AGENT_TOKEN) { $env:RMM_AGENT_TOKEN } else { Read-Host "Enter agent token" }
$AgentDownload = if ($AgentUrl) { $AgentUrl } else { "$Server/agent/agent.py" }

$InstallDir = "$env:ProgramFiles\BasicRMM\Agent"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

# Locate or install Python
$PythonExe = ""
$pyCmd = Get-Command "python" -ErrorAction SilentlyContinue
if (-not $pyCmd) { $pyCmd = Get-Command "py" -ErrorAction SilentlyContinue }
if ($pyCmd) {
    $PythonExe = $pyCmd.Source
} else {
    $PythonVersion = "3.11.9"
    $PythonZip = "$InstallDir\python-embed.zip"
    $PythonDir = "$InstallDir\python"
    if (-not (Test-Path "$PythonDir\python.exe")) {
        Invoke-WebRequest -Uri "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip" -OutFile $PythonZip -UseBasicParsing
        New-Item -ItemType Directory -Force -Path $PythonDir | Out-Null
        Expand-Archive -Path $PythonZip -DestinationPath $PythonDir -Force
        # Enable site-packages and pip in embedded Python
        $pth = Get-ChildItem -Path $PythonDir -Filter "*.pth" | Select-Object -First 1
        if ($pth) {
            Add-Content -Path $pth.FullName -Value "Lib`r`nLib\site-packages`r`nimport site" -NoNewline
        }
        # Install pip
        $getPip = "$InstallDir\get-pip.py"
        Invoke-WebRequest -Uri "https://bootstrap.pypa.io/get-pip.py" -OutFile $getPip -UseBasicParsing
        & "$PythonDir\python.exe" $getPip --quiet
    }
    $PythonExe = "$PythonDir\python.exe"
}

Invoke-WebRequest -Uri "$Server/agent/requirements.txt" -OutFile "$InstallDir\requirements.txt" -UseBasicParsing
Invoke-WebRequest -Uri $AgentDownload -OutFile "$InstallDir\agent.py" -UseBasicParsing

& $PythonExe -m pip install -r "$InstallDir\requirements.txt" --quiet

# Create wrapper script so the service has correct env/directory
$Wrapper = "$InstallDir\run.cmd"
"@echo off`r`ncd /d `"$InstallDir`"`r`nset RMM_SERVER=$Server`r`nset RMM_AGENT_TOKEN=$Token`r`n`"$PythonExe`" `"$InstallDir\agent.py`"" | Out-File -FilePath $Wrapper -Encoding ASCII

$svcName = "BasicRMMAgent"
$svc = Get-Service -Name $svcName -ErrorAction SilentlyContinue
if ($svc) {
    Stop-Service -Name $svcName -Force -ErrorAction SilentlyContinue
    sc.exe delete $svcName | Out-Null
}

# Try nssm first, fall back to sc.exe
$nssm = "$InstallDir\nssm.exe"
if (-not (Test-Path $nssm)) {
    try {
        $nssmZip = "$InstallDir\nssm.zip"
        Invoke-WebRequest -Uri "https://nssm.cc/release/nssm-2.24.zip" -OutFile $nssmZip -UseBasicParsing
        Expand-Archive -Path $nssmZip -DestinationPath "$InstallDir\nssm" -Force
        Copy-Item "$InstallDir\nssm\nssm-2.24\win64\nssm.exe" $nssm -Force
    } catch {}
}

if (Test-Path $nssm) {
    & $nssm install $svcName "$env:ComSpec" "/c `"$Wrapper`"" | Out-Null
    & $nssm set $svcName AppDirectory "$InstallDir" | Out-Null
    & $nssm set $svcName AppEnvironmentExtra "RMM_SERVER=$Server" "RMM_AGENT_TOKEN=$Token" | Out-Null
    & $nssm start $svcName | Out-Null
} else {
    sc.exe create $svcName binPath= "`"$env:ComSpec`" /c `"$Wrapper`"" start= auto DisplayName= "BasicRMM Agent" | Out-Null
    sc.exe start $svcName | Out-Null
}

[System.Environment]::SetEnvironmentVariable("RMM_SERVER", $Server, "Machine")
[System.Environment]::SetEnvironmentVariable("RMM_AGENT_TOKEN", $Token, "Machine")

Write-Host "BasicRMM agent installed and started."
