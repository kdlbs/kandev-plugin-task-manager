package main

import (
	"bytes"
	"encoding/binary"
	"strconv"
	"strings"
)

// The pure parsers behind the macOS scanner. They live outside the
// darwin-tagged file on purpose: parsing `ps` output and a KERN_PROCARGS2
// blob is where the bugs are, and keeping the functions platform-neutral
// means their tests run on every machine and in CI, not only on a Mac.

// lstartTokens is the number of whitespace-separated tokens in ps's `lstart`
// column ("Wed Aug 20 12:00:00 2026"). It is fixed, which is what makes a
// format carrying both lstart and a space-bearing command column parseable.
const lstartTokens = 5

// psFormat is the column set the scanner requests. Order matters: the two
// variable-width columns are last, and lstart's token count is fixed, so the
// row can be split positionally from both ends.
const psFormat = "pid=,ppid=,rss=,time=,lstart=,command="

// parsePSLine parses one `pid ppid rss time lstart... command...` row.
func parsePSLine(line string) (procSample, bool) {
	fields := strings.Fields(line)
	const fixedFields = 4
	if len(fields) < fixedFields+lstartTokens+1 {
		return procSample{}, false
	}
	pid, err := strconv.Atoi(fields[0])
	if err != nil {
		return procSample{}, false
	}
	ppid, err := strconv.Atoi(fields[1])
	if err != nil {
		return procSample{}, false
	}
	start := strings.Join(fields[fixedFields:fixedFields+lstartTokens], " ")
	command := strings.Join(fields[fixedFields+lstartTokens:], " ")

	return procSample{
		PID:  pid,
		PPID: ppid,
		// ps reports the full path; the basename is what a process list wants.
		Name:       baseName(fields[fixedFields+lstartTokens]),
		Command:    truncateCommand(command),
		CPUSeconds: parsePSTime(fields[3]),
		RSSBytes:   parseUint(fields[2]) * 1024, // ps reports KiB
		StartKey:   strconv.Itoa(pid) + ":" + start,
	}, true
}

// parsePSTime reads ps's cumulative TIME column. macOS renders it as
// "MM:SS.CC", widening to "HH:MM:SS.CC" and "D-HH:MM:SS.CC" for long-lived
// processes, so the parser folds colon-separated groups left to right and
// treats a leading "D-" as days.
func parsePSTime(field string) float64 {
	var days float64
	if before, after, found := strings.Cut(field, "-"); found {
		days, _ = strconv.ParseFloat(before, 64)
		field = after
	}
	var seconds float64
	for _, part := range strings.Split(field, ":") {
		value, err := strconv.ParseFloat(part, 64)
		if err != nil {
			return 0
		}
		seconds = seconds*60 + value
	}
	return days*86400 + seconds
}

func baseName(path string) string {
	if idx := strings.LastIndexByte(path, '/'); idx >= 0 {
		return path[idx+1:]
	}
	return path
}

// environBlockFromProcargs2 extracts the environment section of a
// KERN_PROCARGS2 blob, whose layout is:
//
//	int32 argc | exec_path\0 | \0 padding | argv[0..argc-1] | envp... | ...
//
// There is no length prefix on the environment section, so the only way in is
// to step over exactly argc argv strings first.
func environBlockFromProcargs2(raw []byte) ([]byte, bool) {
	const argcSize = 4
	if len(raw) < argcSize {
		return nil, false
	}
	argc := int(int32(binary.NativeEndian.Uint32(raw[:argcSize])))
	if argc < 0 {
		return nil, false
	}
	rest := raw[argcSize:]

	// Step over the exec path, then over the NUL padding that aligns argv.
	end := bytes.IndexByte(rest, 0)
	if end < 0 {
		return nil, false
	}
	rest = rest[end:]
	for len(rest) > 0 && rest[0] == 0 {
		rest = rest[1:]
	}

	// Step over argc argv strings. Running out mid-way means the blob was
	// truncated (sysctl caps its size), so there is no environment to read.
	for range argc {
		end := bytes.IndexByte(rest, 0)
		if end < 0 {
			return nil, false
		}
		rest = rest[end+1:]
	}
	return rest, true
}
