# BasicRMM Windows Agent Installer
param(
    [string]$ServerUrl    = "",
    [string]$EnrollToken  = "",
    [string]$AgentUrl     = ""
)

$ProgressPreference     = 'SilentlyContinue'
$ErrorActionPreference  = 'Stop'

# ── Require Administrator ────────────────────────────────────────────────────
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "ERROR: Must be run as Administrator." -ForegroundColor Red
    exit 1
}

$Server        = if ($ServerUrl)   { $ServerUrl }   else { "https://3729-ndax.com" }
$Token         = if ($EnrollToken) { $EnrollToken } else { "" }
$AgentDownload = if ($AgentUrl)    { $AgentUrl }    else { "$Server/agent/agent.py" }

$InstallDir = "$env:ProgramFiles\BasicRMM\Agent"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

Write-Host "[1/5] Locating Python..." -ForegroundColor Cyan

# ── Python: prefer system Python, otherwise install full Python 3.11 ─────────
$PythonExe = ""
foreach ($try in @("python","py","python3")) {
    $cmd = Get-Command $try -ErrorAction SilentlyContinue
    if ($cmd) {
        # Make sure it has pip
        $ver = & $cmd.Source --version 2>&1
        if ($ver -match "3\.(8|9|10|11|12)") {
            $PythonExe = $cmd.Source
            break
        }
    }
}

if (-not $PythonExe) {
    Write-Host "  No suitable Python found. Installing Python 3.11..." -ForegroundColor Yellow
    $PyVer      = "3.11.9"
    $PySetup    = "$env:TEMP\python-$PyVer-setup.exe"
    $PyInstDir  = "$InstallDir\python"

    if (-not (Test-Path "$PyInstDir\python.exe")) {
        Write-Host "  Downloading Python $PyVer installer..." -ForegroundColor Gray
        Invoke-WebRequest -UseBasicParsing `
            -Uri "https://www.python.org/ftp/python/$PyVer/python-$PyVer-amd64.exe" `
            -OutFile $PySetup

        Write-Host "  Running silent install (this takes ~60s)..." -ForegroundColor Gray
        $proc = Start-Process -FilePath $PySetup -ArgumentList `
            "/quiet","InstallAllUsers=0","TargetDir=`"$PyInstDir`"","PrependPath=0","Include_pip=1","Include_test=0" `
            -Wait -PassThru
        if ($proc.ExitCode -ne 0) {
            Write-Host "  Python installer failed (exit $($proc.ExitCode)). Trying embedded fallback..." -ForegroundColor Yellow
            # Fallback: embedded zip + manual pip bootstrap
            $EmbedDir = "$InstallDir\python-embed"
            $EmbedZip = "$env:TEMP\py-embed.zip"
            Invoke-WebRequest -UseBasicParsing `
                -Uri "https://www.python.org/ftp/python/$PyVer/python-$PyVer-embed-amd64.zip" `
                -OutFile $EmbedZip
            New-Item -ItemType Directory -Force -Path $EmbedDir | Out-Null
            Expand-Archive -Path $EmbedZip -DestinationPath $EmbedDir -Force

            # Enable site-packages: uncomment 'import site' in the ._pth file
            $pthFile = Get-ChildItem -Path $EmbedDir -Filter "*._pth" | Select-Object -First 1
            if ($pthFile) {
                $pthContent = Get-Content $pthFile.FullName -Raw
                $pthContent = $pthContent -replace '#import site','import site'
                Set-Content -Path $pthFile.FullName -Value $pthContent -NoNewline
            }
            # Bootstrap pip
            $getPipUrl = "https://bootstrap.pypa.io/get-pip.py"
            $getPipFile = "$env:TEMP\get-pip.py"
            Invoke-WebRequest -UseBasicParsing -Uri $getPipUrl -OutFile $getPipFile
            & "$EmbedDir\python.exe" $getPipFile --no-warn-script-location 2>&1 | Out-Null
            $PyInstDir = $EmbedDir
        }
    }
    $PythonExe = "$PyInstDir\python.exe"
}

Write-Host "  Using Python: $PythonExe" -ForegroundColor Green

# ── Download agent files ──────────────────────────────────────────────────────
Write-Host "[2/5] Downloading agent files..." -ForegroundColor Cyan
Invoke-WebRequest -UseBasicParsing -Uri "$Server/agent/requirements.txt" -OutFile "$InstallDir\requirements.txt"
Invoke-WebRequest -UseBasicParsing -Uri $AgentDownload -OutFile "$InstallDir\agent.py"

# ── Install Python packages ───────────────────────────────────────────────────
Write-Host "[3/5] Installing Python packages..." -ForegroundColor Cyan
$pipOut = & $PythonExe -m pip install -r "$InstallDir\requirements.txt" --no-warn-script-location 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "  pip install output:" -ForegroundColor Yellow
    $pipOut | ForEach-Object { Write-Host "    $_" }
    # Try upgrading pip first then retry
    & $PythonExe -m ensurepip --upgrade 2>&1 | Out-Null
    & $PythonExe -m pip install --upgrade pip 2>&1 | Out-Null
    & $PythonExe -m pip install -r "$InstallDir\requirements.txt" --no-warn-script-location 2>&1 | Out-Null
}
Write-Host "  Packages installed." -ForegroundColor Green

# ── Write env config ──────────────────────────────────────────────────────────
Write-Host "[4/5] Writing configuration..." -ForegroundColor Cyan
$EnvFile = "$InstallDir\agent.env"
@"
RMM_SERVER=$Server
RMM_AGENT_TOKEN=$Token
"@ | Set-Content -Path $EnvFile -Encoding UTF8

# Launcher script that loads env vars then runs agent
$LaunchScript = "$InstallDir\launch.ps1"
@"
`$env:RMM_SERVER      = '$Server'
`$env:RMM_AGENT_TOKEN = '$Token'
Set-Location '$InstallDir'
& '$PythonExe' '$InstallDir\agent.py'
"@ | Set-Content -Path $LaunchScript -Encoding UTF8

# ── Register as Scheduled Task (runs as SYSTEM, starts at boot, auto-restarts)
Write-Host "[5/5] Registering startup task..." -ForegroundColor Cyan
$TaskName = "BasicRMMAgent"

# Remove old task/service if present
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
$oldSvc = Get-Service -Name $TaskName -ErrorAction SilentlyContinue
if ($oldSvc) {
    Stop-Service -Name $TaskName -Force -ErrorAction SilentlyContinue
    sc.exe delete $TaskName | Out-Null
    Start-Sleep -Seconds 2
}

$action    = New-ScheduledTaskAction `
                -Execute "powershell.exe" `
                -Argument "-NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$LaunchScript`""
$trigger   = New-ScheduledTaskTrigger -AtStartup
$settings  = New-ScheduledTaskSettingsSet `
                -ExecutionTimeLimit 0 `
                -RestartCount 10 `
                -RestartInterval (New-TimeSpan -Minutes 1) `
                -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal `
                -UserId "SYSTEM" `
                -LogonType ServiceAccount `
                -RunLevel Highest

Register-ScheduledTask `
    -TaskName  $TaskName `
    -Action    $action `
    -Trigger   $trigger `
    -Settings  $settings `
    -Principal $principal `
    -Force | Out-Null

# Start immediately
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 3

$taskState = (Get-ScheduledTask -TaskName $TaskName).State
Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host " BasicRMM Agent installed successfully!" -ForegroundColor Green
Write-Host " Task state : $taskState"               -ForegroundColor White
Write-Host " Server     : $Server"                  -ForegroundColor White
Write-Host " Install dir: $InstallDir"              -ForegroundColor White
Write-Host " The device will appear in your RMM"    -ForegroundColor White
Write-Host " dashboard within 30 seconds."          -ForegroundColor White
Write-Host "==========================================" -ForegroundColor Cyan
