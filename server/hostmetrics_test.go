package main

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"testing"
	"time"

	"github.com/kandev/kandev/pkg/pluginsdk"
)

type fakeHostMetricsReader struct {
	cpu         []hostCPUTimes
	cpuIndex    int
	memory      hostMemoryReading
	disk        hostDiskReading
	temperature float64
	load        float64
	memoryErr   error
	diskErr     error
	tempErr     error
	loadErr     error
	diskStarted chan<- struct{}
	diskRelease <-chan struct{}
}

func (f *fakeHostMetricsReader) readCPUTimes() (hostCPUTimes, error) {
	if len(f.cpu) == 0 {
		return hostCPUTimes{}, errors.New("no CPU sample")
	}
	reading := f.cpu[min(f.cpuIndex, len(f.cpu)-1)]
	f.cpuIndex++
	return reading, nil
}

func (f *fakeHostMetricsReader) readMemory() (hostMemoryReading, error) {
	return f.memory, f.memoryErr
}

func (f *fakeHostMetricsReader) readDisk(ctx context.Context, _ string) (hostDiskReading, error) {
	if f.diskStarted != nil {
		select {
		case f.diskStarted <- struct{}{}:
		default:
		}
	}
	if f.diskRelease != nil {
		select {
		case <-f.diskRelease:
		case <-ctx.Done():
			return hostDiskReading{}, ctx.Err()
		}
	}
	return f.disk, f.diskErr
}

func (f *fakeHostMetricsReader) readTemperature() (float64, error) {
	return f.temperature, f.tempErr
}

func (f *fakeHostMetricsReader) readLoad() (float64, error) {
	return f.load, f.loadErr
}

func TestNormalizeMonitorConfig(t *testing.T) {
	tests := []struct {
		name string
		raw  map[string]any
		want monitorConfig
		err  bool
	}{
		{name: "defaults", want: defaultMonitorConfig()},
		{
			name: "configured",
			raw:  map[string]any{"refresh_interval_seconds": float64(30), "disk_path": " /var "},
			want: monitorConfig{RefreshIntervalSeconds: 30, DiskPath: "/var"},
		},
		{name: "bad interval", raw: map[string]any{"refresh_interval_seconds": 0}, err: true},
		{name: "fractional interval", raw: map[string]any{"refresh_interval_seconds": 1.5}, err: true},
		{
			name: "bad path only disables disk",
			raw:  map[string]any{"disk_path": "  "},
			want: monitorConfig{
				RefreshIntervalSeconds: defaultRefreshIntervalSeconds,
				DiskPathError:          "disk_path must be a non-empty string",
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := normalizeMonitorConfig(tt.raw)
			if tt.err {
				if err == nil || !errors.Is(err, errInvalidMonitorConfig) {
					t.Fatalf("error = %v, want invalid config error", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("normalizeMonitorConfig: %v", err)
			}
			if got != tt.want {
				t.Fatalf("config = %+v, want %+v", got, tt.want)
			}
		})
	}
}

func TestHostMetricMathRejectsInvalidCapacity(t *testing.T) {
	if _, err := diskCapacityFromBytes(0, 0); err == nil {
		t.Error("zero filesystem capacity was accepted")
	}
	if _, err := diskCapacityFromBytes(10, 11); err == nil {
		t.Error("available capacity greater than total was accepted")
	}
	reading, percent, err := memoryCapacityFromBytes(12, 10)
	if err != nil {
		t.Fatalf("memoryCapacityFromBytes: %v", err)
	}
	if reading.UsedBytes != 10 || percent != 100 {
		t.Errorf("clamped memory = %+v, %.2f%%", reading, percent)
	}
	if _, err := calculateHostCPUPercent(hostCPUTimes{Total: 10, Idle: 5}, hostCPUTimes{Total: 9, Idle: 4}); err == nil {
		t.Error("backward CPU counters were accepted")
	}
}

func TestHostCPUSamplingReturnsCoreAndHostPercent(t *testing.T) {
	reader := &fakeHostMetricsReader{cpu: []hostCPUTimes{
		{Total: 100, Idle: 50},
		{Total: 200, Idle: 100},
	}}
	collector := newHostMetricsCollector(reader)
	collector.cores = 4
	collector.sleep = func(context.Context, time.Duration) error { return nil }
	core, relative, err := collector.sampleHostCPU(context.Background())
	if err != nil {
		t.Fatalf("sampleHostCPU: %v", err)
	}
	if core != 200 || relative != 50 {
		t.Fatalf("CPU = %.2f core, %.2f relative; want 200, 50", core, relative)
	}
}

func TestHostSummaryKeepsIndependentMetricFailures(t *testing.T) {
	reader := &fakeHostMetricsReader{
		cpu:         []hostCPUTimes{{Total: 100, Idle: 50}, {Total: 180, Idle: 90}},
		memory:      hostMemoryReading{UsedBytes: 4, TotalBytes: 10},
		disk:        hostDiskReading{UsedBytes: 8, TotalBytes: 10},
		temperature: math.NaN(),
		load:        1.25,
	}
	p := newPlugin()
	p.hostMetrics = newHostMetricsCollector(reader)
	p.hostMetrics.cores = 2
	p.hostMetrics.sleep = func(context.Context, time.Duration) error { return nil }
	response, err := p.HandleWebhook(context.Background(), &pluginsdk.WebhookRequest{
		WebhookKey: summaryWebhookKey,
		Method:     "POST",
		Body:       []byte(`{"metric_ids":["cpu","memory","disk","cpu_temperature","system_load"],"cpu_source":"host"}`),
	})
	if err != nil {
		t.Fatalf("HandleWebhook: %v", err)
	}
	if response.Status != 200 {
		t.Fatalf("status = %d, body = %s", response.Status, response.Body)
	}
	var report summaryReport
	if err := json.Unmarshal(response.Body, &report); err != nil {
		t.Fatalf("decode summary: %v", err)
	}
	if !report.Metrics["cpu"].Available || !report.Metrics["memory"].Available || !report.Metrics["disk"].Available || !report.Metrics["system_load"].Available {
		t.Fatalf("independent metrics unexpectedly unavailable: %+v", report.Metrics)
	}
	if report.Metrics["cpu_temperature"].Available || report.Metrics["cpu_temperature"].Error == "" {
		t.Fatalf("temperature failure was not represented: %+v", report.Metrics["cpu_temperature"])
	}
}

func TestHostSummaryInvalidDiskPathKeepsIndependentMetrics(t *testing.T) {
	reader := &fakeHostMetricsReader{
		cpu:    []hostCPUTimes{{Total: 100, Idle: 50}, {Total: 180, Idle: 90}},
		memory: hostMemoryReading{UsedBytes: 4, TotalBytes: 10},
		load:   1.25,
	}
	p := newPlugin()
	p.hostMetrics = newHostMetricsCollector(reader)
	p.hostMetrics.sleep = func(context.Context, time.Duration) error { return nil }

	response, err := p.sampleSummary(context.Background(), summaryRequest{
		MetricIDs: []string{"cpu", "memory", "disk", "system_load"},
		CPUSource: "host",
	}, monitorConfig{
		RefreshIntervalSeconds: defaultRefreshIntervalSeconds,
		DiskPathError:          "disk_path must be a non-empty string",
	})
	if err != nil {
		t.Fatalf("sampleSummary: %v", err)
	}
	if response.Status != 200 {
		t.Fatalf("status = %d, body = %s", response.Status, response.Body)
	}
	var report summaryReport
	if err := json.Unmarshal(response.Body, &report); err != nil {
		t.Fatalf("decode summary: %v", err)
	}
	for _, id := range []string{"cpu", "memory", "system_load"} {
		if !report.Metrics[id].Available {
			t.Fatalf("%s unexpectedly unavailable: %+v", id, report.Metrics[id])
		}
	}
	if report.Metrics["disk"].Available || report.Metrics["disk"].Error == "" {
		t.Fatalf("invalid disk path was not isolated: %+v", report.Metrics["disk"])
	}
}
