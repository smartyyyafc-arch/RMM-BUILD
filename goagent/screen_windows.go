//go:build windows

package main

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"fmt"
	"image"
	"image/jpeg"
	"os/exec"
	"syscall"
	"unsafe"
)

var (
	user32   = syscall.NewLazyDLL("user32.dll")
	gdi32    = syscall.NewLazyDLL("gdi32.dll")
	kernel32 = syscall.NewLazyDLL("kernel32.dll")
	wtsapi32 = syscall.NewLazyDLL("wtsapi32.dll")

	procGetDC            = user32.NewProc("GetDC")
	procReleaseDC        = user32.NewProc("ReleaseDC")
	procGetSystemMetrics = user32.NewProc("GetSystemMetrics")
	procSetCursorPos     = user32.NewProc("SetCursorPos")
	procMouseEvent       = user32.NewProc("mouse_event")
	procKeybdEvent       = user32.NewProc("keybd_event")
	procVkKeyScan        = user32.NewProc("VkKeyScanW")
	procLockWorkStation  = user32.NewProc("LockWorkStation")
	procBlockInput       = user32.NewProc("BlockInput")

	procCreateCompatibleDC     = gdi32.NewProc("CreateCompatibleDC")
	procCreateCompatibleBitmap = gdi32.NewProc("CreateCompatibleBitmap")
	procSelectObject           = gdi32.NewProc("SelectObject")
	procBitBlt                 = gdi32.NewProc("BitBlt")
	procGetDIBits              = gdi32.NewProc("GetDIBits")
	procDeleteDC               = gdi32.NewProc("DeleteDC")
	procDeleteObject           = gdi32.NewProc("DeleteObject")

	procGetCurrentProcessId          = kernel32.NewProc("GetCurrentProcessId")
	procProcessIdToSessionId         = kernel32.NewProc("ProcessIdToSessionId")
	procWTSGetActiveConsoleSessionId = kernel32.NewProc("WTSGetActiveConsoleSessionId")
	procWTSQueryUserToken            = wtsapi32.NewProc("WTSQueryUserToken")
)

const (
	SM_CXSCREEN    = 0
	SM_CYSCREEN    = 1
	SRCCOPY        = 0x00CC0020
	DIB_RGB_COLORS = 0
	BI_RGB         = 0
	KEYEVENTF_UP   = 2
)

// isInSession0 returns true when this process is running in Windows Session 0
// (SYSTEM service). GetDC(NULL) from Session 0 yields an invisible/black surface;
// screen capture must be delegated to a subprocess in the interactive user session.
func isInSession0() bool {
	pid, _, _ := procGetCurrentProcessId.Call()
	var sid uint32
	procProcessIdToSessionId.Call(pid, uintptr(unsafe.Pointer(&sid)))
	return sid == 0
}

// spawnScreenHelper launches exePath --screen-helper inside the active
// interactive user session via WTSQueryUserToken + CreateProcessAsUserW
// (Go uses CreateProcessAsUserW when SysProcAttr.Token is set).
// The helper writes captured frames as JSON lines to its stdout.
// Returns a line Scanner over the pipe plus a cleanup function.
func spawnScreenHelper(exePath string) (*bufio.Scanner, func(), error) {
	sessionID, _, _ := procWTSGetActiveConsoleSessionId.Call()
	if sessionID == 0xFFFFFFFF {
		return nil, nil, fmt.Errorf("no active console session")
	}

	var hToken syscall.Token
	r, _, e := procWTSQueryUserToken.Call(sessionID, uintptr(unsafe.Pointer(&hToken)))
	if r == 0 {
		return nil, nil, fmt.Errorf("WTSQueryUserToken(session %d): %v", sessionID, e)
	}
	defer hToken.Close()

	cmd := exec.Command(exePath, "--screen-helper")
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Token:         hToken,
		HideWindow:    true,
		CreationFlags: 0x08000000, // CREATE_NO_WINDOW
	}

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, nil, err
	}

	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 4*1024*1024), 4*1024*1024)

	cleanup := func() {
		stdout.Close()
		if cmd.Process != nil {
			cmd.Process.Kill()
			cmd.Wait()
		}
	}
	return scanner, cleanup, nil
}

// ── Screen capture ────────────────────────────────────────────────────────────

type BITMAPINFOHEADER struct {
	BiSize          uint32
	BiWidth         int32
	BiHeight        int32
	BiPlanes        uint16
	BiBitCount      uint16
	BiCompression   uint32
	BiSizeImage     uint32
	BiXPelsPerMeter int32
	BiYPelsPerMeter int32
	BiClrUsed       uint32
	BiClrImportant  uint32
}

type BITMAPINFO struct {
	BmiHeader BITMAPINFOHEADER
	BmiColors [1]uint32
}

func captureScreen() (string, int, int, error) {
	sw, _, _ := procGetSystemMetrics.Call(SM_CXSCREEN)
	sh, _, _ := procGetSystemMetrics.Call(SM_CYSCREEN)
	w := int(sw)
	h := int(sh)

	hdc, _, _ := procGetDC.Call(0)
	if hdc == 0 {
		return "", 0, 0, fmt.Errorf("GetDC failed")
	}
	defer procReleaseDC.Call(0, hdc)

	memDC, _, _ := procCreateCompatibleDC.Call(hdc)
	if memDC == 0 {
		return "", 0, 0, fmt.Errorf("CreateCompatibleDC failed")
	}
	defer procDeleteDC.Call(memDC)

	hBmp, _, _ := procCreateCompatibleBitmap.Call(hdc, uintptr(w), uintptr(h))
	if hBmp == 0 {
		return "", 0, 0, fmt.Errorf("CreateCompatibleBitmap failed")
	}
	defer procDeleteObject.Call(hBmp)

	procSelectObject.Call(memDC, hBmp)
	ret, _, _ := procBitBlt.Call(memDC, 0, 0, uintptr(w), uintptr(h), hdc, 0, 0, SRCCOPY)
	if ret == 0 {
		return "", 0, 0, fmt.Errorf("BitBlt failed")
	}

	// Scale down to max 1280×720 for bandwidth
	maxW, maxH := 1280, 720
	scale := 1.0
	if float64(w)/float64(h) > float64(maxW)/float64(maxH) {
		scale = float64(maxW) / float64(w)
	} else {
		scale = float64(maxH) / float64(h)
	}
	if scale > 1.0 {
		scale = 1.0
	}
	nw := int(float64(w) * scale)
	nh := int(float64(h) * scale)

	bih := BITMAPINFOHEADER{
		BiSize:     uint32(unsafe.Sizeof(BITMAPINFOHEADER{})),
		BiWidth:    int32(w),
		BiHeight:   -int32(h),
		BiPlanes:   1,
		BiBitCount: 32,
	}
	bi := BITMAPINFO{BmiHeader: bih}

	pixelData := make([]byte, w*h*4)
	ret, _, _ = procGetDIBits.Call(
		hdc, hBmp, 0, uintptr(h),
		uintptr(unsafe.Pointer(&pixelData[0])),
		uintptr(unsafe.Pointer(&bi)),
		DIB_RGB_COLORS,
	)
	if ret == 0 {
		return "", 0, 0, fmt.Errorf("GetDIBits failed")
	}

	// BGRA → RGBA
	src := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			i := (y*w + x) * 4
			src.Pix[(y*w+x)*4+0] = pixelData[i+2]
			src.Pix[(y*w+x)*4+1] = pixelData[i+1]
			src.Pix[(y*w+x)*4+2] = pixelData[i+0]
			src.Pix[(y*w+x)*4+3] = 255
		}
	}

	// Nearest-neighbour scale
	scaled := image.NewRGBA(image.Rect(0, 0, nw, nh))
	for y := 0; y < nh; y++ {
		for x := 0; x < nw; x++ {
			sx := x * w / nw
			sy := y * h / nh
			si := src.PixOffset(sx, sy)
			di := scaled.PixOffset(x, y)
			copy(scaled.Pix[di:di+4], src.Pix[si:si+4])
		}
	}

	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, scaled, &jpeg.Options{Quality: 70}); err != nil {
		return "", 0, 0, err
	}

	return base64.StdEncoding.EncodeToString(buf.Bytes()), w, h, nil
}

// ── Input control ─────────────────────────────────────────────────────────────

func blockUserInput(block bool) {
	b := uintptr(0)
	if block {
		b = 1
	}
	procBlockInput.Call(b)
}

func moveMouse(x, y int) {
	procSetCursorPos.Call(uintptr(x), uintptr(y))
}

func mouseButton(x, y, btn int, down bool) {
	procSetCursorPos.Call(uintptr(x), uintptr(y))
	if btn == 1 { // right
		if down {
			procMouseEvent.Call(0x0008, 0, 0, 0, 0)
		} else {
			procMouseEvent.Call(0x0010, 0, 0, 0, 0)
		}
	} else { // left
		if down {
			procMouseEvent.Call(0x0002, 0, 0, 0, 0)
		} else {
			procMouseEvent.Call(0x0004, 0, 0, 0, 0)
		}
	}
}

func clickMouse(x, y int, right bool) {
	procSetCursorPos.Call(uintptr(x), uintptr(y))
	if right {
		procMouseEvent.Call(0x0008, 0, 0, 0, 0)
		procMouseEvent.Call(0x0010, 0, 0, 0, 0)
	} else {
		procMouseEvent.Call(0x0002, 0, 0, 0, 0)
		procMouseEvent.Call(0x0004, 0, 0, 0, 0)
	}
}

func dblClickMouse(x, y int) {
	procSetCursorPos.Call(uintptr(x), uintptr(y))
	procMouseEvent.Call(0x0002, 0, 0, 0, 0)
	procMouseEvent.Call(0x0004, 0, 0, 0, 0)
	procMouseEvent.Call(0x0002, 0, 0, 0, 0)
	procMouseEvent.Call(0x0004, 0, 0, 0, 0)
}

func scrollMouse(dy int) {
	delta := int32(dy * 120)
	procMouseEvent.Call(0x0800, 0, 0, uintptr(uint32(delta)), 0)
}

// ── Keyboard ──────────────────────────────────────────────────────────────────

var keyMap = map[string]byte{
	"Enter": 13, "Tab": 9, "Escape": 27, "Backspace": 8,
	"Delete": 46, "Insert": 45,
	"Space": 32,
	"Control": 17, "Alt": 18, "Shift": 16, "Meta": 91,
	"ArrowLeft": 37, "ArrowUp": 38, "ArrowRight": 39, "ArrowDown": 40,
	"Home": 36, "End": 35, "PageUp": 33, "PageDown": 34,
	"F1": 112, "F2": 113, "F3": 114, "F4": 115,
	"F5": 116, "F6": 117, "F7": 118, "F8": 119,
	"F9": 120, "F10": 121, "F11": 122, "F12": 123,
	"CapsLock": 20, "NumLock": 144, "ScrollLock": 145,
	"PrintScreen": 44, "Pause": 19, "ContextMenu": 93,
}

func sendKey(key string) {
	if vk, ok := keyMap[key]; ok {
		procKeybdEvent.Call(uintptr(vk), 0, 0, 0)
		procKeybdEvent.Call(uintptr(vk), 0, KEYEVENTF_UP, 0)
		return
	}
	if len(key) >= 1 {
		r, _, _ := procVkKeyScan.Call(uintptr(rune(key[0])))
		vk := byte(r & 0xFF)
		if vk == 0xFF {
			return
		}
		needShift := (r>>8)&1 != 0
		if needShift {
			procKeybdEvent.Call(16, 0, 0, 0)
		}
		procKeybdEvent.Call(uintptr(vk), 0, 0, 0)
		procKeybdEvent.Call(uintptr(vk), 0, KEYEVENTF_UP, 0)
		if needShift {
			procKeybdEvent.Call(16, 0, KEYEVENTF_UP, 0)
		}
	}
}

func sendKeyWithMods(key string, ctrl, shift, alt bool) {
	if ctrl {
		procKeybdEvent.Call(17, 0, 0, 0)
	}
	if alt {
		procKeybdEvent.Call(18, 0, 0, 0)
	}

	if vk, ok := keyMap[key]; ok {
		if shift {
			procKeybdEvent.Call(16, 0, 0, 0)
		}
		procKeybdEvent.Call(uintptr(vk), 0, 0, 0)
		procKeybdEvent.Call(uintptr(vk), 0, KEYEVENTF_UP, 0)
		if shift {
			procKeybdEvent.Call(16, 0, KEYEVENTF_UP, 0)
		}
	} else if len(key) >= 1 {
		r, _, _ := procVkKeyScan.Call(uintptr(rune(key[0])))
		vk := byte(r & 0xFF)
		if vk != 0xFF {
			needShift := (r>>8)&1 != 0
			if needShift {
				procKeybdEvent.Call(16, 0, 0, 0)
			}
			procKeybdEvent.Call(uintptr(vk), 0, 0, 0)
			procKeybdEvent.Call(uintptr(vk), 0, KEYEVENTF_UP, 0)
			if needShift {
				procKeybdEvent.Call(16, 0, KEYEVENTF_UP, 0)
			}
		}
	}

	if alt {
		procKeybdEvent.Call(18, 0, KEYEVENTF_UP, 0)
	}
	if ctrl {
		procKeybdEvent.Call(17, 0, KEYEVENTF_UP, 0)
	}
}

func handleInput(msg map[string]interface{}) {
	event, _ := msg["event"].(string)
	switch event {
	case "move":
		moveMouse(toInt(msg["x"]), toInt(msg["y"]))
	case "mousedown":
		mouseButton(toInt(msg["x"]), toInt(msg["y"]), toInt(msg["button"]), true)
	case "mouseup":
		mouseButton(toInt(msg["x"]), toInt(msg["y"]), toInt(msg["button"]), false)
	case "click":
		clickMouse(toInt(msg["x"]), toInt(msg["y"]), toInt(msg["button"]) == 1)
	case "dblclick":
		dblClickMouse(toInt(msg["x"]), toInt(msg["y"]))
	case "scroll":
		scrollMouse(toInt(msg["dy"]))
	case "key":
		k, _ := msg["key"].(string)
		ctrl, _ := msg["ctrl"].(bool)
		shift, _ := msg["shift"].(bool)
		alt, _ := msg["alt"].(bool)
		sendKeyWithMods(k, ctrl, shift, alt)
	}
}

func toInt(v interface{}) int {
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	}
	return 0
}
