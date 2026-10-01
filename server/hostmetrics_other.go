//go:build !linux && !darwin && !windows

package main

import (
	"context"
	"errors"
)

type unsupportedHostMetricsReader struct{}

func newHostMetricsReader() hostMetricsReader { return &unsupportedHostMetricsReader{} }

func (unsupportedHostMetricsReader) readCPUTimes() (hostCPUTimes, error) {
	return hostCPUTimes{}, errors.New("host CPU metrics are unavailable on this platform")
}

func (unsupportedHostMetricsReader) readMemory() (hostMemoryReading, error) {
	return hostMemoryReading{}, errors.New("host memory metrics are unavailable on this platform")
}

func (unsupportedHostMetricsReader) readDisk(context.Context, string) (hostDiskReading, error) {
	return hostDiskReading{}, errors.New("disk metrics are unavailable on this platform")
}

func (unsupportedHostMetricsReader) readTemperature() (float64, error) {
	return 0, errors.New("CPU temperature is unavailable on this platform")
}

func (unsupportedHostMetricsReader) readLoad() (float64, error) {
	return 0, errors.New("load average is unavailable on this platform")
}
