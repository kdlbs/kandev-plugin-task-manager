package main

import (
	"context"
	"runtime"
	"sort"
	"time"
)

// Sampling window. CPU percentage is a rate, so it needs two observations of
// cumulative CPU time separated by a known interval. sampleWindow is how far
// apart the plugin insists those observations are: short enough that the
// number feels live, long enough that the delta is well above the resolution
// of the underlying counters (10ms on Linux, 10ms on macOS's ps).
const sampleWindow = 700 * time.Millisecond

// staleAfter is the age past which a stored observation is discarded rather
// than used as one half of a delta. Diffing against a minutes-old sample
// would average CPU over that whole gap and show a long-finished burst as
// current activity.
const staleAfter = 5 * time.Second

// memoryTTL decouples the memory cadence from the CPU cadence.
//
// Measured on a machine running 24 tasks over 748 processes: a whole scan
// costs ~30ms, but reading PSS for every attributed process costs ~370ms,
// because the kernel walks the process's entire VMA list to build
// smaps_rollup. Paying that every second would make the task manager one of
// the heavier things on the machine it is reporting on. Memory also simply
// does not move at CPU's timescale, so re-reading it every few seconds and
// reusing the value in between costs nothing a person can perceive.
const memoryTTL = 5 * time.Second

// identity is the kandev ownership of a process, resolved once per process
// and then inherited by its descendants.
type identity struct {
	taskID    string
	sessionID string
}

// memoryReading is a cached per-process memory measurement.
type memoryReading struct {
	bytes uint64
	basis string
	at    time.Time
}

// procUsage is one process's contribution to a task.
type procUsage struct {
	PID         int     `json:"pid"`
	PPID        int     `json:"ppid"`
	Name        string  `json:"name"`
	Command     string  `json:"command,omitempty"`
	CPUPercent  float64 `json:"cpu_percent"`
	MemoryBytes uint64  `json:"memory_bytes"`
	// New marks a process first seen in this sample. It has no previous CPU
	// reading to diff against, so its CPUPercent is 0 rather than unknown.
	New bool `json:"new,omitempty"`
}

// taskUsage is the whole cost of one task: its agent plus everything the
// agent spawned.
type taskUsage struct {
	TaskID string `json:"task_id"`
	// Title, Identifier and State come from kandev rather than the kernel and
	// are filled in after sampling (see titles.go). They stay empty when the
	// task has been deleted but its processes have not exited yet, which is
	// itself worth seeing.
	Title       string      `json:"title,omitempty"`
	Identifier  string      `json:"identifier,omitempty"`
	State       string      `json:"state,omitempty"`
	SessionIDs  []string    `json:"session_ids"`
	CPUPercent  float64     `json:"cpu_percent"`
	MemoryBytes uint64      `json:"memory_bytes"`
	MemoryBasis string      `json:"memory_basis"`
	Processes   []procUsage `json:"processes"`
}

// snapshot is one complete measurement.
type snapshot struct {
	SampledAt       time.Time `json:"sampled_at"`
	IntervalSeconds float64   `json:"interval_seconds"`
	Platform        string    `json:"platform"`
	CPUCores        int       `json:"cpu_cores"`
	// TotalMemoryBytes is the machine's installed memory, so the UI can show
	// a task's memory as a share of the whole rather than a bare number.
	TotalMemoryBytes uint64      `json:"total_memory_bytes,omitempty"`
	Tasks            []taskUsage `json:"tasks"`
}

// sampler turns pairs of process-table scans into per-task rates.
//
// It is request-driven rather than a background ticker: a task manager nobody
// has open should cost nothing. The trade is that a cold request has to
// establish its own baseline and wait one sampleWindow before it can report a
// rate; warm requests (the UI polls while its modal is open) diff against the
// previous request and return immediately.
type sampler struct {
	scanner procScanner

	// prevCPU maps a process's stable identity to its cumulative CPU seconds
	// as of prevAt.
	prevCPU map[string]float64
	prevAt  time.Time

	// identities caches attribution per process identity, including the
	// negative result. Without the negative cache every poll would re-read
	// the environment of every unrelated process on the machine.
	identities map[string]*identity

	// memory caches each process's memory reading for memoryTTL. See the
	// constant for the measurements that motivate it.
	memory map[string]memoryReading

	// Injected for tests, which must not actually sleep or drift.
	now   func() time.Time
	sleep func(context.Context, time.Duration) error
}

func newSampler(scanner procScanner) *sampler {
	return &sampler{
		scanner:    scanner,
		identities: map[string]*identity{},
		memory:     map[string]memoryReading{},
		now:        time.Now,
		sleep:      sleepContext,
	}
}

func sleepContext(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// sample produces one snapshot, establishing a baseline first if the stored
// one is missing or stale. Callers must serialize calls; plugin.go holds a
// mutex across the whole request for that reason.
func (s *sampler) sample(ctx context.Context) (*snapshot, error) {
	if s.prevCPU == nil || s.now().Sub(s.prevAt) > staleAfter {
		if err := s.baseline(ctx); err != nil {
			return nil, err
		}
	}
	if wait := sampleWindow - s.now().Sub(s.prevAt); wait > 0 {
		if err := s.sleep(ctx, wait); err != nil {
			return nil, err
		}
	}

	current, err := s.scanner.scan()
	if err != nil {
		return nil, err
	}
	now := s.now()
	interval := now.Sub(s.prevAt).Seconds()
	snap := s.build(current, now, interval)

	s.prevCPU = cpuByKey(current)
	s.prevAt = now
	return snap, nil
}

func (s *sampler) baseline(ctx context.Context) error {
	current, err := s.scanner.scan()
	if err != nil {
		return err
	}
	s.prevCPU = cpuByKey(current)
	s.prevAt = s.now()
	return nil
}

func cpuByKey(samples []procSample) map[string]float64 {
	out := make(map[string]float64, len(samples))
	for _, sample := range samples {
		out[sample.StartKey] = sample.CPUSeconds
	}
	return out
}

// build groups the scanned processes into per-task rollups.
func (s *sampler) build(current []procSample, now time.Time, interval float64) *snapshot {
	owners := s.attribute(current)

	byTask := map[string]*taskUsage{}
	sessionSeen := map[string]map[string]bool{}
	// Tasks in which at least one process could not supply PSS. Tracked
	// separately from MemoryBasis so a later PSS reading cannot silently
	// upgrade a sum that already mixed in an RSS one.
	rssFallback := map[string]bool{}
	for _, sample := range current {
		owner, ok := owners[sample.PID]
		if !ok {
			continue
		}
		task := byTask[owner.taskID]
		if task == nil {
			task = &taskUsage{TaskID: owner.taskID, MemoryBasis: basisRSS}
			byTask[owner.taskID] = task
			sessionSeen[owner.taskID] = map[string]bool{}
		}
		if owner.sessionID != "" && !sessionSeen[owner.taskID][owner.sessionID] {
			sessionSeen[owner.taskID][owner.sessionID] = true
			task.SessionIDs = append(task.SessionIDs, owner.sessionID)
		}

		memory, basis := s.memoryFor(sample, now)
		previous, seen := s.prevCPU[sample.StartKey]
		cpu := 0.0
		if seen && interval > 0 {
			// Clamp: a counter should never go backwards, but a truncated or
			// racing read should not surface as negative CPU.
			if delta := sample.CPUSeconds - previous; delta > 0 {
				cpu = delta / interval * 100
			}
		}

		task.CPUPercent += cpu
		task.MemoryBytes += memory
		// A tree's memory is only as trustworthy as its weakest reading: if
		// any process fell back to RSS, the sum double-counts shared pages
		// and must not claim to be PSS.
		if basis == basisPSS && !rssFallback[owner.taskID] {
			task.MemoryBasis = basisPSS
		} else {
			rssFallback[owner.taskID] = true
			task.MemoryBasis = basisRSS
		}
		task.Processes = append(task.Processes, procUsage{
			PID:         sample.PID,
			PPID:        sample.PPID,
			Name:        sample.Name,
			Command:     sample.Command,
			CPUPercent:  cpu,
			MemoryBytes: memory,
			New:         !seen,
		})
	}

	tasks := make([]taskUsage, 0, len(byTask))
	for _, task := range byTask {
		sort.Slice(task.Processes, func(i, j int) bool {
			if task.Processes[i].CPUPercent != task.Processes[j].CPUPercent {
				return task.Processes[i].CPUPercent > task.Processes[j].CPUPercent
			}
			return task.Processes[i].MemoryBytes > task.Processes[j].MemoryBytes
		})
		sort.Strings(task.SessionIDs)
		tasks = append(tasks, *task)
	}
	sort.Slice(tasks, func(i, j int) bool {
		if tasks[i].CPUPercent != tasks[j].CPUPercent {
			return tasks[i].CPUPercent > tasks[j].CPUPercent
		}
		return tasks[i].MemoryBytes > tasks[j].MemoryBytes
	})

	return &snapshot{
		SampledAt:        now,
		IntervalSeconds:  interval,
		Platform:         s.scanner.platform(),
		CPUCores:         runtime.NumCPU(),
		TotalMemoryBytes: s.scanner.totalMemoryBytes(),
		Tasks:            tasks,
	}
}

// attribute resolves which task owns each process.
//
// Two rules, in order:
//
//  1. A process's own KANDEV_TASK_ID is authoritative. The environment is the
//     ground truth; everything else is an optimization layered on top of it.
//     This matters whenever a process deliberately re-declares the variable:
//     without the rule it is silently charged to whichever task happened to
//     spawn it, which is both wrong and very hard to notice.
//  2. Otherwise the process inherits its parent's attribution. This covers a
//     tool call that scrubbed its own environment (`env -i make`), and it is
//     robust in a way cwd- or argv-based guessing is not — ancestry does not
//     change when a process chdirs or re-execs.
//
// Reading every process's environment rather than only the unattributed ones
// costs ~14ms across a whole 760-process machine, and the identity cache
// means each process pays that once in its lifetime. Cheap enough that
// correctness wins outright.
//
// Orphans then fall out of rule 1 for free: a dev server re-parented to init
// when its shell exited is severed from the tree, but still carries the
// inherited environment, so it is still attributed.
func (s *sampler) attribute(samples []procSample) map[int]identity {
	byPID := make(map[int]procSample, len(samples))
	children := make(map[int][]int, len(samples))
	for _, sample := range samples {
		byPID[sample.PID] = sample
	}
	var roots []int
	for _, sample := range samples {
		// A process whose parent is not in the table (init's children, or a
		// process whose parent exited during the scan) is a root of its own
		// visible tree. Guarding on self-parenting keeps a corrupt reading
		// from building a cycle.
		if _, ok := byPID[sample.PPID]; ok && sample.PPID != sample.PID {
			children[sample.PPID] = append(children[sample.PPID], sample.PID)
		} else {
			roots = append(roots, sample.PID)
		}
	}

	owners := map[int]identity{}
	live := make(map[string]bool, len(samples))

	// Breadth-first from the roots guarantees a parent is resolved before its
	// children, which is what makes single-pass inheritance correct.
	queue := append([]int(nil), roots...)
	for len(queue) > 0 {
		pid := queue[0]
		queue = queue[1:]
		sample := byPID[pid]
		live[sample.StartKey] = true

		if own, ok := s.lookupIdentity(sample); ok {
			owners[pid] = own
		} else if parent, ok := owners[sample.PPID]; ok {
			owners[pid] = parent
		}
		queue = append(queue, children[pid]...)
	}

	// Prune the caches to processes that still exist, so a long-running
	// backend does not accumulate an entry per process the machine has ever
	// run.
	for key := range s.identities {
		if !live[key] {
			delete(s.identities, key)
		}
	}
	for key := range s.memory {
		if !live[key] {
			delete(s.memory, key)
		}
	}
	return owners
}

// memoryFor returns a process's memory reading, refreshing it only once per
// memoryTTL. The reading is keyed on the process's stable identity, so a
// recycled PID gets its own measurement rather than the previous occupant's.
func (s *sampler) memoryFor(sample procSample, now time.Time) (uint64, string) {
	if cached, ok := s.memory[sample.StartKey]; ok && now.Sub(cached.at) < memoryTTL {
		return cached.bytes, cached.basis
	}
	bytes, basis := s.scanner.memoryBytes(sample.PID, sample.RSSBytes)
	s.memory[sample.StartKey] = memoryReading{bytes: bytes, basis: basis, at: now}
	return bytes, basis
}

func (s *sampler) lookupIdentity(sample procSample) (identity, bool) {
	if cached, ok := s.identities[sample.StartKey]; ok {
		if cached == nil {
			return identity{}, false
		}
		return *cached, true
	}
	taskID, sessionID, ok := s.scanner.identity(sample.PID)
	if !ok {
		s.identities[sample.StartKey] = nil
		return identity{}, false
	}
	resolved := identity{taskID: taskID, sessionID: sessionID}
	s.identities[sample.StartKey] = &resolved
	return resolved, true
}
