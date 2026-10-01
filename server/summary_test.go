package main

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/kandev/kandev/pkg/pluginsdk"
)

func TestSummaryDiskReadDoesNotBlockDetailedUsage(t *testing.T) {
	diskStarted := make(chan struct{}, 1)
	diskRelease := make(chan struct{})
	reader := &fakeHostMetricsReader{
		disk:        hostDiskReading{UsedBytes: 1, TotalBytes: 2},
		diskStarted: diskStarted,
		diskRelease: diskRelease,
	}
	p := newPlugin()
	p.hostMetrics = newHostMetricsCollector(reader)
	p.sampler, _ = newTestSampler(&fakeScanner{
		tables: [][]procSample{{}},
	})

	summaryDone := make(chan error, 1)
	go func() {
		_, err := p.sampleSummary(context.Background(), summaryRequest{MetricIDs: []string{"disk"}}, defaultMonitorConfig())
		summaryDone <- err
	}()
	select {
	case <-diskStarted:
	case <-time.After(time.Second):
		t.Fatal("disk read did not start")
	}

	usageDone := make(chan error, 1)
	go func() {
		_, err := p.handleUsage(context.Background(), &pluginsdk.WebhookRequest{WebhookKey: "usage", Method: http.MethodPost})
		usageDone <- err
	}()
	select {
	case err := <-usageDone:
		if err != nil {
			t.Fatalf("detailed usage: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("detailed usage was blocked by the disk read")
	}

	close(diskRelease)
	select {
	case err := <-summaryDone:
		if err != nil {
			t.Fatalf("summary: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("disk summary did not finish after release")
	}
}

func TestSummaryWebhookRejectsInvalidSelectors(t *testing.T) {
	tests := []struct {
		name string
		body string
	}{
		{name: "unknown metric", body: `{"metric_ids":["network"]}`},
		{name: "missing CPU source", body: `{"metric_ids":["cpu"]}`},
		{name: "source without CPU", body: `{"metric_ids":["memory"],"cpu_source":"host"}`},
		{name: "bad source", body: `{"metric_ids":["cpu"],"cpu_source":"processes"}`},
		{name: "non object", body: `null`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			response, err := newPlugin().HandleWebhook(context.Background(), &pluginsdk.WebhookRequest{
				WebhookKey: summaryWebhookKey,
				Method:     http.MethodPost,
				Body:       []byte(tt.body),
			})
			if err != nil {
				t.Fatalf("HandleWebhook: %v", err)
			}
			if response.Status != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400 (body: %s)", response.Status, response.Body)
			}
		})
	}
}

func TestSummaryWebhookDeduplicatesMetricSelectors(t *testing.T) {
	reader := &fakeHostMetricsReader{memory: hostMemoryReading{UsedBytes: 1, TotalBytes: 2}}
	p := newPlugin()
	p.hostMetrics = newHostMetricsCollector(reader)
	response, err := p.HandleWebhook(context.Background(), &pluginsdk.WebhookRequest{
		WebhookKey: summaryWebhookKey,
		Method:     http.MethodPost,
		Body:       []byte(`{"metric_ids":["memory","memory","memory"]}`),
	})
	if err != nil {
		t.Fatalf("HandleWebhook: %v", err)
	}
	if response.Status != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body: %s)", response.Status, response.Body)
	}
	var report summaryReport
	if err := json.Unmarshal(response.Body, &report); err != nil {
		t.Fatalf("decode summary: %v", err)
	}
	if len(report.Metrics) != 1 || !report.Metrics["memory"].Available {
		t.Fatalf("metrics = %+v, want one available memory metric", report.Metrics)
	}
}
