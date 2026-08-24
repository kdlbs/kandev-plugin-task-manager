package main

import (
	"context"
	"errors"
	"strconv"
	"testing"
	"time"
)

// errScanFailed stands in for whatever the platform scanner might fail with.
var errScanFailed = errors.New("process table unavailable")

// fakeScanner replays scripted process tables so the sampler's arithmetic and
// attribution can be tested without a real machine underneath it. It also
// counts identity() calls, because "how often does this read a process
// environment" is a correctness property, not just a performance one: the
// whole design rests on descendants inheriting attribution instead of each
// being interrogated.
type fakeScanner struct {
	tables    [][]procSample
	index     int
	env       map[int]identity
	idCalls   map[int]int
	memBasis  string
	scanError error
}

func (f *fakeScanner) scan() ([]procSample, error) {
	if f.scanError != nil {
		return nil, f.scanError
	}
	table := f.tables[min(f.index, len(f.tables)-1)]
	f.index++
	return table, nil
}

func (f *fakeScanner) identity(pid int) (string, string, bool) {
	if f.idCalls == nil {
		f.idCalls = map[int]int{}
	}
	f.idCalls[pid]++
	id, ok := f.env[pid]
	if !ok {
		return "", "", false
	}
	return id.taskID, id.sessionID, true
}

func (f *fakeScanner) memoryBytes(_ int, rss uint64) (uint64, string) {
	if f.memBasis == basisPSS {
		return rss / 2, basisPSS
	}
	return rss, basisRSS
}

func (f *fakeScanner) platform() string { return "fake" }

func (f *fakeScanner) totalMemoryBytes() uint64 { return 32 << 30 }

// newTestSampler wires a sampler to a fake clock, so a "700ms sampling
// window" costs no wall time and the interval used for rate arithmetic is
// exact rather than approximate.
func newTestSampler(scanner procScanner) (*sampler, *time.Time) {
	clock := time.Date(2026, 8, 20, 12, 0, 0, 0, time.UTC)
	s := newSampler(scanner)
	s.now = func() time.Time { return clock }
	s.sleep = func(_ context.Context, d time.Duration) error {
		clock = clock.Add(d)
		return nil
	}
	return s, &clock
}

func proc(pid, ppid int, name string, cpu float64, rss uint64) procSample {
	return procSample{
		PID:        pid,
		PPID:       ppid,
		Name:       name,
		CPUSeconds: cpu,
		RSSBytes:   rss,
		StartKey:   key(pid),
	}
}

func key(pid int) string { return "k" + strconv.Itoa(pid) }

func findTask(t *testing.T, snap *snapshot, taskID string) taskUsage {
	t.Helper()
	for _, task := range snap.Tasks {
		if task.TaskID == taskID {
			return task
		}
	}
	t.Fatalf("task %q not found in snapshot (%d tasks)", taskID, len(snap.Tasks))
	return taskUsage{}
}

// The realistic shape: kandev's backend spawns one shared agentctl, agentctl
// spawns a per-session ACP agent that carries the task environment, and the
// agent spawns tool processes that inherit it.
func agentTree(agentCPU, toolCPU float64) []procSample {
	return []procSample{
		proc(1, 0, "init", 0, 0),
		proc(100, 1, "kandev", 5, 200),
		proc(200, 100, "agentctl", 3, 100),
		proc(300, 200, "node", agentCPU, 1000), // ACP agent, has KANDEV_TASK_ID
		proc(400, 300, "bash", toolCPU, 500),   // tool call, inherits it
		proc(500, 400, "go", toolCPU/2, 700),   // grandchild, inherits it
		proc(600, 1, "firefox", 42, 900),       // unrelated, must not appear
	}
}

func agentEnv() map[int]identity {
	return map[int]identity{300: {taskID: "task-a", sessionID: "sess-1"}}
}

func TestSampleAttributesDescendantsToTheirTask(t *testing.T) {
	scanner := &fakeScanner{
		tables: [][]procSample{agentTree(10, 4), agentTree(10, 4)},
		env:    agentEnv(),
	}
	s, _ := newTestSampler(scanner)

	snap, err := s.sample(context.Background())
	if err != nil {
		t.Fatalf("sample: %v", err)
	}
	if len(snap.Tasks) != 1 {
		t.Fatalf("want exactly the one kandev task, got %d", len(snap.Tasks))
	}
	task := findTask(t, snap, "task-a")
	if len(task.Processes) != 3 {
		t.Fatalf("want agent + 2 descendants, got %d", len(task.Processes))
	}
	// The unrelated browser and kandev's own backend must be absent: the
	// plugin reports what a task costs, not what the machine costs.
	for _, p := range task.Processes {
		if p.Name == "firefox" || p.Name == "kandev" || p.Name == "agentctl" {
			t.Errorf("process %q was wrongly attributed to the task", p.Name)
		}
	}
	if got := task.SessionIDs; len(got) != 1 || got[0] != "sess-1" {
		t.Errorf("session ids = %v, want [sess-1]", got)
	}
}

func TestSampleInheritsAttributionForAScrubbedEnvironment(t *testing.T) {
	// The tool processes declare nothing of their own (`env -i make` is the
	// realistic case). They are still the agent's work and must still be
	// counted against its task.
	scanner := &fakeScanner{
		tables: [][]procSample{agentTree(10, 4), agentTree(10, 4)},
		env:    agentEnv(),
	}
	s, _ := newTestSampler(scanner)

	snap, err := s.sample(context.Background())
	if err != nil {
		t.Fatalf("sample: %v", err)
	}
	if got := len(findTask(t, snap, "task-a").Processes); got != 3 {
		t.Errorf("task has %d processes, want the agent plus its 2 descendants", got)
	}
}

func TestSampleLetsAProcessDeclareItsOwnTask(t *testing.T) {
	// A process that names a task in its own environment belongs to that
	// task, even when its parent is already attributed to a different one.
	// Inheriting instead would silently charge the work to whichever task
	// happened to spawn it — the failure mode that first showed up running
	// this against a real machine.
	scanner := &fakeScanner{
		tables: [][]procSample{agentTree(10, 4), agentTree(10, 4)},
		env: map[int]identity{
			300: {taskID: "task-a", sessionID: "sess-1"},
			400: {taskID: "task-b", sessionID: "sess-2"}, // child of 300
		},
	}
	s, _ := newTestSampler(scanner)

	snap, err := s.sample(context.Background())
	if err != nil {
		t.Fatalf("sample: %v", err)
	}
	taskB := findTask(t, snap, "task-b")
	if len(taskB.Processes) != 2 {
		t.Fatalf("task-b has %d processes, want the re-declaring process and its child", len(taskB.Processes))
	}
	if got := len(findTask(t, snap, "task-a").Processes); got != 1 {
		t.Errorf("task-a has %d processes, want only its own agent", got)
	}
}

func TestSampleReadsEachProcessEnvironmentOnce(t *testing.T) {
	scanner := &fakeScanner{
		tables: [][]procSample{agentTree(10, 4), agentTree(11, 5), agentTree(12, 6)},
		env:    agentEnv(),
	}
	s, clock := newTestSampler(scanner)
	for range 3 {
		if _, err := s.sample(context.Background()); err != nil {
			t.Fatalf("sample: %v", err)
		}
		*clock = clock.Add(time.Second)
	}
	// Every process is interrogated, but only once in its lifetime — that
	// cache is what keeps reading the whole machine's environments affordable.
	for pid, calls := range scanner.idCalls {
		if calls != 1 {
			t.Errorf("pid %d environment read %d times across 3 polls, want 1", pid, calls)
		}
	}
}

func TestSampleCachesAttributionAcrossPolls(t *testing.T) {
	scanner := &fakeScanner{
		tables: [][]procSample{agentTree(10, 4), agentTree(11, 5), agentTree(12, 6)},
		env:    agentEnv(),
	}
	s, clock := newTestSampler(scanner)
	for range 3 {
		if _, err := s.sample(context.Background()); err != nil {
			t.Fatalf("sample: %v", err)
		}
		*clock = clock.Add(time.Second)
	}
	// Without the negative cache, every poll would re-read the environment of
	// every unrelated process on the machine.
	if calls := scanner.idCalls[600]; calls != 1 {
		t.Errorf("unrelated process environment read %d times across 3 polls, want 1", calls)
	}
}

func TestSampleComputesCPUAsARateNotALifetimeAverage(t *testing.T) {
	// The agent burned 0.35 CPU-seconds over the 700ms window: one full core.
	scanner := &fakeScanner{
		tables: [][]procSample{agentTree(10, 4), agentTree(10.35, 4)},
		env:    agentEnv(),
	}
	s, _ := newTestSampler(scanner)

	snap, err := s.sample(context.Background())
	if err != nil {
		t.Fatalf("sample: %v", err)
	}
	if got, want := snap.IntervalSeconds, sampleWindow.Seconds(); got != want {
		t.Fatalf("interval = %v, want %v", got, want)
	}
	task := findTask(t, snap, "task-a")
	if got := task.CPUPercent; got < 49.9 || got > 50.1 {
		// 0.35s of CPU in 0.7s of wall time is 50%, regardless of how much
		// CPU the process consumed over its whole life (10 seconds' worth).
		t.Errorf("cpu = %.2f%%, want ~50%%", got)
	}
}

func TestSampleSumsCPUAcrossTheWholeTree(t *testing.T) {
	before := agentTree(10, 4)
	after := agentTree(10.35, 4)
	after[4].CPUSeconds = 4.7  // bash: +0.7s = 100%
	after[5].CPUSeconds = 2.35 // go:   +0.35s = 50% (was toolCPU/2 = 2)
	scanner := &fakeScanner{tables: [][]procSample{before, after}, env: agentEnv()}
	s, _ := newTestSampler(scanner)

	snap, err := s.sample(context.Background())
	if err != nil {
		t.Fatalf("sample: %v", err)
	}
	task := findTask(t, snap, "task-a")
	if got := task.CPUPercent; got < 199.5 || got > 200.5 {
		t.Errorf("tree cpu = %.2f%%, want ~200%% (50 + 100 + 50)", got)
	}
	// Sorted hottest-first so the UI can render the list as-is.
	if task.Processes[0].Name != "bash" {
		t.Errorf("processes[0] = %q, want the hottest process (bash)", task.Processes[0].Name)
	}
}

func TestSampleTreatsARecycledPIDAsANewProcess(t *testing.T) {
	before := agentTree(10, 4)
	after := agentTree(10, 4)
	// Same pid, different process: the kernel recycled 400 and the new
	// occupant has consumed almost no CPU. Diffing against the old
	// occupant's 4 seconds would report a large negative delta (clamped to
	// zero, hiding a real reading) or, in the other direction, a fictional
	// burst.
	after[4].StartKey = "k400-recycled"
	after[4].CPUSeconds = 0.1
	scanner := &fakeScanner{tables: [][]procSample{before, after}, env: agentEnv()}
	s, _ := newTestSampler(scanner)

	snap, err := s.sample(context.Background())
	if err != nil {
		t.Fatalf("sample: %v", err)
	}
	task := findTask(t, snap, "task-a")
	for _, p := range task.Processes {
		if p.PID != 400 {
			continue
		}
		if !p.New {
			t.Error("recycled pid should be reported as newly seen")
		}
		if p.CPUPercent != 0 {
			t.Errorf("recycled pid cpu = %.2f%%, want 0 (no comparable previous reading)", p.CPUPercent)
		}
	}
}

func TestSampleClampsABackwardsCounter(t *testing.T) {
	before := agentTree(10, 4)
	after := agentTree(9, 4) // impossible, but a torn read could produce it
	scanner := &fakeScanner{tables: [][]procSample{before, after}, env: agentEnv()}
	s, _ := newTestSampler(scanner)

	snap, err := s.sample(context.Background())
	if err != nil {
		t.Fatalf("sample: %v", err)
	}
	if got := findTask(t, snap, "task-a").CPUPercent; got < 0 {
		t.Errorf("cpu = %.2f%%, want no negative rate", got)
	}
}

func TestSampleRebaselinesAfterAStaleGap(t *testing.T) {
	// Poll, wait far longer than staleAfter, poll again. The second reading
	// must not average the agent's CPU over the whole idle gap.
	tables := [][]procSample{agentTree(10, 4), agentTree(10, 4), agentTree(10, 4), agentTree(10.007, 4)}
	scanner := &fakeScanner{tables: tables, env: agentEnv()}
	s, clock := newTestSampler(scanner)

	if _, err := s.sample(context.Background()); err != nil {
		t.Fatalf("first sample: %v", err)
	}
	*clock = clock.Add(10 * time.Minute)

	snap, err := s.sample(context.Background())
	if err != nil {
		t.Fatalf("second sample: %v", err)
	}
	if got, want := snap.IntervalSeconds, sampleWindow.Seconds(); got != want {
		t.Fatalf("interval = %vs, want a fresh %vs window, not the 600s gap", got, want)
	}
	if got := findTask(t, snap, "task-a").CPUPercent; got > 2 {
		t.Errorf("cpu = %.2f%%, want ~1%% measured over the fresh window", got)
	}
}

func TestSampleAttributesAnOrphanedDescendant(t *testing.T) {
	// A dev server the agent started, re-parented to init when its shell
	// exited. Ancestry no longer connects it to the agent, but it kept the
	// inherited environment — which is why an unattributed parent means
	// "read this process's environment" rather than "skip it".
	table := append(agentTree(10, 4), proc(700, 1, "vite", 8, 300))
	scanner := &fakeScanner{
		tables: [][]procSample{table, table},
		env: map[int]identity{
			300: {taskID: "task-a", sessionID: "sess-1"},
			700: {taskID: "task-a", sessionID: "sess-1"},
		},
	}
	s, _ := newTestSampler(scanner)

	snap, err := s.sample(context.Background())
	if err != nil {
		t.Fatalf("sample: %v", err)
	}
	task := findTask(t, snap, "task-a")
	var found bool
	for _, p := range task.Processes {
		found = found || p.Name == "vite"
	}
	if !found {
		t.Error("orphaned descendant was dropped; it still carries the task environment")
	}
}

func TestSampleSeparatesConcurrentTasks(t *testing.T) {
	table := append(agentTree(10, 4),
		proc(800, 200, "node", 20, 1000), // second agent under the same agentctl
		proc(900, 800, "rg", 6, 200),
	)
	scanner := &fakeScanner{
		tables: [][]procSample{table, table},
		env: map[int]identity{
			300: {taskID: "task-a", sessionID: "sess-1"},
			800: {taskID: "task-b", sessionID: "sess-2"},
		},
	}
	s, _ := newTestSampler(scanner)

	snap, err := s.sample(context.Background())
	if err != nil {
		t.Fatalf("sample: %v", err)
	}
	if len(snap.Tasks) != 2 {
		t.Fatalf("want 2 tasks, got %d", len(snap.Tasks))
	}
	if got := len(findTask(t, snap, "task-b").Processes); got != 2 {
		t.Errorf("task-b has %d processes, want 2", got)
	}
	if got := len(findTask(t, snap, "task-a").Processes); got != 3 {
		t.Errorf("task-a has %d processes, want 3", got)
	}
}

func TestSampleRanksTasksByCPU(t *testing.T) {
	before := append(agentTree(10, 4), proc(800, 200, "node", 20, 1000))
	after := append(agentTree(10.1, 4), proc(800, 200, "node", 20.6, 1000))
	scanner := &fakeScanner{
		tables: [][]procSample{before, after},
		env: map[int]identity{
			300: {taskID: "task-a", sessionID: "sess-1"},
			800: {taskID: "task-b", sessionID: "sess-2"},
		},
	}
	s, _ := newTestSampler(scanner)

	snap, err := s.sample(context.Background())
	if err != nil {
		t.Fatalf("sample: %v", err)
	}
	if snap.Tasks[0].TaskID != "task-b" {
		t.Errorf("tasks[0] = %q, want the hottest task first", snap.Tasks[0].TaskID)
	}
}

func TestSamplePrunesTheAttributionCache(t *testing.T) {
	full := agentTree(10, 4)
	shrunk := full[:4] // the tool processes exited
	// A cold sample() scans twice — once for its baseline, once to measure —
	// so the first poll consumes two tables.
	scanner := &fakeScanner{tables: [][]procSample{full, full, shrunk, shrunk}, env: agentEnv()}
	s, _ := newTestSampler(scanner)

	if _, err := s.sample(context.Background()); err != nil {
		t.Fatalf("sample: %v", err)
	}
	before := len(s.identities)
	if _, err := s.sample(context.Background()); err != nil {
		t.Fatalf("sample: %v", err)
	}
	if len(s.identities) >= before {
		t.Errorf("cache held %d entries, still %d after processes exited; it must not grow without bound",
			before, len(s.identities))
	}
}

func TestSampleReportsMemoryBasisHonestly(t *testing.T) {
	scanner := &fakeScanner{
		tables:   [][]procSample{agentTree(10, 4), agentTree(10, 4)},
		env:      agentEnv(),
		memBasis: basisPSS,
	}
	s, _ := newTestSampler(scanner)

	snap, err := s.sample(context.Background())
	if err != nil {
		t.Fatalf("sample: %v", err)
	}
	task := findTask(t, snap, "task-a")
	if task.MemoryBasis != basisPSS {
		t.Errorf("basis = %q, want %q when every process supplied PSS", task.MemoryBasis, basisPSS)
	}
	// 1000 + 500 + 700, halved by the fake's PSS rule.
	if got, want := task.MemoryBytes, uint64(1100); got != want {
		t.Errorf("memory = %d, want %d", got, want)
	}
}

func TestSampleFallsBackToRSSBasisWhenAnyProcessDoes(t *testing.T) {
	scanner := &fakeScanner{
		tables: [][]procSample{agentTree(10, 4), agentTree(10, 4)},
		env:    agentEnv(),
	}
	s, _ := newTestSampler(scanner)

	snap, err := s.sample(context.Background())
	if err != nil {
		t.Fatalf("sample: %v", err)
	}
	if got := findTask(t, snap, "task-a").MemoryBasis; got != basisRSS {
		t.Errorf("basis = %q, want %q", got, basisRSS)
	}
}

func TestSampleReusesMemoryReadingsWithinTheTTL(t *testing.T) {
	// Reading PSS costs an order of magnitude more than the whole process
	// scan (see memoryTTL), so polling it at CPU's cadence would make the
	// task manager one of the heavier things on the machine it reports on.
	scanner := &countingMemoryScanner{fakeScanner: fakeScanner{
		tables: [][]procSample{agentTree(10, 4)},
		env:    agentEnv(),
	}}
	s, clock := newTestSampler(scanner)

	for range 4 {
		if _, err := s.sample(context.Background()); err != nil {
			t.Fatalf("sample: %v", err)
		}
		*clock = clock.Add(time.Second)
	}
	// 4 polls one second apart span 3s, inside the 5s TTL: one read each.
	if got := scanner.memCalls; got != 3 {
		t.Errorf("memory read %d times across 4 polls of 3 processes, want 3", got)
	}

	*clock = clock.Add(memoryTTL + time.Second)
	if _, err := s.sample(context.Background()); err != nil {
		t.Fatalf("sample: %v", err)
	}
	if got := scanner.memCalls; got != 6 {
		t.Errorf("memory read %d times after the TTL expired, want a refresh to 6", got)
	}
}

type countingMemoryScanner struct {
	fakeScanner
	memCalls int
}

func (c *countingMemoryScanner) memoryBytes(pid int, rss uint64) (uint64, string) {
	c.memCalls++
	return c.fakeScanner.memoryBytes(pid, rss)
}

func TestSampleSurfacesAScanFailure(t *testing.T) {
	scanner := &fakeScanner{tables: [][]procSample{nil}, scanError: errScanFailed}
	s, _ := newTestSampler(scanner)

	if _, err := s.sample(context.Background()); err == nil {
		t.Fatal("want the scan failure surfaced, not an empty snapshot")
	}
}

func TestSampleHonoursContextCancellation(t *testing.T) {
	scanner := &fakeScanner{tables: [][]procSample{agentTree(10, 4)}, env: agentEnv()}
	s := newSampler(scanner)
	// Real sleep, cancelled context: the browser aborting a poll must not
	// leave the plugin blocked for the rest of the window.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if _, err := s.sample(ctx); err == nil {
		t.Fatal("want the cancellation surfaced")
	}
}
