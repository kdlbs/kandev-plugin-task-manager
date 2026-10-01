//go:build !windows

package main

import (
	"context"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestReadUnixDiskCapacityBoundsBusySlot(t *testing.T) {
	original := monitorStatfs
	started := make(chan struct{})
	release := make(chan struct{})
	monitorStatfs = func(_ string, _ *syscall.Statfs_t) error {
		close(started)
		<-release
		return nil
	}
	defer func() {
		monitorStatfs = original
		select {
		case <-release:
		default:
			close(release)
		}
	}()

	firstDone := make(chan error, 1)
	go func() {
		_, err := readUnixDiskCapacity(context.Background(), "/")
		firstDone <- err
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("statfs stub did not start")
	}

	startedAt := time.Now()
	_, err := readUnixDiskCapacity(context.Background(), "/")
	if err == nil || !strings.Contains(err.Error(), "busy") {
		t.Fatalf("second disk read error = %v, want a bounded busy error", err)
	}
	if elapsed := time.Since(startedAt); elapsed > diskStatfsSlotWait+time.Second {
		t.Fatalf("busy disk read took %s, want it bounded near %s", elapsed, diskStatfsSlotWait)
	}

	close(release)
	select {
	case <-firstDone:
	case <-time.After(time.Second):
		t.Fatal("first statfs stub did not finish after release")
	}
}
