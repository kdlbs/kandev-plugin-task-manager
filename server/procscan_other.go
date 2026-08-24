//go:build !linux && !darwin && !windows

package main

import (
	"errors"
	"runtime"
)

// errUnsupportedPlatform is returned instead of guessed numbers. A task
// manager that silently reports zero CPU everywhere is worse than one that
// says it cannot measure this platform, so the UI renders the reason.
var errUnsupportedPlatform = errors.New("per-process CPU/memory sampling is implemented for Linux and macOS only")

type unsupportedScanner struct{}

func newScanner() procScanner { return &unsupportedScanner{} }

func (s *unsupportedScanner) platform() string { return runtime.GOOS }

func (s *unsupportedScanner) scan() ([]procSample, error) { return nil, errUnsupportedPlatform }

func (s *unsupportedScanner) identity(int) (string, string, bool) { return "", "", false }

func (s *unsupportedScanner) memoryBytes(_ int, rss uint64) (uint64, string) { return rss, basisRSS }

func (s *unsupportedScanner) totalMemoryBytes() uint64 { return 0 }
