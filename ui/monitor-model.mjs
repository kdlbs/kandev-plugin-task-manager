export const MONITOR_SETTINGS_VERSION = 1;
export const MONITOR_STORAGE_SCOPE = "instance";
export const MONITOR_STORAGE_SCOPE_ID = "profile";
export const MONITOR_STORAGE_KEY = "topbar-settings-v1";

export const METRIC_IDS = Object.freeze([
  "cpu",
  "memory",
  "disk",
  "cpu_temperature",
  "system_load",
]);

const CPU_MODES = new Set(["host_relative", "tasks_relative", "tasks_per_core"]);
const MEMORY_UNITS = new Set(["percent", "gb"]);
const DISK_VISIBILITY = new Set(["always", "threshold"]);
const DEFAULT_DISK_THRESHOLD = 80;

const DEFAULT_METRICS = Object.freeze([
  Object.freeze({ id: "cpu", enabled: true, mode: "tasks_per_core", show_bar: true }),
  Object.freeze({ id: "memory", enabled: false, unit: "percent", show_bar: true }),
  Object.freeze({
    id: "disk",
    enabled: false,
    show_bar: true,
    visibility: "always",
    threshold_percent: DEFAULT_DISK_THRESHOLD,
  }),
  Object.freeze({ id: "cpu_temperature", enabled: false }),
  Object.freeze({ id: "system_load", enabled: false }),
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneMetric(metric) {
  return { ...metric };
}

export function defaultMonitorSettings() {
  return {
    version: MONITOR_SETTINGS_VERSION,
    metrics: DEFAULT_METRICS.map(cloneMetric),
  };
}

export function normalizeMonitorSettings(value) {
  if (!isRecord(value) || value.version !== MONITOR_SETTINGS_VERSION || !Array.isArray(value.metrics)) {
    return defaultMonitorSettings();
  }

  const defaults = new Map(DEFAULT_METRICS.map((metric) => [metric.id, metric]));
  const metrics = [];
  const seen = new Set();
  for (const candidate of value.metrics) {
    if (!isRecord(candidate) || typeof candidate.id !== "string" || !defaults.has(candidate.id)) {
      continue;
    }
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    metrics.push(normalizeMetric(candidate, defaults.get(candidate.id)));
  }
  for (const metric of DEFAULT_METRICS) {
    if (!seen.has(metric.id)) metrics.push(cloneMetric(metric));
  }
  return { version: MONITOR_SETTINGS_VERSION, metrics };
}

function normalizeMetric(candidate, fallback) {
  const metric = { ...fallback };
  if (typeof candidate.enabled === "boolean") metric.enabled = candidate.enabled;
  if (candidate.id === "cpu") {
    if (CPU_MODES.has(candidate.mode)) metric.mode = candidate.mode;
    if (typeof candidate.show_bar === "boolean") metric.show_bar = candidate.show_bar;
  } else if (candidate.id === "memory") {
    if (MEMORY_UNITS.has(candidate.unit)) metric.unit = candidate.unit;
    if (typeof candidate.show_bar === "boolean") metric.show_bar = candidate.show_bar;
  } else if (candidate.id === "disk") {
    if (typeof candidate.show_bar === "boolean") metric.show_bar = candidate.show_bar;
    if (DISK_VISIBILITY.has(candidate.visibility)) metric.visibility = candidate.visibility;
    const threshold = normalizeThreshold(candidate.threshold_percent);
    if (threshold !== null) metric.threshold_percent = threshold;
  }
  return metric;
}

function normalizeThreshold(value) {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1 || value > 100) {
    return null;
  }
  return value;
}

export function settingsRevision(settings) {
  return JSON.stringify(normalizeMonitorSettings(settings));
}

export function settingsEqual(left, right) {
  return settingsRevision(left) === settingsRevision(right);
}

export function enabledMetricIds(settings) {
  return normalizeMonitorSettings(settings).metrics.filter((metric) => metric.enabled).map((metric) => metric.id);
}

export function metricForId(settings, id) {
  return normalizeMonitorSettings(settings).metrics.find((metric) => metric.id === id);
}

export function cpuSourceForMode(mode) {
  return mode === "host_relative" ? "host" : "tasks";
}

export function summaryRequestForSettings(settings) {
  const normalized = normalizeMonitorSettings(settings);
  const ids = normalized.metrics.filter((metric) => metric.enabled).map((metric) => metric.id);
  const cpu = normalized.metrics.find((metric) => metric.id === "cpu" && metric.enabled);
  return cpu ? { metric_ids: ids, cpu_source: cpuSourceForMode(cpu.mode) } : { metric_ids: ids };
}

export function cpuDisplayPercent(metric, sample) {
  if (!sample || !sample.available) return null;
  return metric.mode === "tasks_per_core" ? sample.core_percent : sample.relative_percent;
}

export function metricProgressPercent(id, sample) {
  if (!sample || !sample.available) return null;
  if (id === "cpu") return sample.relative_percent;
  if (id === "memory" || id === "disk") return sample.percent;
  return null;
}

export function diskIsVisible(metric, sample) {
  if (!sample || !metric || metric.id !== "disk") return false;
  if (!metric.enabled) return false;
  if (!sample.available || metric.visibility === "always") return true;
  return sample.percent >= metric.threshold_percent;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  const megabytes = bytes / (1024 * 1024);
  if (megabytes < 1024) return `${Math.round(megabytes)} MB`;
  return `${(megabytes / 1024).toFixed(1)} GB`;
}

export function formatGB(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 GB";
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function formatPercent(value) {
  if (!Number.isFinite(value) || value < 0.05) return "0%";
  if (value < 10) return `${value.toFixed(1)}%`;
  return `${Math.round(value)}%`;
}

export function progressFraction(value) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(1, value / 100);
}

export function progressWidth(value) {
  const fraction = progressFraction(value);
  return fraction === 0 ? "0%" : `${Math.max(1.5, fraction * 100)}%`;
}

export function reorderMetrics(metrics, fromId, toId) {
  const current = Array.isArray(metrics) ? metrics.map(cloneMetric) : [];
  const from = current.findIndex((metric) => metric.id === fromId);
  const to = current.findIndex((metric) => metric.id === toId);
  if (from < 0 || to < 0 || from === to) return current;
  const [moved] = current.splice(from, 1);
  current.splice(current.findIndex((metric) => metric.id === toId), 0, moved);
  return current;
}

export function moveMetric(metrics, id, direction) {
  const current = Array.isArray(metrics) ? metrics.map(cloneMetric) : [];
  const index = current.findIndex((metric) => metric.id === id);
  const next = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || next < 0 || next >= current.length) return current;
  [current[index], current[next]] = [current[next], current[index]];
  return current;
}

export function normalizeDiskThreshold(value, fallback = DEFAULT_DISK_THRESHOLD) {
  return normalizeThreshold(value) ?? fallback;
}

export { DEFAULT_DISK_THRESHOLD };
