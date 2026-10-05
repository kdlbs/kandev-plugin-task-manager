// Renders the shipped bundle against deterministic task and process fixtures.
(function () {
  const CORES = 8;
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

  let poll = 0;
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
  window.__resetClimb = () => {
    poll = 0;
  };

  const h = window.React.createElement;
  const translations = {};
  function HarnessAction({ label, icon, text, tooltip, onClick }) {
    return h(
      "button",
      { type: "button", "aria-label": label, title: tooltip, onClick, "data-testid": "host-action" },
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
      fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve(reportForPoll()) }),
      baseUrl: "",
    },
    navigate: (href) => console.log("navigate", href),
    openModal(options) {
      window.__modalContent = options.content;
      window.__modalTitle = options.title;
      return { close: () => {} };
    },
    i18n: {
      useTranslation() {
        return {
          t(key, options = {}) {
            const message = translations[key] || options.defaultValue || key;
            return message.replace(/\{\{(\w+)\}\}/g, (_match, name) => options.values?.[name] ?? "");
          },
        };
      },
    },
    ui: mode === "legacy" ? {} : { Action: HarnessAction },
  };

  const slots = {};
  const keys = {};
  const registry = {
    registerTranslations(catalogs) {
      Object.assign(translations, catalogs.en || {});
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
    document.getElementById("modal-title").textContent = window.__modalTitle;
  };
})();
