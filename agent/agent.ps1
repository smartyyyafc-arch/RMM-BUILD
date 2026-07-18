# BasicRMM Agent - Pure PowerShell, no dependencies required
# Requires: PowerShell 5.1+ (built into Windows 10/11/Server 2016+)
param(
    [string]$Server  = $env:RMM_SERVER,
    [string]$Token   = $env:RMM_AGENT_TOKEN
)

$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference    = 'SilentlyContinue'

# ── Persistent Agent ID ───────────────────────────────────────────────────────
$ConfigFile = "$PSScriptRoot\agent.conf"
if (Test-Path $ConfigFile) {
    $cfg     = Get-Content $ConfigFile -Raw | ConvertFrom-Json
    $AgentId = $cfg.agent_id
} else {
    $AgentId = [System.Guid]::NewGuid().ToString()
    [pscustomobject]@{agent_id=$AgentId} | ConvertTo-Json | Set-Content $ConfigFile
}

# ── C# helpers (screen capture + input simulation) ────────────────────────────
Add-Type -ReferencedAssemblies 'System.Drawing','System.Windows.Forms' -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Windows.Forms;
using System.Runtime.InteropServices;

public class RmmScreen {
    public static int W { get { return Screen.PrimaryScreen.Bounds.Width; } }
    public static int H { get { return Screen.PrimaryScreen.Bounds.Height; } }

    public static string Grab(int maxW, int maxH) {
        var b = Screen.PrimaryScreen.Bounds;
        using (var bmp = new Bitmap(b.Width, b.Height, PixelFormat.Format32bppArgb)) {
            using (var g = Graphics.FromImage(bmp))
                g.CopyFromScreen(b.Location, Point.Empty, b.Size);
            float scale = Math.Min((float)maxW / b.Width, (float)maxH / b.Height);
            if (scale >= 1f) return ToJpeg(bmp);
            int nw = (int)(b.Width * scale), nh = (int)(b.Height * scale);
            using (var small = new Bitmap(bmp, new Size(nw, nh)))
                return ToJpeg(small);
        }
    }
    static string ToJpeg(Bitmap bmp) {
        using (var ms = new MemoryStream()) {
            var enc  = GetEncoder(ImageFormat.Jpeg);
            var pars = new EncoderParameters(1);
            pars.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 55L);
            bmp.Save(ms, enc, pars);
            return Convert.ToBase64String(ms.ToArray());
        }
    }
    static ImageCodecInfo GetEncoder(ImageFormat fmt) {
        foreach (var c in ImageCodecInfo.GetImageDecoders())
            if (c.FormatID == fmt.Guid) return c;
        return null;
    }
}

public class RmmInput {
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern void mouse_event(uint f, uint x, uint y, uint d, UIntPtr i);
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte sc, uint f, UIntPtr i);
    [DllImport("user32.dll")] public static extern bool LockWorkStation();

    public static void Move(int x, int y)  { SetCursorPos(x, y); }
    public static void Click(int x, int y, bool right) {
        SetCursorPos(x, y);
        if (right) { mouse_event(0x0008,0,0,0,UIntPtr.Zero); mouse_event(0x0010,0,0,0,UIntPtr.Zero); }
        else       { mouse_event(0x0002,0,0,0,UIntPtr.Zero); mouse_event(0x0004,0,0,0,UIntPtr.Zero); }
    }
    public static void Scroll(int dy) { mouse_event(0x0800,0,0,(uint)(dy*120),UIntPtr.Zero); }
    public static void KeyTap(byte vk) { keybd_event(vk,0,0,UIntPtr.Zero); keybd_event(vk,0,2,UIntPtr.Zero); }

    static readonly System.Collections.Generic.Dictionary<string,byte> KeyMap =
        new System.Collections.Generic.Dictionary<string,byte>(StringComparer.OrdinalIgnoreCase) {
            {"Enter",0x0D},{"Tab",0x09},{"Escape",0x1B},{"Backspace",0x08},{"Delete",0x2E},
            {"Control",0x11},{"Alt",0x12},{"Shift",0x10},{"Win",0x5B},
            {"ArrowLeft",0x25},{"ArrowUp",0x26},{"ArrowRight",0x27},{"ArrowDown",0x28},
            {"Home",0x24},{"End",0x23},{"PageUp",0x21},{"PageDown",0x22},
            {"F1",0x70},{"F2",0x71},{"F3",0x72},{"F4",0x73},{"F5",0x74},
            {"F6",0x75},{"F7",0x76},{"F8",0x77},{"F9",0x78},{"F10",0x79},
            {"F11",0x7A},{"F12",0x7B}
        };

    public static void TypeKey(string key) {
        byte vk;
        if (KeyMap.TryGetValue(key, out vk)) { KeyTap(vk); return; }
        if (key.Length == 1) {
            short res = VkKeyScan(key[0]);
            vk = (byte)(res & 0xFF);
            bool shift = (res >> 8 & 1) != 0;
            if (shift) keybd_event(0x10,0,0,UIntPtr.Zero);
            KeyTap(vk);
            if (shift) keybd_event(0x10,0,2,UIntPtr.Zero);
        }
    }
    [DllImport("user32.dll")] static extern short VkKeyScan(char c);
}
'@ 2>$null

# ── Metrics ───────────────────────────────────────────────────────────────────
function Get-Metrics {
    $cpu  = [math]::Round((Get-WmiObject Win32_Processor | Measure-Object LoadPercentage -Average).Average, 1)
    $os   = Get-WmiObject Win32_OperatingSystem
    $mem  = [math]::Round((1 - $os.FreePhysicalMemory / $os.TotalVisibleMemorySize) * 100, 1)
    $disk = Get-PSDrive C
    $diskPct = [math]::Round($disk.Used / ($disk.Used + $disk.Free) * 100, 1)
    return @{ cpu_percent=$cpu; memory_percent=$mem; disk_percent=$diskPct }
}

function Get-LocalIP {
    try {
        $r = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction Stop | Sort-Object RouteMetric | Select-Object -First 1
        return (Get-NetIPAddress -InterfaceIndex $r.InterfaceIndex -AddressFamily IPv4 -ErrorAction Stop).IPAddress
    } catch { return '0.0.0.0' }
}

# ── HTTP helpers ──────────────────────────────────────────────────────────────
function Invoke-Api($Method, $Path, $Body) {
    $uri = "$Server/api$Path"
    $headers = @{ 'Content-Type'='application/json' }
    $json = if ($Body) { $Body | ConvertTo-Json -Depth 10 -Compress } else { $null }
    try {
        $r = Invoke-WebRequest -UseBasicParsing -Uri $uri -Method $Method -Body $json -Headers $headers -TimeoutSec 10
        return $r.Content | ConvertFrom-Json
    } catch { return $null }
}

# ── Heartbeat + command queue ─────────────────────────────────────────────────
function Send-Heartbeat {
    $m = Get-Metrics
    $payload = @{
        agent_id       = $AgentId
        token          = $Token
        hostname       = $env:COMPUTERNAME
        os             = (Get-WmiObject Win32_OperatingSystem).Caption
        platform       = 'windows'
        version        = '2.0.0'
        ip             = (Get-LocalIP)
        user           = $env:USERNAME
        group          = 'default'
        tags           = ''
        cpu_percent    = $m.cpu_percent
        memory_percent = $m.memory_percent
        disk_percent   = $m.disk_percent
    }
    $resp = Invoke-Api POST '/agent/heartbeat' $payload
    if ($resp -and $resp.commands) { return $resp.commands }
    return @()
}

function Send-Result($CmdId, $ExitCode, $Output) {
    Invoke-Api POST "/agent/command/$CmdId/result" @{
        status    = if ($ExitCode -eq 0) { 'done' } else { 'failed' }
        exit_code = $ExitCode
        output    = $Output.Substring(0, [Math]::Min($Output.Length, 100000))
    } | Out-Null
}

function Run-Command($CmdId, $Shell, $Command) {
    try {
        if ($Shell -eq 'curtain') {
            Run-Curtain $Command
            Send-Result $CmdId 0 'Curtain updated'
            return
        }
        $proc = if ($Shell -eq 'powershell') {
            Start-Process powershell -ArgumentList '-NoProfile','-Command',$Command `
                -Wait -PassThru -WindowStyle Hidden -RedirectStandardOutput "$env:TEMP\rmm_out.txt" `
                -RedirectStandardError "$env:TEMP\rmm_err.txt"
        } elseif ($Shell -eq 'cmd') {
            Start-Process cmd -ArgumentList '/c',$Command `
                -Wait -PassThru -WindowStyle Hidden -RedirectStandardOutput "$env:TEMP\rmm_out.txt" `
                -RedirectStandardError "$env:TEMP\rmm_err.txt"
        } else {
            Start-Process $Shell -ArgumentList '-c',$Command `
                -Wait -PassThru -WindowStyle Hidden -RedirectStandardOutput "$env:TEMP\rmm_out.txt" `
                -RedirectStandardError "$env:TEMP\rmm_err.txt"
        }
        $out = (Get-Content "$env:TEMP\rmm_out.txt" -Raw -ErrorAction SilentlyContinue) + `
               (Get-Content "$env:TEMP\rmm_err.txt" -Raw -ErrorAction SilentlyContinue)
        Send-Result $CmdId $proc.ExitCode ($out -replace $null,'')
    } catch {
        Send-Result $CmdId 1 $_.Exception.Message
    }
}

# ── Curtain overlays (WPF) ────────────────────────────────────────────────────
$script:CurtainJob = $null

function Run-Curtain($action) {
    if ($script:CurtainJob) { Stop-Job $script:CurtainJob -PassThru | Remove-Job; $script:CurtainJob = $null }
    if ($action -eq 'remove') { return }

    $wpfCode = switch -Wildcard ($action) {
        'black'   { 'window.Background = [System.Windows.Media.Brushes]::Black' }
        'bsod'    { 'window.Background = [System.Windows.Media.SolidColorBrush][System.Windows.Media.Color]::FromRgb(0,120,215); $tb=[System.Windows.Controls.TextBlock]::new(); $tb.Text=":("; $tb.Foreground=[System.Windows.Media.Brushes]::White; $tb.FontSize=160; $tb.Margin=[System.Windows.Thickness]::new(80,80,0,0); $window.Content=$tb' }
        'lock'    { '[System.Runtime.InteropServices.Marshal]::GetDelegateForFunctionPointer([System.Runtime.InteropServices.Marshal]::GetExportedFunctionPointer([System.Runtime.InteropServices.Marshal]::LoadLibrary("user32.dll"),"LockWorkStation"),[Action]).Invoke()'; return }
        'blanklok'{ Run-Curtain 'black'; Start-Sleep 1; [RmmInput]::LockWorkStation() | Out-Null; return }
        'logoff'  { Start-Process logoff; return }
        'update'  { 'window.Background=[System.Windows.Media.SolidColorBrush][System.Windows.Media.Color]::FromRgb(26,26,26); $tb=[System.Windows.Controls.TextBlock]::new(); $tb.Text="Working on updates`n100% complete"; $tb.Foreground=[System.Windows.Media.Brushes]::White; $tb.FontSize=36; $tb.TextAlignment="Center"; $tb.VerticalAlignment="Center"; $tb.HorizontalAlignment="Center"; $window.Content=$tb' }
        default   { 'window.Background = [System.Windows.Media.Brushes]::Black' }
    }

    $script:CurtainJob = Start-Job -ScriptBlock {
        param($code)
        Add-Type -AssemblyName PresentationFramework,PresentationCore,WindowsBase
        $window = [System.Windows.Window]::new()
        $window.WindowStyle   = 'None'
        $window.WindowState   = 'Maximized'
        $window.Topmost       = $true
        $window.ResizeMode    = 'NoResize'
        Invoke-Expression $code
        $window.ShowDialog() | Out-Null
    } -ArgumentList $wpfCode
}

# ── WebSocket connection ───────────────────────────────────────────────────────
$script:WsConnected  = $false
$script:RemoteActive = $false
$script:ShellProc    = $null
$script:SessionId    = ''

function Start-WsConnection {
    $wsUrl = $Server -replace '^http','ws'
    $uri   = [System.Uri]"$wsUrl/ws/agent/$AgentId`?token=$Token"
    $ws    = [System.Net.WebSockets.ClientWebSocket]::new()
    $ws.Options.KeepAliveInterval = [TimeSpan]::FromSeconds(20)

    try {
        $ws.ConnectAsync($uri, [System.Threading.CancellationToken]::None).GetAwaiter().GetResult()
        $script:WsConnected = $true
        Write-Host "WS connected"
    } catch {
        Write-Host "WS connect failed: $_"
        return
    }

    # Remote desktop sender thread
    $remoteThread = [System.Threading.Thread]::new([System.Threading.ThreadStart]{
        while ($true) {
            if ($script:RemoteActive -and $script:WsConnected) {
                try {
                    $b64 = [RmmScreen]::Grab(1280, 720)
                    $frame = @{type='frame'; data=$b64; w=[RmmScreen]::W; h=[RmmScreen]::H; device_id=$script:DeviceId; session_id=$script:SessionId} | ConvertTo-Json -Compress
                    $bytes = [System.Text.Encoding]::UTF8.GetBytes($frame)
                    $ws.SendAsync([ArraySegment[byte]]$bytes, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [System.Threading.CancellationToken]::None).GetAwaiter().GetResult()
                } catch {}
                [System.Threading.Thread]::Sleep(100)
            } else {
                [System.Threading.Thread]::Sleep(200)
            }
        }
    })
    $remoteThread.IsBackground = $true
    $remoteThread.Start()

    # WS receive loop
    $buf = [byte[]]::new(65536)
    while ($ws.State -eq 'Open') {
        try {
            $seg    = [ArraySegment[byte]]$buf
            $result = $ws.ReceiveAsync($seg, [System.Threading.CancellationToken]::None).GetAwaiter().GetResult()
            if ($result.MessageType -eq 'Close') { break }
            $json   = [System.Text.Encoding]::UTF8.GetString($buf, 0, $result.Count)
            $msg    = $json | ConvertFrom-Json
            $script:SessionId = $msg.session_id
            $script:DeviceId  = $msg.device_id

            switch ($msg.type) {
                'terminal_input' {
                    if (-not $script:ShellProc -or $script:ShellProc.HasExited) {
                        $script:ShellProc = Start-Process powershell -ArgumentList '-NoLogo','-NoExit' `
                            -PassThru -WindowStyle Hidden `
                            -RedirectStandardInput  "$env:TEMP\rmm_stdin.txt" `
                            -RedirectStandardOutput "$env:TEMP\rmm_stdout.txt" `
                            -RedirectStandardError  "$env:TEMP\rmm_stderr.txt"
                    }
                    # Forward input
                    [System.IO.File]::AppendAllText("$env:TEMP\rmm_stdin.txt", $msg.data)
                    # Send output back
                    $out = [System.IO.File]::ReadAllText("$env:TEMP\rmm_stdout.txt") + `
                           [System.IO.File]::ReadAllText("$env:TEMP\rmm_stderr.txt")
                    if ($out) {
                        $reply = @{type='terminal_output';data=$out;session_id=$script:SessionId} | ConvertTo-Json -Compress
                        $rb = [System.Text.Encoding]::UTF8.GetBytes($reply)
                        $ws.SendAsync([ArraySegment[byte]]$rb,[System.Net.WebSockets.WebSocketMessageType]::Text,$true,[System.Threading.CancellationToken]::None).GetAwaiter().GetResult() | Out-Null
                    }
                }
                'remote_start'  { $script:RemoteActive = $true }
                'remote_stop'   { $script:RemoteActive = $false }
                'remote_input'  {
                    switch ($msg.event) {
                        'move'  { [RmmInput]::Move($msg.x, $msg.y) }
                        'click' { [RmmInput]::Click($msg.x, $msg.y, ($msg.button -eq 1)) }
                        'scroll'{ [RmmInput]::Scroll($msg.dy) }
                        'key'   { [RmmInput]::TypeKey($msg.key) }
                    }
                }
                'curtain'    { Run-Curtain $msg.action }
                'key'        { foreach ($k in $msg.keys) { [RmmInput]::TypeKey($k) } }
                'keepawake'  {
                    if ($msg.enabled) {
                        Add-Type -Name WinPwr -Namespace RMM -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint s);'
                        [RMM.WinPwr]::SetThreadExecutionState(0x80000003) | Out-Null
                    }
                }
            }
        } catch { break }
    }
    $script:WsConnected  = $false
    $script:RemoteActive = $false
    try { $ws.Dispose() } catch {}
}

# ── Main loop ─────────────────────────────────────────────────────────────────
Write-Host "BasicRMM Agent starting — $AgentId"
Write-Host "Server: $Server"

# WebSocket in background thread
$wsThread = [System.Threading.Thread]::new([System.Threading.ThreadStart]{
    while ($true) {
        try { Start-WsConnection } catch {}
        Start-Sleep 5
    }
})
$wsThread.IsBackground = $true
$wsThread.Start()

# Heartbeat loop
while ($true) {
    try {
        $cmds = Send-Heartbeat
        foreach ($cmd in $cmds) {
            $c = $cmd
            $t = [System.Threading.Thread]::new([System.Threading.ThreadStart]{
                Run-Command $c.id $c.shell $c.command
            })
            $t.IsBackground = $true
            $t.Start()
        }
    } catch {}
    Start-Sleep 30
}
