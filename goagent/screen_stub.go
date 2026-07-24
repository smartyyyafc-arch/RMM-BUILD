//go:build !windows

package main

import (
	"bufio"
	"fmt"
)

func captureScreen() (string, int, int, error) {
	return "", 0, 0, fmt.Errorf("screen capture only supported on Windows")
}

func isInSession0() bool { return false }

func spawnScreenHelper(exePath string) (*bufio.Scanner, func(), error) {
	return nil, nil, fmt.Errorf("not supported on this platform")
}

func blockUserInput(block bool)              {}
func handleInput(msg map[string]interface{}) {}
func moveMouse(x, y int)                    {}
func clickMouse(x, y int, right bool)       {}
func scrollMouse(dy int)                    {}
func sendKey(key string)                    {}
