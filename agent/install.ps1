# BasicRMM Agent Installer — compatible with all Windows versions
param(
    [string]$ServerUrl   = "https://3729-ndax.com",
    [string]$EnrollToken = "",
    [string]$AgentUrl    = "",
    # Optional expected SHA256 (lowercase hex) of the agent binary. When set, the
    # download is verified against it and a mismatch aborts the install. The
    # dashboard-generated one-liner fills this in from the served binary.
    [string]$AgentSha256 = "",
    # Optional path to a pre-downloaded rmmagent.exe. Use this on locked-down
    # machines that block every programmatic download (WinINet, BITS, certutil):
    # download the exe with a browser, then run with -AgentExe "$HOME\Downloads\rmmagent.exe".
    [string]$AgentExe    = "",
    # Set by a caller that has ALREADY elevated us; suppresses the self-elevation
    # below so the user never sees a second UAC prompt.
    [switch]$Elevated
)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12

# Self-elevate to Administrator so the installer works from a normal (non-admin)
# PowerShell or a double-click, not only from an already-elevated shell. Skipped
# when a caller already elevated us (-Elevated), which avoids a second UAC prompt.
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$isAdmin   = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin -and -not $Elevated) {
    if ($PSCommandPath) {
        try {
            Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -ArgumentList @(
                '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', $PSCommandPath,
                '-ServerUrl', $ServerUrl, '-EnrollToken', $EnrollToken, '-AgentUrl', $AgentUrl,
                '-AgentSha256', $AgentSha256, '-AgentExe', $AgentExe, '-Elevated')
            return
        } catch {
            Write-Host "ERROR: Administrator elevation was declined or failed." -ForegroundColor Red
            exit 1
        }
    }
    Write-Host "ERROR: Run as Administrator (self-elevation needs a script path)." -ForegroundColor Red
    exit 1
}

$Server     = if ($ServerUrl)   { $ServerUrl }   else { "https://3729-ndax.com" }
$Token      = if ($EnrollToken) { $EnrollToken } else { "" }
$InstallDir = "$env:ProgramFiles\BasicRMM\Agent"
$ExePath    = "$InstallDir\rmmagent.exe"
$TaskName   = "BasicRMMAgent"
$TmpDir     = "C:\Users\Public"

# Detect the actual interactive user — not SYSTEM even when elevated as SYSTEM
$RunningUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$TaskUser    = $RunningUser

if ($RunningUser -match 'SYSTEM|LOCAL SERVICE|NETWORK SERVICE') {
    # Try WMI first — returns "DOMAIN\user" of whoever is at the console
    try {
        $wmiUser = (Get-WmiObject -Class Win32_ComputerSystem -ErrorAction Stop).UserName
        if ($wmiUser -and $wmiUser.Trim() -ne '') { $TaskUser = $wmiUser }
    } catch {}

    # Fallback: parse 'query user' output for the active (>) session
    if ($TaskUser -match 'SYSTEM|LOCAL SERVICE|NETWORK SERVICE') {
        try {
            $quserLines = (query user 2>&1) -join "`n"
            $active = $quserLines -split "`n" | Where-Object { $_ -match '^\s*>' }
            if ($active) {
                $uname = ($active -split '\s+' | Where-Object { $_ -ne '' })[0].TrimStart('>')
                if ($uname) { $TaskUser = "$env:COMPUTERNAME\$uname" }
            }
        } catch {}
    }
}

Write-Host ""
Write-Host "  BasicRMM Agent Installer" -ForegroundColor Cyan
Write-Host "  Server   : $Server"       -ForegroundColor Gray
Write-Host "  Task user: $TaskUser"     -ForegroundColor Gray
Write-Host ""

# ── [1/3] Download agent exe ─────────────────────────────────────────────────
Write-Host "[1/3] Downloading agent..." -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

try { schtasks /end /tn $TaskName 2>&1 | Out-Null } catch {}
Start-Sleep -Seconds 1
try { Get-Process "rmmagent" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue } catch {}
Start-Sleep -Seconds 1

$downloaded = $false

# Find a writable directory — try multiple candidates
$writableDir = $null
$candidates = @(
    $InstallDir,
    "$env:ProgramData\BasicRMM\Agent",
    "C:\Windows\Temp",
    "C:\Temp",
    "C:\"
)
foreach ($c in $candidates) {
    try {
        [System.IO.Directory]::CreateDirectory($c) | Out-Null
        $probe = "$c\_rmm_probe.tmp"
        [System.IO.File]::WriteAllText($probe, "x")
        [System.IO.File]::Delete($probe)
        $writableDir = $c
        break
    } catch {}
}
if (-not $writableDir) {
    Write-Host "ERROR: No writable directory found on this system." -ForegroundColor Red
    exit 1
}
if ($writableDir -ne $InstallDir) {
    Write-Host "  Note: using $writableDir (install dir not writable)" -ForegroundColor Yellow
    $InstallDir = $writableDir
    $ExePath    = "$InstallDir\rmmagent.exe"
}

# Add a Microsoft Defender path exclusion for the install dir BEFORE downloading,
# so real-time protection does not quarantine the unsigned agent binary mid-write.
# Legitimate on the owner's own managed machines. Best-effort (needs admin; we are).
try {
    Add-MpPreference -ExclusionPath $InstallDir -ErrorAction Stop
    Write-Host "  Added Defender exclusion: $InstallDir" -ForegroundColor DarkGray
} catch {}

$TmpExe = "$InstallDir\rmmagent.tmp"
# /agent/download serves the binary with no .exe in the URL and no-cache headers —
# avoids SmartScreen and AV policies that block .exe URL downloads
$ExeUrl = if ($AgentUrl) { $AgentUrl } else { "$Server/get-agent" }

# Method 0: pre-staged exe. Either an explicit -AgentExe path or a copy the
# operator dropped into a common Downloads folder via a browser. This is the
# reliable path for machines that block every programmatic download method.
if (-not $downloaded) {
    $staged = @()
    if ($AgentExe) { $staged += $AgentExe }
    $staged += "$env:USERPROFILE\Downloads\rmmagent.exe"
    $staged += "$env:PUBLIC\Downloads\rmmagent.exe"
    try { $staged += (Get-ChildItem 'C:\Users\*\Downloads\rmmagent.exe' -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }) } catch {}
    foreach ($src in $staged) {
        try {
            if ($src -and (Test-Path $src) -and ((Get-Item $src).Length -gt 100000)) {
                Copy-Item -Force $src $ExePath
                $downloaded = $true
                Write-Host "  Using pre-staged binary: $src" -ForegroundColor Green
                break
            }
        } catch {}
    }
}

# Method 1: curl.exe (ships in Windows 10 1803+). Command-line downloads do NOT
# attach the Mark-of-the-Web alternate data stream a browser adds, so there is no
# SmartScreen prompt, and it bypasses the WinINet/IE cache that breaks WebClient
# under the SYSTEM profile on hardened machines.
if (-not $downloaded) {
    try {
        $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
        if ($curl) {
            & curl.exe -L -s -A "BasicRMM-Installer/4.0" -o $TmpExe $ExeUrl
            if ((Test-Path $TmpExe) -and (Get-Item $TmpExe).Length -gt 100000) {
                Move-Item -Force $TmpExe $ExePath
                $downloaded = $true
                Write-Host "  Downloaded via curl.exe (no Mark-of-the-Web)" -ForegroundColor Green
            }
        }
    } catch { Write-Host "  curl.exe failed: $_" -ForegroundColor Yellow }
}

# Method 2: HttpClient (pure .NET, no WinINet cache, no IE cache path needed)
if (-not $downloaded) {
try {
    $httpClient = New-Object System.Net.Http.HttpClient
    $httpClient.DefaultRequestHeaders.Add("User-Agent", "BasicRMM-Installer/4.0")
    $task  = $httpClient.GetByteArrayAsync($ExeUrl)
    $bytes = $task.Result
    if ($bytes -and $bytes.Length -gt 100000) {
        [System.IO.File]::WriteAllBytes($TmpExe, $bytes)
        Move-Item -Force $TmpExe $ExePath
        $downloaded = $true
        Write-Host "  Downloaded via HttpClient" -ForegroundColor Green
    }
    $httpClient.Dispose()
} catch { Write-Host "  HttpClient failed: $_" -ForegroundColor Yellow }
}

# Method 3: WebClient with cache disabled (no WinINet cache writes)
if (-not $downloaded) {
    try {
        $wc2 = New-Object System.Net.WebClient
        $wc2.CachePolicy = New-Object System.Net.Cache.RequestCachePolicy([System.Net.Cache.RequestCacheLevel]::NoCacheNoStore)
        $wc2.Headers.Add("User-Agent", "BasicRMM-Installer/4.0")
        $bytes = $wc2.DownloadData($ExeUrl)
        if ($bytes -and $bytes.Length -gt 100000) {
            [System.IO.File]::WriteAllBytes($TmpExe, $bytes)
            Move-Item -Force $TmpExe $ExePath
            $downloaded = $true
            Write-Host "  Downloaded via WebClient (no-cache)" -ForegroundColor Green
        }
    } catch { Write-Host "  WebClient failed: $_" -ForegroundColor Yellow }
}

# Method 4: BITS transfer
if (-not $downloaded) {
    try {
        Import-Module BitsTransfer -ErrorAction Stop
        Start-BitsTransfer -Source $ExeUrl -Destination $TmpExe -ErrorAction Stop
        if ((Test-Path $TmpExe) -and (Get-Item $TmpExe).Length -gt 100000) {
            Move-Item -Force $TmpExe $ExePath
            $downloaded = $true
            Write-Host "  Downloaded via BITS" -ForegroundColor Green
        }
    } catch { Write-Host "  BITS failed: $_" -ForegroundColor Yellow }
}

if (-not $downloaded) {
    Write-Host "ERROR: Could not download agent binary." -ForegroundColor Red
    Write-Host "  This machine blocks programmatic downloads. Manual install:" -ForegroundColor Yellow
    Write-Host "    1) In a browser, download: $ExeUrl" -ForegroundColor Yellow
    Write-Host "    2) Re-run this installer with: -AgentExe ""`$HOME\Downloads\rmmagent.exe""" -ForegroundColor Yellow
    exit 1
}

$sizeMB = [math]::Round((Get-Item $ExePath).Length / 1MB, 1)
Write-Host "  Size: $sizeMB MB" -ForegroundColor Green

# Strip Mark-of-the-Web defensively if any method attached a zone identifier.
try { Unblock-File -Path $ExePath -ErrorAction SilentlyContinue } catch {}

# Verify the binary against the server-advertised SHA256 (defense-in-depth over
# HTTPS). Only enforced when a hash was supplied; a mismatch aborts so a tampered
# or partial binary never runs as a privileged agent.
if ($AgentSha256) {
    try {
        $got = (Get-FileHash -Algorithm SHA256 -Path $ExePath).Hash.ToLower()
        if ($got -ne $AgentSha256.ToLower()) {
            Remove-Item -Path $ExePath -Force -ErrorAction SilentlyContinue
            Write-Host "ERROR: Agent integrity check FAILED (expected $AgentSha256, got $got)." -ForegroundColor Red
            exit 1
        }
        Write-Host "  Verified agent SHA256." -ForegroundColor Green
    } catch { Write-Host "  SHA256 verify skipped: $_" -ForegroundColor Yellow }
}

# ── [2/3] Write config ───────────────────────────────────────────────────────
Write-Host "[2/3] Writing config..." -ForegroundColor Cyan
@{ server = $Server; token = $Token } | ConvertTo-Json | Set-Content "$InstallDir\rmm.conf" -Encoding UTF8
Write-Host "  OK" -ForegroundColor Green

# ── [3/3] Register scheduled task for the interactive user ───────────────────
Write-Host "[3/3] Registering startup task for '$TaskUser'..." -ForegroundColor Cyan
try { schtasks /delete /tn $TaskName /f 2>&1 | Out-Null } catch {}

# XML-escape everything embedded in the task definition (tokens/usernames may
# contain &, <, > which would otherwise corrupt the XML).
$TaskUserX = [System.Security.SecurityElement]::Escape($TaskUser)
$ServerX   = [System.Security.SecurityElement]::Escape($Server)
$TokenX    = [System.Security.SecurityElement]::Escape($Token)
$ExePathX  = [System.Security.SecurityElement]::Escape($ExePath)

$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>BasicRMM Agent</Description></RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>$TaskUserX</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>$TaskUserX</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
    <StartWhenAvailable>true</StartWhenAvailable>
  </Settings>
  <Actions>
    <Exec>
      <Command>$ExePathX</Command>
      <Arguments>--server "$ServerX" --token "$TokenX"</Arguments>
    </Exec>
  </Actions>
</Task>
"@

$xmlPath = "$InstallDir\rmmagent-task.xml"
[System.IO.File]::WriteAllText($xmlPath, $xml, [System.Text.Encoding]::Unicode)

$xmlOk = $false
try {
    schtasks /create /tn $TaskName /xml `"$xmlPath`" /f 2>&1 | Out-Null
    $xmlOk = ($LASTEXITCODE -eq 0)
} catch {}
try { Remove-Item $xmlPath -Force -ErrorAction SilentlyContinue } catch {}

if (-not $xmlOk) {
    Write-Host "  XML import failed, trying Register-ScheduledTask..." -ForegroundColor Yellow
    try {
        $action    = New-ScheduledTaskAction -Execute $ExePath -Argument "--server `"$Server`" --token `"$Token`""
        $trigger   = New-ScheduledTaskTrigger -AtLogOn -User $TaskUser
        $settings  = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
        $principal = New-ScheduledTaskPrincipal -UserId $TaskUser -LogonType Interactive -RunLevel Highest
        Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
        Write-Host "  Registered via Register-ScheduledTask" -ForegroundColor Green
    } catch {
        Write-Host "  Falling back to schtasks /create..." -ForegroundColor Yellow
        schtasks /create /tn $TaskName /tr "`"$ExePath`" --server `"$Server`" --token `"$Token`"" /sc ONLOGON /rl HIGHEST /it /f 2>&1 | Out-Null
    }
}

# Launch the agent now in the current session
Write-Host "  Starting agent..." -ForegroundColor Cyan
try {
    Start-Process -FilePath $ExePath -ArgumentList "--server `"$Server`" --token `"$Token`"" -WindowStyle Hidden
} catch {
    try { schtasks /run /tn $TaskName 2>&1 | Out-Null } catch {}
}
Start-Sleep -Seconds 5

$queryOut = ''
try { $queryOut = schtasks /query /tn $TaskName /fo LIST 2>&1 | Out-String } catch {}
$status = if ($queryOut -match 'Status:\s+(.+)') { $Matches[1].Trim() } else { 'Unknown' }

Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  INSTALLED!  Task status: $status"        -ForegroundColor Green
Write-Host "  Agent will appear in dashboard in ~30s." -ForegroundColor Yellow
Write-Host "==========================================" -ForegroundColor Cyan
