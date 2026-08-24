package main

import (
	"context"
	"os"
	"testing"
)

// TestLiveProbe runs the real platform scanner against the machine it is
// executed on and prints what it found. It is a diagnostic, not an assertion
// suite: what a developer's machine happens to be running is not a
// contract, so it is skipped unless explicitly asked for.
//
//	KANDEV_TM_LIVE=1 go test ./server/ -run TestLiveProbe -v
//
// Use it to confirm attribution end to end on a new platform, or when kandev
// changes how it launches agents.
func TestLiveProbe(t *testing.T) {
	if os.Getenv("KANDEV_TM_LIVE") == "" {
		t.Skip("set KANDEV_TM_LIVE=1 to sample this machine")
	}
	s := newSampler(newScanner())
	snap, err := s.sample(context.Background())
	if err != nil {
		t.Fatalf("sample: %v", err)
	}

	t.Logf("platform=%s cores=%d interval=%.3fs tasks=%d",
		snap.Platform, snap.CPUCores, snap.IntervalSeconds, len(snap.Tasks))
	for _, task := range snap.Tasks {
		t.Logf("  task %s  cpu=%.1f%%  mem=%.0fMB (%s)  procs=%d  sessions=%v",
			task.TaskID, task.CPUPercent, float64(task.MemoryBytes)/1e6,
			task.MemoryBasis, len(task.Processes), task.SessionIDs)
		for _, p := range task.Processes {
			t.Logf("      pid=%-7d %-16s cpu=%5.1f%% mem=%6.0fMB  %s",
				p.PID, p.Name, p.CPUPercent, float64(p.MemoryBytes)/1e6, p.Command)
		}
	}
}
