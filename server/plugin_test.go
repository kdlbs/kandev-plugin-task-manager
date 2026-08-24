package main

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/kandev/kandev/pkg/pluginsdk"
)

// The UI polls with POST rather than GET. Kandev rejects a
// session-authenticated webhook call that carries no Origin header (CSRF
// protection), and browsers omit Origin on same-origin GETs — so a GET poll
// is answered 403 by the host on any instance with authentication enabled,
// and the panel renders as though nothing were running. Accepting POST is
// what keeps the UI working there.
func TestHandleWebhookAcceptsTheMethodsTheUIAndCLIUse(t *testing.T) {
	for _, method := range []string{http.MethodPost, http.MethodGet, ""} {
		t.Run("method="+method, func(t *testing.T) {
			p := newPlugin()
			resp, err := p.HandleWebhook(context.Background(), &pluginsdk.WebhookRequest{
				WebhookKey: "usage",
				Method:     method,
			})
			if err != nil {
				t.Fatalf("HandleWebhook: %v", err)
			}
			if resp.Status != http.StatusOK {
				t.Fatalf("status = %d, want 200 (body: %s)", resp.Status, resp.Body)
			}
			var body map[string]any
			if err := json.Unmarshal(resp.Body, &body); err != nil {
				t.Fatalf("response is not JSON: %v", err)
			}
			if _, ok := body["supported"]; !ok {
				t.Errorf("response missing 'supported': %s", resp.Body)
			}
		})
	}
}

func TestHandleWebhookRefusesOtherMethods(t *testing.T) {
	p := newPlugin()
	resp, err := p.HandleWebhook(context.Background(), &pluginsdk.WebhookRequest{
		WebhookKey: "usage",
		Method:     http.MethodDelete,
	})
	if err != nil {
		t.Fatalf("HandleWebhook: %v", err)
	}
	if resp.Status != http.StatusMethodNotAllowed {
		t.Errorf("status = %d, want 405", resp.Status)
	}
}

func TestHandleWebhookRejectsAnUnknownKey(t *testing.T) {
	p := newPlugin()
	resp, err := p.HandleWebhook(context.Background(), &pluginsdk.WebhookRequest{
		WebhookKey: "not-a-key",
		Method:     http.MethodPost,
	})
	if err != nil {
		t.Fatalf("HandleWebhook: %v", err)
	}
	if resp.Status != http.StatusNotFound {
		t.Errorf("status = %d, want 404", resp.Status)
	}
}
