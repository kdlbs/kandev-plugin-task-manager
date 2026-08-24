// Renders ../ui/bundle.js against a stub host, so the modal's layout can be
// inspected without standing up a kandev instance. The mock data is
// deliberately hostile: very long command lines, long task titles, and more
// tasks than fit, because those are what made the first version overflow.
(function () {
  const CORES = 16;

  const LONG_CMD =
    "/home/jcfs/.npm/_npx/d820eb7d96bc2600/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude " +
    "--output-format stream-json --verbose --input-format stream-json --permission-mode acceptEdits " +
    "--mcp-config /tmp/kandev-mcp-config-8837.json --append-system-prompt-file /tmp/kandev-sysprompt.md";

  function proc(pid, name, cpu, mem, cmd) {
    return { pid, ppid: 1, name, cpu_percent: cpu, memory_bytes: mem * 1024 * 1024, command: cmd };
  }

  const TASKS = [
    {
      task_id: "538d65b1-78e1-4dea-ac1d-dd7153fffd66",
      title: "Use shared formatBytes helper across the analytics and executor surfaces",
      identifier: "KAN-412",
      state: "IN_PROGRESS",
      session_ids: ["c8ba0816"],
      cpu_percent: 379.5,
      memory_bytes: 2942 * 1024 * 1024,
      memory_basis: "pss",
      processes: [
        proc(490031, "MainThread", 313.9, 2568, "node /home/jcfs/.kandev/tasks/use-shared-formatbyt_nx34w0d6/kandev/apps/web/node_modules/.bin/../vitest/vitest.mjs run --reporter=verbose"),
        proc(101465, "claude", 9.0, 250, LONG_CMD),
        proc(489920, "MainThread", 0.4, 59, "node /home/jcfs/.nvm/versions/node/v24.18.0/bin/pnpm test"),
        proc(100910, "npm exec @agentclientprotocol", 0, 12, "npm exec @agentclientprotocol/claude-agent-acp"),
        proc(551348, "sleep", 0, 0, "sleep 45"),
      ],
    },
    {
      task_id: "93003a81-c1da-4804-b6b7-eef70f7ca131",
      title: "What about the concept of a per-workspace agent budget?",
      identifier: "KAN-398",
      state: "IN_PROGRESS",
      session_ids: ["58d991fc"],
      cpu_percent: 59.7,
      memory_bytes: 870 * 1024 * 1024,
      memory_basis: "pss",
      processes: [
        proc(594626, "MainThread", 54.7, 620, "node /home/jcfs/.kandev/tasks/what-about-the-conce_i94zd072/kandev/apps/web/node_modules/typescript/bin/tsc --noEmit -p tsconfig.json"),
        proc(56964, "claude", 5.0, 235, LONG_CMD),
        proc(56794, "MainThread", 0, 15, "node claude-agent-acp"),
      ],
    },
    {
      task_id: "9ca9a45d-ed8e-468d-8269-bc3638760d7d",
      title: "kandev log is logging the whole payload on every websocket frame",
      identifier: "KAN-401",
      state: "IN_REVIEW",
      session_ids: ["9b29372e"],
      cpu_percent: 6.8,
      memory_bytes: 352 * 1024 * 1024,
      memory_basis: "rss",
      processes: [
        proc(59617, "claude", 6.8, 235, LONG_CMD),
        proc(552466, "gh", 0, 35, "gh api repos/kdlbs/kandev/compare/08f07b709e7cbd653319d242bf4bbca73cc645b0...5f5bd7cfb05d40a15f9c77c25b25d3a8d2e82fdd"),
        proc(552465, "jq", 0, 4, "jq -c {merge_base_oid: (.merge_base_commit.sha // null)}"),
        proc(552463, "bash", 0, 2, "bash /home/jcfs/.kandev/tasks/kandev-log-is-loggin_nvtcung7/kandev/scripts/pr-state --summary 2865"),
      ],
    },
    {
      task_id: "e0d38be0-0356-4ef7-b460-bda82369b2d7",
      title: "Per-task CPU and memory plugin",
      identifier: "KAN-415",
      state: "IN_PROGRESS",
      session_ids: ["66619dfd"],
      cpu_percent: 5.4,
      memory_bytes: 458 * 1024 * 1024,
      memory_basis: "pss",
      processes: [proc(365494, "claude", 5.4, 285, LONG_CMD)],
    },
    {
      task_id: "871ce3f0-be6c-49a8-9349-fcdc334d21b5",
      title: "Compact model availability warning",
      identifier: "KAN-377",
      state: "DONE",
      session_ids: ["e66e1fe3"],
      cpu_percent: 1.4,
      memory_bytes: 202 * 1024 * 1024,
      memory_basis: "pss",
      processes: [proc(65979, "claude", 1.4, 166, LONG_CMD)],
    },
    {
      // A task kandev no longer knows about: its agent is still winding down.
      task_id: "7b71a3c1-c41c-4d98-838e-f9e0dbc626c0",
      session_ids: ["f02b8f16"],
      cpu_percent: 0.2,
      memory_bytes: 537 * 1024 * 1024,
      memory_basis: "pss",
      processes: [proc(127538, "claude", 0.2, 392, LONG_CMD)],
    },
  ];

  for (let i = 0; i < 8; i += 1) {
    TASKS.push({
      task_id: `filler-${i}-0000-0000-0000-000000000000`,
      title: `Idle background task number ${i + 1} with a fairly long descriptive title`,
      identifier: `KAN-${300 + i}`,
      state: "CREATED",
      session_ids: [`sess-${i}`],
      cpu_percent: 0,
      memory_bytes: (180 + i * 7) * 1024 * 1024,
      memory_basis: "pss",
      processes: [proc(200000 + i, "claude", 0, 180 + i * 7, LONG_CMD)],
    });
  }

  const REPORT = {
    sampled_at: new Date().toISOString(),
    interval_seconds: 0.74,
    platform: "linux",
    cpu_cores: CORES,
    total_memory_bytes: 32 * 1024 * 1024 * 1024,
    supported: true,
    tasks: TASKS,
  };

  // Each poll swaps the CPU of the top two tasks, which is the churn that
  // made the real list reshuffle every second. The harness exaggerates it so
  // an ordering regression is unmissable rather than intermittent.
  let poll = 0;
  function reportForPoll() {
    poll += 1;
    const swing = poll % 2 === 0;
    const tasks = TASKS.map((task, index) => {
      // Two tasks that merely oscillate: smoothing should absorb these, and
      // the list should not reshuffle on their account.
      if (index === 0) return { ...task, cpu_percent: swing ? 40 : 380 };
      if (index === 1) return { ...task, cpu_percent: swing ? 390 : 60 };
      // One task climbing steadily from idle: a real, sustained change that
      // the list *should* eventually reflect once it is free to re-rank.
      if (index === TASKS.length - 1) return { ...task, cpu_percent: poll * 45 };
      // One task straddling the idle threshold, alternating just above and
      // just below it. Without hysteresis it hops between the working list
      // and the idle group on every single poll.
      if (index === TASKS.length - 2) return { ...task, cpu_percent: swing ? 0.8 : 1.2 };
      return task;
    });
    return { ...REPORT, tasks, sampled_at: new Date().toISOString() };
  }
  window.__pollCount = () => poll;
  // Lets the ordering test restart the climbing task from idle, so its rank
  // is measured from a known starting point rather than wherever the earlier
  // steps happened to leave it.
  window.__resetClimb = () => {
    poll = 0;
  };

  const host = {
    React: window.React,
    jsx: window.React.createElement,
    theme: "dark",
    api: {
      fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve(reportForPoll()) }),
      baseUrl: "",
    },
    navigate: (href) => console.log("navigate", href),
    openModal: (options) => {
      window.__modalContent = options.content;
      window.__modalTitle = options.title;
      return { close: () => {} };
    },
    ui: {},
  };

  const slots = {};
  const keys = {};
  const registry = {
    registerComponent: (slot, C) => {
      slots[slot] = C;
    },
    registerKeybinding: (id, handler) => {
      keys[id] = handler;
    },
    registerRoute: () => {},
    registerNavItem: () => {},
  };

  window.registerKandevPlugin = (id, plugin) => {
    plugin.initialize(registry, host);
    // Trigger the hotkey path, which is what populates __modalContent.
    keys["open-task-manager"]();

    const h = window.React.createElement;
    window.__createRoot(document.getElementById("modal-body")).render(h(window.__modalContent));
    if (slots["main-top-bar"]) {
      window.__createRoot(document.getElementById("chip-slot")).render(
        h(slots["main-top-bar"], { presentation: "desktop", currentPage: "kanban" }),
      );
    }
    document.getElementById("modal-title").textContent = window.__modalTitle;
  };
})();
