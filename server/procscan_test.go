package main

import (
	"bytes"
	"encoding/binary"
	"strings"
	"testing"
)

func environ(pairs ...string) []byte {
	return []byte(strings.Join(pairs, "\x00") + "\x00")
}

func TestIdentityFromEnviron(t *testing.T) {
	tests := []struct {
		name              string
		raw               []byte
		wantTask, wantSes string
		wantOK            bool
	}{
		{
			name:     "task and session",
			raw:      environ("PATH=/usr/bin", "KANDEV_TASK_ID=t1", "KANDEV_SESSION_ID=s1", "HOME=/root"),
			wantTask: "t1", wantSes: "s1", wantOK: true,
		},
		{
			// A task with no readable session id is still that task's cost.
			name:     "task only",
			raw:      environ("KANDEV_TASK_ID=t1"),
			wantTask: "t1", wantOK: true,
		},
		{
			// A session id alone identifies nothing groupable.
			name: "session only",
			raw:  environ("KANDEV_SESSION_ID=s1"),
		},
		{
			name: "no kandev variables",
			raw:  environ("PATH=/usr/bin", "HOME=/root"),
		},
		{
			// Prefix collisions must not match: KANDEV_TASK_ID_SOMETHING is a
			// different variable, and matching it would attribute a process to
			// a task id that does not exist.
			name: "similar variable name",
			raw:  environ("KANDEV_TASK_IDENTIFIER=t1", "MY_KANDEV_TASK_ID=t2"),
		},
		{
			name: "empty",
			raw:  nil,
		},
		{
			// An empty value is not an id; grouping by "" would merge every
			// such process into one phantom task.
			name: "empty task id value",
			raw:  environ("KANDEV_TASK_ID="),
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			task, session, ok := identityFromEnviron(tc.raw)
			if ok != tc.wantOK {
				t.Fatalf("ok = %v, want %v", ok, tc.wantOK)
			}
			if task != tc.wantTask || session != tc.wantSes {
				t.Errorf("got (%q, %q), want (%q, %q)", task, session, tc.wantTask, tc.wantSes)
			}
		})
	}
}

func TestParsePSLine(t *testing.T) {
	// macOS `ps -axww -o pid=,ppid=,rss=,time=,lstart=,command=`.
	const line = "  1234   200  245760   1:23.45 Wed Aug 20 12:00:00 2026 /usr/local/bin/node --max-old-space-size=8192 server.js"
	sample, ok := parsePSLine(line)
	if !ok {
		t.Fatal("parse failed")
	}
	if sample.PID != 1234 || sample.PPID != 200 {
		t.Errorf("pid/ppid = %d/%d, want 1234/200", sample.PID, sample.PPID)
	}
	if sample.Name != "node" {
		t.Errorf("name = %q, want the basename", sample.Name)
	}
	// The command column contains spaces; everything after the fixed lstart
	// token count belongs to it.
	if !strings.Contains(sample.Command, "server.js") {
		t.Errorf("command = %q, want the full argv", sample.Command)
	}
	if sample.RSSBytes != 245760*1024 {
		t.Errorf("rss = %d, want ps KiB converted to bytes", sample.RSSBytes)
	}
	// The start key must come from lstart, not from the elapsed time: it has
	// to stay identical between samples or every process would look new.
	if sample.StartKey != "1234:Wed Aug 20 12:00:00 2026" {
		t.Errorf("start key = %q", sample.StartKey)
	}
	if sample.CPUSeconds != 83.45 {
		t.Errorf("cpu = %v, want 83.45", sample.CPUSeconds)
	}

	if _, ok := parsePSLine(""); ok {
		t.Error("want a blank line rejected")
	}
	if _, ok := parsePSLine("  1234   200  245760   1:23.45 Wed Aug"); ok {
		t.Error("want a short line rejected")
	}
}

func TestParsePSTime(t *testing.T) {
	tests := map[string]float64{
		"0:03.42":    3.42,
		"1:23.45":    83.45,
		"59:59.99":   3599.99,
		"1:00:00.00": 3600,
		"2-03:04:05": 2*86400 + 3*3600 + 4*60 + 5,
		"garbage":    0,
	}
	for input, want := range tests {
		if got := parsePSTime(input); got != want {
			t.Errorf("parsePSTime(%q) = %v, want %v", input, got, want)
		}
	}
}

func TestEnvironBlockFromProcargs2(t *testing.T) {
	// argc | exec_path\0 | \0 padding | argv... | envp...
	build := func(argc int32, execPath string, argv []string, envp []string) []byte {
		var buf bytes.Buffer
		_ = binary.Write(&buf, binary.NativeEndian, argc)
		buf.WriteString(execPath)
		buf.WriteByte(0)
		buf.WriteString("\x00\x00\x00") // alignment padding
		for _, arg := range argv {
			buf.WriteString(arg)
			buf.WriteByte(0)
		}
		for _, env := range envp {
			buf.WriteString(env)
			buf.WriteByte(0)
		}
		return buf.Bytes()
	}

	t.Run("steps over argv to reach the environment", func(t *testing.T) {
		raw := build(3, "/bin/node", []string{"node", "--flag", "app.js"},
			[]string{"PATH=/usr/bin", "KANDEV_TASK_ID=t1", "KANDEV_SESSION_ID=s1"})
		block, ok := environBlockFromProcargs2(raw)
		if !ok {
			t.Fatal("parse failed")
		}
		task, session, ok := identityFromEnviron(block)
		if !ok || task != "t1" || session != "s1" {
			t.Errorf("got (%q, %q, %v), want (t1, s1, true)", task, session, ok)
		}
	})

	t.Run("an argv token is not mistaken for the environment", func(t *testing.T) {
		// If the argv walk stopped one string early, this argument would be
		// read as an environment entry and attribute the process to the wrong
		// task entirely.
		raw := build(2, "/bin/sh", []string{"sh", "KANDEV_TASK_ID=wrong-task"},
			[]string{"KANDEV_TASK_ID=right-task"})
		block, ok := environBlockFromProcargs2(raw)
		if !ok {
			t.Fatal("parse failed")
		}
		// Assert on the boundary itself, not only on the parsed result: an
		// off-by-one argv walk that leaves the argument in the block can
		// still yield the right task id by accident, and then the same bug
		// silently misattributes a process whose argv holds a different id.
		if strings.Contains(string(block), "wrong-task") {
			t.Errorf("environment block leaked an argv token: %q", block)
		}
		task, _, _ := identityFromEnviron(block)
		if task != "right-task" {
			t.Errorf("task = %q, want right-task", task)
		}
	})

	t.Run("truncated blob", func(t *testing.T) {
		// sysctl caps the blob size, so a process with a huge argv can arrive
		// cut off mid-string. Reporting no identity beats reporting a
		// half-parsed one.
		raw := build(5, "/bin/sh", []string{"sh", "one"}, nil)
		if _, ok := environBlockFromProcargs2(raw); ok {
			t.Error("want a truncated blob rejected")
		}
	})

	t.Run("too short for argc", func(t *testing.T) {
		if _, ok := environBlockFromProcargs2([]byte{1, 2}); ok {
			t.Error("want a runt blob rejected")
		}
	})
}

func TestTruncateCommand(t *testing.T) {
	long := strings.Repeat("x", maxCommandLen*2)
	got := truncateCommand(long)
	if len([]byte(got)) > maxCommandLen+3 {
		t.Errorf("truncated length = %d, want ~%d", len(got), maxCommandLen)
	}
	if short := truncateCommand("go test ./..."); short != "go test ./..." {
		t.Errorf("short command was altered: %q", short)
	}
}
