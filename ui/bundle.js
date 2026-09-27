// kandev-plugin-task-manager UI bundle (no-build ES module).
//
// A usage monitor for kandev tasks, shaped like Activity Monitor rather than a
// spreadsheet: one row per task carrying a filled CPU bar and memory bar with
// large readable numbers, expandable into the processes that make it up.
// Tasks that are not using CPU fold into a single idle row, because most
// agents sit at zero waiting on a reply and listing twenty of them buries the
// one that is actually working.
//
//   • global hotkey (Ctrl/Cmd + Shift + Esc) opens the modal,
//   • a top-bar chip shows live total CPU and opens the same modal.
//
// Data flow: panel -> host.api.fetch("webhooks/usage")
//   (= GET /api/plugins/kandev-plugin-task-manager/webhooks/usage)
//   -> kandev relays over gRPC HandleWebhook -> plugin backend samples the
//   host process table -> JSON rollup back.
//
// Nothing here may touch React at module scope: the bundle is evaluated
// before initialize() hands it the host, so every component is built inside a
// factory that closes over `host`.

(function () {
  const PLUGIN_ID = "kandev-plugin-task-manager";
  const STYLE_ELEMENT_ID = "ktm-styles";

  // The modal polls fast because CPU is the point; the chip is ambient, so it
  // settles for a slower cadence. Both are above the backend's own sampling
  // window (700ms) and below the age at which it discards its baseline (5s),
  // which is what keeps every poll a cheap warm one.
  const PANEL_POLL_MS = 1200;
  const CHIP_POLL_MS = 4000;

  // How long the row order is held steady before it may be re-ranked. CPU
  // moves every poll, so ranking strictly by the latest reading makes the list
  // reshuffle roughly once a second — unreadable, and impossible to click.
  const RERANK_MS = 4000;

  // Smoothing applied to CPU before it is displayed or ranked. A single 700ms
  // delta is noisy; blending it with the previous reading keeps the number
  // legible without hiding a real change.
  const CPU_SMOOTHING = 0.4;

  // How many samples the per-task CPU sparkline keeps. At the panel's poll
  // rate this is roughly the last half minute, which is long enough to tell a
  // steady load from a spike without becoming a chart nobody reads.
  const HISTORY_SAMPLES = 36;

  // A task is promoted out of the idle group at IDLE_ENTER and only demoted
  // back below IDLE_EXIT. The gap is hysteresis: with a single threshold, a
  // task hovering around it hops between the two groups every poll, which is
  // the most jarring kind of jumping because the row moves the length of the
  // list.
  const IDLE_ENTER_PERCENT = 1;
  const IDLE_EXIT_PERCENT = 0.5;

  // 100% is one core, the convention top/htop use. A task above this is doing
  // real parallel work, which the CPU bar signals by changing colour.
  const ONE_CORE = 100;

  const TITLE = "Task Manager";
  const HOTKEY_HINT = "⌘/Ctrl + Shift + Esc";

  // The stylesheet ships inside the bundle and is injected on initialize,
  // rather than being declared as `ui.styles` for kandev to fetch as a
  // separate <link>. That request is served from an authenticated route a
  // <link> tag cannot satisfy, so it returns 401 and the UI renders unstyled.
  // Carrying the styles in the file that already had to load to draw anything
  // makes that impossible.
  //
  // Everything is expressed against kandev's own CSS custom properties, never
  // Tailwind utility classes: Tailwind v4 only compiles classes it finds while
  // scanning kandev's sources, and a plugin bundle is not scanned, so a
  // utility that "works" today breaks when kandev drops its last use of it.
  const STYLES = `
.ktm-frame {
  display: flex;
  flex-direction: column;
  /* A fixed frame keeps the dialog from resizing every poll as tasks come and
   * go. */
  height: min(70vh, 36rem);
  /* The host's DialogContent is a CSS grid, and a grid item defaults to
   * min-width: auto — it refuses to shrink below its content's min-content
   * width and spills out of the dialog instead.
   *
   * width: 0 with min-width: 100% is the belt-and-braces version of
   * min-width: 0: a definite width of zero means this element contributes
   * nothing to any ancestor's intrinsic width, whatever the host wraps it in,
   * while min-width: 100% still makes it fill the space it is given. It does
   * not depend on CSS containment support, and it holds even if a future host
   * change adds another wrapper between the dialog and this panel. */
  width: 0;
  min-width: 100%;
  max-width: 100%;
  color: var(--foreground);
  font-size: 0.8125rem;
}

/* ---- toolbar ---- */

.ktm-toolbar {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex: none;
  min-width: 0;
  padding-bottom: 0.75rem;
}

.ktm-filter {
  flex: 1;
  min-width: 0;
  height: 1.875rem;
  padding: 0 0.625rem;
  border-radius: 0.375rem;
  border: 1px solid var(--border);
  background: var(--background);
  color: var(--foreground);
  font-size: 0.8125rem;
  outline: none;
}

.ktm-filter:focus-visible {
  border-color: var(--ring);
}

.ktm-totals {
  display: flex;
  align-items: baseline;
  gap: 1rem;
  flex: none;
  white-space: nowrap;
}

.ktm-total {
  display: flex;
  align-items: baseline;
  gap: 0.375rem;
}

.ktm-total-label {
  color: var(--muted-foreground);
  font-size: 0.625rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  opacity: 0.7;
}

.ktm-total-value {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}

.ktm-note {
  color: var(--muted-foreground);
  font-size: 0.6875rem;
  opacity: 0.75;
}

/* ---- list ---- */

.ktm-list {
  flex: 1;
  min-height: 0;
  min-width: 0;
  overflow-y: auto;
  overflow-x: hidden;
  display: flex;
  flex-direction: column;
  /* Rows sit flush and are separated by a hairline rather than boxed in
   * cards: at a dozen rows the borders were the loudest thing on screen. */
  gap: 0;
}

.ktm-task {
  /* flex: none is load-bearing. As a flex child this defaults to
   * flex-shrink: 1, so once the rows are taller than the list the browser
   * shrinks them — and with overflow: hidden that silently clips the process
   * rows mid-row instead of scrolling. */
  flex: none;
  min-width: 0;
  /* Makes the row's width independent of its contents outright, so no future
   * addition can push the panel wider than its dialog again. */
  contain: inline-size;
  border-radius: 0.375rem;
  overflow: hidden;
}

.ktm-task + .ktm-task .ktm-task-head::before {
  content: "";
  position: absolute;
  inset: 0 0.5rem auto;
  height: 1px;
  background: color-mix(in oklab, var(--border) 60%, transparent);
}

.ktm-task-open .ktm-task-head::before,
.ktm-task:hover .ktm-task-head::before {
  opacity: 0;
}

.ktm-task-head {
  position: relative;
  display: grid;
  /* Fixed columns so every row's numbers line up, and a minmax(0, 1fr) title
   * track that can actually shrink. */
  grid-template-columns: 0.875rem minmax(0, 1fr) 6rem 3.5rem 4.5rem;
  align-items: center;
  gap: 0.625rem;
  width: 100%;
  min-width: 0;
  padding: 0.4375rem 0.5rem;
  background: none;
  border: none;
  border-radius: 0.375rem;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.ktm-task:hover .ktm-task-head,
.ktm-task-open .ktm-task-head {
  background: color-mix(in oklab, var(--muted) 70%, transparent);
}

.ktm-caret {
  color: var(--muted-foreground);
  font-size: 0.625rem;
  opacity: 0.7;
}

.ktm-task-main {
  display: flex;
  align-items: baseline;
  gap: 0.4375rem;
  min-width: 0;
}

.ktm-task-title {
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.ktm-badge {
  flex: none;
  padding: 0.0625rem 0.375rem;
  border-radius: 0.25rem;
  background: color-mix(in oklab, var(--muted-foreground) 14%, transparent);
  color: var(--muted-foreground);
  font-size: 0.625rem;
  text-transform: lowercase;
  white-space: nowrap;
}

.ktm-count {
  flex: none;
  color: var(--muted-foreground);
  font-size: 0.6875rem;
  font-variant-numeric: tabular-nums;
  opacity: 0.65;
}

.ktm-open {
  flex: none;
  margin-left: auto;
  padding: 0.0625rem 0.4375rem;
  border-radius: 0.25rem;
  border: 1px solid var(--border);
  background: var(--background);
  color: var(--muted-foreground);
  font-size: 0.625rem;
  cursor: pointer;
  /* visibility, not display, so the row does not reflow on hover. */
  visibility: hidden;
}

.ktm-task:hover .ktm-open,
.ktm-open:focus-visible {
  visibility: visible;
}

.ktm-open:hover {
  color: var(--foreground);
  background: var(--muted);
}

/* ---- sparkline ---- */

.ktm-spark {
  display: block;
  height: 1.375rem;
  min-width: 0;
  color: var(--primary);
  /* A hairline baseline, so a task with no history yet still occupies the
   * column instead of leaving a hole in the row. */
  border-bottom: 1px solid color-mix(in oklab, var(--foreground) 8%, transparent);
}

.ktm-spark-hot {
  color: var(--destructive);
}

.ktm-spark svg {
  display: block;
  width: 100%;
  height: 100%;
  overflow: visible;
}

.ktm-spark-area {
  fill: currentColor;
  opacity: 0.13;
}

.ktm-spark-line {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.25;
  stroke-linejoin: round;
  stroke-linecap: round;
}

/* ---- numbers ---- */

.ktm-cpu {
  text-align: right;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.ktm-cpu-hot {
  color: var(--destructive);
}

.ktm-mem {
  text-align: right;
  color: var(--muted-foreground);
  font-variant-numeric: tabular-nums;
  font-size: 0.75rem;
}

.ktm-approx {
  opacity: 0.55;
  margin-left: 0.0625rem;
  font-size: 0.625rem;
  font-weight: 400;
}

/* ---- processes ---- */

.ktm-procs {
  min-width: 0;
  margin: 0 0.5rem 0.375rem 1.5rem;
  padding: 0.25rem 0.5rem 0.3125rem;
  border-left: 1px solid var(--border);
  background: color-mix(in oklab, var(--muted) 45%, transparent);
  border-radius: 0 0.25rem 0.25rem 0;
}

/* A grid, not a flex row, and deliberately so.
 *
 * As flex, the command's intrinsic width leaked all the way up: min-width: 0
 * on the item and on every ancestor still let a flex item's min-content
 * contribution widen the container, so a long command line pushed the whole
 * panel ~1600px past the dialog. A grid track declared minmax(0, 1fr) has a
 * definite zero minimum, which stops the contribution at this row.
 *
 * It also gives the alignment the flex version never had: name, command and
 * each number occupy the same column on every row instead of starting
 * wherever the previous cell happened to end. */
.ktm-proc {
  display: grid;
  grid-template-columns: 9rem minmax(0, 1fr) 3.75rem 3.75rem 3.75rem;
  align-items: baseline;
  gap: 0.75rem;
  min-width: 0;
  padding: 0.125rem 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.6875rem;
}

/* A FIXED width, not max-width: with a variable-width name every command
 * started at a different x and the two ran together into one unreadable
 * string ("sh sh -c ...", "npm exec @agent npm exec ..."). Pinning the column
 * lets names and commands each form their own vertical edge. */
.ktm-proc-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}

.ktm-proc-cmd {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  /* Subordinate to the name beside it. The colour difference carries the
   * hierarchy; the opacity only softens it. */
  color: var(--muted-foreground);
  opacity: 0.8;
}

.ktm-proc-num {
  text-align: right;
  color: var(--muted-foreground);
  font-variant-numeric: tabular-nums;
}

.ktm-proc-pid {
  text-align: right;
  color: var(--muted-foreground);
  font-variant-numeric: tabular-nums;
  opacity: 0.6;
}

/* ---- idle group ---- */

.ktm-idle-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex: none;
  width: 100%;
  margin-top: 0.25rem;
  padding: 0.4375rem 0.5rem;
  border: none;
  border-top: 1px solid color-mix(in oklab, var(--border) 60%, transparent);
  background: none;
  color: var(--muted-foreground);
  font: inherit;
  font-size: 0.75rem;
  text-align: left;
  cursor: pointer;
}

.ktm-idle-head:hover {
  color: var(--foreground);
}

.ktm-idle-total {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
}

/* ---- empty ---- */

.ktm-empty {
  margin: auto;
  padding: 2rem 1rem;
  text-align: center;
  color: var(--muted-foreground);
}

/* ---- top-bar chip ---- */

.ktm-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  height: 1.5rem;
  padding: 0 0.5rem;
  border-radius: 0.3125rem;
  border: 1px solid var(--border);
  background: var(--background);
  /* A <button> does not inherit colour: without this it falls back to the
   * UA's dark grey buttontext, which is invisible on a dark background. */
  color: var(--foreground);
  font-size: 0.6875rem;
  cursor: pointer;
  white-space: nowrap;
}

.ktm-chip:hover {
  background: var(--muted);
}

.ktm-chip-label {
  color: var(--muted-foreground);
  opacity: 0.8;
}

.ktm-chip-value {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}

.ktm-chip-track {
  width: 2.5rem;
  height: 0.25rem;
  border-radius: 0.125rem;
  background: color-mix(in oklab, var(--foreground) 12%, transparent);
  overflow: hidden;
}
`;

  function injectStyles() {
    // Idempotent: initialize() may run again when the plugin is disabled and
    // re-enabled in the same tab.
    const existing = document.getElementById(STYLE_ELEMENT_ID);
    if (existing) existing.remove();
    const style = document.createElement("style");
    style.id = STYLE_ELEMENT_ID;
    style.dataset.pluginId = PLUGIN_ID;
    style.textContent = STYLES;
    document.head.appendChild(style);
  }

  function formatCPU(percent) {
    if (!percent || percent < 0.05) return "0%";
    if (percent < 10) return `${percent.toFixed(1)}%`;
    return `${Math.round(percent)}%`;
  }

  function formatMemory(bytes) {
    if (!bytes) return "0 MB";
    const mb = bytes / 1024 / 1024;
    if (mb < 1024) return `${Math.round(mb)} MB`;
    return `${(mb / 1024).toFixed(1)} GB`;
  }

  function percentWidth(fraction) {
    const clamped = Math.max(0, Math.min(1, fraction || 0));
    // A non-zero value always shows a sliver, so "a little" is visibly
    // different from "nothing at all".
    return `${clamped === 0 ? 0 : Math.max(1.5, clamped * 100)}%`;
  }

  function cpuIcon(h) {
    return h(
      "svg",
      {
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: "1.75",
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": "true",
        focusable: "false",
      },
      h("rect", { x: "6", y: "6", width: "12", height: "12", rx: "2" }),
      h("path", {
        d: "M9 9h6v6H9zM9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4",
      }),
    );
  }

  // A task whose processes exist but whose kandev row does not: deleted while
  // its agent was still winding down. Showing the bare id is the honest
  // rendering — it is still consuming the machine.
  function taskLabel(task) {
    return task.title || `Unknown task ${task.task_id.slice(0, 8)}`;
  }

  // smoothInto folds each fresh reading into the running average kept in
  // `store`; pruneStore drops entries for rows that no longer exist so the map
  // cannot grow without bound.
  function smoothInto(store, key, value) {
    const previous = store.get(key);
    const next = previous === undefined ? value : previous + CPU_SMOOTHING * (value - previous);
    store.set(key, next);
    return next;
  }

  // pushHistory keeps a bounded ring of recent values per key.
  function pushHistory(store, key, value) {
    const series = store.get(key) || [];
    series.push(value);
    if (series.length > HISTORY_SAMPLES) series.splice(0, series.length - HISTORY_SAMPLES);
    store.set(key, series);
    return series;
  }

  // sparklinePath turns a series into an SVG line and the matching closed area
  // beneath it. Both are drawn in a 0..1 space and scaled by the SVG's
  // viewBox, so the caller does not need pixel geometry.
  function sparklinePath(series, ceiling) {
    if (!series || series.length === 0) return null;
    const points = series.map((value, index) => {
      const x = series.length === 1 ? 1 : index / (series.length - 1);
      const y = 1 - Math.max(0, Math.min(1, value / ceiling));
      return [x, y];
    });
    const line = points.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(4)},${y.toFixed(4)}`).join("");
    const area = `${line}L1,1L0,1Z`;
    return { line, area };
  }

  function pruneStore(store, liveKeys) {
    for (const key of [...store.keys()]) {
      if (!liveKeys.has(key)) store.delete(key);
    }
  }

  // reconcileOrder keeps the previous order, dropping ids that are gone and
  // appending ids that are new. It is what a held list does between re-ranks:
  // still correct about which rows exist, just not re-sorted.
  function reconcileOrder(previous, desired) {
    const desiredSet = new Set(desired);
    const kept = previous.filter((id) => desiredSet.has(id));
    const keptSet = new Set(kept);
    return kept.concat(desired.filter((id) => !keptSet.has(id)));
  }

  // pinOrder re-ranks everything except the pinned rows, which stay at the
  // index they already occupied. An expanded task is pinned: its process list
  // sliding up the panel while you read it is the whole complaint, but
  // freezing the entire list until it is collapsed would leave the panel
  // silently stale instead.
  function pinOrder(previous, desired, pinned) {
    if (!pinned.size) return desired;
    const desiredSet = new Set(desired);
    const anchored = [...pinned]
      .filter((id) => desiredSet.has(id))
      .map((id) => ({ id, index: previous.indexOf(id) }))
      .sort((a, b) => a.index - b.index);
    const rest = desired.filter((id) => !pinned.has(id));
    for (const { id, index } of anchored) {
      const at = index < 0 ? rest.length : Math.min(index, rest.length);
      rest.splice(at, 0, id);
    }
    return rest;
  }

  function matchesFilter(task, needle) {
    if (!needle) return true;
    const haystack = [taskLabel(task), task.identifier, task.task_id]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (haystack.includes(needle)) return true;
    return task.processes.some((p) =>
      `${p.name} ${p.command || ""} ${p.pid}`.toLowerCase().includes(needle),
    );
  }

  // useUsage fetches the rollup and re-polls on an interval while mounted.
  function makeUseUsage(host) {
    const { React } = host;
    return function useUsage(pollMs) {
      const [state, setState] = React.useState({ loading: true, error: null, report: null });
      const timer = React.useRef(null);

      const load = React.useCallback((quiet) => {
        if (!quiet) setState((s) => ({ ...s, loading: !s.report, error: null }));
        return host.api
          // POST, not GET, and deliberately so. Kandev requires a valid
          // Origin header on session-authenticated webhook calls as CSRF
          // protection — but browsers omit Origin on same-origin GET
          // requests, so a GET poll is rejected 403 on every instance that
          // has authentication enabled. A POST always carries Origin.
          .fetch("webhooks/usage", { method: "POST" })
          .then(async (res) => {
            const body = await res.json();
            if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
            setState({ loading: false, error: null, report: body });
          })
          .catch((err) =>
            // Keep the last good report on screen through a transient failure:
            // a monitor that blanks itself on one dropped poll is worse than
            // one showing a reading a second or two old.
            setState((s) => ({ loading: false, error: String(err.message || err), report: s.report })),
          );
      }, []);

      React.useEffect(() => {
        load(false);
        if (pollMs) {
          timer.current = setInterval(() => load(true), pollMs);
          return () => clearInterval(timer.current);
        }
        return undefined;
      }, [load, pollMs]);

      return { ...state, reload: () => load(false) };
    };
  }

  function makePanel(host, closeModal) {
    const { React, jsx: h } = host;
    const useUsage = makeUseUsage(host);

    // An inline SVG rather than a canvas: it scales with the row, follows the
    // theme through currentColor, and needs no imperative redraw on every
    // poll — React just hands it a new path.
    function Sparkline({ series, hot }) {
      // Scaled to this task's own peak, floored at one core. A shared scale
      // made every task except the busiest a flat line; flooring at one core
      // keeps a task that never did real work looking flat, which is true.
      const peak = series && series.length ? Math.max(...series) : 0;
      const path = sparklinePath(series, Math.max(ONE_CORE, peak));
      if (!path) return h("span", { className: "ktm-spark" });
      return h(
        "span",
        { className: `ktm-spark${hot ? " ktm-spark-hot" : ""}` },
        h(
          "svg",
          {
            viewBox: "0 0 1 1",
            preserveAspectRatio: "none",
            "aria-hidden": "true",
            focusable: "false",
          },
          h("path", { className: "ktm-spark-area", d: path.area }),
          // vector-effect keeps the stroke one pixel wide despite the
          // non-uniform viewBox scaling, which would otherwise smear it.
          h("path", {
            className: "ktm-spark-line",
            d: path.line,
            vectorEffect: "non-scaling-stroke",
          }),
        ),
      );
    }

    function ProcessRow({ proc }) {
      return h(
        "div",
        { className: "ktm-proc" },
        h("span", { className: "ktm-proc-name", title: proc.name }, proc.name),
        h("span", { className: "ktm-proc-cmd", title: proc.command || "" }, proc.command || ""),
        h("span", { className: "ktm-proc-num" }, formatCPU(proc.cpu_percent)),
        h("span", { className: "ktm-proc-num" }, formatMemory(proc.memory_bytes)),
        h("span", { className: "ktm-proc-pid" }, proc.pid),
      );
    }

    function TaskRow({ task, expanded, onToggle, onOpen }) {
      const label = taskLabel(task);
      const hot = task.cpu_percent >= ONE_CORE;
      return h(
        "div",
        { className: `ktm-task${expanded ? " ktm-task-open" : ""}` },
        h(
          "button",
          {
            type: "button",
            className: "ktm-task-head",
            "aria-expanded": expanded,
            onClick: onToggle,
          },
          h("span", { className: "ktm-caret" }, expanded ? "▾" : "▸"),
          h(
            "span",
            { className: "ktm-task-main" },
            h("span", { className: "ktm-task-title", title: label }, label),
            task.state
              ? h("span", { className: "ktm-badge" }, task.state.replace(/_/g, " ").toLowerCase())
              : null,
            h("span", { className: "ktm-count" }, `${task.processes.length}`),
            h(
              "span",
              {
                className: "ktm-open",
                role: "button",
                tabIndex: 0,
                title: "Open this task",
                onClick: (event) => {
                  // The header toggles; only this affordance navigates, so
                  // expanding a task never yanks you out of the modal.
                  event.stopPropagation();
                  onOpen();
                },
              },
              "Open",
            ),
          ),
          h(Sparkline, { series: task.history, hot }),
          h(
            "span",
            {
              className: `ktm-cpu${hot ? " ktm-cpu-hot" : ""}`,
              title: `${formatCPU(task.cpu_percent)} — 100% is one core`,
            },
            formatCPU(task.cpu_percent),
          ),
          h(
            "span",
            {
              className: "ktm-mem",
              title:
                task.memory_basis === "pss"
                  ? "Proportional set size — pages shared between processes counted once"
                  : "Resident set size — shared pages counted in every process, so this tree total reads high",
            },
            formatMemory(task.memory_bytes),
            task.memory_basis === "rss" ? h("sup", { className: "ktm-approx" }, "*") : null,
          ),
        ),
        expanded
          ? h(
              "div",
              { className: "ktm-procs" },
              task.processes.map((proc) => h(ProcessRow, { key: proc.pid, proc })),
            )
          : null,
      );
    }

    function IdleGroup(props) {
      const { tasks, expanded, onToggle } = props;
      const memory = tasks.reduce((sum, t) => sum + t.memory_bytes, 0);
      return h(
        React.Fragment,
        null,
        h(
          "button",
          {
            type: "button",
            className: "ktm-idle-head",
            "aria-expanded": expanded,
            onClick: onToggle,
          },
          h("span", { className: "ktm-caret" }, expanded ? "▾" : "▸"),
          h("span", null, `${tasks.length} idle ${tasks.length === 1 ? "task" : "tasks"}`),
          h("span", { className: "ktm-idle-total" }, formatMemory(memory)),
        ),
        expanded
          ? tasks.map((task) =>
              h(TaskRow, {
                key: task.task_id,
                task,
                expanded: Boolean(props.expandedIds[task.task_id]),
                onToggle: () => props.onToggleTask(task.task_id),
                onOpen: () => props.onOpenTask(task.task_id),
              }),
            )
          : null,
      );
    }

    return function TaskManagerPanel() {
      const { loading, error, report } = useUsage(PANEL_POLL_MS);
      const [expanded, setExpanded] = React.useState({});
      const [idleOpen, setIdleOpen] = React.useState(false);
      const [filter, setFilter] = React.useState("");
      const [hovering, setHovering] = React.useState(false);
      // Running CPU averages, keyed by task id and by "taskId:pid".
      const smoothed = React.useRef(new Map());
      // Recent smoothed CPU per task, for the sparklines.
      const history = React.useRef(new Map());
      // The order actually rendered, plus the filter it was built for and when
      // it was last rebuilt.
      const order = React.useRef({ token: "", ids: [], at: 0 });
      // Which tasks are currently shown as working. Membership is sticky:
      // recomputed only when the list is free to change, for the same reason
      // the order is.
      const activeIds = React.useRef(new Set());

      const toggle = React.useCallback(
        (id) => setExpanded((prev) => ({ ...prev, [id]: !prev[id] })),
        [],
      );
      const openTask = React.useCallback((id) => {
        host.navigate(`/t/${id}`);
        if (closeModal) closeModal();
      }, []);

      if (loading && !report) {
        return h("div", { className: "ktm-frame" }, h("div", { className: "ktm-empty" }, "Sampling processes…"));
      }

      // An unsupported platform is a different thing from an empty list, and
      // saying so beats rendering a reassuring zero.
      if (report && report.supported === false) {
        return h(
          "div",
          { className: "ktm-frame" },
          h(
            "div",
            { className: "ktm-empty" },
            report.error || "Per-process sampling is not available on this platform.",
          ),
        );
      }

      const cores = (report && report.cpu_cores) || 1;
      const raw = (report && report.tasks) || [];

      // Blend each reading into its running average before anything reads it,
      // so display and ranking agree and neither twitches on a noisy sample.
      const liveKeys = new Set();
      const all = raw.map((task) => {
        liveKeys.add(task.task_id);
        const processes = task.processes.map((proc) => {
          const key = `${task.task_id}:${proc.pid}`;
          liveKeys.add(key);
          return { ...proc, cpu_percent: smoothInto(smoothed.current, key, proc.cpu_percent) };
        });
        const cpu = smoothInto(smoothed.current, task.task_id, task.cpu_percent);
        return {
          ...task,
          cpu_percent: cpu,
          history: pushHistory(history.current, task.task_id, cpu),
          processes,
        };
      });
      pruneStore(smoothed.current, liveKeys);
      pruneStore(history.current, liveKeys);

      const usedMemory = all.reduce((sum, t) => sum + t.memory_bytes, 0);
      const installed = (report && report.total_memory_bytes) || 0;
      const totalCPU = all.reduce((sum, t) => sum + t.cpu_percent, 0);

      const needle = filter.trim().toLowerCase();
      const visible = all.filter((t) => matchesFilter(t, needle));

      // The list holds still while the pointer is over it — rows sliding out
      // from under the cursor as you reach for one is the complaint. It is
      // deliberately NOT also frozen by an expanded row: leaving a row open
      // would then stop the panel updating indefinitely, which is worse than
      // movement. Expanded rows are pinned in place instead (see pinOrder).
      const frozen = hovering;
      const pinned = new Set(Object.keys(expanded).filter((id) => expanded[id]));

      // Membership, with hysteresis: a task already shown as working stays
      // until it drops below IDLE_EXIT, rather than flipping at the same
      // number it was promoted on. An expanded task stays regardless, so its
      // process list cannot vanish into the idle group while you read it.
      const nextActive = new Set(pinned);
      for (const task of visible) {
        const wasActive = activeIds.current.has(task.task_id);
        const threshold = wasActive ? IDLE_EXIT_PERCENT : IDLE_ENTER_PERCENT;
        if (task.cpu_percent >= threshold) nextActive.add(task.task_id);
      }
      if (!frozen) {
        activeIds.current = nextActive;
      } else {
        // Held: keep the current membership plus anything pinned, but forget
        // tasks that no longer exist so the set cannot grow stale.
        const live = new Set(visible.map((t) => t.task_id));
        activeIds.current = new Set(
          [...activeIds.current, ...pinned].filter((id) => live.has(id)),
        );
      }

      // A filter is a search: it should reach idle tasks too, so filtering
      // suspends the idle/active split rather than hiding matches inside it.
      const active = needle ? visible : visible.filter((t) => activeIds.current.has(t.task_id));
      const idle = needle ? [] : visible.filter((t) => !activeIds.current.has(t.task_id));

      const desired = [...active]
        .sort((a, b) => b.cpu_percent - a.cpu_percent || b.memory_bytes - a.memory_bytes)
        .map((t) => t.task_id);

      const now = Date.now();
      if (order.current.token !== needle) {
        order.current = { token: needle, ids: desired, at: now };
      } else if (!frozen && now - order.current.at >= RERANK_MS) {
        order.current = {
          token: needle,
          ids: pinOrder(order.current.ids, desired, pinned),
          at: now,
        };
      } else {
        order.current = {
          token: needle,
          ids: reconcileOrder(order.current.ids, desired),
          at: order.current.at,
        };
      }

      const byId = new Map(active.map((t) => [t.task_id, t]));
      const ordered = order.current.ids.map((id) => byId.get(id)).filter(Boolean);
      const idleSorted = [...idle].sort((a, b) => b.memory_bytes - a.memory_bytes);

      return h(
        "div",
        { className: "ktm-frame" },
        h(
          "div",
          { className: "ktm-toolbar" },
          h("input", {
            className: "ktm-filter",
            type: "search",
            value: filter,
            placeholder: "Filter tasks and processes",
            "aria-label": "Filter tasks and processes",
            onChange: (e) => setFilter(e.target.value),
          }),
          h(
            "div",
            { className: "ktm-totals" },
            h(
              "span",
              { className: "ktm-total", title: `${cores} cores available` },
              h("span", { className: "ktm-total-label" }, "CPU"),
              h("span", { className: "ktm-total-value" }, formatCPU(totalCPU)),
            ),
            h(
              "span",
              {
                className: "ktm-total",
                title: installed ? `${formatMemory(installed)} installed` : undefined,
              },
              h("span", { className: "ktm-total-label" }, "Mem"),
              h("span", { className: "ktm-total-value" }, formatMemory(usedMemory)),
            ),
            error ? h("span", { className: "ktm-note", title: error }, "reconnecting") : null,
          ),
        ),
        h(
          "div",
          {
            className: "ktm-list",
            onMouseEnter: () => setHovering(true),
            onMouseLeave: () => setHovering(false),
          },
          !report && error
            ? h(
                "div",
                { className: "ktm-empty" },
                // Distinguishing these matters: a request that never
                // succeeded previously rendered as "no task is running",
                // which reads as a true measurement of an idle machine
                // rather than as a broken panel.
                h("div", null, "Could not reach the task manager backend."),
                h("div", { className: "ktm-note" }, error),
              )
            : null,
          report && ordered.length === 0 && idleSorted.length === 0
            ? h(
                "div",
                { className: "ktm-empty" },
                needle ? "Nothing matches that filter." : "No task is running an agent process right now.",
              )
            : null,
          report && ordered.length === 0 && idleSorted.length > 0
            ? h("div", { className: "ktm-empty" }, "No task is using CPU right now.")
            : null,
          ordered.map((task) =>
            h(TaskRow, {
              key: task.task_id,
              task,
              expanded: Boolean(expanded[task.task_id]),
              onToggle: () => toggle(task.task_id),
              onOpen: () => openTask(task.task_id),
            }),
          ),
          idleSorted.length
            ? h(IdleGroup, {
                tasks: idleSorted,
                expanded: idleOpen,
                onToggle: () => setIdleOpen((v) => !v),
                expandedIds: expanded,
                onToggleTask: toggle,
                onOpenTask: openTask,
              })
            : null,
        ),
      );
    };
  }

  // The top-bar chip: ambient total CPU, and a second way into the modal for
  // anyone who does not know the hotkey.
  function makeChip(host, openManager) {
    const { jsx: h, ui } = host;
    const useUsage = makeUseUsage(host);

    return function TaskManagerChip(props) {
      const { report } = useUsage(CHIP_POLL_MS);
      const mobile = props && props.slotProps && props.slotProps.presentation === "mobile";
      const tasks = (report && report.tasks) || [];
      const cores = (report && report.cpu_cores) || 1;
      const totalCPU = tasks.reduce((sum, t) => sum + t.cpu_percent, 0);
      const translate = host.i18n && typeof host.i18n.useTranslation === "function"
        ? host.i18n.useTranslation().t
        : null;
      const label = translate
        ? translate("cpuActionLabel", { defaultValue: "Task Manager CPU usage" })
        : "Task Manager CPU usage";
      const percent = formatCPU(totalCPU);
      const tooltip = translate
        ? translate("cpuActionTooltip", {
            defaultValue: "Open Task Manager · CPU {{percent}} · Shortcut: {{hotkey}}",
            values: { percent, hotkey: HOTKEY_HINT },
          })
        : `Open Task Manager · CPU ${percent} · Shortcut: ${HOTKEY_HINT}`;

      if (typeof ui.Action === "function") {
        return h(ui.Action, {
          label,
          icon: cpuIcon(h),
          text: percent,
          tooltip,
          onClick: () => openManager(),
        });
      }

      return h(
        "button",
        {
          type: "button",
          className: "ktm-chip",
          style: mobile ? { minHeight: "2.75rem", padding: "0 0.75rem" } : null,
          onClick: () => openManager(),
          "aria-label": label,
          title: tooltip,
        },
        h("span", { className: "ktm-chip-label" }, "CPU"),
        h(
          "span",
          { className: "ktm-chip-track" },
          h("span", {
            className: `ktm-fill${totalCPU >= ONE_CORE ? " ktm-fill-hot" : ""}`,
            style: { width: percentWidth(totalCPU / (cores * ONE_CORE)) },
          }),
        ),
        h("span", { className: "ktm-chip-value" }, formatCPU(totalCPU)),
      );
    };
  }

  window.registerKandevPlugin(PLUGIN_ID, {
    initialize(registry, host) {
      injectStyles();

      if (typeof registry.registerTranslations === "function") {
        registry.registerTranslations({
          en: {
            cpuActionLabel: "Task Manager CPU usage",
            cpuActionTooltip: "Open Task Manager · CPU {{percent}} · Shortcut: {{hotkey}}",
          },
        });
      }

      // One modal at a time. The handle host.openModal returns carries no
      // close notification, so a modal dismissed with Esc leaves a stale
      // handle behind; closing unconditionally before opening is therefore
      // both idempotent and correct, where a toggle would swallow the next
      // hotkey press after every manual dismiss.
      let handle = null;
      const closeManager = () => {
        if (handle) handle.close();
        handle = null;
      };
      const openManager = () => {
        closeManager();
        const Panel = makePanel(host, closeManager);
        handle = host.openModal({ title: TITLE, content: Panel, size: "lg" });
      };

      registry.registerKeybinding("open-task-manager", () => openManager());
      registry.registerComponent("main-top-bar", makeChip(host, openManager));
    },

    // The host revokes slots, keybindings and modals itself, but its style
    // cleanup only looks for <link> elements, so the injected <style> is this
    // plugin's to remove.
    destroy() {
      const style = document.getElementById(STYLE_ELEMENT_ID);
      if (style) style.remove();
    },
  });
})();
