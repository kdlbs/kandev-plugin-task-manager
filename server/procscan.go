// Package main implements the kandev-plugin-task-manager plugin backend.
//
// The plugin answers one question: for each kandev task with a live agent,
// how much CPU and memory is that task actually costing this machine right
// now? It answers it from the host kernel, not from anything kandev records.
//
// Attribution is exact rather than heuristic. Kandev exports KANDEV_TASK_ID
// and KANDEV_SESSION_ID into the ACP agent's environment, and every process
// the agent spawns (its tool calls, `npm`, `go test`, a dev server) inherits
// that environment. So a process belongs to a task if its own environment
// names the task, or if any of its ancestors' does. See sampler.go for how
// the two are combined.
package main

import (
	"bytes"
	"strconv"
)

// The environment variables kandev exports into every agent process. They are
// the whole attribution mechanism; if kandev ever stops exporting them the
// plugin reports no tasks rather than guessing.
const (
	envTaskID    = "KANDEV_TASK_ID"
	envSessionID = "KANDEV_SESSION_ID"
)

// What a memory figure was actually measured from, reported alongside the
// number so the UI never implies more precision than the platform gave.
const (
	basisPSS = "pss"
	basisRSS = "rss"
)

// procSample is one process as the kernel described it at one instant.
type procSample struct {
	PID  int
	PPID int
	// Name is the short executable name ("claude", "node"), for display.
	Name string
	// Command is the argv-derived command line, truncated for display. It may
	// be empty for processes whose argv is unreadable.
	Command string
	// CPUSeconds is cumulative user+system CPU consumed since the process
	// started. Instantaneous CPU% is a delta of this between two samples —
	// never a lifetime average like `ps %cpu`, which reports an idle agent
	// that was once busy as though it were still busy.
	CPUSeconds float64
	// RSSBytes is resident set size. It double-counts pages shared between a
	// parent and its children, so a tree rollup prefers PSS where the
	// platform can supply it (see resolveMemory).
	RSSBytes uint64
	// StartKey identifies this process across samples. A PID alone is not
	// enough: the kernel recycles PIDs, and a recycled PID inheriting the
	// previous occupant's cumulative CPU time would report a large negative
	// (clamped to zero) or absurd delta. Pairing the PID with its start time
	// makes the identity stable.
	StartKey string
}

// procScanner is the platform-specific half of the sampler.
type procScanner interface {
	// scan returns every process this user can see. Processes owned by other
	// users are outside the plugin's reach on both supported platforms, and
	// kandev's agents always run as the backend's own user.
	scan() ([]procSample, error)

	// identity reads pid's environment and returns the kandev task and
	// session it was launched for. ok is false when the process carries no
	// kandev identity, or when its environment cannot be read at all — the
	// caller treats both the same way, since neither yields an attribution.
	identity(pid int) (taskID, sessionID string, ok bool)

	// memoryBytes returns a better per-process memory figure than RSS when
	// the platform can supply one (Linux: PSS, which splits shared pages
	// proportionally between the processes mapping them). basis names what
	// was actually measured so the UI can label it honestly. Returning the
	// input RSS unchanged with basis "rss" is a valid implementation.
	memoryBytes(pid int, rss uint64) (bytes uint64, basis string)

	// totalMemoryBytes is the machine's installed physical memory, the
	// denominator that turns a task's memory figure into a proportion. 0 when
	// the platform cannot report it, which the UI treats as "no scale".
	totalMemoryBytes() uint64

	// platform is the GOOS-style name reported to the UI.
	platform() string
}

// maxCommandLen bounds the command line kept for display. The UI shows one
// line per process; a multi-megabyte argv would bloat every poll response.
const maxCommandLen = 160

func truncateCommand(s string) string {
	if len(s) <= maxCommandLen {
		return s
	}
	return s[:maxCommandLen-1] + "…"
}

// identityFromEnviron pulls the kandev ids out of a NUL-separated environment
// block, the shape both platforms end up with. A process counts as
// kandev-owned on KANDEV_TASK_ID alone: the session id is useful context, but
// a process whose session id is missing is still that task's process.
func identityFromEnviron(raw []byte) (taskID, sessionID string, ok bool) {
	for _, entry := range bytes.Split(raw, []byte{0}) {
		key, value, found := bytes.Cut(entry, []byte{'='})
		if !found {
			continue
		}
		// First occurrence wins. A well-formed environment block holds each
		// name once, so this only matters when something upstream handed us a
		// block that also contains argv — in which case the earlier entry is
		// the one the caller was actually asked about, and letting a later
		// duplicate overwrite it would silently paper over that bug.
		switch {
		case string(key) == envTaskID && taskID == "":
			taskID = string(value)
		case string(key) == envSessionID && sessionID == "":
			sessionID = string(value)
		}
		if taskID != "" && sessionID != "" {
			break
		}
	}
	if taskID == "" {
		return "", "", false
	}
	return taskID, sessionID, true
}

func parseUint(s string) uint64 {
	v, err := strconv.ParseUint(s, 10, 64)
	if err != nil {
		return 0
	}
	return v
}
