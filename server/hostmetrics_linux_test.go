//go:build linux

package main

import "testing"

func TestParseLinuxCPUTimes(t *testing.T) {
	reading, err := parseLinuxCPUTimes([]byte("cpu  10 2 8 70 5 1 2 0 0 0\ncpu0 1 0 1 8\n"))
	if err != nil {
		t.Fatalf("parseLinuxCPUTimes: %v", err)
	}
	if reading.Total != 98 || reading.Idle != 75 {
		t.Fatalf("CPU counters = %+v, want total 98 idle 75", reading)
	}
}

func TestParseLinuxMemoryUsesAvailableBytes(t *testing.T) {
	total, available, err := parseLinuxMemory([]byte("MemTotal:       1024 kB\nMemFree:         128 kB\nMemAvailable:    256 kB\n"))
	if err != nil {
		t.Fatalf("parseLinuxMemory: %v", err)
	}
	if total != 1024*1024 || available != 256*1024 {
		t.Fatalf("memory = %d total, %d available", total, available)
	}
}

func TestParseLinuxMemoryFallsBackToFree(t *testing.T) {
	total, available, err := parseLinuxMemory([]byte("MemTotal: 1000 kB\nMemFree: 100 kB\n"))
	if err != nil {
		t.Fatalf("parseLinuxMemory: %v", err)
	}
	if total != 1000*1024 || available != 100*1024 {
		t.Fatalf("memory = %d total, %d available", total, available)
	}
}
