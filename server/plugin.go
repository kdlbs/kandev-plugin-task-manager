package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"

	"github.com/kandev/kandev/pkg/pluginsdk"
)

// taskManagerPlugin exposes a single "usage" webhook used by its own UI as a
// request relay: the modal calls GET /api/plugins/kandev-plugin-task-manager/
// webhooks/usage, kandev relays it over gRPC HandleWebhook to this process,
// and we answer with a freshly sampled per-task CPU/memory rollup.
type taskManagerPlugin struct {
	pluginsdk.UnimplementedPlugin

	// mu serializes sampling. Two overlapping polls sharing one previous
	// observation would each diff against it and both report roughly half the
	// real rate, so the second caller waits and then gets an honest reading.
	mu      sync.Mutex
	sampler *sampler
	titles  *titleCache
}

var _ pluginsdk.Plugin = (*taskManagerPlugin)(nil)

func newPlugin() *taskManagerPlugin {
	return &taskManagerPlugin{
		sampler: newSampler(newScanner()),
		titles:  newTitleCache(),
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

func (p *taskManagerPlugin) HandleWebhook(ctx context.Context, req *pluginsdk.WebhookRequest) (*pluginsdk.WebhookResponse, error) {
	if req.WebhookKey != "usage" {
		return jsonError(http.StatusNotFound, fmt.Sprintf("unknown webhook key %q", req.WebhookKey))
	}
	// Both GET and POST are accepted. Sampling is a read, so GET is the
	// honest verb and is what a non-browser caller should use — but kandev
	// requires an Origin header on session-authenticated webhook calls, and
	// browsers omit Origin on same-origin GETs, so the UI has to POST to get
	// past that guard. Anything else is refused.
	if req.Method != "" && req.Method != http.MethodGet && req.Method != http.MethodPost {
		return jsonError(http.StatusMethodNotAllowed, fmt.Sprintf("method %s not allowed", req.Method))
	}

	p.mu.Lock()
	snap, err := p.sampler.sample(ctx)
	p.mu.Unlock()
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
