import test from "node:test";
import assert from "node:assert/strict";

import {
  defaultMonitorSettings,
  diskIsVisible,
  enabledMetricIds,
  cpuDisplayPercent,
  formatGB,
  formatPercent,
  metricProgressPercent,
  moveMetric,
  normalizeDiskThreshold,
  normalizeMonitorSettings,
  progressWidth,
  reorderMetrics,
  settingsEqual,
  summaryRequestForSettings,
} from "./monitor-model.mjs";

test("defaults preserve the original CPU per-core bar", () => {
  const settings = defaultMonitorSettings();

  assert.deepEqual(settings.metrics.map((metric) => metric.id), [
    "cpu",
    "memory",
    "disk",
    "cpu_temperature",
    "system_load",
  ]);
  assert.deepEqual(settings.metrics[0], {
    id: "cpu",
    enabled: true,
    mode: "tasks_per_core",
    show_bar: true,
  });
  assert.deepEqual(enabledMetricIds(settings), ["cpu"]);
});

test("normalization keeps valid order, removes duplicates, and appends new metrics", () => {
  const settings = normalizeMonitorSettings({
    version: 1,
    metrics: [
      { id: "disk", enabled: true, visibility: "threshold", threshold_percent: 100 },
      { id: "cpu", enabled: false, mode: "tasks_relative", show_bar: false },
      { id: "disk", enabled: false, visibility: "always" },
      { id: "unknown", enabled: true },
    ],
  });

  assert.deepEqual(settings.metrics.map((metric) => metric.id), [
    "disk",
    "cpu",
    "memory",
    "cpu_temperature",
    "system_load",
  ]);
  assert.equal(settings.metrics[0].threshold_percent, 100);
  assert.equal(settings.metrics[1].mode, "tasks_relative");
  assert.equal(settings.metrics[1].show_bar, false);
  assert.equal(settings.metrics[2].enabled, false);
});

test("invalid saved values normalize to safe defaults", () => {
  const settings = normalizeMonitorSettings({
    version: 1,
    metrics: [
      { id: "cpu", enabled: "yes", mode: "bad", show_bar: 1 },
      { id: "memory", enabled: true, unit: "bytes", show_bar: false },
      { id: "disk", enabled: true, threshold_percent: 0, visibility: "bad" },
    ],
  });

  assert.equal(settings.metrics[0].enabled, true);
  assert.equal(settings.metrics[0].mode, "tasks_per_core");
  assert.equal(settings.metrics[0].show_bar, true);
  assert.equal(settings.metrics[1].unit, "percent");
  assert.equal(settings.metrics[2].threshold_percent, 80);
  assert.equal(settings.metrics[2].visibility, "always");
});

test("summary request samples only enabled families and selects the CPU source", () => {
  const settings = normalizeMonitorSettings({
    version: 1,
    metrics: [
      { id: "memory", enabled: true, unit: "gb", show_bar: true },
      { id: "cpu", enabled: true, mode: "host_relative", show_bar: true },
    ],
  });

  assert.deepEqual(summaryRequestForSettings(settings), {
    metric_ids: ["memory", "cpu"],
    cpu_source: "host",
  });
  assert.deepEqual(summaryRequestForSettings({
    version: 1,
    metrics: settings.metrics.map((metric) => ({ ...metric, enabled: false })),
  }), { metric_ids: [] });
});

test("disk threshold includes the edge and keeps unavailable readings visible", () => {
  const metric = {
    id: "disk",
    enabled: true,
    visibility: "threshold",
    threshold_percent: 80,
    show_bar: true,
  };

  assert.equal(diskIsVisible(metric, { available: true, percent: 79.99 }), false);
  assert.equal(diskIsVisible(metric, { available: true, percent: 80 }), true);
  assert.equal(diskIsVisible(metric, { available: false, error: "unsupported" }), true);
  assert.equal(diskIsVisible(metric, null), false);
});

test("CPU display scale and capacity bars stay independent", () => {
  const sample = { available: true, core_percent: 273, relative_percent: 17.1, percent: 25 };

  assert.equal(cpuDisplayPercent({ mode: "tasks_per_core" }, sample), 273);
  assert.equal(cpuDisplayPercent({ mode: "tasks_relative" }, sample), 17.1);
  assert.equal(metricProgressPercent("cpu", sample), 17.1);
  assert.equal(metricProgressPercent("memory", sample), 25);
  assert.equal(metricProgressPercent("disk", sample), 25);
  assert.equal(metricProgressPercent("system_load", sample), null);
  assert.equal(metricProgressPercent("memory", { available: false }), null);
});

test("reordering is stable and progress is bounded", () => {
  const metrics = defaultMonitorSettings().metrics;
  const moved = moveMetric(metrics, "cpu_temperature", "up");
  const reordered = reorderMetrics(moved, "disk", "cpu");

  assert.deepEqual(reordered.map((metric) => metric.id), [
    "disk",
    "cpu",
    "memory",
    "cpu_temperature",
    "system_load",
  ]);
  assert.equal(progressWidth(-1), "0%");
  assert.equal(progressWidth(0), "0%");
  assert.equal(progressWidth(100), "100%");
  assert.equal(progressWidth(160), "100%");
});

test("formatters do not turn missing values into false measurements", () => {
  assert.equal(formatGB(0), "0 GB");
  assert.equal(formatGB(Number.NaN), "0 GB");
  assert.equal(formatPercent(Number.NaN), "0%");
  assert.equal(normalizeDiskThreshold(101), 80);
  assert.equal(settingsEqual(defaultMonitorSettings(), { version: 1, metrics: [] }), true);
});
