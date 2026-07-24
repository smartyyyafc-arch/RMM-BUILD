package main

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// ── Config ────────────────────────────────────────────────────────────────────

var (
	server  string
	token   string
	agentID string
	logFile *os.File
)

func log_(msg string) {
	line := fmt.Sprintf("[%s] %s\n", time.Now().Format("2006-01-02 15:04:05"), msg)
	fmt.Print(line)
	if logFile != nil {
		logFile.WriteString(line)
	}
}

// ── Persistent agent ID ────────────────────────────────────────────────────

func loadOrCreateID(confPath string) string {
	type Conf struct {
		AgentID string `json:"agent_id"`
	}
	if b, err := os.ReadFile(confPath); err == nil {
		var c Conf
		if json.Unmarshal(b, &c) == nil && c.AgentID != "" {
			return c.AgentID
		}
	}
	id := randomUUID()
	b, _ := json.Marshal(Conf{AgentID: id})
	os.WriteFile(confPath, b, 0644)
	return id
}

func randomUUID() string {
	var b [16]byte
	rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%s-%s-%s-%s-%s",
		hex.EncodeToString(b[0:4]),
		hex.EncodeToString(b[4:6]),
		hex.EncodeToString(b[6:8]),
		hex.EncodeToString(b[8:10]),
		hex.EncodeToString(b[10:16]))
}

// ── HTTP client (TLS skip — works with any cert) ──────────────────────────

var httpClient = &http.Client{
	Timeout: 15 * time.Second,
	Transport: &http.Transport{
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
	},
}

func postJSON(path string, body interface{}) (map[string]interface{}, error) {
	b, _ := json.Marshal(body)
	resp, err := httpClient.Post(server+path, "application/json", bytes.NewReader(b))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var result map[string]interface{}
	json.NewDecoder(resp.Body).Decode(&result)
	return result, nil
}

// ── Metrics ────────────────────────────────────────────────────────────────

func getMetrics() (cpu, mem, disk float64) {
	if runtime.GOOS == "windows" {
		out, err := exec.Command("wmic", "cpu", "get", "LoadPercentage").Output()
		if err == nil {
			lines := strings.Split(string(out), "\n")
			for _, l := range lines {
				l = strings.TrimSpace(l)
				if l != "" && l != "LoadPercentage" {
					fmt.Sscanf(l, "%f", &cpu)
					break
				}
			}
		}
		var total, free float64
		out, err = exec.Command("wmic", "OS", "get", "TotalVisibleMemorySize,FreePhysicalMemory").Output()
		if err == nil {
			lines := strings.Split(string(out), "\n")
			for _, l := range lines {
				l = strings.TrimSpace(l)
				if l != "" && !strings.HasPrefix(l, "Free") {
					fmt.Sscanf(l, "%f %f", &free, &total)
					break
				}
			}
			if total > 0 {
				mem = (1 - free/total) * 100
			}
		}
		var freeDisk, totalDisk float64
		out, err = exec.Command("wmic", "logicaldisk", "where", "DeviceID='C:'", "get", "FreeSpace,Size").Output()
		if err == nil {
			lines := strings.Split(string(out), "\n")
			for _, l := range lines {
				l = strings.TrimSpace(l)
				if l != "" && !strings.HasPrefix(l, "Free") {
					fmt.Sscanf(l, "%f %f", &freeDisk, &totalDisk)
					break
				}
			}
			if totalDisk > 0 {
				disk = (1 - freeDisk/totalDisk) * 100
			}
		}
	}
	return
}

func getLocalIP() string {
	out, err := exec.Command("powershell", "-NoProfile", "-Command",
		"(Get-NetIPAddress -AddressFamily IPv4 | Where-Object {$_.IPAddress -notlike '127.*'} | Select-Object -First 1).IPAddress").Output()
	if err == nil {
		ip := strings.TrimSpace(string(out))
		if ip != "" {
			return ip
		}
	}
	return "0.0.0.0"
}

func getOS() string {
	if runtime.GOOS == "windows" {
		out, err := exec.Command("wmic", "os", "get", "Caption").Output()
		if err == nil {
			lines := strings.Split(string(out), "\n")
			for _, l := range lines {
				l = strings.TrimSpace(l)
				if l != "" && l != "Caption" {
					return l
				}
			}
		}
		return "Windows"
	}
	return runtime.GOOS
}

func getHostname() string {
	h, _ := os.Hostname()
	return h
}

func getUser() string {
	if runtime.GOOS == "windows" {
		return os.Getenv("USERNAME")
	}
	return os.Getenv("USER")
}

// ── Command execution ──────────────────────────────────────────────────────

type CmdResult struct {
	Status   string `json:"status"`
	ExitCode int    `json:"exit_code"`
	Output   string `json:"output"`
}

func runCommand(shell, command string) CmdResult {
	var cmd *exec.Cmd
	switch shell {
	case "powershell":
		cmd = exec.Command("powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command)
	case "cmd":
		cmd = exec.Command("cmd", "/c", command)
	default:
		return CmdResult{Status: "failed", ExitCode: 1, Output: "unsupported shell: " + shell}
	}

	out, err := cmd.CombinedOutput()
	outStr := string(out)
	if len(outStr) > 50000 {
		outStr = outStr[:50000]
	}

	exitCode := 0
	if err != nil {
		if ex, ok := err.(*exec.ExitError); ok {
			exitCode = ex.ExitCode()
		} else {
			exitCode = 1
		}
	}

	status := "done"
	if exitCode != 0 {
		status = "failed"
	}
	return CmdResult{Status: status, ExitCode: exitCode, Output: outStr}
}

// ── Heartbeat ──────────────────────────────────────────────────────────────

var (
	cachedOS string
	cachedIP string
)

func heartbeat() {
	cpu, mem, disk := getMetrics()
	payload := map[string]interface{}{
		"agent_id":       agentID,
		"token":          token,
		"hostname":       getHostname(),
		"os":             cachedOS,
		"platform":       runtime.GOOS,
		"version":        "3.0.0",
		"ip":             cachedIP,
		"user":           getUser(),
		"group":          "default",
		"tags":           "",
		"cpu_percent":    cpu,
		"memory_percent": mem,
		"disk_percent":   disk,
	}

	resp, err := postJSON("/api/agent/heartbeat", payload)
	if err != nil {
		log_("Heartbeat error: " + err.Error())
		return
	}
	log_("Heartbeat OK")

	if cmdsRaw, ok := resp["commands"]; ok {
		if cmds, ok := cmdsRaw.([]interface{}); ok {
			for _, c := range cmds {
				if cmd, ok := c.(map[string]interface{}); ok {
					id := fmt.Sprintf("%v", cmd["id"])
					shell := fmt.Sprintf("%v", cmd["shell"])
					command := fmt.Sprintf("%v", cmd["command"])

					go func(id, shell, command string) {
						if shell == "curtain" {
							applyCurtain(command)
							postJSON("/api/agent/command/"+id+"/result", map[string]interface{}{
								"token": token, "status": "done", "exit_code": 0, "output": "curtain applied",
							})
							return
						}
						result := runCommand(shell, command)
						postJSON("/api/agent/command/"+id+"/result", map[string]interface{}{
							"token": token, "status": result.Status, "exit_code": result.ExitCode, "output": result.Output,
						})
					}(id, shell, command)
				}
			}
		}
	}
}

// ── Curtain overlays ──────────────────────────────────────────────────────

func applyCurtain(action string) {
	switch action {
	case "lock", "blanklok":
		exec.Command("rundll32.exe", "user32.dll,LockWorkStation").Run()
	case "logoff":
		exec.Command("shutdown", "/l", "/f").Run()
	case "reboot":
		exec.Command("shutdown", "/r", "/f", "/t", "0").Run()
	case "shutdown":
		exec.Command("shutdown", "/s", "/f", "/t", "0").Run()
	case "black", "bsod", "update", "config":
		exec.Command("powershell", "-NoProfile", "-Command",
			"Get-Process | Where-Object {$_.MainWindowTitle -match 'curtain'} | Stop-Process -Force").Run()
		script := buildCurtainScript(action)
		exec.Command("powershell", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
			"-ExecutionPolicy", "Bypass", "-Command", script).Start()
	case "remove":
		exec.Command("powershell", "-NoProfile", "-Command",
			"Get-Process powershell -ErrorAction SilentlyContinue | Where-Object {$_.MainWindowHandle -eq 0 -and $_.Id -ne $PID} | Stop-Process -Force").Run()
	}
}

func buildCurtainScript(action string) string {
	switch action {
	case "bsod":
		return `Add-Type -AssemblyName PresentationFramework,PresentationCore,WindowsBase;
$w=[System.Windows.Window]::new();$w.WindowStyle='None';$w.WindowState='Maximized';$w.Topmost=$true;
$w.Background=[System.Windows.Media.SolidColorBrush][System.Windows.Media.Color]::FromRgb(0,120,215);
$sp=[System.Windows.Controls.StackPanel]::new();
$t=[System.Windows.Controls.TextBlock]::new();$t.Text=':)';$t.FontSize=120;$t.Margin=[System.Windows.Thickness]::new(80,60,0,20);$t.Foreground=[System.Windows.Media.Brushes]::White;
$t2=[System.Windows.Controls.TextBlock]::new();$t2.Text="Your PC ran into a problem.";$t2.FontSize=24;$t2.Foreground=[System.Windows.Media.Brushes]::White;$t2.Margin=[System.Windows.Thickness]::new(80,0,0,0);
$sp.Children.Add($t);$sp.Children.Add($t2);$w.Content=$sp;$w.ShowDialog()`
	case "update":
		return `Add-Type -AssemblyName PresentationFramework,PresentationCore,WindowsBase;
$w=[System.Windows.Window]::new();$w.WindowStyle='None';$w.WindowState='Maximized';$w.Topmost=$true;
$w.Background=[System.Windows.Media.SolidColorBrush][System.Windows.Media.Color]::FromRgb(26,26,26);
$sp=[System.Windows.Controls.StackPanel]::new();$sp.VerticalAlignment='Center';$sp.HorizontalAlignment='Center';
$t=[System.Windows.Controls.TextBlock]::new();$t.Text='Working on updates  100%';$t.FontSize=36;$t.Foreground=[System.Windows.Media.Brushes]::White;$t.HorizontalAlignment='Center';
$t2=[System.Windows.Controls.TextBlock]::new();$t2.Text="Do not turn off your PC";$t2.FontSize=18;$t2.Foreground=[System.Windows.Media.Brushes]::Gray;$t2.HorizontalAlignment='Center';$t2.Margin=[System.Windows.Thickness]::new(0,12,0,0);
$sp.Children.Add($t);$sp.Children.Add($t2);$w.Content=$sp;$w.ShowDialog()`
	case "config":
		return `Add-Type -AssemblyName PresentationFramework,PresentationCore,WindowsBase;
$w=[System.Windows.Window]::new();$w.WindowStyle='None';$w.WindowState='Maximized';$w.Topmost=$true;
$w.Background=[System.Windows.Media.SolidColorBrush][System.Windows.Media.Color]::FromRgb(10,10,40);
$t=[System.Windows.Controls.TextBlock]::new();$t.Text='Configuring system...';$t.FontSize=28;$t.Foreground=[System.Windows.Media.Brushes]::Cyan;$t.VerticalAlignment='Center';$t.HorizontalAlignment='Center';
$w.Content=$t;$w.ShowDialog()`
	default: // black
		return `Add-Type -AssemblyName PresentationFramework,PresentationCore,WindowsBase;
$w=[System.Windows.Window]::new();$w.WindowStyle='None';$w.WindowState='Maximized';$w.Topmost=$true;
$w.Background=[System.Windows.Media.Brushes]::Black;$w.ShowDialog()`
	}
}

// ── Screen helper mode ────────────────────────────────────────────────────
// When launched with --screen-helper the agent runs in the interactive user's
// session (placed there by the parent via CreateProcessAsUserW). It captures
// the screen in a loop and writes JSON-encoded frames to stdout.

func runScreenHelper() {
	out := bufio.NewWriter(os.Stdout)
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for range ticker.C {
		b64, w, h, err := captureScreen()
		if err != nil {
			continue
		}
		line, _ := json.Marshal(map[string]interface{}{
			"data": b64,
			"w":    w,
			"h":    h,
		})
		out.Write(line)
		out.WriteByte('\n')
		out.Flush()
	}
}

// ── Self-update ───────────────────────────────────────────────────────────

func selfUpdate() {
	exe, err := os.Executable()
	if err != nil {
		log_("Update: cannot resolve executable: " + err.Error())
		return
	}
	dir := filepath.Dir(exe)
	tmpPath := filepath.Join(dir, "rmmagent_update.exe")

	log_("Update: downloading new binary...")
	resp, err := httpClient.Get(server + "/agent/rmmagent.exe")
	if err != nil {
		log_("Update: download error: " + err.Error())
		return
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		log_("Update: read error: " + err.Error())
		return
	}
	if err := os.WriteFile(tmpPath, data, 0755); err != nil {
		log_("Update: write error: " + err.Error())
		return
	}

	log_("Update: restarting with new binary")
	// PowerShell waits 2 s (for this process to exit), moves the new binary over the old
	// one, then starts the new exe with the same server/token flags.
	script := fmt.Sprintf(
		`Start-Sleep 2; Copy-Item -Force '%s' '%s'; Start-Process '%s' -ArgumentList '--server "%s" --token "%s"' -WindowStyle Hidden`,
		tmpPath, exe, exe, server, token,
	)
	exec.Command("powershell", "-NonInteractive", "-NoProfile",
		"-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-Command", script).Start()
	os.Exit(0)
}

// ── WebSocket agent channel ───────────────────────────────────────────────

var wsDialer = &websocket.Dialer{
	TLSClientConfig:  &tls.Config{InsecureSkipVerify: true},
	HandshakeTimeout: 15 * time.Second,
}

// helperFrame is a decoded screen frame received from the screen-helper subprocess.
type helperFrame struct {
	data string
	w, h int
}

func wsLoop() {
	wsURL := strings.Replace(server, "http://", "ws://", 1)
	wsURL = strings.Replace(wsURL, "https://", "wss://", 1)
	u := wsURL + "/ws/agent/" + agentID + "?token=" + url.QueryEscape(token)

	for {
		func() {
			conn, _, err := wsDialer.Dial(u, nil)
			if err != nil {
				log_("WS connect error: " + err.Error())
				return
			}
			defer conn.Close()
			log_("WS connected")

			var mu sync.Mutex
			remoteActive := false
			var deviceID, sessionID string

			stopFrames := make(chan struct{})
			defer close(stopFrames)

			// Detect session once — if Session 0 (SYSTEM), capture via helper subprocess.
			inSession0 := isInSession0()
			if inSession0 {
				log_("Session 0 detected — screen capture via user-session helper")
			}

			helperCh := make(chan helperFrame, 2)

			if inSession0 {
				exe, _ := os.Executable()
				go func() {
					for {
						select {
						case <-stopFrames:
							return
						default:
						}

						scanner, cleanup, err := spawnScreenHelper(exe)
						if err != nil {
							log_("Screen helper: " + err.Error())
							select {
							case <-time.After(5 * time.Second):
							case <-stopFrames:
								return
							}
							continue
						}
						log_("Screen helper started")

						for scanner.Scan() {
							var fm map[string]interface{}
							if json.Unmarshal([]byte(scanner.Text()), &fm) != nil {
								continue
							}
							data, _ := fm["data"].(string)
							w, h := 0, 0
							if wf, ok := fm["w"].(float64); ok {
								w = int(wf)
							}
							if hf, ok := fm["h"].(float64); ok {
								h = int(hf)
							}
							if data == "" {
								continue
							}
							select {
							case helperCh <- helperFrame{data, w, h}:
							case <-stopFrames:
								cleanup()
								return
							default: // drop frame if reader is lagging
							}
						}
						cleanup()
						log_("Screen helper exited, respawning")
						select {
						case <-time.After(1 * time.Second):
						case <-stopFrames:
							return
						}
					}
				}()
			}

			// Frame sender — ticks at 10 fps
			go func() {
				ticker := time.NewTicker(100 * time.Millisecond)
				defer ticker.Stop()
				for {
					select {
					case <-stopFrames:
						return
					case <-ticker.C:
						mu.Lock()
						active := remoteActive
						did := deviceID
						sid := sessionID
						mu.Unlock()
						if !active {
							continue
						}

						var b64 string
						var fw, fh int

						if inSession0 {
							// Read latest frame from helper; skip tick if none ready
							select {
							case fm := <-helperCh:
								b64, fw, fh = fm.data, fm.w, fm.h
							default:
								continue
							}
						} else {
							var err error
							b64, fw, fh, err = captureScreen()
							if err != nil {
								continue
							}
						}

						if b64 == "" {
							continue
						}

						msg := map[string]interface{}{
							"type":       "frame",
							"data":       b64,
							"w":          fw,
							"h":          fh,
							"device_id":  did,
							"session_id": sid,
						}
						b, _ := json.Marshal(msg)
						conn.WriteMessage(websocket.TextMessage, b)
					}
				}
			}()

			for {
				_, raw, err := conn.ReadMessage()
				if err != nil {
					log_("WS read error: " + err.Error())
					return
				}

				var msg map[string]interface{}
				if json.Unmarshal(raw, &msg) != nil {
					continue
				}

				if sid, ok := msg["session_id"].(string); ok {
					mu.Lock()
					sessionID = sid
					mu.Unlock()
				}
				if did, ok := msg["device_id"]; ok {
					mu.Lock()
					deviceID = fmt.Sprintf("%v", did)
					mu.Unlock()
				}

				msgType, _ := msg["type"].(string)
				sid, _ := msg["session_id"].(string)
				switch msgType {
				case "remote_start":
					mu.Lock()
					remoteActive = true
					mu.Unlock()
					log_("Remote started")
				case "remote_stop":
					mu.Lock()
					remoteActive = false
					mu.Unlock()
					log_("Remote stopped")
				case "remote_input":
					handleInput(msg)
				case "block_input":
					enabled, _ := msg["enabled"].(bool)
					go blockUserInput(enabled)
				case "curtain":
					action, _ := msg["action"].(string)
					go applyCurtain(action)
				case "key":
					if keys, ok := msg["keys"].([]interface{}); ok {
						for _, k := range keys {
							sendKey(fmt.Sprintf("%v", k))
						}
					}
				case "update_agent":
					go selfUpdate()
				case "keepawake":
					moveMouse(200, 201)
				case "terminal_input":
					text, _ := msg["text"].(string)
					command := strings.TrimSpace(text)
					if command == "" {
						break
					}
					go func(cmd, sid string) {
						result := runCommand("powershell", cmd)
						output := result.Output
						if output == "" && result.ExitCode != 0 {
							output = fmt.Sprintf("Exit code: %d", result.ExitCode)
						}
						resp := map[string]interface{}{
							"type":       "output",
							"text":       output,
							"session_id": sid,
						}
						b, _ := json.Marshal(resp)
						conn.WriteMessage(websocket.TextMessage, b)
					}(command, sid)
				}
			}
		}()
		time.Sleep(5 * time.Second)
	}
}

// ── Main ────────────────────────────────────────────────────────────────────

func main() {
	var screenHelper bool
	flag.BoolVar(&screenHelper, "screen-helper", false, "")
	flag.StringVar(&server, "server", os.Getenv("RMM_SERVER"), "RMM server URL")
	flag.StringVar(&token, "token", os.Getenv("RMM_AGENT_TOKEN"), "Agent enrollment token")
	flag.Parse()

	// Helper mode: spawned by the parent into the user's interactive session.
	// Captures screen and writes JSON frames to stdout. No server connection needed.
	if screenHelper {
		runScreenHelper()
		return
	}

	if server == "" {
		fmt.Println("ERROR: --server required")
		os.Exit(1)
	}
	if token == "" {
		fmt.Println("ERROR: --token required")
		os.Exit(1)
	}

	exe, _ := os.Executable()
	dir := filepath.Dir(exe)
	logPath := filepath.Join(dir, "agent.log")
	logFile, _ = os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if logFile != nil {
		defer logFile.Close()
	}

	confPath := filepath.Join(dir, "agent.conf")
	agentID = loadOrCreateID(confPath)

	log_("BasicRMM Agent starting — " + agentID)
	log_("Server: " + server)

	cachedOS = getOS()
	cachedIP = getLocalIP()

	go wsLoop()

	for {
		heartbeat()
		time.Sleep(30 * time.Second)
	}
}
