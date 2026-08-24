package main

// Tests for the /proc parsers. Linux-suffixed so the file only builds where
// the code under test does — otherwise `GOOS=windows go vet` fails on
// symbols that platform never compiles.

import (
	"strings"
	"testing"
)

func TestParseStatLine(t *testing.T) {
	// Real shape of /proc/<pid>/stat, abbreviated to the fields that matter.
	// Fields: pid comm state ppid ... utime(14) stime(15) ... starttime(22)
	// ... rss(24, in pages).
	line := func(comm string) []byte {
		fields := []string{
			"S", "4242", "0", "0", "0", "0", "0", "0", "0", "0", // 3..12
			"0",                          // 13 cutime placeholder shift
			"150",                        // 14 utime
			"50",                         // 15 stime
			"0", "0", "0", "0", "0", "0", // 16..21
			"99887766", // 22 starttime
			"0",        // 23 vsize
			"1000",     // 24 rss (pages)
		}
		return []byte("1234 (" + comm + ") " + strings.Join(fields, " ") + "\n")
	}

	t.Run("ordinary comm", func(t *testing.T) {
		sample, ok := parseStatLine(1234, line("claude"), 4096)
		if !ok {
			t.Fatal("parse failed")
		}
		if sample.Name != "claude" {
			t.Errorf("name = %q", sample.Name)
		}
		if sample.PPID != 4242 {
			t.Errorf("ppid = %d, want 4242", sample.PPID)
		}
		// (150 + 50) ticks at 100 Hz = 2 seconds.
		if sample.CPUSeconds != 2 {
			t.Errorf("cpu = %v, want 2", sample.CPUSeconds)
		}
		if sample.RSSBytes != 1000*4096 {
			t.Errorf("rss = %d, want %d", sample.RSSBytes, 1000*4096)
		}
		if sample.StartKey != "1234:99887766" {
			t.Errorf("start key = %q", sample.StartKey)
		}
	})

	t.Run("comm containing spaces and parentheses", func(t *testing.T) {
		// A process can set any comm it likes. Splitting the line on spaces,
		// or anchoring on the FIRST ')', misaligns every later field — which
		// would silently report this process's ppid as garbage and hand it to
		// the wrong task.
		sample, ok := parseStatLine(1234, line("we (are) many"), 4096)
		if !ok {
			t.Fatal("parse failed")
		}
		if sample.Name != "we (are) many" {
			t.Errorf("name = %q, want the full comm", sample.Name)
		}
		if sample.PPID != 4242 {
			t.Errorf("ppid = %d, want 4242 — fields misaligned by the comm", sample.PPID)
		}
		if sample.CPUSeconds != 2 {
			t.Errorf("cpu = %v, want 2 — fields misaligned by the comm", sample.CPUSeconds)
		}
	})

	t.Run("truncated line", func(t *testing.T) {
		if _, ok := parseStatLine(1234, []byte("1234 (sh) S 1"), 4096); ok {
			t.Error("want a truncated stat line rejected, not partially parsed")
		}
	})

	t.Run("garbage", func(t *testing.T) {
		if _, ok := parseStatLine(1234, []byte("not a stat line"), 4096); ok {
			t.Error("want garbage rejected")
		}
	})
}

func TestParsePssBytes(t *testing.T) {
	rollup := []byte("Rss:              123456 kB\nPss:               65536 kB\nPss_Dirty:          100 kB\n")
	bytes, basis := parsePssBytes(rollup, 999)
	if basis != basisPSS {
		t.Fatalf("basis = %q, want %q", basis, basisPSS)
	}
	if bytes != 65536*1024 {
		t.Errorf("pss = %d, want %d", bytes, 65536*1024)
	}

	// Kernels before 4.14 have no smaps_rollup, and a container can deny it.
	// The fallback has to be RSS *and* say so, or a mixed tree would be
	// summed as though it were PSS.
	fallback, basis := parsePssBytes([]byte("Rss: 100 kB\n"), 777)
	if basis != basisRSS || fallback != 777 {
		t.Errorf("fallback = (%d, %q), want (777, %q)", fallback, basis, basisRSS)
	}
}
