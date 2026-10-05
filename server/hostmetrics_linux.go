//go:build linux

package main

import (
	"bufio"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type linuxHostMetricsReader struct {
	procRoot   string
	sysRoot    string
	cgroupRoot string
}

func newHostMetricsReader() hostMetricsReader {
	return &linuxHostMetricsReader{
		procRoot:   "/proc",
		sysRoot:    "/sys",
		cgroupRoot: "/sys/fs/cgroup",
	}
}

func (r *linuxHostMetricsReader) readCPUTimes() (hostCPUTimes, error) {
	data, err := os.ReadFile(filepath.Join(r.procRoot, "stat"))
	if err != nil {
		return hostCPUTimes{}, err
	}
	return parseLinuxCPUTimes(data)
}

func parseLinuxCPUTimes(data []byte) (hostCPUTimes, error) {
	line := strings.SplitN(string(data), "\n", 2)[0]
	fields := strings.Fields(line)
	if len(fields) < 5 || fields[0] != "cpu" {
		return hostCPUTimes{}, errors.New("invalid /proc/stat cpu line")
	}
	var total, idle uint64
	for index, field := range fields[1:] {
		// guest and guest_nice are already included in user and nice.
		if index >= 8 {
			break
		}
		value, err := strconv.ParseUint(field, 10, 64)
		if err != nil {
			return hostCPUTimes{}, err
		}
		total += value
		if index == 3 || index == 4 {
			idle += value
		}
	}
	return hostCPUTimes{Total: total, Idle: idle}, nil
}

func (r *linuxHostMetricsReader) readMemory() (hostMemoryReading, error) {
	data, err := os.ReadFile(filepath.Join(r.procRoot, "meminfo"))
	if err != nil {
		return hostMemoryReading{}, err
	}
	total, available, err := parseLinuxMemory(data)
	if err != nil {
		return hostMemoryReading{}, err
	}
	if cgroup, ok := r.readCgroupMemory(total); ok {
		return cgroup, nil
	}
	return hostMemoryReading{UsedBytes: total - available, TotalBytes: total}, nil
}

func parseLinuxMemory(data []byte) (total, available uint64, err error) {
	values := map[string]uint64{}
	scanner := bufio.NewScanner(strings.NewReader(string(data)))
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 2 {
			continue
		}
		value, parseErr := strconv.ParseUint(fields[1], 10, 64)
		if parseErr != nil {
			continue
		}
		if len(fields) > 2 && strings.EqualFold(fields[2], "kb") {
			value *= 1024
		}
		values[strings.TrimSuffix(fields[0], ":")] = value
	}
	if scanErr := scanner.Err(); scanErr != nil {
		return 0, 0, scanErr
	}
	total = values["MemTotal"]
	if total == 0 {
		return 0, 0, errors.New("MemTotal missing")
	}
	available, ok := values["MemAvailable"]
	if !ok {
		available = values["MemFree"]
	}
	if available > total {
		available = total
	}
	return total, available, nil
}

func (r *linuxHostMetricsReader) readCgroupMemory(hostTotal uint64) (hostMemoryReading, bool) {
	root := filepath.Clean(r.cgroupRoot)
	dir := root
	if data, err := os.ReadFile(filepath.Join(r.procRoot, "self/cgroup")); err == nil {
		for _, line := range strings.Split(string(data), "\n") {
			if path, ok := strings.CutPrefix(line, "0::"); ok {
				dir = filepath.Join(root, strings.TrimPrefix(filepath.Clean("/"+path), "/"))
				break
			}
		}
	}
	var selected hostMemoryReading
	for {
		if reading, ok := readCgroupMemoryAt(dir, hostTotal); ok && (selected.TotalBytes == 0 || reading.TotalBytes < selected.TotalBytes) {
			selected = reading
		}
		if dir == root {
			break
		}
		dir = filepath.Dir(dir)
	}
	return selected, selected.TotalBytes > 0
}

func readCgroupMemoryAt(dir string, hostTotal uint64) (hostMemoryReading, bool) {
	currentRaw, err := os.ReadFile(filepath.Join(dir, "memory.current"))
	if err != nil {
		return hostMemoryReading{}, false
	}
	limitRaw, err := os.ReadFile(filepath.Join(dir, "memory.max"))
	if err != nil {
		return hostMemoryReading{}, false
	}
	limitText := strings.TrimSpace(string(limitRaw))
	if limitText == "max" {
		return hostMemoryReading{}, false
	}
	limit, err := strconv.ParseUint(limitText, 10, 64)
	if err != nil || limit == 0 || limit >= hostTotal {
		return hostMemoryReading{}, false
	}
	current, err := strconv.ParseUint(strings.TrimSpace(string(currentRaw)), 10, 64)
	if err != nil {
		return hostMemoryReading{}, false
	}
	if current > limit {
		current = limit
	}
	return hostMemoryReading{UsedBytes: current, TotalBytes: limit}, true
}

func (r *linuxHostMetricsReader) readDisk(ctx context.Context, path string) (hostDiskReading, error) {
	return readUnixDiskCapacity(ctx, path)
}

func (r *linuxHostMetricsReader) readTemperature() (float64, error) {
	paths, err := filepath.Glob(filepath.Join(r.sysRoot, "class/thermal/thermal_zone*/temp"))
	if err != nil || len(paths) == 0 {
		return 0, errors.New("CPU temperature unavailable")
	}
	for _, path := range paths {
		kind, kindErr := os.ReadFile(filepath.Join(filepath.Dir(path), "type"))
		name := strings.ToLower(strings.TrimSpace(string(kind)))
		if kindErr != nil || (!strings.Contains(name, "cpu") && !strings.Contains(name, "pkg") && name != "coretemp") {
			continue
		}
		data, readErr := os.ReadFile(path)
		if readErr != nil {
			continue
		}
		value, parseErr := strconv.ParseFloat(strings.TrimSpace(string(data)), 64)
		if parseErr != nil {
			continue
		}
		if value > 1000 {
			value /= 1000
		}
		return value, nil
	}
	return 0, errors.New("CPU temperature unavailable")
}

func (r *linuxHostMetricsReader) readLoad() (float64, error) {
	data, err := os.ReadFile(filepath.Join(r.procRoot, "loadavg"))
	if err != nil {
		return 0, err
	}
	fields := strings.Fields(string(data))
	if len(fields) == 0 {
		return 0, errors.New("load average unavailable")
	}
	value, err := strconv.ParseFloat(fields[0], 64)
	if err != nil {
		return 0, err
	}
	return value, nil
}
