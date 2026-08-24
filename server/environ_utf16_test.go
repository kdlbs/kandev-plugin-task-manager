package main

import (
	"testing"
	"unicode/utf16"
)

// utf16Block builds a Windows-shaped environment block: UTF-16 entries, each
// NUL-terminated, the whole thing closed by an empty entry.
func utf16Block(entries ...string) []uint16 {
	var units []uint16
	for _, entry := range entries {
		units = append(units, utf16.Encode([]rune(entry))...)
		units = append(units, 0)
	}
	return append(units, 0)
}

func TestIdentityFromUTF16Environ(t *testing.T) {
	tests := []struct {
		name              string
		units             []uint16
		wantTask, wantSes string
		wantOK            bool
	}{
		{
			name:     "task and session",
			units:    utf16Block(`Path=C:\Windows`, "KANDEV_TASK_ID=t1", "KANDEV_SESSION_ID=s1"),
			wantTask: "t1", wantSes: "s1", wantOK: true,
		},
		{
			name:     "task only",
			units:    utf16Block("KANDEV_TASK_ID=t1"),
			wantTask: "t1", wantOK: true,
		},
		{
			name:  "session only",
			units: utf16Block("KANDEV_SESSION_ID=s1"),
		},
		{
			name:  "no kandev variables",
			units: utf16Block(`Path=C:\Windows`, `TEMP=C:\Temp`),
		},
		{
			name:  "similar variable name",
			units: utf16Block("KANDEV_TASK_IDENTIFIER=t1", "MY_KANDEV_TASK_ID=t2"),
		},
		{
			name:  "empty task id value",
			units: utf16Block("KANDEV_TASK_ID="),
		},
		{
			name:  "empty block",
			units: []uint16{0, 0},
		},
		{
			name:  "nil",
			units: nil,
		},
		{
			// First occurrence wins, matching the POSIX path. A well-formed
			// block holds each name once, so a duplicate means the read
			// overran into something it should not have — and silently
			// preferring the later value would hide exactly that.
			name:     "duplicate task id",
			units:    utf16Block("KANDEV_TASK_ID=first", "KANDEV_TASK_ID=second"),
			wantTask: "first", wantOK: true,
		},
		{
			name:     "duplicate session id",
			units:    utf16Block("KANDEV_TASK_ID=t1", "KANDEV_SESSION_ID=first", "KANDEV_SESSION_ID=second"),
			wantTask: "t1", wantSes: "first", wantOK: true,
		},
		{
			// Windows environments routinely hold non-ASCII paths; decoding
			// must not corrupt the entries around them.
			name:     "non-ascii neighbours",
			units:    utf16Block(`USERPROFILE=C:\Users\Jörg`, "KANDEV_TASK_ID=t1", "GREET=日本語"),
			wantTask: "t1", wantOK: true,
		},
		{
			// Windows puts drive-letter entries like "=C:=C:\path" at the
			// front of the block. They start with '=', so a naive split on
			// the first '=' yields an empty name — which must not be
			// mistaken for anything, nor stop the scan before the real
			// variables further in.
			name:     "leading drive-letter entries",
			units:    utf16Block(`=C:=C:\Users\jcfs`, "=ExitCode=00000000", "KANDEV_TASK_ID=t1"),
			wantTask: "t1", wantOK: true,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			task, session, ok := identityFromUTF16Environ(tc.units)
			if ok != tc.wantOK {
				t.Fatalf("ok = %v, want %v", ok, tc.wantOK)
			}
			if task != tc.wantTask || session != tc.wantSes {
				t.Errorf("got (%q, %q), want (%q, %q)", task, session, tc.wantTask, tc.wantSes)
			}
		})
	}
}

func TestEnvironBlockEnd(t *testing.T) {
	// A complete block ends at the empty entry; anything after it (the block
	// is read a page at a time, so trailing bytes are whatever else lived on
	// that page) must not be parsed as environment.
	block := utf16Block("A=1", "B=2")
	// utf16Block ends with the last entry's own NUL followed by the empty
	// entry's NUL, so the double-NUL starts two units from the end.
	padded := append(block, utf16.Encode([]rune("GARBAGE=x"))...)
	if got, want := environBlockEnd(padded), len(block)-2; got != want {
		t.Errorf("end = %d, want %d (the terminator position)", got, want)
	}

	task, _, ok := identityFromUTF16Environ(
		append(utf16Block("KANDEV_TASK_ID=t1"), utf16.Encode([]rune("KANDEV_TASK_ID=leaked"))...))
	if !ok || task != "t1" {
		t.Errorf("task = %q (ok=%v), want t1 — content past the terminator was parsed", task, ok)
	}
}

func TestEnvironBlockEndWithoutTerminator(t *testing.T) {
	// A capped or truncated read has no terminator. The entries that did
	// arrive are still worth parsing — the variables we want sit near the
	// front of a block far more often than not.
	var units []uint16
	units = append(units, utf16.Encode([]rune("KANDEV_TASK_ID=t1"))...)
	units = append(units, 0)
	units = append(units, utf16.Encode([]rune("PARTIAL=tru"))...)

	task, _, ok := identityFromUTF16Environ(units)
	if !ok || task != "t1" {
		t.Errorf("task = %q (ok=%v), want t1 from the complete leading entry", task, ok)
	}
}

func TestUTF16FromBytesRoundTrip(t *testing.T) {
	// ReadProcessMemory hands back raw bytes; the little-endian decode is the
	// one place a byte-order slip would turn every variable name into
	// mojibake and silently attribute nothing.
	units := utf16Block("KANDEV_TASK_ID=t1")
	raw := make([]byte, len(units)*2)
	for i, u := range units {
		raw[i*2] = byte(u)
		raw[i*2+1] = byte(u >> 8)
	}

	task, _, ok := identityFromUTF16Environ(utf16FromBytes(raw))
	if !ok || task != "t1" {
		t.Errorf("task = %q (ok=%v), want t1", task, ok)
	}

	// An odd trailing byte (a page boundary splitting a code unit) must not
	// panic; the truncated unit is simply dropped.
	if got := utf16FromBytes(raw[:len(raw)-1]); len(got) != len(units)-1 {
		t.Errorf("odd-length decode produced %d units, want %d", len(got), len(units)-1)
	}
}
