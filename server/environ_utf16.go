package main

import (
	"strings"
	"unicode/utf16"
)

// Windows keeps a process's environment as a UTF-16LE block of
// "NAME=VALUE\x00" entries terminated by an empty entry (the double NUL).
// Splitting and decoding it is pure logic, so it lives outside the
// windows-tagged file and its tests run on every platform — the syscall
// plumbing that fetches the block is the only part that cannot.

// environBlockEnd returns the length, in UTF-16 code units, of the
// environment block at the start of units: everything up to the empty entry
// that terminates it. When no terminator is present (the read was capped or
// truncated), it returns the whole slice, so a partial block still yields
// whatever complete entries it contains.
func environBlockEnd(units []uint16) int {
	for i := 0; i+1 < len(units); i++ {
		if units[i] == 0 && units[i+1] == 0 {
			return i
		}
	}
	if len(units) > 0 && units[len(units)-1] == 0 {
		return len(units) - 1
	}
	return len(units)
}

// identityFromUTF16Environ pulls the kandev ids out of a UTF-16 environment
// block, mirroring identityFromEnviron's contract: KANDEV_TASK_ID alone is
// enough, an empty value is not an id, and the first occurrence wins.
func identityFromUTF16Environ(units []uint16) (taskID, sessionID string, ok bool) {
	block := units[:environBlockEnd(units)]
	start := 0
	for i := 0; i <= len(block); i++ {
		if i != len(block) && block[i] != 0 {
			continue
		}
		if entry := string(utf16.Decode(block[start:i])); entry != "" {
			name, value, found := strings.Cut(entry, "=")
			switch {
			case !found:
			case name == envTaskID && taskID == "":
				taskID = value
			case name == envSessionID && sessionID == "":
				sessionID = value
			}
		}
		start = i + 1
	}
	if taskID == "" {
		return "", "", false
	}
	return taskID, sessionID, true
}

// utf16FromBytes decodes the little-endian bytes ReadProcessMemory returns
// into UTF-16 code units. A trailing odd byte (a page boundary splitting a
// code unit) is dropped rather than panicking.
func utf16FromBytes(raw []byte) []uint16 {
	units := make([]uint16, len(raw)/2)
	for i := range units {
		units[i] = uint16(raw[i*2]) | uint16(raw[i*2+1])<<8
	}
	return units
}
