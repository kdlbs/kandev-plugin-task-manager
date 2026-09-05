//go:build !windows

package main

import (
	"context"
	"errors"
	"fmt"
	"syscall"
	"time"
)

const diskStatfsTimeout = 2 * time.Second

var monitorStatfs = syscall.Statfs

var diskCallSlot = make(chan struct{}, 1)

type diskStatfsResult struct {
	stat syscall.Statfs_t
	err  error
}

func readUnixDiskCapacity(ctx context.Context, path string) (hostDiskReading, error) {
	if path == "" {
		return hostDiskReading{}, errors.New("disk path is empty")
	}
	select {
	case diskCallSlot <- struct{}{}:
	case <-ctx.Done():
		return hostDiskReading{}, ctx.Err()
	}

	result := make(chan diskStatfsResult, 1)
	go func() {
		defer func() { <-diskCallSlot }()
		var stat syscall.Statfs_t
		err := monitorStatfs(path, &stat)
		result <- diskStatfsResult{stat: stat, err: err}
	}()

	timer := time.NewTimer(diskStatfsTimeout)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return hostDiskReading{}, ctx.Err()
	case <-timer.C:
		return hostDiskReading{}, fmt.Errorf("filesystem capacity lookup timed out")
	case response := <-result:
		if response.err != nil {
			return hostDiskReading{}, response.err
		}
		return diskCapacityFromStatfs(response.stat)
	}
}

func diskCapacityFromStatfs(stat syscall.Statfs_t) (hostDiskReading, error) {
	blockSize := uint64(stat.Bsize)
	return diskCapacityFromBytes(
		uint64(stat.Blocks)*blockSize,
		uint64(stat.Bavail)*blockSize,
	)
}
