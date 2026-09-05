package main

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/kandev/kandev/pkg/pluginsdk"
)

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
