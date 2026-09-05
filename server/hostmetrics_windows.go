//go:build windows

package main

import (
	"context"
	"errors"
	"fmt"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

type windowsHostMetricsReader struct{}

var monitorGetSystemTimes = windows.NewLazySystemDLL("kernel32.dll").NewProc("GetSystemTimes")

const (
	windowsDiskCallTimeout = 2 * time.Second
	windowsDiskSlotWait    = 250 * time.Millisecond
)

var windowsDiskCallSlot = make(chan struct{}, 1)

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
	waitTimer := time.NewTimer(windowsDiskSlotWait)
	defer waitTimer.Stop()
	select {
	case windowsDiskCallSlot <- struct{}{}:
	case <-ctx.Done():
		return hostDiskReading{}, ctx.Err()
	case <-waitTimer.C:
		return hostDiskReading{}, errors.New("filesystem capacity lookup is busy")
	}

	type diskResult struct {
		freeToCaller uint64
		total        uint64
		free         uint64
		err          error
	}
	result := make(chan diskResult, 1)
	go func() {
		defer func() { <-windowsDiskCallSlot }()
		var freeToCaller, total, free uint64
		callErr := windows.GetDiskFreeSpaceEx(pathPtr, &freeToCaller, &total, &free)
		result <- diskResult{freeToCaller: freeToCaller, total: total, free: free, err: callErr}
	}()

	callTimer := time.NewTimer(windowsDiskCallTimeout)
	defer callTimer.Stop()
	select {
	case <-ctx.Done():
		return hostDiskReading{}, ctx.Err()
	case <-callTimer.C:
		return hostDiskReading{}, errors.New("filesystem capacity lookup timed out")
	case response := <-result:
		if response.err != nil {
			return hostDiskReading{}, response.err
		}
		return diskCapacityFromBytes(response.total, response.freeToCaller)
	}
}

func (windowsHostMetricsReader) readTemperature() (float64, error) {
	return 0, errors.New("CPU temperature unavailable on windows")
}

func (windowsHostMetricsReader) readLoad() (float64, error) {
	return 0, errors.New("load average unavailable on windows")
}
