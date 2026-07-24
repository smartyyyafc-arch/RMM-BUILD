# BasicRMM Agent - Pure PowerShell, no external dependencies
# Requires PowerShell 5.1+ (built into Windows 10/11/Server 2016+)
param(
    [string]$Server = $env:RMM_SERVER,
    [string]$Token  = $env:RMM_AGENT_TOKEN
)

$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference    = 'SilentlyContinue'

# Force TLS 1.2 — required for modern HTTPS; PS 5.1 defaults to TLS 1.0 which fails
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12

# Log file for diagnostics
$LogFile = Join-Path $PSScriptRoot "agent.log"
function Write-Log($msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
    try { Add-Content -Path $LogFile -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue } catch {}
    Write-Host $line
}

if (-not $Server) { Write-Log "ERROR: No server URL"; exit 1 }
if (-not $Token)  { Write-Log "ERROR: No token";      exit 1 }

# ── Persistent Agent ID ──────────────────────────────────────────────────────
$ConfigFile = Join-Path $PSScriptRoot "agent.conf"
if (Test-Path $ConfigFile) {
    try { $AgentId = (Get-Content $ConfigFile -Raw | ConvertFrom-Json).agent_id } catch {}
}
if (-not $AgentId) {
    $AgentId = [System.Guid]::NewGuid().ToString()
    try { [pscustomobject]@{agent_id=$AgentId} | ConvertTo-Json | Set-Content $ConfigFile -Encoding UTF8 } catch {}
}

Write-Log "BasicRMM Agent $AgentId starting — $Server"

# ── HTTP helper ──────────────────────────────────────────────────────────────
function Invoke-Post($Url, $Body) {
    try {
        $json = $Body | ConvertTo-Json -Depth 5 -Compress
        $r = Invoke-WebRequest -UseBasicParsing -Uri $Url -Method POST `
             -Body $json -ContentType 'application/json' -TimeoutSec 15
        return $r.Content | ConvertFrom-Json
    } catch {
        Write-Log "POST error $Url : $_"
        return $null
    }
}

# ── Metrics ──────────────────────────────────────────────────────────────────
$script:OsCaption = 'Windows'
$script:LocalIP   = '0.0.0.0'
try { $script:OsCaption = (Get-WmiObject Win32_OperatingSystem).Caption } catch {}
try {
    $r = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction Stop |
         Sort-Object RouteMetric | Select-Object -First 1
    $script:LocalIP = (Get-NetIPAddress -InterfaceIndex $r.InterfaceIndex -AddressFamily IPv4 -ErrorAction Stop).IPAddress
} catch {}

function Get-Metrics {
    $cpu = 0; $mem = 0; $disk = 0
    try { $cpu  = [math]::Round((Get-WmiObject Win32_Processor).LoadPercentage, 1) } catch {}
    try {
        $os  = Get-WmiObject Win32_OperatingSystem
        $mem = [math]::Round((1 - $os.FreePhysicalMemory / $os.TotalVisibleMemorySize) * 100, 1)
    } catch {}
    try { $d = Get-PSDrive C; $disk = [math]::Round($d.Used / ($d.Used + $d.Free) * 100, 1) } catch {}
    return @{ cpu=$cpu; mem=$mem; disk=$disk }
}

# ── WebSocket background job ──────────────────────────────────────────────────
# Runs in its own PowerShell runspace — no shared state issues
$WsJobScript = {
    param([string]$Server, [string]$Token, [string]$AgentId)
    $ErrorActionPreference = 'SilentlyContinue'
    $ProgressPreference    = 'SilentlyContinue'

    # WPF curtain overlay — defined here so the WS runspace can start it
    $LocalCurtainScript = {
        param([string]$Action)
        $ErrorActionPreference = 'SilentlyContinue'
        try {
            if ($Action -eq 'logoff') { logoff; return }
            Add-Type -AssemblyName PresentationFramework,PresentationCore,WindowsBase
            if ($Action -eq 'lock') {
                Add-Type -Name U2 -Namespace W2 -MemberDefinition '[DllImport("user32.dll")]public static extern bool LockWorkStation();'
                [W2.U2]::LockWorkStation() | Out-Null; return
            }
            if ($Action -eq 'remove') { return }
            $w = [System.Windows.Window]::new()
            $w.WindowStyle    = 'None'
            $w.WindowState    = 'Maximized'
            $w.Topmost        = $true
            $w.AllowsTransparency = $false
            switch -Wildcard ($Action) {
                'black'  { $w.Background = [System.Windows.Media.Brushes]::Black }
                'bsod'   {
                    $w.Background = [System.Windows.Media.SolidColorBrush][System.Windows.Media.Color]::FromRgb(0,120,215)
                    $sp = [System.Windows.Controls.StackPanel]::new()
                    $t1 = [System.Windows.Controls.TextBlock]::new()
                    $t1.Text = ':)'; $t1.Foreground = [System.Windows.Media.Brushes]::White
                    $t1.FontSize = 120; $t1.Margin = [System.Windows.Thickness]::new(80,60,0,20)
                    $t2 = [System.Windows.Controls.TextBlock]::new()
                    $t2.Text = "Your PC ran into a problem and needs to restart.`nWe're collecting some error info, and then we'll restart for you.`n`n0% complete"
                    $t2.Foreground = [System.Windows.Media.Brushes]::White; $t2.FontSize = 24
                    $t2.Margin = [System.Windows.Thickness]::new(80,0,0,0); $t2.TextWrapping = 'Wrap'
                    $sp.Children.Add($t1); $sp.Children.Add($t2)
                    $w.Content = $sp
                }
                'update' {
                    $w.Background = [System.Windows.Media.SolidColorBrush][System.Windows.Media.Color]::FromRgb(26,26,26)
                    $sp = [System.Windows.Controls.StackPanel]::new()
                    $sp.VerticalAlignment = 'Center'; $sp.HorizontalAlignment = 'Center'
                    $t1 = [System.Windows.Controls.TextBlock]::new()
                    $t1.Text = 'Working on updates  100%'; $t1.FontSize = 36
                    $t1.Foreground = [System.Windows.Media.Brushes]::White
                    $t1.HorizontalAlignment = 'Center'
                    $t2 = [System.Windows.Controls.TextBlock]::new()
                    $t2.Text = "Don't turn off your PC"; $t2.FontSize = 18
                    $t2.Foreground = [System.Windows.Media.Brushes]::Gray
                    $t2.HorizontalAlignment = 'Center'; $t2.Margin = [System.Windows.Thickness]::new(0,12,0,0)
                    $sp.Children.Add($t1); $sp.Children.Add($t2)
                    $w.Content = $sp
                }
                'config' {
                    $w.Background = [System.Windows.Media.SolidColorBrush][System.Windows.Media.Color]::FromRgb(10,10,40)
                    $t = [System.Windows.Controls.TextBlock]::new()
                    $t.Text = 'Configuring system...'; $t.FontSize = 28
                    $t.Foreground = [System.Windows.Media.Brushes]::Cyan
                    $t.VerticalAlignment = 'Center'; $t.HorizontalAlignment = 'Center'
                    $w.Content = $t
                }
                'custom:*' {
                    $imgPath = $Action.Substring(7)
                    $w.Background = [System.Windows.Media.Brushes]::Black
                    try {
                        $img = [System.Windows.Controls.Image]::new()
                        $bmp = [System.Windows.Media.Imaging.BitmapImage]::new([System.Uri]::new($imgPath))
                        $img.Source = $bmp
                        $img.Stretch = [System.Windows.Media.Stretch]::UniformToFill
                        $w.Content = $img
                    } catch {}
                }
                default  { $w.Background = [System.Windows.Media.Brushes]::Black }
            }
            $w.ShowDialog() | Out-Null
        } catch {}
    }

    $script:CurtainJob = $null

    # Compile C# screen capture + input in this runspace
    $script:HasScreen = $false
    try {
        Add-Type -ReferencedAssemblies 'System.Drawing','System.Windows.Forms' -TypeDefinition @'
using System; using System.Drawing; using System.Drawing.Imaging;
using System.IO; using System.Windows.Forms; using System.Runtime.InteropServices;
public class RmmScreen {
    public static int W() { return Screen.PrimaryScreen.Bounds.Width; }
    public static int H() { return Screen.PrimaryScreen.Bounds.Height; }
    public static string Grab(int maxW, int maxH) {
        var b = Screen.PrimaryScreen.Bounds;
        using (var bmp = new Bitmap(b.Width, b.Height))
        using (var g   = Graphics.FromImage(bmp)) {
            g.CopyFromScreen(b.Location, Point.Empty, b.Size);
            float s = Math.Min((float)maxW/b.Width, (float)maxH/b.Height);
            int nw=(int)(b.Width*s), nh=(int)(b.Height*s);
            using (var sm = new Bitmap(bmp, nw, nh))
            using (var ms = new MemoryStream()) {
                sm.Save(ms, ImageFormat.Jpeg);
                return Convert.ToBase64String(ms.ToArray());
            }
        }
    }
}
public class RmmInput {
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x,int y);
    [DllImport("user32.dll")] static extern void mouse_event(uint f,uint x,uint y,uint d,UIntPtr i);
    [DllImport("user32.dll")] static extern void keybd_event(byte vk,byte sc,uint f,UIntPtr i);
    [DllImport("user32.dll")] public static extern bool LockWorkStation();
    [DllImport("user32.dll")] static extern short VkKeyScan(char c);
    static System.Collections.Generic.Dictionary<string,byte> km =
        new System.Collections.Generic.Dictionary<string,byte>(StringComparer.OrdinalIgnoreCase){
            {"Enter",13},{"Tab",9},{"Escape",27},{"Backspace",8},{"Delete",46},
            {"Control",17},{"Alt",18},{"Shift",16},{"Space",32},
            {"ArrowLeft",37},{"ArrowUp",38},{"ArrowRight",39},{"ArrowDown",40},
            {"F1",112},{"F2",113},{"F3",114},{"F4",115},{"F5",116},{"F6",117},
            {"F7",118},{"F8",119},{"F9",120},{"F10",121},{"F11",122},{"F12",123}
        };
    public static void Move(int x,int y){SetCursorPos(x,y);}
    public static void Click(int x,int y,bool right){
        SetCursorPos(x,y);
        if(right){mouse_event(8,0,0,0,UIntPtr.Zero);mouse_event(16,0,0,0,UIntPtr.Zero);}
        else     {mouse_event(2,0,0,0,UIntPtr.Zero);mouse_event(4,0,0,0,UIntPtr.Zero);}
    }
    public static void Scroll(int dy){mouse_event(0x0800,0,0,(uint)(dy*120),UIntPtr.Zero);}
    public static void TypeKey(string key){
        byte vk;
        if(km.TryGetValue(key,out vk)){
            keybd_event(vk,0,0,UIntPtr.Zero);keybd_event(vk,0,2,UIntPtr.Zero);return;
        }
        if(key.Length==1){
            short r=VkKeyScan(key[0]); vk=(byte)(r&0xFF);
            bool sh=((r>>8)&1)!=0;
            if(sh)keybd_event(16,0,0,UIntPtr.Zero);
            keybd_event(vk,0,0,UIntPtr.Zero);keybd_event(vk,0,2,UIntPtr.Zero);
            if(sh)keybd_event(16,0,2,UIntPtr.Zero);
        }
    }
}
'@
        $script:HasScreen = $true
    } catch {}

    function Send-WsText($ws, $text) {
        try {
            $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
            $seg   = [System.ArraySegment[byte]]$bytes
            $ws.SendAsync($seg,
                [System.Net.WebSockets.WebSocketMessageType]::Text,
                $true,
                [System.Threading.CancellationToken]::None).GetAwaiter().GetResult()
        } catch {}
    }

    $wsUrl = $Server -replace '^http','ws'
    $uri   = [System.Uri]("$wsUrl/ws/agent/$AgentId`?token=$Token")
    $buf   = [byte[]]::new(65536)

    while ($true) {
        $ws = $null
        try {
            $ws = [System.Net.WebSockets.ClientWebSocket]::new()
            $ws.Options.KeepAliveInterval = [System.TimeSpan]::FromSeconds(20)
            $ws.ConnectAsync($uri, [System.Threading.CancellationToken]::None).GetAwaiter().GetResult()

            $remoteActive = $false
            $deviceId     = $null
            $sessionId    = $null
            $lastFrame    = [System.DateTime]::MinValue

            while ($ws.State -eq [System.Net.WebSockets.WebSocketState]::Open) {

                # If remote is active, use a short-timeout receive so we can send frames
                $cts = [System.Threading.CancellationTokenSource]::new()
                if ($remoteActive) { $cts.CancelAfter(100) } else { $cts.CancelAfter(5000) }

                $result = $null
                try {
                    $seg    = [System.ArraySegment[byte]]$buf
                    $result = $ws.ReceiveAsync($seg, $cts.Token).GetAwaiter().GetResult()
                } catch [System.OperationCanceledException] {
                    # Timeout — send a frame if remote is active
                } catch {
                    break
                } finally {
                    $cts.Dispose()
                }

                # Send a frame if needed
                if ($remoteActive -and $script:HasScreen) {
                    $now = [System.DateTime]::UtcNow
                    if (($now - $lastFrame).TotalMilliseconds -ge 100) {
                        try {
                            $b64   = [RmmScreen]::Grab(1280,720)
                            $w     = [RmmScreen]::W()
                            $h     = [RmmScreen]::H()
                            $didStr = if ($deviceId) { $deviceId } else { 'null' }
                            $sidStr = if ($sessionId) { '"' + $sessionId + '"' } else { 'null' }
                            Send-WsText $ws ('{"type":"frame","data":"' + $b64 + '","w":' + $w + ',"h":' + $h + ',"device_id":' + $didStr + ',"session_id":' + $sidStr + '}')
                            $lastFrame = $now
                        } catch {}
                    }
                }

                if (-not $result) { continue }
                if ($result.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) { break }

                try {
                    $text = [System.Text.Encoding]::UTF8.GetString($buf, 0, $result.Count)
                    $msg  = $text | ConvertFrom-Json
                    if ($msg.session_id) { $sessionId = $msg.session_id }
                    if ($msg.device_id)  { $deviceId  = [string]$msg.device_id }

                    switch ($msg.type) {
                        'remote_start' { $remoteActive = $true  }
                        'remote_stop'  { $remoteActive = $false }
                        'remote_input' {
                            switch ($msg.event) {
                                'move'   { try { [RmmInput]::Move([int]$msg.x,[int]$msg.y) } catch {} }
                                'click'  { try { [RmmInput]::Click([int]$msg.x,[int]$msg.y,($msg.button -eq 1)) } catch {} }
                                'scroll' { try { [RmmInput]::Scroll([int]$msg.dy) } catch {} }
                                'key'    { try { [RmmInput]::TypeKey([string]$msg.key) } catch {} }
                            }
                        }
                        'curtain' {
                            $a = $msg.action
                            # Kill any existing curtain overlay first
                            if ($script:CurtainJob) {
                                try { Stop-Job  $script:CurtainJob -ErrorAction SilentlyContinue } catch {}
                                try { Remove-Job $script:CurtainJob -Force -ErrorAction SilentlyContinue } catch {}
                                $script:CurtainJob = $null
                            }
                            if ($a -eq 'lock' -or $a -eq 'blanklok') {
                                try { [RmmInput]::LockWorkStation() | Out-Null } catch {}
                            } elseif ($a -ne 'remove') {
                                $script:CurtainJob = Start-Job -ScriptBlock $LocalCurtainScript -ArgumentList $a
                            }
                        }
                        'key' {
                            foreach ($k in @($msg.keys)) {
                                try { [RmmInput]::TypeKey([string]$k) } catch {}
                            }
                        }
                        'keepawake' {
                            # Move mouse slightly to prevent sleep
                            try { [RmmInput]::Move(200,200); [RmmInput]::Move(201,201) } catch {}
                        }
                    }
                } catch {}
            }
        } catch {}
        finally {
            try { if ($ws) { $ws.Dispose() } } catch {}
        }
        Start-Sleep 5
    }
}

# Curtain WPF overlay job script
$CurtainJobScript = {
    param([string]$Action)
    $ErrorActionPreference = 'SilentlyContinue'
    try {
        if ($Action -eq 'logoff') { logoff; return }
        Add-Type -AssemblyName PresentationFramework,PresentationCore,WindowsBase
        if ($Action -eq 'lock') {
            Add-Type -Name U2 -Namespace W2 -MemberDefinition '[DllImport("user32.dll")]public static extern bool LockWorkStation();'
            [W2.U2]::LockWorkStation() | Out-Null; return
        }
        if ($Action -eq 'remove') { return }
        $w = [System.Windows.Window]::new()
        $w.WindowStyle    = 'None'
        $w.WindowState    = 'Maximized'
        $w.Topmost        = $true
        $w.AllowsTransparency = $false
        switch ($Action) {
            'black'  { $w.Background = [System.Windows.Media.Brushes]::Black }
            'bsod'   {
                $w.Background = [System.Windows.Media.SolidColorBrush][System.Windows.Media.Color]::FromRgb(0,120,215)
                $sp = [System.Windows.Controls.StackPanel]::new()
                $t1 = [System.Windows.Controls.TextBlock]::new()
                $t1.Text = ':)'; $t1.Foreground = [System.Windows.Media.Brushes]::White
                $t1.FontSize = 120; $t1.Margin = [System.Windows.Thickness]::new(80,60,0,20)
                $t2 = [System.Windows.Controls.TextBlock]::new()
                $t2.Text = "Your PC ran into a problem and needs to restart.`nWe're collecting some error info, and then we'll restart for you.`n`n0% complete"
                $t2.Foreground = [System.Windows.Media.Brushes]::White; $t2.FontSize = 24
                $t2.Margin = [System.Windows.Thickness]::new(80,0,0,0); $t2.TextWrapping = 'Wrap'
                $sp.Children.Add($t1); $sp.Children.Add($t2)
                $w.Content = $sp
            }
            'update' {
                $w.Background = [System.Windows.Media.SolidColorBrush][System.Windows.Media.Color]::FromRgb(26,26,26)
                $sp = [System.Windows.Controls.StackPanel]::new()
                $sp.VerticalAlignment = 'Center'; $sp.HorizontalAlignment = 'Center'
                $t1 = [System.Windows.Controls.TextBlock]::new()
                $t1.Text = 'Working on updates  100%'; $t1.FontSize = 36
                $t1.Foreground = [System.Windows.Media.Brushes]::White
                $t1.HorizontalAlignment = 'Center'
                $t2 = [System.Windows.Controls.TextBlock]::new()
                $t2.Text = "Don't turn off your PC"; $t2.FontSize = 18
                $t2.Foreground = [System.Windows.Media.Brushes]::Gray
                $t2.HorizontalAlignment = 'Center'; $t2.Margin = [System.Windows.Thickness]::new(0,12,0,0)
                $sp.Children.Add($t1); $sp.Children.Add($t2)
                $w.Content = $sp
            }
            'config' {
                $w.Background = [System.Windows.Media.SolidColorBrush][System.Windows.Media.Color]::FromRgb(10,10,40)
                $t = [System.Windows.Controls.TextBlock]::new()
                $t.Text = 'Configuring system...'; $t.FontSize = 28
                $t.Foreground = [System.Windows.Media.Brushes]::Cyan
                $t.VerticalAlignment = 'Center'; $t.HorizontalAlignment = 'Center'
                $w.Content = $t
            }
            default  { $w.Background = [System.Windows.Media.Brushes]::Black }
        }
        $w.ShowDialog() | Out-Null
    } catch {}
}

# ── Start the WebSocket background job ───────────────────────────────────────
$script:WsJob = Start-Job -ScriptBlock $WsJobScript -ArgumentList $Server, $Token, $AgentId

# ── Main heartbeat loop (runs directly in this runspace — no threads) ─────────
Write-Log "Heartbeat loop starting..."

while ($true) {
    try {
        $m = Get-Metrics
        $payload = @{
            agent_id       = $AgentId
            token          = $Token
            hostname       = $env:COMPUTERNAME
            os             = $script:OsCaption
            platform       = 'windows'
            version        = '2.0.0'
            ip             = $script:LocalIP
            user           = $env:USERNAME
            group          = 'default'
            tags           = ''
            cpu_percent    = $m.cpu
            memory_percent = $m.mem
            disk_percent   = $m.disk
        }

        $resp = Invoke-Post "$Server/api/agent/heartbeat" $payload

        if ($resp -and $resp.commands) {
            foreach ($cmd in $resp.commands) {
                $cmdId  = $cmd.id
                $shell  = $cmd.shell
                $cmdStr = $cmd.command

                if ($shell -eq 'curtain') {
                    # WPF curtain in its own job
                    Start-Job -ScriptBlock $CurtainJobScript -ArgumentList $cmdStr | Out-Null
                    Invoke-Post "$Server/api/agent/command/$cmdId/result" @{
                        token=$Token; status='done'; exit_code=0; output="Curtain '$cmdStr' applied"
                    } | Out-Null
                } else {
                    # Execute and POST result inline (fast enough for 30s cycle)
                    $exitCode = 0; $output = ''
                    try {
                        $tmp    = [System.IO.Path]::GetTempFileName()
                        $errTmp = $tmp + '.err'
                        if ($shell -eq 'powershell') {
                            $proc = Start-Process powershell.exe `
                                -ArgumentList "-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command `"$cmdStr`"" `
                                -WindowStyle Hidden -Wait -PassThru `
                                -RedirectStandardOutput $tmp -RedirectStandardError $errTmp
                        } elseif ($shell -eq 'cmd') {
                            $proc = Start-Process cmd.exe `
                                -ArgumentList "/c $cmdStr" `
                                -WindowStyle Hidden -Wait -PassThru `
                                -RedirectStandardOutput $tmp -RedirectStandardError $errTmp
                        } else {
                            $output = "Shell not supported: $shell"; $exitCode = 1; $proc = $null
                        }
                        if ($proc) {
                            $exitCode = $proc.ExitCode
                            $out1 = if (Test-Path $tmp)    { Get-Content $tmp    -Raw } else { '' }
                            $out2 = if (Test-Path $errTmp) { Get-Content $errTmp -Raw } else { '' }
                            $output = ($out1 + $out2).TrimEnd()
                            Remove-Item $tmp,$errTmp -Force -ErrorAction SilentlyContinue
                        }
                    } catch {
                        $output = $_.Exception.Message; $exitCode = 1
                    }

                    $truncated = if ($output.Length -gt 50000) { $output.Substring(0,50000) } else { $output }
                    Invoke-Post "$Server/api/agent/command/$cmdId/result" @{
                        token     = $Token
                        status    = if ($exitCode -eq 0) {'done'} else {'failed'}
                        exit_code = $exitCode
                        output    = $truncated
                    } | Out-Null
                }
            }
        }
    } catch {
        Write-Log "Heartbeat error: $_"
    }

    # Restart WS job if it stopped
    try {
        if ($script:WsJob.State -ne 'Running') {
            Remove-Job $script:WsJob -Force -ErrorAction SilentlyContinue
            $script:WsJob = Start-Job -ScriptBlock $WsJobScript -ArgumentList $Server,$Token,$AgentId
        }
    } catch {}

    # Clean up finished jobs (curtain overlays etc.)
    Get-Job | Where-Object { $_.State -in 'Completed','Failed','Stopped' } | Remove-Job -Force -ErrorAction SilentlyContinue

    Start-Sleep 30
}
