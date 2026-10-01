package main

import (
	"context"
	"testing"
)

func TestSampleTaskCPUDoesNotReadMemory(t *testing.T) {
	scanner := &fakeScanner{
		tables: [][]procSample{agentTree(10, 4), agentTree(10.35, 4)},
		env:    agentEnv(),
	}
	sampler, _ := newTestSampler(scanner)

	core, relative, err := sampler.sampleTaskCPU(context.Background(), 4)
	if err != nil {
		t.Fatalf("sampleTaskCPU: %v", err)
	}
	if core < 49.9 || core > 50.1 {
		t.Fatalf("task CPU = %.2f%%, want approximately 50%% of one core", core)
	}
	if relative < 12.4 || relative > 12.6 {
		t.Fatalf("relative task CPU = %.2f%%, want approximately 12.5%%", relative)
	}
	if scanner.memCalls != 0 {
		t.Fatalf("ambient task CPU read memory %d times", scanner.memCalls)
	}
}
