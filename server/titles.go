package main

import (
	"context"
	"log"
	"sync"
	"time"

	"github.com/kandev/kandev/pkg/pluginsdk"
)

// titleTTL is how long a task's title, identifier and state are reused before
// being re-read. The UI polls roughly once a second while its modal is open;
// asking kandev for the same handful of titles at that rate would be pure
// waste, and none of these fields change fast enough for staleness to matter.
const titleTTL = 60 * time.Second

// missingTTL is the shorter reuse window for "kandev does not know this task".
// It is deliberately short because the common cause is a race — the process
// exists a moment before the task row is visible — and the plugin should
// recover on its own rather than showing an unnamed row until restart.
const missingTTL = 5 * time.Second

type titleEntry struct {
	title      string
	identifier string
	state      string
	found      bool
	fetchedAt  time.Time
}

// titleCache turns task ids from the process table into the names a person
// recognizes. It is the only place the plugin reads anything from kandev; all
// the numbers come from the kernel.
type titleCache struct {
	mu      sync.Mutex
	entries map[string]titleEntry
	now     func() time.Time
}

func newTitleCache() *titleCache {
	return &titleCache{entries: map[string]titleEntry{}, now: time.Now}
}

// taskGetter is the one method of kandev's Host API this plugin needs. Naming
// the narrow dependency rather than the whole Host keeps the capability
// surface obvious at a glance, and lets the tests supply a task row without
// standing up the rest of the interface.
type taskGetter interface {
	Get(ctx context.Context, id string) (*pluginsdk.Task, error)
}

// annotate fills in the kandev-owned fields of each task in place. A failure
// to reach kandev is logged and left blank: a task manager that can still
// show which task id is burning a core is more useful than one that refuses
// to render because a title lookup failed.
func (c *titleCache) annotate(ctx context.Context, tasksAPI taskGetter, tasks []taskUsage) {
	for i := range tasks {
		entry, ok := c.lookup(tasks[i].TaskID)
		if !ok {
			entry = c.fetch(ctx, tasksAPI, tasks[i].TaskID)
		}
		if !entry.found {
			continue
		}
		tasks[i].Title = entry.title
		tasks[i].Identifier = entry.identifier
		tasks[i].State = entry.state
	}
}

func (c *titleCache) lookup(taskID string) (titleEntry, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, ok := c.entries[taskID]
	if !ok {
		return titleEntry{}, false
	}
	ttl := titleTTL
	if !entry.found {
		ttl = missingTTL
	}
	if c.now().Sub(entry.fetchedAt) > ttl {
		return titleEntry{}, false
	}
	return entry, true
}

func (c *titleCache) fetch(ctx context.Context, tasksAPI taskGetter, taskID string) titleEntry {
	entry := titleEntry{fetchedAt: c.now()}
	// The Host connection is injected asynchronously after startup, so it can
	// legitimately be absent for the first request after a plugin restart.
	if tasksAPI == nil {
		return entry
	}
	task, err := tasksAPI.Get(ctx, taskID)
	switch {
	case err != nil:
		log.Printf("task-manager: task %s: %v", taskID, err)
	case task != nil:
		entry.title = task.Title
		entry.identifier = task.Identifier
		entry.state = task.State
		entry.found = true
	}

	c.mu.Lock()
	c.entries[taskID] = entry
	c.mu.Unlock()
	return entry
}
