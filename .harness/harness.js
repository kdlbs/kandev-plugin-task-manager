// Renders the shipped bundle against deterministic task and process fixtures.
(function () {
  const CORES = 8;

  // Keep timer callbacks controllable for the cadence assertion in shoot.mjs.
  // The production bundle still uses the browser timers; this only lets the
  // harness fire a long (300s) retry without waiting five minutes.
  const nativeSetTimeout = window.setTimeout.bind(window);
  const nativeClearTimeout = window.clearTimeout.bind(window);
  const scheduledTimers = new Set();
  window.setTimeout = (callback, delay, ...args) => {
    const record = {
      callback,
      delay: Number(delay) || 0,
      args,
      id: null,
    };
    const wrapped = () => {
      scheduledTimers.delete(record);
      callback(...args);
    };
    record.id = nativeSetTimeout(wrapped, delay);
    scheduledTimers.add(record);
    return record.id;
  };
  window.clearTimeout = (id) => {
    for (const record of scheduledTimers) {
      if (record.id !== id) continue;
      scheduledTimers.delete(record);
      break;
    }
    return nativeClearTimeout(id);
  };
  window.__pendingTimerDelays = () =>
    [...scheduledTimers].filter((record) => record.id !== null).map((record) => record.delay);
  window.__runScheduledTimer = (minimumDelay = 0) => {
    const record = [...scheduledTimers]
      .reverse()
      .find((candidate) => candidate.delay >= minimumDelay);
    if (!record) throw new Error(`no pending timer at least ${minimumDelay}ms`);
    scheduledTimers.delete(record);
    nativeClearTimeout(record.id);
    return record.callback(...record.args);
  };
  const LONG_CMD =
    "node ./fixtures/fake-worker.js --mode=sample --input=synthetic-value --payload=" + "x".repeat(512);

  function proc(pid, name, cpu, mem, command) {
    return { pid, ppid: 1, name, cpu_percent: cpu, memory_bytes: mem * 1024 * 1024, command };
  }

  const TASKS = [
    {
      task_id: "sample-task-01",
      title: "Synthetic workload alpha",
      identifier: "TEST-101",
      state: "IN_PROGRESS",
      session_ids: ["sample-session-01"],
      cpu_percent: 380,
      memory_bytes: 920 * 1024 * 1024,
      memory_basis: "pss",
      processes: [proc(81001, "fake-worker", 310, 640, LONG_CMD), proc(81002, "fake-tool", 70, 280, "fake-tool --sample")],
    },
    {
      task_id: "sample-task-02",
      title: "Synthetic workload beta",
      identifier: "TEST-102",
      state: "IN_PROGRESS",
      session_ids: ["sample-session-02"],
      cpu_percent: 390,
      memory_bytes: 710 * 1024 * 1024,
      memory_basis: "pss",
      processes: [proc(82001, "fake-worker", 390, 710, LONG_CMD)],
    },
    {
      task_id: "sample-task-03",
      title: "Synthetic workload gamma with a long title for layout checks",
      identifier: "TEST-103",
      state: "IN_PROGRESS",
      session_ids: ["sample-session-03"],
      cpu_percent: 8.2,
      memory_bytes: 350 * 1024 * 1024,
      memory_basis: "rss",
      processes: [proc(83001, "fake-worker", 8.2, 350, LONG_CMD)],
    },
    {
      task_id: "sample-task-04",
      title: "Synthetic workload delta",
      identifier: "TEST-104",
      state: "CREATED",
      session_ids: ["sample-session-04"],
      cpu_percent: 0,
      memory_bytes: 290 * 1024 * 1024,
      memory_basis: "pss",
      processes: [proc(84001, "fake-worker", 0, 290, LONG_CMD)],
    },
    {
      task_id: "sample-task-05",
      title: "Synthetic workload epsilon",
      identifier: "TEST-105",
      state: "CREATED",
      session_ids: ["sample-session-05"],
      cpu_percent: 0,
      memory_bytes: 270 * 1024 * 1024,
      memory_basis: "pss",
      processes: [proc(85001, "fake-worker", 0, 270, LONG_CMD)],
    },
    {
      task_id: "sample-task-06",
      title: "Synthetic workload zeta",
      identifier: "TEST-106",
      state: "CREATED",
      session_ids: ["sample-session-06"],
      cpu_percent: 0,
      memory_bytes: 250 * 1024 * 1024,
      memory_basis: "pss",
      processes: [proc(86001, "fake-worker", 0, 250, LONG_CMD)],
    },
    {
      task_id: "sample-task-07",
      title: "Synthetic idle task 7",
      identifier: "TEST-107",
      state: "CREATED",
      session_ids: ["sample-session-07"],
      cpu_percent: 0.8,
      memory_bytes: 230 * 1024 * 1024,
      memory_basis: "pss",
      processes: [proc(87001, "fake-worker", 0.8, 230, LONG_CMD)],
    },
    {
      task_id: "sample-task-08",
      title: "Synthetic idle task 8",
      identifier: "TEST-108",
      state: "CREATED",
      session_ids: ["sample-session-08"],
      cpu_percent: 0,
      memory_bytes: 210 * 1024 * 1024,
      memory_basis: "pss",
      processes: [proc(88001, "fake-worker", 0, 210, LONG_CMD)],
    },
  ];

  const REPORT = {
    sampled_at: new Date().toISOString(),
    interval_seconds: 0.74,
    platform: "linux",
    cpu_cores: CORES,
    total_memory_bytes: 16 * 1024 * 1024 * 1024,
    supported: true,
    tasks: TASKS,
  };

  const h = window.React.createElement;
  let translationCatalog = {};
  const storageListeners = new Set();
  const saveContributors = new Map();
  let monitorStorage = null;
  let monitorStorageUpdatedAt = null;

  function clone(value) {
    return value === undefined ? value : JSON.parse(JSON.stringify(value));
  }

  function translate(key, options) {
    let message = translationCatalog.en?.[key] || key;
    for (const [name, value] of Object.entries(options?.values || {})) {
      message = message.replaceAll(`{{${name}}}`, String(value));
    }
    return message;
  }

  function plainComponent(tag) {
    return function Component(props) {
      const { children, asChild, ...rest } = props || {};
      return h(tag, rest, children);
    };
  }

  function buttonComponent(props) {
    const { children, variant, size, ...rest } = props || {};
    return h("button", rest, children);
  }

  function checkComponent(props) {
    const { checked, onCheckedChange, children, ...rest } = props || {};
    return h("input", {
      ...rest,
      type: "checkbox",
      checked: Boolean(checked),
      onChange: (event) => onCheckedChange?.(event.target.checked),
    }, children);
  }

  const UI = {
    SettingsCard: plainComponent("section"),
    Card: plainComponent("section"),
    CardHeader: plainComponent("div"),
    CardTitle: plainComponent("h2"),
    CardContent: plainComponent("div"),
    Button: buttonComponent,
    Switch: checkComponent,
    Checkbox: checkComponent,
    Tooltip: plainComponent("span"),
    TooltipProvider: plainComponent("span"),
    TooltipTrigger: plainComponent("span"),
    TooltipContent: plainComponent("span"),
  };

  // Each poll swaps the CPU of the top two tasks, which is the churn that
  // made the real list reshuffle every second. The harness exaggerates it so
  // an ordering regression is unmissable rather than intermittent.
  let poll = 0;
  let summaryFetches = 0;
  let lastSummaryRequest = null;
  let summaryIntervalSeconds = 300;
  let summaryShouldFail = false;
  function reportForPoll() {
    poll += 1;
    const swing = poll % 2 === 0;
    const tasks = TASKS.map((task, index) => {
      if (index === 0) return { ...task, cpu_percent: swing ? 40 : 380 };
      if (index === 1) return { ...task, cpu_percent: swing ? 390 : 60 };
      if (index === TASKS.length - 1) return { ...task, cpu_percent: poll * 45 };
      if (index === TASKS.length - 2) return { ...task, cpu_percent: swing ? 0.8 : 1.2 };
      return task;
    });
    return { ...REPORT, tasks, sampled_at: new Date().toISOString() };
  }

  window.__pollCount = () => poll;
  window.__summaryFetchCount = () => summaryFetches;
  window.__lastSummaryRequest = () => clone(lastSummaryRequest);
  window.__setSummaryInterval = (seconds) => {
    summaryIntervalSeconds = seconds;
  };
  window.__setSummaryFailure = (shouldFail) => {
    summaryShouldFail = Boolean(shouldFail);
  };
  // Lets the ordering test restart the climbing task from idle, so its rank
  // is measured from a known starting point rather than wherever the earlier
  // steps happened to leave it.
  window.__resetClimb = () => {
    poll = 0;
  };

  function HarnessAction({ label, icon, text, tooltip, onClick, "data-testid": testId }) {
    return h(
      "button",
      { type: "button", "aria-label": label, title: tooltip, onClick, "data-testid": testId },
      icon,
      text,
    );
  }

  const mode = new URLSearchParams(window.location.search).get("host") || "action";
  const host = {
    React: window.React,
    jsx: h,
    theme: "dark",
    api: {
      fetch: (path, options = {}) => {
        if (path === "webhooks/summary") {
          summaryFetches += 1;
          if (summaryShouldFail) {
            return Promise.resolve({
              ok: false,
              status: 503,
              json: () => Promise.resolve({ error: "summary unavailable" }),
            });
          }
          let request = {};
          try {
            request = JSON.parse(options.body || "{}");
            lastSummaryRequest = request;
          } catch (_error) {
            return Promise.resolve({ ok: false, status: 400, json: () => Promise.resolve({ error: "bad request" }) });
          }
          const source = request.cpu_source || "tasks";
          const metrics = {};
          for (const id of request.metric_ids || []) {
            if (id === "cpu") {
              metrics.cpu = {
                available: true,
                source,
                core_percent: source === "host" ? 240 : 42,
                relative_percent: source === "host" ? 15 : 2.625,
              };
            } else if (id === "memory") {
              metrics.memory = {
                available: true,
                used_bytes: 8 * 1024 * 1024 * 1024,
                total_bytes: 32 * 1024 * 1024 * 1024,
                percent: 25,
              };
            } else if (id === "disk") {
              metrics.disk = {
                available: true,
                path: "/",
                used_bytes: 82 * 1024 * 1024 * 1024,
                total_bytes: 100 * 1024 * 1024 * 1024,
                percent: 82,
              };
            } else if (id === "cpu_temperature") {
              metrics.cpu_temperature = { available: true, celsius: 57.5 };
            } else if (id === "system_load") {
              metrics.system_load = { available: true, one_minute: 1.25 };
            }
          }
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              sampled_at: new Date().toISOString(),
              refresh_interval_seconds: summaryIntervalSeconds,
              cpu_cores: CORES,
              metrics,
            }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve(reportForPoll()) });
      },
      baseUrl: "",
    },
    navigate: (href) => console.log("navigate", href),
    openModal(options) {
      window.__modalContent = options.content;
      window.__modalTitle = options.title;
      return { close: () => {} };
    },
    ui: { ...UI, ...(mode === "legacy" ? {} : { Action: HarnessAction }) },
    i18n: {
      locale: "en",
      t: translate,
      useTranslation: () => ({ locale: "en", t: translate }),
    },
    storage: {
      get: async () => monitorStorageUpdatedAt
        ? { value: clone(monitorStorage), updatedAt: monitorStorageUpdatedAt }
        : null,
      set: async (_scope, _scopeId, _key, value, options = {}) => {
        if (options.ifUnmodifiedSince && options.ifUnmodifiedSince !== monitorStorageUpdatedAt) {
          const error = new Error("storage conflict");
          error.name = "PluginStorageConflictError";
          throw error;
        }
        monitorStorage = clone(value);
        monitorStorageUpdatedAt = new Date().toISOString();
        // The real host suppresses the writer's own subscription echo. The
        // controller publishes its local save directly; external updates use
        // __notifyMonitorStorage below.
        return { value: clone(monitorStorage), updatedAt: monitorStorageUpdatedAt };
      },
      subscribe: (_filter, handler) => {
        storageListeners.add(handler);
        return () => storageListeners.delete(handler);
      },
    },
    useSettingsSaveContributor: (contributor) => {
      saveContributors.set(contributor.id, contributor);
      window.__settingsContributor = contributor;
    },
  };

  window.__setMonitorStorage = (value) => {
    monitorStorage = clone(value);
    monitorStorageUpdatedAt = new Date().toISOString();
  };
  window.__notifyMonitorStorage = (value) => {
    monitorStorage = clone(value);
    monitorStorageUpdatedAt = new Date().toISOString();
    for (const listener of storageListeners) listener();
  };
  window.__saveMonitorSettings = () => {
    const contributor = window.__settingsContributor;
    return contributor ? contributor.save(contributor.revision) : Promise.reject(new Error("no settings contributor"));
  };
  window.__discardMonitorSettings = () => {
    const contributor = window.__settingsContributor;
    return contributor?.discard(contributor.revision);
  };

  const slots = {};
  const keys = {};
  const registry = {
    registerTranslations(catalogs) {
      translationCatalog = catalogs;
    },
    registerComponent(slot, Component) {
      slots[slot] = Component;
    },
    registerKeybinding(id, handler) {
      keys[id] = handler;
    },
  };

  window.registerKandevPlugin = (id, plugin) => {
    plugin.initialize(registry, host);
    keys["open-task-manager"]();

    window.__createRoot(document.getElementById("modal-body")).render(h(window.__modalContent));
    if (slots["main-top-bar"]) {
      const presentation = new URLSearchParams(window.location.search).get("presentation") || "desktop";
      window.__createRoot(document.getElementById("chip-slot")).render(
        h(slots["main-top-bar"], { slotProps: { presentation, currentPage: "kanban" } }),
      );
    }
    if (slots["plugin-settings"]) {
      window.__createRoot(document.getElementById("settings-body")).render(
        h(slots["plugin-settings"], { pluginId: id, status: "active" }),
      );
    }
    document.getElementById("modal-title").textContent = window.__modalTitle;
  };
})();
