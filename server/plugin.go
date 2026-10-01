package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"sync"
	"time"

	"github.com/kandev/kandev/pkg/pluginsdk"
)

// taskManagerPlugin exposes the detailed "usage" webhook and the lightweight
// "summary" webhook used by its own UI as request relays. Kandev forwards both
// over gRPC HandleWebhook, and the plugin answers with fresh host readings.
type taskManagerPlugin struct {
	pluginsdk.UnimplementedPlugin

	// cpuMu serializes the two stateful CPU samplers. Two overlapping polls
	// sharing one previous observation would each diff against it and both
	// report roughly half the real rate, so the second caller waits and then
	// gets an honest reading. Host memory, disk, temperature, and load are
	// independent reads and must not wait behind this lock.
	cpuMu   sync.Mutex
	sampler *sampler
	titles  *titleCache

	configMu      sync.Mutex
	config        monitorConfig
	configLoaded  bool
	hostMetricsMu sync.Mutex
	hostMetrics   *hostMetricsCollector
}

var _ pluginsdk.Plugin = (*taskManagerPlugin)(nil)

func newPlugin() *taskManagerPlugin {
	return &taskManagerPlugin{
		sampler:     newSampler(newScanner()),
		titles:      newTitleCache(),
		hostMetrics: newHostMetricsCollector(newHostMetricsReader()),
	}
}

// usageReport is the webhook's response body.
type usageReport struct {
	*snapshot
	// Supported is false when the host platform has no implementation. The UI
	// renders Error instead of an empty, falsely reassuring list.
	Supported bool   `json:"supported"`
	Error     string `json:"error,omitempty"`
}

const (
	summaryWebhookKey = "summary"
	maxSummaryBody    = 8192
	maxSummaryMetrics = 5
)

type summaryRequest struct {
	MetricIDs []string `json:"metric_ids"`
	CPUSource string   `json:"cpu_source,omitempty"`
}

type summaryMetric struct {
	Available       bool     `json:"available"`
	Error           string   `json:"error,omitempty"`
	Source          string   `json:"source,omitempty"`
	CorePercent     *float64 `json:"core_percent,omitempty"`
	RelativePercent *float64 `json:"relative_percent,omitempty"`
	UsedBytes       *uint64  `json:"used_bytes,omitempty"`
	TotalBytes      *uint64  `json:"total_bytes,omitempty"`
	Percent         *float64 `json:"percent,omitempty"`
	Path            string   `json:"path,omitempty"`
	Celsius         *float64 `json:"celsius,omitempty"`
	OneMinute       *float64 `json:"one_minute,omitempty"`
}

type summaryReport struct {
	SampledAt              time.Time                `json:"sampled_at"`
	RefreshIntervalSeconds int                      `json:"refresh_interval_seconds"`
	CPUCores               int                      `json:"cpu_cores"`
	Metrics                map[string]summaryMetric `json:"metrics"`
}

func (p *taskManagerPlugin) HandleWebhook(ctx context.Context, req *pluginsdk.WebhookRequest) (*pluginsdk.WebhookResponse, error) {
	switch req.WebhookKey {
	case "usage":
		return p.handleUsage(ctx, req)
	case summaryWebhookKey:
		return p.handleSummary(ctx, req)
	default:
		return jsonError(http.StatusNotFound, fmt.Sprintf("unknown webhook key %q", req.WebhookKey))
	}
}

func (p *taskManagerPlugin) handleUsage(ctx context.Context, req *pluginsdk.WebhookRequest) (*pluginsdk.WebhookResponse, error) {
	// Both GET and POST are accepted. Sampling is a read, so GET is the
	// honest verb and is what a non-browser caller should use — but kandev
	// requires an Origin header on session-authenticated webhook calls, and
	// browsers omit Origin on same-origin GETs, so the UI has to POST to get
	// past that guard. Anything else is refused.
	if req.Method != "" && req.Method != http.MethodGet && req.Method != http.MethodPost {
		return jsonError(http.StatusMethodNotAllowed, fmt.Sprintf("method %s not allowed", req.Method))
	}

	p.cpuMu.Lock()
	snap, err := p.sampler.sample(ctx)
	p.cpuMu.Unlock()
	if err != nil {
		// A sampling failure is the plugin's own problem, not the caller's:
		// report it in the body so the UI can show the reason, and use 200 so
		// a transient scan error does not render as a broken endpoint.
		log.Printf("task-manager: sample: %v", err)
		return jsonBody(http.StatusOK, usageReport{
			snapshot:  &snapshot{Platform: p.sampler.scanner.platform()},
			Supported: false,
			Error:     err.Error(),
		})
	}

	p.titles.annotate(ctx, p.tasksAPI(), snap.Tasks)
	return jsonBody(http.StatusOK, usageReport{snapshot: snap, Supported: true})
}

func (p *taskManagerPlugin) handleSummary(ctx context.Context, req *pluginsdk.WebhookRequest) (*pluginsdk.WebhookResponse, error) {
	if req.Method != "" && req.Method != http.MethodPost {
		return jsonError(http.StatusMethodNotAllowed, fmt.Sprintf("method %s not allowed", req.Method))
	}
	request, err := decodeSummaryRequest(req.Body)
	if err != nil {
		return jsonError(http.StatusBadRequest, err.Error())
	}
	config, err := p.loadMonitorConfig(ctx)
	if err != nil {
		return jsonError(http.StatusInternalServerError, boundedMetricError(err))
	}

	return p.sampleSummary(ctx, request, config)
}

func (p *taskManagerPlugin) metricsCollector() *hostMetricsCollector {
	p.hostMetricsMu.Lock()
	defer p.hostMetricsMu.Unlock()
	if p.hostMetrics == nil {
		p.hostMetrics = newHostMetricsCollector(newHostMetricsReader())
	}
	return p.hostMetrics
}

func decodeSummaryRequest(body []byte) (summaryRequest, error) {
	if len(body) == 0 {
		return summaryRequest{}, nil
	}
	if len(body) > maxSummaryBody {
		return summaryRequest{}, errors.New("summary request is too large")
	}
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return summaryRequest{}, errors.New("summary request must contain one JSON object")
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	var request summaryRequest
	if err := decoder.Decode(&request); err != nil {
		return summaryRequest{}, fmt.Errorf("invalid summary request: %w", err)
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return summaryRequest{}, errors.New("summary request must contain one JSON object")
	}
	return validateSummaryRequest(request)
}

func validateSummaryRequest(request summaryRequest) (summaryRequest, error) {
	known := map[string]bool{
		"cpu": true, "memory": true, "disk": true,
		"cpu_temperature": true, "system_load": true,
	}
	seen := make(map[string]bool, len(request.MetricIDs))
	ids := make([]string, 0, len(request.MetricIDs))
	for _, id := range request.MetricIDs {
		if !known[id] {
			return summaryRequest{}, fmt.Errorf("unsupported summary metric %q", id)
		}
		if !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	if len(ids) > maxSummaryMetrics {
		return summaryRequest{}, errors.New("summary request contains too many metrics")
	}
	request.MetricIDs = ids
	if request.CPUSource != "" && request.CPUSource != "host" && request.CPUSource != "tasks" {
		return summaryRequest{}, fmt.Errorf("unsupported CPU source %q", request.CPUSource)
	}
	if seen["cpu"] && request.CPUSource == "" {
		return summaryRequest{}, errors.New("cpu_source is required when CPU is requested")
	}
	if !seen["cpu"] && request.CPUSource != "" {
		return summaryRequest{}, errors.New("cpu_source requires CPU to be requested")
	}
	return request, nil
}

func (p *taskManagerPlugin) loadMonitorConfig(ctx context.Context) (monitorConfig, error) {
	p.configMu.Lock()
	defer p.configMu.Unlock()
	if p.configLoaded {
		return p.config, nil
	}
	config := defaultMonitorConfig()
	host := p.Host()
	if host == nil {
		return config, nil
	}
	raw, err := host.GetConfig(ctx)
	if err != nil {
		return monitorConfig{}, fmt.Errorf("read task manager monitor configuration: %w", err)
	}
	config, err = normalizeMonitorConfig(raw)
	if err != nil {
		return monitorConfig{}, err
	}
	p.config = config
	p.configLoaded = true
	return config, nil
}

func (p *taskManagerPlugin) sampleSummary(ctx context.Context, request summaryRequest, config monitorConfig) (*pluginsdk.WebhookResponse, error) {
	metrics := p.metricsCollector()
	cores := logicalCPUCores()
	report := summaryReport{
		SampledAt:              time.Now().UTC(),
		RefreshIntervalSeconds: config.RefreshIntervalSeconds,
		CPUCores:               cores,
		Metrics:                make(map[string]summaryMetric, len(request.MetricIDs)),
	}
	for _, id := range request.MetricIDs {
		report.Metrics[id] = p.sampleSummaryMetricWithCollector(ctx, id, request.CPUSource, config, cores, metrics)
	}
	return jsonBody(http.StatusOK, report)
}

// sampleSummaryMetric keeps the small internal helper useful to callers that
// only need one metric. The summary request path uses the collector-aware
// variant so all independent metrics share the same reader instance without
// extending the CPU lock across the whole request.
func (p *taskManagerPlugin) sampleSummaryMetric(ctx context.Context, id, cpuSource string, config monitorConfig, cores int) summaryMetric {
	return p.sampleSummaryMetricWithCollector(ctx, id, cpuSource, config, cores, p.metricsCollector())
}

func (p *taskManagerPlugin) sampleSummaryMetricWithCollector(ctx context.Context, id, cpuSource string, config monitorConfig, cores int, metrics *hostMetricsCollector) summaryMetric {
	switch id {
	case "cpu":
		return p.sampleSummaryCPUWithCollector(ctx, cpuSource, cores, metrics)
	case "memory":
		return sampleSummaryMemory(metrics)
	case "disk":
		return sampleSummaryDisk(ctx, metrics, config.DiskPath, config.DiskPathError)
	case "cpu_temperature":
		return sampleSummaryTemperature(metrics)
	case "system_load":
		return sampleSummaryLoad(metrics)
	default:
		return unavailableMetric(errors.New("unsupported summary metric"))
	}
}

func (p *taskManagerPlugin) sampleSummaryCPU(ctx context.Context, source string, cores int) summaryMetric {
	return p.sampleSummaryCPUWithCollector(ctx, source, cores, p.metricsCollector())
}

func (p *taskManagerPlugin) sampleSummaryCPUWithCollector(ctx context.Context, source string, cores int, metrics *hostMetricsCollector) summaryMetric {
	p.cpuMu.Lock()
	defer p.cpuMu.Unlock()
	if source == "host" {
		core, relative, err := metrics.sampleHostCPU(ctx)
		if err != nil {
			return unavailableMetricWithSource(source, err)
		}
		return cpuMetric(source, core, relative)
	}
	core, relative, err := p.sampler.sampleTaskCPU(ctx, cores)
	if err != nil {
		return unavailableMetricWithSource(source, err)
	}
	return cpuMetric(source, core, relative)
}

func (p *taskManagerPlugin) sampleSummaryMemory() summaryMetric {
	return sampleSummaryMemory(p.metricsCollector())
}

func (p *taskManagerPlugin) sampleSummaryDisk(ctx context.Context, path, pathError string) summaryMetric {
	return sampleSummaryDisk(ctx, p.metricsCollector(), path, pathError)
}

func (p *taskManagerPlugin) sampleSummaryTemperature() summaryMetric {
	return sampleSummaryTemperature(p.metricsCollector())
}

func (p *taskManagerPlugin) sampleSummaryLoad() summaryMetric {
	return sampleSummaryLoad(p.metricsCollector())
}

func cpuMetric(source string, core, relative float64) summaryMetric {
	return summaryMetric{
		Available:       true,
		Source:          source,
		CorePercent:     floatPointer(core),
		RelativePercent: floatPointer(clampPercent(relative)),
	}
}

func sampleSummaryMemory(metrics *hostMetricsCollector) summaryMetric {
	reading, percent, err := metrics.sampleMemory()
	if err != nil {
		return unavailableMetric(err)
	}
	return summaryMetric{
		Available:  true,
		UsedBytes:  uintPointer(reading.UsedBytes),
		TotalBytes: uintPointer(reading.TotalBytes),
		Percent:    floatPointer(percent),
	}
}

func sampleSummaryDisk(ctx context.Context, metrics *hostMetricsCollector, path, pathError string) summaryMetric {
	metric := summaryMetric{Path: path}
	if pathError != "" {
		metric.Error = boundedMetricError(errors.New(pathError))
		return metric
	}
	reading, err := metrics.sampleDisk(ctx, path)
	if err != nil {
		metric.Error = boundedMetricError(err)
		return metric
	}
	if reading.UsedBytes > reading.TotalBytes {
		metric.Error = boundedMetricError(errors.New("filesystem used capacity exceeds total capacity"))
		return metric
	}
	normalized, err := diskCapacityFromBytes(reading.TotalBytes, reading.TotalBytes-reading.UsedBytes)
	if err != nil {
		metric.Error = boundedMetricError(err)
		return metric
	}
	metric.Available = true
	metric.UsedBytes = uintPointer(normalized.UsedBytes)
	metric.TotalBytes = uintPointer(normalized.TotalBytes)
	metric.Percent = floatPointer(normalized.Percent)
	return metric
}

func sampleSummaryTemperature(metrics *hostMetricsCollector) summaryMetric {
	value, err := metrics.reader.readTemperature()
	if err != nil || math.IsNaN(value) || math.IsInf(value, 0) {
		return unavailableMetric(firstMetricError(err, "CPU temperature is unavailable"))
	}
	return summaryMetric{Available: true, Celsius: floatPointer(value)}
}

func sampleSummaryLoad(metrics *hostMetricsCollector) summaryMetric {
	value, err := metrics.reader.readLoad()
	if err != nil || math.IsNaN(value) || math.IsInf(value, 0) {
		return unavailableMetric(firstMetricError(err, "system load is unavailable"))
	}
	return summaryMetric{Available: true, OneMinute: floatPointer(value)}
}

func unavailableMetric(err error) summaryMetric {
	return summaryMetric{Available: false, Error: boundedMetricError(err)}
}

func unavailableMetricWithSource(source string, err error) summaryMetric {
	metric := unavailableMetric(err)
	metric.Source = source
	return metric
}

func firstMetricError(err error, fallback string) error {
	if err != nil {
		return err
	}
	return errors.New(fallback)
}

func floatPointer(value float64) *float64 { return &value }

func uintPointer(value uint64) *uint64 { return &value }

// tasksAPI returns kandev's task reader, or nil while the Host connection is
// still being injected.
func (p *taskManagerPlugin) tasksAPI() taskGetter {
	host := p.Host()
	if host == nil {
		return nil
	}
	return host.Tasks()
}

func jsonBody(status int, payload any) (*pluginsdk.WebhookResponse, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return jsonError(http.StatusInternalServerError, err.Error())
	}
	return &pluginsdk.WebhookResponse{
		Status:  int32(status),
		Headers: map[string]string{"Content-Type": "application/json"},
		Body:    body,
	}, nil
}

func jsonError(status int, message string) (*pluginsdk.WebhookResponse, error) {
	body, _ := json.Marshal(map[string]string{"error": message})
	return &pluginsdk.WebhookResponse{
		Status:  int32(status),
		Headers: map[string]string{"Content-Type": "application/json"},
		Body:    body,
	}, nil
}
