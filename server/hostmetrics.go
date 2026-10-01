package main

import (
	"context"
	"errors"
	"fmt"
	"math"
	"runtime"
	"strings"
	"time"
)

const (
	defaultRefreshIntervalSeconds = 5
	defaultDiskPath               = "/"
	minimumRefreshInterval        = 1
	maximumRefreshInterval        = 300
	maxMetricErrorLength          = 240
)

var (
	errInvalidMonitorConfig = errors.New("invalid task manager monitor configuration")
	errInvalidCPUWindow     = errors.New("host CPU counters are not comparable")
)

type monitorConfig struct {
	RefreshIntervalSeconds int
	DiskPath               string
	DiskPathError          string
}

func defaultMonitorConfig() monitorConfig {
	return monitorConfig{
		RefreshIntervalSeconds: defaultRefreshIntervalSeconds,
		DiskPath:               defaultDiskPath,
	}
}

type hostCPUTimes struct {
	Total uint64
	Idle  uint64
}

type hostMemoryReading struct {
	UsedBytes  uint64
	TotalBytes uint64
}

type hostDiskReading struct {
	UsedBytes  uint64
	TotalBytes uint64
	Percent    float64
}

type hostMetricsReader interface {
	readCPUTimes() (hostCPUTimes, error)
	readMemory() (hostMemoryReading, error)
	readDisk(context.Context, string) (hostDiskReading, error)
	readTemperature() (float64, error)
	readLoad() (float64, error)
}

type hostMetricsCollector struct {
	reader hostMetricsReader
	prev   hostCPUTimes
	prevAt time.Time
	now    func() time.Time
	sleep  func(context.Context, time.Duration) error
	cores  int
}

func newHostMetricsCollector(reader hostMetricsReader) *hostMetricsCollector {
	return &hostMetricsCollector{
		reader: reader,
		now:    time.Now,
		sleep:  sleepContext,
		cores:  runtime.NumCPU(),
	}
}

func logicalCPUCores() int {
	if cores := runtime.NumCPU(); cores > 0 {
		return cores
	}
	return 1
}

func normalizeMonitorConfig(raw map[string]any) (monitorConfig, error) {
	config := defaultMonitorConfig()
	if raw == nil {
		return config, nil
	}

	if value, found := raw["refresh_interval_seconds"]; found {
		interval, ok := monitorInteger(value)
		if !ok || interval < minimumRefreshInterval || interval > maximumRefreshInterval {
			return monitorConfig{}, fmt.Errorf("%w: refresh_interval_seconds must be between %d and %d", errInvalidMonitorConfig, minimumRefreshInterval, maximumRefreshInterval)
		}
		config.RefreshIntervalSeconds = interval
	}
	if value, found := raw["disk_path"]; found {
		path, ok := value.(string)
		path = strings.TrimSpace(path)
		if !ok || path == "" {
			config.DiskPath = ""
			config.DiskPathError = "disk_path must be a non-empty string"
			return config, nil
		}
		config.DiskPath = path
	}
	return config, nil
}

func monitorInteger(value any) (int, bool) {
	switch value := value.(type) {
	case int:
		return value, true
	case int8:
		return int(value), true
	case int16:
		return int(value), true
	case int32:
		return int(value), true
	case int64:
		return int(value), int64(int(value)) == value
	case uint:
		return int(value), uint(int(value)) == value
	case uint8:
		return int(value), true
	case uint16:
		return int(value), true
	case uint32:
		return int(value), uint32(int(value)) == value
	case uint64:
		return int(value), uint64(int(value)) == value
	case float32:
		return monitorFloatInteger(float64(value))
	case float64:
		return monitorFloatInteger(value)
	default:
		return 0, false
	}
}

func monitorFloatInteger(value float64) (int, bool) {
	if math.IsNaN(value) || math.IsInf(value, 0) || value != math.Trunc(value) {
		return 0, false
	}
	converted := int(value)
	return converted, float64(converted) == value
}

func boundedMetricError(err error) string {
	if err == nil {
		return ""
	}
	message := strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return ' '
		}
		return r
	}, strings.TrimSpace(err.Error()))
	if len(message) <= maxMetricErrorLength {
		return message
	}
	return message[:maxMetricErrorLength-1] + "…"
}

func diskCapacityFromBytes(totalBytes, availableBytes uint64) (hostDiskReading, error) {
	if totalBytes == 0 {
		return hostDiskReading{}, errors.New("filesystem capacity is zero")
	}
	if availableBytes > totalBytes {
		return hostDiskReading{}, errors.New("filesystem available capacity exceeds total capacity")
	}
	used := totalBytes - availableBytes
	percent := float64(used) / float64(totalBytes) * 100
	return hostDiskReading{UsedBytes: used, TotalBytes: totalBytes, Percent: clampPercent(percent)}, nil
}

func memoryCapacityFromBytes(usedBytes, totalBytes uint64) (hostMemoryReading, float64, error) {
	if totalBytes == 0 {
		return hostMemoryReading{}, 0, errors.New("physical memory capacity is zero")
	}
	if usedBytes > totalBytes {
		usedBytes = totalBytes
	}
	percent := float64(usedBytes) / float64(totalBytes) * 100
	return hostMemoryReading{UsedBytes: usedBytes, TotalBytes: totalBytes}, clampPercent(percent), nil
}

func clampPercent(value float64) float64 {
	if math.IsNaN(value) || value < 0 {
		return 0
	}
	if value > 100 {
		return 100
	}
	return value
}

func calculateHostCPUPercent(previous, current hostCPUTimes) (float64, error) {
	if current.Total <= previous.Total || current.Idle < previous.Idle {
		return 0, errInvalidCPUWindow
	}
	totalDelta := current.Total - previous.Total
	idleDelta := current.Idle - previous.Idle
	if idleDelta > totalDelta {
		return 0, errInvalidCPUWindow
	}
	return clampPercent(float64(totalDelta-idleDelta) / float64(totalDelta) * 100), nil
}

func (c *hostMetricsCollector) sampleHostCPU(ctx context.Context) (float64, float64, error) {
	current, err := c.reader.readCPUTimes()
	if err != nil {
		return 0, 0, err
	}
	now := c.now()
	if c.prevAt.IsZero() || now.Sub(c.prevAt) > staleAfter {
		c.prev = current
		c.prevAt = now
		if err := c.sleep(ctx, sampleWindow); err != nil {
			return 0, 0, err
		}
	} else if wait := sampleWindow - now.Sub(c.prevAt); wait > 0 {
		if err := c.sleep(ctx, wait); err != nil {
			return 0, 0, err
		}
	}

	current, err = c.reader.readCPUTimes()
	if err != nil {
		return 0, 0, err
	}
	now = c.now()
	percent, err := calculateHostCPUPercent(c.prev, current)
	c.prev = current
	c.prevAt = now
	if err != nil {
		return 0, 0, err
	}
	cores := c.cores
	if cores < 1 {
		cores = 1
	}
	// core_percent is deliberately expressed in the same percentage unit as
	// task CPU: 50% on four logical cores is 200%, or two fully busy cores.
	return percent * float64(cores), percent, nil
}

func (c *hostMetricsCollector) sampleMemory() (hostMemoryReading, float64, error) {
	reading, err := c.reader.readMemory()
	if err != nil {
		return hostMemoryReading{}, 0, err
	}
	return memoryCapacityFromBytes(reading.UsedBytes, reading.TotalBytes)
}

func (c *hostMetricsCollector) sampleDisk(ctx context.Context, path string) (hostDiskReading, error) {
	return c.reader.readDisk(ctx, path)
}
