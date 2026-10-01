//go:build darwin

package main

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

type darwinHostMetricsReader struct{}

func newHostMetricsReader() hostMetricsReader { return &darwinHostMetricsReader{} }

func (darwinHostMetricsReader) readCPUTimes() (hostCPUTimes, error) {
	raw, err := unix.SysctlRaw("kern.cp_time")
	if err != nil {
		return hostCPUTimes{}, fmt.Errorf("sysctl kern.cp_time: %w", err)
	}
	return parseDarwinCPUTimes(raw)
}

func parseDarwinCPUTimes(raw []byte) (hostCPUTimes, error) {
	if len(raw) >= 32 {
		var total, idle uint64
		for index := 0; index < 4; index++ {
			value := binary.LittleEndian.Uint64(raw[index*8 : index*8+8])
			total += value
			if index == 3 {
				idle = value
			}
		}
		return hostCPUTimes{Total: total, Idle: idle}, nil
	}
	if len(raw) >= 16 {
		var total, idle uint64
		for index := 0; index < 4; index++ {
			value := uint64(binary.LittleEndian.Uint32(raw[index*4 : index*4+4]))
			total += value
			if index == 3 {
				idle = value
			}
		}
		return hostCPUTimes{Total: total, Idle: idle}, nil
	}
	return hostCPUTimes{}, errors.New("kern.cp_time response is too short")
}

func (darwinHostMetricsReader) readMemory() (hostMemoryReading, error) {
	total, err := unix.SysctlUint64("hw.memsize")
	if err != nil {
		return hostMemoryReading{}, fmt.Errorf("sysctl hw.memsize: %w", err)
	}
	free, inactive, speculative, pageSize, err := readDarwinVMCounts()
	if err != nil {
		return hostMemoryReading{}, err
	}
	available := (free + inactive + speculative) * pageSize
	if available > total {
		available = total
	}
	return hostMemoryReading{UsedBytes: total - available, TotalBytes: total}, nil
}

func readDarwinVMCounts() (free, inactive, speculative, pageSize uint64, err error) {
	pageSize = uint64(os.Getpagesize())
	if pageSize == 0 {
		return 0, 0, 0, 0, errors.New("darwin page size is zero")
	}
	free, freeErr := darwinVMCount("vm.stats.vm.pages_free")
	inactive, inactiveErr := darwinVMCount("vm.stats.vm.pages_inactive")
	speculative, speculativeErr := darwinVMCount("vm.stats.vm.pages_speculative")
	if freeErr == nil && inactiveErr == nil && speculativeErr == nil {
		return free, inactive, speculative, pageSize, nil
	}
	data, commandErr := exec.Command("vm_stat").Output()
	if commandErr != nil {
		return 0, 0, 0, 0, fmt.Errorf("read vm_stat: %w", commandErr)
	}
	return parseDarwinVMStat(data, pageSize)
}

func darwinVMCount(name string) (uint64, error) {
	return unix.SysctlUint64(name)
}

func parseDarwinVMStat(data []byte, defaultPageSize uint64) (free, inactive, speculative, pageSize uint64, err error) {
	pageSize = defaultPageSize
	values := map[string]uint64{}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.Contains(line, "page size of") {
			pageSize = parseVMStatPageSize(line, pageSize)
			continue
		}
		label, value, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		value = strings.TrimSuffix(strings.TrimSpace(value), ".")
		parsed, parseErr := strconv.ParseUint(value, 10, 64)
		if parseErr == nil {
			values[strings.ToLower(strings.TrimSpace(label))] = parsed
		}
	}
	if pageSize == 0 {
		return 0, 0, 0, 0, errors.New("vm_stat page size is zero")
	}
	free, freeOK := values["pages free"]
	inactive, inactiveOK := values["pages inactive"]
	speculative, speculativeOK := values["pages speculative"]
	if !freeOK || !inactiveOK || !speculativeOK {
		return 0, 0, 0, 0, errors.New("vm_stat memory counters are incomplete")
	}
	return free, inactive, speculative, pageSize, nil
}

func parseVMStatPageSize(line string, fallback uint64) uint64 {
	fields := strings.Fields(line)
	for index, field := range fields {
		if field != "of" || index+1 >= len(fields) {
			continue
		}
		value, err := strconv.ParseUint(fields[index+1], 10, 64)
		if err == nil && value > 0 {
			return value
		}
	}
	return fallback
}

func (darwinHostMetricsReader) readDisk(ctx context.Context, path string) (hostDiskReading, error) {
	return readUnixDiskCapacity(ctx, path)
}

func (darwinHostMetricsReader) readTemperature() (float64, error) {
	return 0, errors.New("CPU temperature unavailable on darwin")
}

func (darwinHostMetricsReader) readLoad() (float64, error) {
	raw, err := unix.SysctlRaw("vm.loadavg")
	if err != nil {
		return 0, fmt.Errorf("sysctl vm.loadavg: %w", err)
	}
	if len(raw) < 24 {
		return 0, errors.New("vm.loadavg response is too short")
	}
	fscale := binary.LittleEndian.Uint64(raw[16:24])
	if fscale == 0 {
		return 0, errors.New("vm.loadavg scale is zero")
	}
	return float64(binary.LittleEndian.Uint32(raw[:4])) / float64(fscale), nil
}
