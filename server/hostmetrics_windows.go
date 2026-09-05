//go:build windows

package main

import (
	"context"
	"errors"
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

type windowsHostMetricsReader struct{}

var monitorGetSystemTimes = windows.NewLazySystemDLL("kernel32.dll").NewProc("GetSystemTimes")

func newHostMetricsReader() hostMetricsReader { return &windowsHostMetricsReader{} }

func (windowsHostMetricsReader) readCPUTimes() (hostCPUTimes, error) {
	var idle, kernel, user windows.Filetime
	result, _, callErr := monitorGetSystemTimes.Call(
		uintptr(unsafe.Pointer(&idle)),
		uintptr(unsafe.Pointer(&kernel)),
		uintptr(unsafe.Pointer(&user)),
	)
	if result == 0 {
		return hostCPUTimes{}, fmt.Errorf("GetSystemTimes: %w", callErr)
	}
	return hostCPUTimes{
		Total: filetimeTicks(kernel) + filetimeTicks(user),
		Idle:  filetimeTicks(idle),
	}, nil
}

func (windowsHostMetricsReader) readMemory() (hostMemoryReading, error) {
	var status memoryStatusEx
	status.Length = uint32(unsafe.Sizeof(status))
	result, _, callErr := procGlobalMemoryStatusEx.Call(uintptr(unsafe.Pointer(&status)))
	if result == 0 {
		return hostMemoryReading{}, fmt.Errorf("GlobalMemoryStatusEx: %w", callErr)
	}
	if status.TotalPhys == 0 || status.AvailPhys > status.TotalPhys {
		return hostMemoryReading{}, errors.New("invalid physical memory counters")
	}
	return hostMemoryReading{
		UsedBytes:  status.TotalPhys - status.AvailPhys,
		TotalBytes: status.TotalPhys,
	}, nil
}

func (windowsHostMetricsReader) readDisk(ctx context.Context, path string) (hostDiskReading, error) {
	if err := ctx.Err(); err != nil {
		return hostDiskReading{}, err
	}
	pathPtr, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return hostDiskReading{}, err
	}
	var freeToCaller, total, free uint64
	if err := windows.GetDiskFreeSpaceEx(pathPtr, &freeToCaller, &total, &free); err != nil {
		return hostDiskReading{}, err
	}
	if err := ctx.Err(); err != nil {
		return hostDiskReading{}, err
	}
	return diskCapacityFromBytes(total, freeToCaller)
}

func (windowsHostMetricsReader) readTemperature() (float64, error) {
	return 0, errors.New("CPU temperature unavailable on windows")
}

func (windowsHostMetricsReader) readLoad() (float64, error) {
	return 0, errors.New("load average unavailable on windows")
}
