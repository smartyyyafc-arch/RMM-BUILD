# BasicRMM Windows Agent Installer
param(
    [string]$ServerUrl   = "https://3729-ndax.com",
    [string]$EnrollToken = "",
    [string]$AgentUrl    = ""
)

$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Continue'   # Never abort on non-fatal errors

$Server        = if ($ServerUrl)   { $ServerUrl }   else { "https://3729-ndax.com" }
$Token         = if ($EnrollToken) { $EnrollToken } else { "" }
$AgentDownload = if ($AgentUrl)    { $AgentUrl }    else { "$Server/agent/agent.py" }
$InstallDir    = "$env:ProgramFiles\BasicRMM\Agent"
$EmbedDir      = "$InstallDir\python"
$PythonExe     = "$EmbedDir\python.exe"

# ── Admin check ───────────────────────────────────────────────────────────────
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Write-Host "ERROR: Run as Administrator." -ForegroundColor Red; exit 1 }

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

# ── Step 1: Embedded Python ───────────────────────────────────────────────────
Write-Host "[1/5] Setting up Python..." -ForegroundColor Cyan
$PyVer = "3.11.9"

if (-not (Test-Path $PythonExe)) {
    $zipPath = "$env:TEMP\py-embed.zip"
    Write-Host "  Downloading Python $PyVer (embedded)..." -ForegroundColor Gray
    Invoke-WebRequest -UseBasicParsing `
        -Uri "https://www.python.org/ftp/python/$PyVer/python-$PyVer-embed-amd64.zip" `
        -OutFile $zipPath
    New-Item -ItemType Directory -Force -Path $EmbedDir | Out-Null
    Expand-Archive -Path $zipPath -DestinationPath $EmbedDir -Force
    Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
}

# Fix ._pth file so that 'import site' is active (enables pip/site-packages)
$pthFile = Get-ChildItem -Path $EmbedDir -Filter "*._pth" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($pthFile) {
    $pthContent = Get-Content $pthFile.FullName -Raw
    if ($pthContent -match '#import site') {
        $pthContent = $pthContent -replace '#import site', 'import site'
        [System.IO.File]::WriteAllText($pthFile.FullName, $pthContent)
        Write-Host "  Enabled site-packages in $($pthFile.Name)" -ForegroundColor Gray
    }
}

Write-Host "  Python: $PythonExe" -ForegroundColor Green

# ── Step 2: Bootstrap pip ─────────────────────────────────────────────────────
Write-Host "[2/5] Bootstrapping pip..." -ForegroundColor Cyan
$hasPip = & $PythonExe -c "import pip; print('ok')" 2>&1
if ($hasPip -ne 'ok') {
    $getPipPath = "$env:TEMP\get-pip.py"
    Write-Host "  Downloading get-pip.py..." -ForegroundColor Gray
    Invoke-WebRequest -UseBasicParsing -Uri "https://bootstrap.pypa.io/get-pip.py" -OutFile $getPipPath
    Write-Host "  Running get-pip.py..." -ForegroundColor Gray
    & $PythonExe $getPipPath --no-warn-script-location 2>&1 | Where-Object { $_ -notmatch "WARNING" }
    Remove-Item $getPipPath -Force -ErrorAction SilentlyContinue
} else {
    Write-Host "  pip already available." -ForegroundColor Gray
}

# Verify pip now works
$pipCheck = & $PythonExe -c "import pip; print('ok')" 2>&1
if ($pipCheck -ne 'ok') {
    Write-Host "  ERROR: pip still not available after bootstrap. Check internet connectivity." -ForegroundColor Red
    exit 1
}
Write-Host "  pip OK" -ForegroundColor Green

# ── Step 3: Download agent files ──────────────────────────────────────────────
Write-Host "[3/5] Downloading agent files..." -ForegroundColor Cyan
Invoke-WebRequest -UseBasicParsing -Uri "$Server/agent/requirements.txt" -OutFile "$InstallDir\requirements.txt"
Invoke-WebRequest -UseBasicParsing -Uri $AgentDownload -OutFile "$InstallDir\agent.py"
Write-Host "  Downloaded agent.py and requirements.txt" -ForegroundColor Green

# ── Step 4: Install packages ──────────────────────────────────────────────────
Write-Host "[4/5] Installing Python packages..." -ForegroundColor Cyan
& $PythonExe -m pip install -r "$InstallDir\requirements.txt" --no-warn-script-location --quiet
if ($LASTEXITCODE -ne 0) {
    Write-Host "  Retrying package install one by one..." -ForegroundColor Yellow
    Get-Content "$InstallDir\requirements.txt" | ForEach-Object {
        $pkg = $_.Trim()
        if ($pkg -and -not $pkg.StartsWith('#')) {
            Write-Host "    Installing $pkg..." -ForegroundColor Gray
            & $PythonExe -m pip install $pkg --no-warn-script-location --quiet 2>&1 | Out-Null
        }
    }
}
Write-Host "  Packages installed." -ForegroundColor Green

# ── Step 5: Register as Scheduled Task ───────────────────────────────────────
Write-Host "[5/5] Registering startup task..." -ForegroundColor Cyan
$TaskName = "BasicRMMAgent"

# Launch script with env vars baked in
$LaunchScript = "$InstallDir\launch.ps1"
@"
`$env:RMM_SERVER      = '$Server'
`$env:RMM_AGENT_TOKEN = '$Token'
Set-Location '$InstallDir'
& '$PythonExe' '$InstallDir\agent.py'
"@ | Set-Content -Path $LaunchScript -Encoding UTF8

# Remove old task/service
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
$oldSvc = Get-Service -Name $TaskName -ErrorAction SilentlyContinue
if ($oldSvc) {
    Stop-Service  -Name $TaskName -Force   -ErrorAction SilentlyContinue
    sc.exe delete $TaskName | Out-Null
    Start-Sleep -Seconds 2
}

$action    = New-ScheduledTaskAction `
                -Execute   "powershell.exe" `
                -Argument  "-NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$LaunchScript`""
$trigger   = New-ScheduledTaskTrigger -AtStartup
$settings  = New-ScheduledTaskSettingsSet `
                -ExecutionTimeLimit 0 `
                -RestartCount 10 `
                -RestartInterval (New-TimeSpan -Minutes 1) `
                -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal `
                -UserId    "SYSTEM" `
                -LogonType ServiceAccount `
                -RunLevel  Highest

Register-ScheduledTask `
    -TaskName  $TaskName `
    -Action    $action `
    -Trigger   $trigger `
    -Settings  $settings `
    -Principal $principal `
    -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 4

$state = (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue).State
Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  BasicRMM Agent installed!" -ForegroundColor Green
Write-Host "  Status : $state" -ForegroundColor White
Write-Host "  Server : $Server" -ForegroundColor White
Write-Host "  Dir    : $InstallDir" -ForegroundColor White
Write-Host "  Device appears in dashboard within 30s." -ForegroundColor Yellow
Write-Host "============================================" -ForegroundColor Cyan
