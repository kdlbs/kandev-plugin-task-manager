package main

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/kandev/kandev/pkg/pluginsdk"
)

// fakeTasks supplies task rows without a gRPC connection to kandev.
type fakeTasks struct {
	tasks map[string]*pluginsdk.Task
	err   error
	gets  int
}

func (f *fakeTasks) Get(_ context.Context, id string) (*pluginsdk.Task, error) {
	f.gets++
	if f.err != nil {
		return nil, f.err
	}
	return f.tasks[id], nil
}

func newTestTitleCache() (*titleCache, *time.Time) {
	clock := time.Date(2026, 8, 20, 12, 0, 0, 0, time.UTC)
	c := newTitleCache()
	c.now = func() time.Time { return clock }
	return c, &clock
}

func TestAnnotateFillsTaskNames(t *testing.T) {
	host := &fakeTasks{tasks: map[string]*pluginsdk.Task{
		"task-a": {ID: "task-a", Title: "Per-task CPU", Identifier: "KAN-12", State: "in_progress"},
	}}
	c, _ := newTestTitleCache()
	tasks := []taskUsage{{TaskID: "task-a"}}

	c.annotate(context.Background(), host, tasks)

	if tasks[0].Title != "Per-task CPU" || tasks[0].Identifier != "KAN-12" || tasks[0].State != "in_progress" {
		t.Errorf("annotated = %+v, want the kandev fields filled in", tasks[0])
	}
}

func TestAnnotateReusesCachedTitles(t *testing.T) {
	host := &fakeTasks{tasks: map[string]*pluginsdk.Task{"task-a": {ID: "task-a", Title: "Cached"}}}
	c, clock := newTestTitleCache()

	for range 5 {
		tasks := []taskUsage{{TaskID: "task-a"}}
		c.annotate(context.Background(), host, tasks)
		*clock = clock.Add(2 * time.Second)
	}
	// The UI polls about once a second while its modal is open; asking kandev
	// for the same title on every poll would be pure waste.
	if host.gets != 1 {
		t.Errorf("host was asked %d times across 5 polls, want 1", host.gets)
	}
}

func TestAnnotateRefetchesAfterTheTTL(t *testing.T) {
	host := &fakeTasks{tasks: map[string]*pluginsdk.Task{"task-a": {ID: "task-a", Title: "First"}}}
	c, clock := newTestTitleCache()
	tasks := []taskUsage{{TaskID: "task-a"}}
	c.annotate(context.Background(), host, tasks)

	host.tasks["task-a"] = &pluginsdk.Task{ID: "task-a", Title: "Renamed"}
	*clock = clock.Add(titleTTL + time.Second)
	c.annotate(context.Background(), host, tasks)

	if tasks[0].Title != "Renamed" {
		t.Errorf("title = %q, want the refreshed title", tasks[0].Title)
	}
}

func TestAnnotateRetriesAnUnknownTaskSooner(t *testing.T) {
	// A process can be visible a moment before its task row is. Caching that
	// miss for the full TTL would leave an unnamed row on screen for a
	// minute, so misses expire faster than hits.
	host := &fakeTasks{tasks: map[string]*pluginsdk.Task{}}
	c, clock := newTestTitleCache()
	tasks := []taskUsage{{TaskID: "task-a"}}
	c.annotate(context.Background(), host, tasks)

	host.tasks["task-a"] = &pluginsdk.Task{ID: "task-a", Title: "Arrived"}
	*clock = clock.Add(missingTTL + time.Second)
	c.annotate(context.Background(), host, tasks)

	if tasks[0].Title != "Arrived" {
		t.Errorf("title = %q, want the task picked up once kandev knew about it", tasks[0].Title)
	}
}

func TestAnnotateSurvivesAHostFailure(t *testing.T) {
	// Knowing that task 7b71a3c1 is burning two cores is useful even when the
	// title lookup fails; refusing to render would not be.
	host := &fakeTasks{err: errors.New("host unavailable")}
	c, _ := newTestTitleCache()
	tasks := []taskUsage{{TaskID: "task-a", CPUPercent: 200}}

	c.annotate(context.Background(), host, tasks)

	if tasks[0].CPUPercent != 200 {
		t.Error("measurements must survive a title lookup failure")
	}
	if tasks[0].Title != "" {
		t.Errorf("title = %q, want it left blank rather than invented", tasks[0].Title)
	}
}

func TestAnnotateToleratesAMissingHost(t *testing.T) {
	// The Host connection is injected asynchronously after startup, so it is
	// legitimately nil for the first request after a plugin restart.
	c, _ := newTestTitleCache()
	tasks := []taskUsage{{TaskID: "task-a"}}

	c.annotate(context.Background(), nil, tasks)

	if tasks[0].Title != "" {
		t.Errorf("title = %q, want no title and no panic", tasks[0].Title)
	}
}
