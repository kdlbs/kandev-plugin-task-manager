package main

import (
	"bytes"
	"os"
	"strconv"
	"strings"
)

// linuxScanner reads everything from /proc. No cgo, no shelling out, no
// external dependency: the files it needs are readable by the process's own
// user, which is the user kandev runs its agents as.
type linuxScanner struct {
	pageSize uint64
}

func newScanner() procScanner {
	return &linuxScanner{pageSize: uint64(os.Getpagesize())}
}

// clockTicks is the kernel's USER_HZ, the unit of the utime/stime fields in
// /proc/<pid>/stat. Reading it properly means sysconf(_SC_CLK_TCK), which
// needs cgo; the value has been 100 on every mainstream Linux build for
// decades, and the kernel documents it as fixed for the /proc ABI.
const clockTicks = 100.0

func (s *linuxScanner) platform() string { return "linux" }

// totalMemoryBytes reads MemTotal from /proc/meminfo.
func (s *linuxScanner) totalMemoryBytes() uint64 {
	raw, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 0
	}
	return parseMemTotalBytes(raw)
}

// parseMemTotalBytes is totalMemoryBytes's pure half. meminfo reports
// MemTotal in kibibytes.
func parseMemTotalBytes(raw []byte) uint64 {
	for _, line := range strings.Split(string(raw), "\n") {
		value, ok := strings.CutPrefix(line, "MemTotal:")
		if !ok {
			continue
		}
		fields := strings.Fields(value)
		if len(fields) == 0 {
			return 0
		}
		return parseUint(fields[0]) * 1024
	}
	return 0
}

func (s *linuxScanner) scan() ([]procSample, error) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil, err
	}
	samples := make([]procSample, 0, len(entries))
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue // not a pid directory
		}
		sample, ok := s.readStat(pid)
		if !ok {
			// The process exited between ReadDir and the read. That is
			// normal and frequent; skipping it is the whole handling.
			continue
		}
		sample.Command = truncateCommand(readCmdline(pid))
		samples = append(samples, sample)
	}
	return samples, nil
}

// readStat parses /proc/<pid>/stat. The format is positional and mostly
// space-separated, with one hazard: field 2 is the executable name in
// parentheses and may itself contain spaces and parentheses (a process can
// set any comm it likes). Splitting the whole line on spaces therefore
// misaligns every later field. Anchoring on the LAST ')' is the documented
// way to parse it.
func (s *linuxScanner) readStat(pid int) (procSample, bool) {
	raw, err := os.ReadFile(procPath(pid, "stat"))
	if err != nil {
		return procSample{}, false
	}
	return parseStatLine(pid, raw, s.pageSize)
}

// parseStatLine is readStat's pure half, split out so the field arithmetic
// can be tested against known-awkward comm values.
func parseStatLine(pid int, raw []byte, pageSize uint64) (procSample, bool) {
	open := bytes.IndexByte(raw, '(')
	closing := bytes.LastIndexByte(raw, ')')
	if open < 0 || closing < 0 || closing < open {
		return procSample{}, false
	}
	name := string(raw[open+1 : closing])

	// fields[0] is field 3 (state), so /proc field N is fields[N-3].
	fields := strings.Fields(string(raw[closing+1:]))
	const (
		idxPPID      = 4 - 3
		idxUTime     = 14 - 3
		idxSTime     = 15 - 3
		idxStartTime = 22 - 3
		idxRSSPages  = 24 - 3
	)
	if len(fields) <= idxRSSPages {
		return procSample{}, false
	}

	ppid, err := strconv.Atoi(fields[idxPPID])
	if err != nil {
		return procSample{}, false
	}
	utime := parseUint(fields[idxUTime])
	stime := parseUint(fields[idxSTime])
	rssPages := parseUint(fields[idxRSSPages])

	return procSample{
		PID:        pid,
		PPID:       ppid,
		Name:       name,
		CPUSeconds: float64(utime+stime) / clockTicks,
		RSSBytes:   rssPages * pageSize,
		StartKey:   strconv.Itoa(pid) + ":" + fields[idxStartTime],
	}, true
}

func (s *linuxScanner) identity(pid int) (string, string, bool) {
	raw, err := os.ReadFile(procPath(pid, "environ"))
	if err != nil {
		return "", "", false
	}
	return identityFromEnviron(raw)
}

// memoryBytes prefers PSS from smaps_rollup. Summing RSS over an agent's
// process tree overstates it badly — a node parent and its forked children
// share most of their pages, and RSS charges those pages in full to every
// process mapping them. PSS charges each shared page once, split across the
// mappers, so a tree sum is meaningful.
//
// smaps_rollup can be absent (kernels before 4.14) or unreadable; RSS is the
// honest fallback and the basis string says so.
func (s *linuxScanner) memoryBytes(pid int, rss uint64) (uint64, string) {
	raw, err := os.ReadFile(procPath(pid, "smaps_rollup"))
	if err != nil {
		return rss, basisRSS
	}
	return parsePssBytes(raw, rss)
}

// parsePssBytes is memoryBytes's pure half. smaps_rollup reports "Pss:" in
// kibibytes; anything else in the file is irrelevant here.
func parsePssBytes(raw []byte, rss uint64) (uint64, string) {
	for _, line := range strings.Split(string(raw), "\n") {
		value, ok := strings.CutPrefix(line, "Pss:")
		if !ok {
			continue
		}
		fields := strings.Fields(value)
		if len(fields) == 0 {
			break
		}
		return parseUint(fields[0]) * 1024, basisPSS
	}
	return rss, basisRSS
}

func readCmdline(pid int) string {
	raw, err := os.ReadFile(procPath(pid, "cmdline"))
	if err != nil {
		return ""
	}
	// argv arrives NUL-separated with a trailing NUL.
	return strings.TrimSpace(strings.ReplaceAll(strings.TrimRight(string(raw), "\x00"), "\x00", " "))
}

func procPath(pid int, file string) string {
	return "/proc/" + strconv.Itoa(pid) + "/" + file
}
