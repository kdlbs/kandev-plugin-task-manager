package main

import (
	"os/exec"
	"strings"

	"golang.org/x/sys/unix"
)

// darwinScanner reads the process table with `ps` and each process's
// environment with sysctl(KERN_PROCARGS2). The parsing lives in
// procscan_ps.go; this file is only the two system calls.
//
// Two constraints shape the choice. First, the plugin binary is
// cross-compiled for macOS from whatever machine builds the release, so cgo
// is off and libproc (proc_pidinfo) is unavailable — `ps` is the portable way
// to get cumulative CPU time, and its TIME column carries centisecond
// resolution, which is ample for a sub-second sampling window. Second, macOS
// restricts reading another process's environment to the same uid (or root);
// kandev's agents run as the backend's own user, so the plugin qualifies.
type darwinScanner struct{}

func newScanner() procScanner { return &darwinScanner{} }

func (s *darwinScanner) platform() string { return "darwin" }

// totalMemoryBytes reads hw.memsize, the installed physical memory.
func (s *darwinScanner) totalMemoryBytes() uint64 {
	total, err := unix.SysctlUint64("hw.memsize")
	if err != nil {
		return 0
	}
	return total
}

func (s *darwinScanner) scan() ([]procSample, error) {
	// -ww defeats the default width truncation of the command column.
	out, err := exec.Command("ps", "-axww", "-o", psFormat).Output()
	if err != nil {
		return nil, err
	}
	var samples []procSample
	for _, line := range strings.Split(string(out), "\n") {
		if sample, ok := parsePSLine(line); ok {
			samples = append(samples, sample)
		}
	}
	return samples, nil
}

func (s *darwinScanner) identity(pid int) (string, string, bool) {
	raw, err := unix.SysctlRaw("kern.procargs2", pid)
	if err != nil {
		return "", "", false
	}
	environ, ok := environBlockFromProcargs2(raw)
	if !ok {
		return "", "", false
	}
	return identityFromEnviron(environ)
}

// memoryBytes has no better answer than RSS on macOS: there is no
// smaps_rollup equivalent reachable without cgo, and `ps` reports only RSS.
func (s *darwinScanner) memoryBytes(_ int, rss uint64) (uint64, string) {
	return rss, basisRSS
}
