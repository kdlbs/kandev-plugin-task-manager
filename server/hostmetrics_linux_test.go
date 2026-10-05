//go:build linux

package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestParseLinuxCPUTimes(t *testing.T) {
	reading, err := parseLinuxCPUTimes([]byte("cpu  10 2 8 70 5 1 2 0 4 1\ncpu0 1 0 1 8\n"))
	if err != nil {
		t.Fatalf("parseLinuxCPUTimes: %v", err)
	}
	if reading.Total != 98 || reading.Idle != 75 {
		t.Fatalf("CPU counters = %+v, want total 98 idle 75", reading)
	}
}

func writeHostFixture(t *testing.T, path, value string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(value), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestCgroupMemoryResolvesProcessAndAncestorLimits(t *testing.T) {
	root := t.TempDir()
	reader := &linuxHostMetricsReader{procRoot: filepath.Join(root, "proc"), cgroupRoot: filepath.Join(root, "cgroup")}
	writeHostFixture(t, filepath.Join(reader.procRoot, "self/cgroup"), "0::/service/worker\n")
	for path, value := range map[string]string{
		"memory.current": "8000", "memory.max": "max",
		"service/memory.current": "3000", "service/memory.max": "4000",
		"service/worker/memory.current": "1500", "service/worker/memory.max": "2000",
	} {
		writeHostFixture(t, filepath.Join(reader.cgroupRoot, path), value)
	}
	got, ok := reader.readCgroupMemory(10000)
	if !ok || got.UsedBytes != 1500 || got.TotalBytes != 2000 {
		t.Fatalf("nested memory = %+v, %v", got, ok)
	}
	writeHostFixture(t, filepath.Join(reader.cgroupRoot, "service/worker/memory.max"), "max")
	got, ok = reader.readCgroupMemory(10000)
	if !ok || got.UsedBytes != 3000 || got.TotalBytes != 4000 {
		t.Fatalf("ancestor memory = %+v, %v", got, ok)
	}
}

func TestTemperatureRequiresCPUSensor(t *testing.T) {
	reader := &linuxHostMetricsReader{sysRoot: t.TempDir()}
	zone := filepath.Join(reader.sysRoot, "class/thermal/thermal_zone0")
	writeHostFixture(t, filepath.Join(zone, "type"), "battery")
	writeHostFixture(t, filepath.Join(zone, "temp"), "42000")
	if _, err := reader.readTemperature(); err == nil {
		t.Fatal("battery reported as CPU temperature")
	}
	writeHostFixture(t, filepath.Join(zone, "type"), "x86_pkg_temp")
	if value, err := reader.readTemperature(); err != nil || value != 42 {
		t.Fatalf("CPU temperature = %v, %v", value, err)
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
