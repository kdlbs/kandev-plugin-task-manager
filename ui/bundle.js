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
//   • an ambient top-bar monitor shows selected host readings and opens the
//     same modal.
//
// Data flow: the panel calls webhooks/usage for detailed process data, while
// the ambient top bar calls webhooks/summary with only the enabled families.
// Kandev relays both authenticated requests over gRPC HandleWebhook.
//
// Nothing here may touch React at module scope: the bundle is evaluated
// before initialize() hands it the host, so every component is built inside a
// factory that closes over `host`.

(function () {
  const PLUGIN_ID = "kandev-plugin-task-manager";
  const STYLE_ELEMENT_ID = "ktm-styles";

  // The modal polls fast because CPU is the point; the ambient monitor uses
  // the operator's slower cadence. Both are above the backend's own sampling
  // window (700ms) and below the age at which it discards its baseline (5s),
  // which is what keeps each active poll a cheap warm one.
  const PANEL_POLL_MS = 1200;
  const DEFAULT_MONITOR_INTERVAL_MS = 5000;
  const MIN_MONITOR_INTERVAL_MS = 1000;
  const MAX_MONITOR_INTERVAL_MS = 300000;
  const MONITOR_SETTINGS_VERSION = 1;
  const MONITOR_STORAGE_SCOPE = "instance";
  const MONITOR_STORAGE_SCOPE_ID = "profile";
  const MONITOR_STORAGE_KEY = "topbar-settings-v1";
  const MONITOR_METRIC_IDS = [
    "cpu",
    "memory",
    "disk",
    "cpu_temperature",
    "system_load",
  ];
  const DEFAULT_DISK_THRESHOLD = 80;

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

  const TRANSLATIONS = {
    en: {
      monitorTitle: "Host monitor",
      monitorOpen: "Open Task Manager host monitor",
      monitorHotkeyHint: "Open Task Manager with {{hotkey}}",
      monitorLoading: "Loading monitor settings…",
      monitorSettingsTitle: "Host monitor display",
      monitorSettingsDescription:
        "Choose the host readings shown in the top bar. The detailed Task Manager dialog keeps its own view.",
      monitorSettingsLoadError: "Monitor settings could not be loaded.",
      monitorSettingsSaveError: "Monitor settings could not be saved.",
      monitorSettingsConflict:
        "These settings changed in another Kandev client. Review the refreshed values before saving again.",
      monitorSettingsRetry: "Retry",
      monitorSettingsEnabled: "Show",
      monitorSettingsBar: "Bar",
      monitorMetricCpu: "CPU",
      monitorMetricMemory: "Memory",
      monitorMetricDisk: "Disk",
      monitorMetricTemperature: "CPU temperature",
      monitorMetricLoad: "System load",
      monitorCpuMode: "CPU reading",
      monitorCpuModeHost: "Host relative",
      monitorCpuModeTasks: "Tasks relative",
      monitorCpuModePerCore: "Tasks per core",
      monitorMemoryUnit: "Memory value",
      monitorMemoryUnitPercent: "Used percent",
      monitorMemoryUnitGB: "Used GB",
      monitorDiskVisibility: "Disk visibility",
      monitorDiskVisibilityAlways: "Always show",
      monitorDiskVisibilityThreshold: "Show at threshold",
      monitorDiskThreshold: "Threshold %",
      monitorMoveUp: "Move metric up",
      monitorMoveDown: "Move metric down",
      monitorDragMetric: "Drag to reorder metric",
      monitorDiskHelpLabel: "About disk monitoring cost and path",
      monitorDiskHelp:
        "Reports capacity for the filesystem containing the configured path. It reads filesystem metadata; it does not scan files or directories. The visibility threshold hides this reading from the top bar but does not stop sampling.",
      monitorUnavailable: "Unavailable",
      monitorStale: "stale",
      monitorSampledAt: "Sampled {{time}}",
      monitorHostSource: "host",
      monitorTasksSource: "tasks",
      monitorUsedOf: "{{used}} of {{total}}",
      monitorBytesDetail: "{{used}} / {{total}} bytes",
      monitorPath: "Path {{path}}",
      monitorNoEnabledMetrics: "Enable a reading to show the host monitor in the top bar.",
      monitorNoSnapshot: "Waiting for the first host reading…",
      monitorUnknownError: "Unknown monitor error",
    },
    "pt-pt": {
      monitorTitle: "Monitor do sistema",
      monitorOpen: "Abrir o monitor do sistema do Gestor de tarefas",
      monitorHotkeyHint: "Abrir o Gestor de tarefas com {{hotkey}}",
      monitorLoading: "A carregar as definições do monitor…",
      monitorSettingsTitle: "Apresentação do monitor do sistema",
      monitorSettingsDescription:
        "Escolha as leituras do sistema apresentadas na barra superior. A janela detalhada mantém a sua própria vista.",
      monitorSettingsLoadError: "Não foi possível carregar as definições do monitor.",
      monitorSettingsSaveError: "Não foi possível guardar as definições do monitor.",
      monitorSettingsConflict:
        "Estas definições mudaram noutro cliente Kandev. Reveja os valores atualizados antes de guardar novamente.",
      monitorSettingsRetry: "Tentar novamente",
      monitorSettingsEnabled: "Mostrar",
      monitorSettingsBar: "Barra",
      monitorMetricCpu: "CPU",
      monitorMetricMemory: "Memória",
      monitorMetricDisk: "Disco",
      monitorMetricTemperature: "Temperatura da CPU",
      monitorMetricLoad: "Carga do sistema",
      monitorCpuMode: "Leitura da CPU",
      monitorCpuModeHost: "Relativa ao sistema",
      monitorCpuModeTasks: "Relativa às tarefas",
      monitorCpuModePerCore: "Tarefas por núcleo",
      monitorMemoryUnit: "Valor da memória",
      monitorMemoryUnitPercent: "Percentagem usada",
      monitorMemoryUnitGB: "GB usados",
      monitorDiskVisibility: "Visibilidade do disco",
      monitorDiskVisibilityAlways: "Mostrar sempre",
      monitorDiskVisibilityThreshold: "Mostrar no limite",
      monitorDiskThreshold: "Limite %",
      monitorMoveUp: "Mover métrica para cima",
      monitorMoveDown: "Mover métrica para baixo",
      monitorDragMetric: "Arrastar para reordenar métrica",
      monitorDiskHelpLabel: "Sobre o custo e o caminho do monitor do disco",
      monitorDiskHelp:
        "Mostra a capacidade do sistema de ficheiros que contém o caminho configurado. Lê metadados do sistema de ficheiros; não analisa ficheiros nem diretórios. O limite de visibilidade oculta esta leitura da barra superior, mas não interrompe a amostragem.",
      monitorUnavailable: "Indisponível",
      monitorStale: "desatualizado",
      monitorSampledAt: "Amostrado {{time}}",
      monitorHostSource: "sistema",
      monitorTasksSource: "tarefas",
      monitorUsedOf: "{{used}} de {{total}}",
      monitorBytesDetail: "{{used}} / {{total}} bytes",
      monitorPath: "Caminho {{path}}",
      monitorNoEnabledMetrics: "Ative uma leitura para mostrar o monitor na barra superior.",
      monitorNoSnapshot: "À espera da primeira leitura do sistema…",
      monitorUnknownError: "Erro desconhecido do monitor",
    },
    "zh-cn": {
      monitorTitle: "主机监视器",
      monitorOpen: "打开任务管理器主机监视器",
      monitorHotkeyHint: "使用 {{hotkey}} 打开任务管理器",
      monitorLoading: "正在加载监视器设置…",
      monitorSettingsTitle: "主机监视器显示",
      monitorSettingsDescription: "选择显示在顶部栏中的主机读数。详细任务管理器对话框保持独立视图。",
      monitorSettingsLoadError: "无法加载监视器设置。",
      monitorSettingsSaveError: "无法保存监视器设置。",
      monitorSettingsConflict: "这些设置已在另一个 Kandev 客户端中更改。请检查刷新后的值再保存。",
      monitorSettingsRetry: "重试",
      monitorSettingsEnabled: "显示",
      monitorSettingsBar: "条形图",
      monitorMetricCpu: "CPU",
      monitorMetricMemory: "内存",
      monitorMetricDisk: "磁盘",
      monitorMetricTemperature: "CPU 温度",
      monitorMetricLoad: "系统负载",
      monitorCpuMode: "CPU 读数",
      monitorCpuModeHost: "相对主机",
      monitorCpuModeTasks: "相对任务",
      monitorCpuModePerCore: "每核心任务",
      monitorMemoryUnit: "内存数值",
      monitorMemoryUnitPercent: "使用百分比",
      monitorMemoryUnitGB: "使用 GB",
      monitorDiskVisibility: "磁盘可见性",
      monitorDiskVisibilityAlways: "始终显示",
      monitorDiskVisibilityThreshold: "达到阈值后显示",
      monitorDiskThreshold: "阈值 %",
      monitorMoveUp: "向上移动指标",
      monitorMoveDown: "向下移动指标",
      monitorDragMetric: "拖动以重新排列指标",
      monitorDiskHelpLabel: "关于磁盘监视成本和路径",
      monitorDiskHelp: "报告包含配置路径的文件系统容量。它读取文件系统元数据，不会扫描文件或目录。可见性阈值只会隐藏顶部栏读数，不会停止采样。",
      monitorUnavailable: "不可用",
      monitorStale: "过期",
      monitorSampledAt: "采样于 {{time}}",
      monitorHostSource: "主机",
      monitorTasksSource: "任务",
      monitorUsedOf: "{{used}} / {{total}}",
      monitorBytesDetail: "{{used}} / {{total}} 字节",
      monitorPath: "路径 {{path}}",
      monitorNoEnabledMetrics: "启用一项读数后，主机监视器会显示在顶部栏。",
      monitorNoSnapshot: "正在等待第一条主机读数…",
      monitorUnknownError: "未知监视器错误",
    },
    "zh-hk": {
      monitorTitle: "主機監察器",
      monitorOpen: "開啟工作管理員主機監察器",
      monitorHotkeyHint: "使用 {{hotkey}} 開啟工作管理員",
      monitorLoading: "正在載入監察器設定…",
      monitorSettingsTitle: "主機監察器顯示",
      monitorSettingsDescription: "選擇顯示在頂部列的主機讀數。詳細工作管理員對話方塊保持獨立檢視。",
      monitorSettingsLoadError: "無法載入監察器設定。",
      monitorSettingsSaveError: "無法儲存監察器設定。",
      monitorSettingsConflict: "這些設定已在另一個 Kandev 用戶端中更改。請檢查重新整理後的值再儲存。",
      monitorSettingsRetry: "重試",
      monitorSettingsEnabled: "顯示",
      monitorSettingsBar: "條形圖",
      monitorMetricCpu: "CPU",
      monitorMetricMemory: "記憶體",
      monitorMetricDisk: "磁碟",
      monitorMetricTemperature: "CPU 溫度",
      monitorMetricLoad: "系統負載",
      monitorCpuMode: "CPU 讀數",
      monitorCpuModeHost: "相對主機",
      monitorCpuModeTasks: "相對工作",
      monitorCpuModePerCore: "每核心工作",
      monitorMemoryUnit: "記憶體數值",
      monitorMemoryUnitPercent: "使用百分比",
      monitorMemoryUnitGB: "使用 GB",
      monitorDiskVisibility: "磁碟可見性",
      monitorDiskVisibilityAlways: "一律顯示",
      monitorDiskVisibilityThreshold: "達到閾值後顯示",
      monitorDiskThreshold: "閾值 %",
      monitorMoveUp: "向上移動指標",
      monitorMoveDown: "向下移動指標",
      monitorDragMetric: "拖曳以重新排列指標",
      monitorDiskHelpLabel: "關於磁碟監察成本及路徑",
      monitorDiskHelp: "報告包含設定路徑的檔案系統容量。它讀取檔案系統中繼資料，不會掃描檔案或目錄。可見性閾值只會隱藏頂部列讀數，不會停止取樣。",
      monitorUnavailable: "無法使用",
      monitorStale: "過時",
      monitorSampledAt: "取樣於 {{time}}",
      monitorHostSource: "主機",
      monitorTasksSource: "工作",
      monitorUsedOf: "{{used}} / {{total}}",
      monitorBytesDetail: "{{used}} / {{total}} 字節",
      monitorPath: "路徑 {{path}}",
      monitorNoEnabledMetrics: "啟用一項讀數後，主機監察器會顯示在頂部列。",
      monitorNoSnapshot: "正在等待第一條主機讀數…",
      monitorUnknownError: "未知監察器錯誤",
    },
    "zh-tw": {
      monitorTitle: "主機監視器",
      monitorOpen: "開啟工作管理員主機監視器",
      monitorHotkeyHint: "使用 {{hotkey}} 開啟工作管理員",
      monitorLoading: "正在載入監視器設定…",
      monitorSettingsTitle: "主機監視器顯示",
      monitorSettingsDescription: "選擇顯示在頂部列中的主機讀數。詳細工作管理員對話方塊保持獨立檢視。",
      monitorSettingsLoadError: "無法載入監視器設定。",
      monitorSettingsSaveError: "無法儲存監視器設定。",
      monitorSettingsConflict: "這些設定已在另一個 Kandev 用戶端中變更。請檢查重新整理後的值再儲存。",
      monitorSettingsRetry: "重試",
      monitorSettingsEnabled: "顯示",
      monitorSettingsBar: "長條圖",
      monitorMetricCpu: "CPU",
      monitorMetricMemory: "記憶體",
      monitorMetricDisk: "磁碟",
      monitorMetricTemperature: "CPU 溫度",
      monitorMetricLoad: "系統負載",
      monitorCpuMode: "CPU 讀數",
      monitorCpuModeHost: "相對主機",
      monitorCpuModeTasks: "相對工作",
      monitorCpuModePerCore: "每核心工作",
      monitorMemoryUnit: "記憶體數值",
      monitorMemoryUnitPercent: "使用百分比",
      monitorMemoryUnitGB: "使用 GB",
      monitorDiskVisibility: "磁碟可見性",
      monitorDiskVisibilityAlways: "一律顯示",
      monitorDiskVisibilityThreshold: "達到閾值後顯示",
      monitorDiskThreshold: "閾值 %",
      monitorMoveUp: "向上移動指標",
      monitorMoveDown: "向下移動指標",
      monitorDragMetric: "拖曳以重新排列指標",
      monitorDiskHelpLabel: "關於磁碟監視成本與路徑",
      monitorDiskHelp: "報告包含設定路徑的檔案系統容量。它讀取檔案系統中繼資料，不會掃描檔案或目錄。可見性閾值只會隱藏頂部列讀數，不會停止取樣。",
      monitorUnavailable: "無法使用",
      monitorStale: "過時",
      monitorSampledAt: "取樣於 {{time}}",
      monitorHostSource: "主機",
      monitorTasksSource: "工作",
      monitorUsedOf: "{{used}} / {{total}}",
      monitorBytesDetail: "{{used}} / {{total}} 位元組",
      monitorPath: "路徑 {{path}}",
      monitorNoEnabledMetrics: "啟用一項讀數後，主機監視器會顯示在頂部列。",
      monitorNoSnapshot: "正在等待第一條主機讀數…",
      monitorUnknownError: "未知監視器錯誤",
    },
  };

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

.ktm-fill {
  display: block;
  height: 100%;
  min-width: 0;
  border-radius: inherit;
  background: var(--primary);
  transition: width 160ms ease;
}

.ktm-fill-hot {
  background: var(--destructive);
}

/* ---- ambient monitor ---- */

.ktm-monitor {
  display: inline-flex;
  align-items: center;
  gap: 0.125rem;
  min-width: 0;
  max-width: 100%;
  height: 1.5rem;
  padding: 0 0.25rem;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 0.3125rem;
  background: var(--background);
  color: var(--foreground);
  font-size: 0.6875rem;
  cursor: pointer;
}

.ktm-monitor:hover {
  background: var(--muted);
}

.ktm-monitor-segment {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  min-width: 0;
  padding: 0 0.25rem;
  white-space: nowrap;
}

.ktm-monitor-segment + .ktm-monitor-segment {
  border-left: 1px solid color-mix(in oklab, var(--border) 70%, transparent);
}

.ktm-monitor-label {
  color: var(--muted-foreground);
  opacity: 0.85;
}

.ktm-monitor-value {
  max-width: 8rem;
  overflow: hidden;
  text-overflow: ellipsis;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}

.ktm-monitor-unavailable {
  color: var(--muted-foreground);
  font-weight: 500;
}

.ktm-monitor-stale .ktm-monitor-value {
  opacity: 0.72;
}

.ktm-monitor-track {
  width: 2.25rem;
  height: 0.25rem;
  overflow: hidden;
  border-radius: 0.125rem;
  background: color-mix(in oklab, var(--foreground) 12%, transparent);
}

/* ---- settings ---- */

.ktm-settings {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.ktm-settings-description,
.ktm-settings-status {
  margin: 0;
  color: var(--muted-foreground);
  font-size: 0.75rem;
}

.ktm-settings-status-error {
  color: var(--destructive);
}

.ktm-settings-status-conflict {
  padding: 0.5rem 0.625rem;
  border: 1px solid color-mix(in oklab, var(--destructive) 45%, var(--border));
  border-radius: 0.375rem;
  color: var(--destructive);
}

.ktm-setting-row {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  min-width: 0;
  padding: 0.625rem;
  border: 1px solid var(--border);
  border-radius: 0.375rem;
  background: color-mix(in oklab, var(--muted) 35%, transparent);
}

.ktm-setting-row-dragover {
  border-color: var(--ring);
  box-shadow: 0 0 0 1px var(--ring);
}

.ktm-setting-heading,
.ktm-setting-controls,
.ktm-setting-actions,
.ktm-setting-label {
  display: flex;
  align-items: center;
  min-width: 0;
}

.ktm-setting-heading {
  gap: 0.5rem;
}

.ktm-setting-label {
  flex: 1;
  gap: 0.375rem;
  font-weight: 600;
}

.ktm-setting-controls {
  flex-wrap: wrap;
  gap: 0.625rem 1rem;
  padding-left: 1.75rem;
}

.ktm-setting-control {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  color: var(--muted-foreground);
  font-size: 0.75rem;
}

.ktm-setting-control select,
.ktm-setting-control input[type="number"] {
  min-height: 1.75rem;
  max-width: 11rem;
  padding: 0.125rem 0.375rem;
  border: 1px solid var(--border);
  border-radius: 0.25rem;
  background: var(--background);
  color: var(--foreground);
  font: inherit;
}

.ktm-setting-control input[type="number"] {
  width: 4.5rem;
}

.ktm-drag-handle,
.ktm-help-button,
.ktm-move-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  border: 1px solid transparent;
  background: transparent;
  color: var(--muted-foreground);
  cursor: pointer;
}

.ktm-drag-handle {
  width: 1.25rem;
  height: 1.5rem;
  cursor: grab;
  font-size: 0.875rem;
}

.ktm-drag-handle:active {
  cursor: grabbing;
}

.ktm-help-button {
  width: 1.25rem;
  height: 1.25rem;
  border-radius: 999px;
  font-size: 0.75rem;
}

.ktm-drag-handle:hover,
.ktm-help-button:hover,
.ktm-move-button:hover,
.ktm-drag-handle:focus-visible,
.ktm-help-button:focus-visible,
.ktm-move-button:focus-visible {
  border-color: var(--ring);
  color: var(--foreground);
  outline: none;
}

.ktm-setting-actions {
  gap: 0.375rem;
  margin-left: auto;
}

.ktm-move-button {
  min-height: 1.625rem;
  padding: 0 0.375rem;
  border-radius: 0.25rem;
  font-size: 0.6875rem;
}

.ktm-move-button:disabled {
  cursor: not-allowed;
  opacity: 0.4;
}

.ktm-visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

@media (max-width: 640px) {
  .ktm-monitor {
    height: 2.75rem;
    padding: 0 0.5rem;
  }

  .ktm-monitor-segment {
    padding: 0 0.375rem;
  }

  .ktm-monitor-track {
    width: 1.75rem;
  }
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

  function formatGB(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 GB";
    return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  }

  const DEFAULT_MONITOR_METRICS = [
    { id: "cpu", enabled: true, mode: "tasks_per_core", show_bar: true },
    { id: "memory", enabled: false, unit: "percent", show_bar: true },
    {
      id: "disk",
      enabled: false,
      show_bar: true,
      visibility: "always",
      threshold_percent: DEFAULT_DISK_THRESHOLD,
    },
    { id: "cpu_temperature", enabled: false },
    { id: "system_load", enabled: false },
  ];

  const CPU_MODES = new Set(["host_relative", "tasks_relative", "tasks_per_core"]);
  const MEMORY_UNITS = new Set(["percent", "gb"]);
  const DISK_VISIBILITY = new Set(["always", "threshold"]);

  function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function cloneMonitorMetric(metric) {
    return { ...metric };
  }

  function defaultMonitorSettings() {
    return {
      version: MONITOR_SETTINGS_VERSION,
      metrics: DEFAULT_MONITOR_METRICS.map(cloneMonitorMetric),
    };
  }

  function normalizeMonitorSettings(value) {
    if (!isRecord(value) || value.version !== MONITOR_SETTINGS_VERSION || !Array.isArray(value.metrics)) {
      return defaultMonitorSettings();
    }
    const defaults = new Map(DEFAULT_MONITOR_METRICS.map((metric) => [metric.id, metric]));
    const seen = new Set();
    const metrics = [];
    for (const candidate of value.metrics) {
      if (!isRecord(candidate) || typeof candidate.id !== "string" || !defaults.has(candidate.id)) continue;
      if (seen.has(candidate.id)) continue;
      seen.add(candidate.id);
      metrics.push(normalizeMonitorMetric(candidate, defaults.get(candidate.id)));
    }
    for (const metric of DEFAULT_MONITOR_METRICS) {
      if (!seen.has(metric.id)) metrics.push(cloneMonitorMetric(metric));
    }
    return { version: MONITOR_SETTINGS_VERSION, metrics };
  }

  function normalizeMonitorMetric(candidate, fallback) {
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
      if (Number.isInteger(candidate.threshold_percent) && candidate.threshold_percent >= 1 && candidate.threshold_percent <= 100) {
        metric.threshold_percent = candidate.threshold_percent;
      }
    }
    return metric;
  }

  function settingsRevision(settings) {
    return JSON.stringify(normalizeMonitorSettings(settings));
  }

  function settingsEqual(left, right) {
    return settingsRevision(left) === settingsRevision(right);
  }

  function enabledMonitorMetrics(settings) {
    return normalizeMonitorSettings(settings).metrics.filter((metric) => metric.enabled);
  }

  function cpuSourceForMode(mode) {
    return mode === "host_relative" ? "host" : "tasks";
  }

  function summaryRequestForSettings(settings) {
    const normalized = normalizeMonitorSettings(settings);
    const metrics = enabledMonitorMetrics(normalized);
    const cpu = metrics.find((metric) => metric.id === "cpu");
    const request = { metric_ids: metrics.map((metric) => metric.id) };
    if (cpu) request.cpu_source = cpuSourceForMode(cpu.mode);
    return request;
  }

  function moveMonitorMetric(metrics, id, direction) {
    const next = (metrics || []).map(cloneMonitorMetric);
    const index = next.findIndex((metric) => metric.id === id);
    const target = direction === "up" ? index - 1 : index + 1;
    if (index < 0 || target < 0 || target >= next.length) return next;
    [next[index], next[target]] = [next[target], next[index]];
    return next;
  }

  function reorderMonitorMetrics(metrics, fromId, toId) {
    const next = (metrics || []).map(cloneMonitorMetric);
    const from = next.findIndex((metric) => metric.id === fromId);
    const to = next.findIndex((metric) => metric.id === toId);
    if (from < 0 || to < 0 || from === to) return next;
    const [moved] = next.splice(from, 1);
    next.splice(next.findIndex((metric) => metric.id === toId), 0, moved);
    return next;
  }

  function diskMonitorVisible(metric, sample) {
    if (!metric || !metric.enabled || !sample) return false;
    if (!sample.available || metric.visibility === "always") return true;
    return sample.percent >= metric.threshold_percent;
  }

  function monitorProgressPercent(id, sample) {
    if (!sample || !sample.available) return null;
    if (id === "cpu") return sample.relative_percent;
    if (id === "memory" || id === "disk") return sample.percent;
    return null;
  }

  function monitorProgressWidth(value) {
    if (!Number.isFinite(value) || value <= 0) return "0%";
    const percent = Math.min(100, value);
    return `${Math.max(1.5, percent)}%`;
  }

  function monitorIntervalMilliseconds(value) {
    const seconds = Number(value);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 300) return null;
    return Math.min(MAX_MONITOR_INTERVAL_MS, Math.max(MIN_MONITOR_INTERVAL_MS, seconds * 1000));
  }

  function createMonitorController(host) {
    let state = {
      phase: "loading",
      confirmed: null,
      draft: null,
      updatedAt: null,
      error: null,
      conflict: false,
    };
    let destroyed = false;
    let requestToken = 0;
    let saveToken = 0;
    let unsubscribe = null;
    const listeners = new Set();
    const aborter = new AbortController();

    function notify() {
      for (const listener of listeners) listener();
    }

    function update(next) {
      if (destroyed) return;
      state = next;
      notify();
    }

    function isDirty() {
      return Boolean(state.confirmed && state.draft && !settingsEqual(state.confirmed, state.draft));
    }

    function getState() {
      return {
        ...state,
        dirty: isDirty(),
        revision: state.draft ? settingsRevision(state.draft) : "",
        confirmedRevision: state.confirmed ? settingsRevision(state.confirmed) : "",
      };
    }

    async function refresh(keepDraft) {
      const token = ++requestToken;
      update({ ...state, phase: "loading", error: keepDraft ? state.error : null });
      try {
        const entry = await host.storage.get(
          MONITOR_STORAGE_SCOPE,
          MONITOR_STORAGE_SCOPE_ID,
          MONITOR_STORAGE_KEY,
          { signal: aborter.signal },
        );
        if (destroyed || token !== requestToken) return;
        const confirmed = normalizeMonitorSettings(entry && entry.value);
        const draft = keepDraft && isDirty() ? state.draft : confirmed;
        update({
          phase: "ready",
          confirmed,
          draft,
          updatedAt: (entry && entry.updatedAt) || null,
          error: null,
          conflict: Boolean(keepDraft && isDirty()),
        });
      } catch (error) {
        if (destroyed || token !== requestToken || error?.name === "AbortError") return;
        update({ ...state, phase: "error", error: String(error?.message || error), conflict: false });
      }
    }

    function setDraft(next) {
      if (state.phase !== "ready") return;
      update({ ...state, draft: normalizeMonitorSettings(next), error: null, conflict: false });
    }

    async function save(revision) {
      if (state.phase !== "ready" || !state.draft || !state.confirmed || revision !== settingsRevision(state.draft)) {
        throw new Error("settings changed before save completed");
      }
      const token = ++saveToken;
      const draft = normalizeMonitorSettings(state.draft);
      try {
        const result = await host.storage.set(
          MONITOR_STORAGE_SCOPE,
          MONITOR_STORAGE_SCOPE_ID,
          MONITOR_STORAGE_KEY,
          draft,
          {
            signal: aborter.signal,
            ifUnmodifiedSince: state.updatedAt || undefined,
          },
        );
        if (destroyed || token !== saveToken) return;
        if (settingsRevision(state.draft) !== revision) {
          // The write may have completed after the user made another edit.
          // Refresh the confirmed value and keep that newer draft instead of
          // silently replacing it with the older submitted object.
          await refresh(true);
          return;
        }
        update({
          phase: "ready",
          confirmed: draft,
          draft,
          updatedAt: result.updatedAt,
          error: null,
          conflict: false,
        });
      } catch (error) {
        if (destroyed || error?.name === "AbortError") return;
        if (error?.name === "PluginStorageConflictError") {
          await refresh(true);
          throw error;
        }
        update({ ...state, phase: "ready", error: String(error?.message || error), conflict: false });
        throw error;
      }
    }

    function discard(revision) {
      if (state.phase !== "ready" || !state.confirmed || (revision && revision !== settingsRevision(state.draft))) return;
      update({ ...state, draft: state.confirmed, error: null, conflict: false });
    }

    function retry() {
      return refresh(false);
    }

    function start() {
      if (
        !host.storage ||
        typeof host.storage.get !== "function" ||
        typeof host.storage.set !== "function"
      ) {
        update({ ...state, phase: "error", error: "Plugin storage is unavailable", conflict: false });
        return Promise.resolve();
      }
      if (typeof host.storage.subscribe === "function") {
        unsubscribe = host.storage.subscribe(
          { scope: MONITOR_STORAGE_SCOPE, scopeId: MONITOR_STORAGE_SCOPE_ID, key: MONITOR_STORAGE_KEY },
          () => refresh(true),
        );
      }
      return refresh(false);
    }

    function destroy() {
      destroyed = true;
      requestToken += 1;
      saveToken += 1;
      aborter.abort();
      if (unsubscribe) unsubscribe();
      unsubscribe = null;
      listeners.clear();
    }

    return {
      start,
      destroy,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      getState,
      setDraft,
      save,
      discard,
      retry,
      isDirty,
    };
  }

  function makeUseMonitorState(host, controller) {
    const { React } = host;
    return function useMonitorState() {
      const [, setVersion] = React.useState(0);
      React.useEffect(() => controller.subscribe(() => setVersion((version) => version + 1)), [controller]);
      return controller.getState();
    };
  }

  function makeUseSummary(host) {
    const { React } = host;
    return function useSummary(settingsState) {
      const [state, setState] = React.useState({
        loading: false,
        error: null,
        report: null,
        stale: false,
      });
      const timer = React.useRef(null);

      React.useEffect(() => {
        let alive = true;
        const requestController = new AbortController();
        // Keep the last administrator-approved cadence across transient
        // failures. Falling back to five seconds after a successful 300s
        // response defeats the install-wide cost control exactly when the
        // host is already under pressure.
        let effectiveIntervalMs = DEFAULT_MONITOR_INTERVAL_MS;
        const confirmed = settingsState.confirmed;
        const enabled = confirmed ? enabledMonitorMetrics(confirmed) : [];

        if (settingsState.phase !== "ready" || !confirmed || enabled.length === 0) {
          setState({ loading: false, error: null, report: null, stale: false });
          return () => requestController.abort();
        }

        const schedule = (milliseconds) => {
          if (!alive) return;
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(load, Math.max(1000, milliseconds));
        };
        const load = async () => {
          if (!alive) return;
          setState((previous) => ({
            loading: !previous.report,
            error: null,
            report: previous.report,
            stale: Boolean(previous.report),
          }));
          try {
            const response = await host.api.fetch("webhooks/summary", {
              method: "POST",
              signal: requestController.signal,
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(summaryRequestForSettings(confirmed)),
            });
            const body = await response.json();
            if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
            if (!alive) return;
            setState({ loading: false, error: null, report: body, stale: false });
            const intervalMs = monitorIntervalMilliseconds(body.refresh_interval_seconds);
            if (intervalMs !== null) effectiveIntervalMs = intervalMs;
            schedule(effectiveIntervalMs);
          } catch (error) {
            if (!alive || error?.name === "AbortError") return;
            setState((previous) => ({
              loading: false,
              error: String(error?.message || error),
              report: previous.report,
              stale: Boolean(previous.report),
            }));
            schedule(effectiveIntervalMs);
          }
        };

        setState({ loading: true, error: null, report: null, stale: false });
        load();
        return () => {
          alive = false;
          requestController.abort();
          if (timer.current) clearTimeout(timer.current);
          timer.current = null;
        };
      }, [host, settingsState.phase, settingsState.confirmedRevision]);

      return { ...state, reload: () => undefined };
    };
  }

  function usePluginTranslation(host) {
    if (host.i18n && typeof host.i18n.useTranslation === "function") {
      return host.i18n.useTranslation();
    }
    return {
      locale: "en",
      t: (key) => TRANSLATIONS.en[key] || key,
    };
  }

  function interpolateMessage(message, values) {
    return Object.entries(values || {}).reduce(
      (result, [key, value]) => result.replaceAll(`{{${key}}}`, String(value)),
      message,
    );
  }

  function monitorMetricLabel(t, id) {
    const labels = {
      cpu: "monitorMetricCpu",
      memory: "monitorMetricMemory",
      disk: "monitorMetricDisk",
      cpu_temperature: "monitorMetricTemperature",
      system_load: "monitorMetricLoad",
    };
    return t(labels[id] || id);
  }

  function monitorTime(locale, timestamp) {
    if (!timestamp) return "—";
    try {
      return new Date(timestamp).toLocaleTimeString(locale || undefined, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch (_error) {
      return "—";
    }
  }

  function monitorValue(metric, sample) {
    if (!sample || !sample.available) return null;
    if (metric.id === "cpu") {
      const value = metric.mode === "tasks_per_core" ? sample.core_percent : sample.relative_percent;
      return formatCPU(value);
    }
    if (metric.id === "memory") {
      return metric.unit === "gb" ? formatGB(sample.used_bytes) : formatCPU(sample.percent);
    }
    if (metric.id === "disk") return formatCPU(sample.percent);
    if (metric.id === "cpu_temperature") return `${Number(sample.celsius).toFixed(1)} °C`;
    if (metric.id === "system_load") return Number(sample.one_minute).toFixed(2);
    return null;
  }

  function monitorDetail(t, metric, sample, report, locale) {
    const sampled = interpolateMessage(t("monitorSampledAt"), {
      time: monitorTime(locale, report && report.sampled_at),
    });
    if (!sample || !sample.available) {
      const path = metric.id === "disk" && sample && sample.path
        ? interpolateMessage(t("monitorPath"), { path: sample.path })
        : null;
      return [t("monitorUnavailable"), sample && sample.error, path, sampled].filter(Boolean).join(" · ");
    }
    if (metric.id === "memory" || metric.id === "disk") {
      const used = formatGB(sample.used_bytes);
      const total = formatGB(sample.total_bytes);
      const capacity = interpolateMessage(t("monitorUsedOf"), { used, total });
      const bytes = interpolateMessage(t("monitorBytesDetail"), {
        used: sample.used_bytes,
        total: sample.total_bytes,
      });
      const path = metric.id === "disk" && sample.path
        ? interpolateMessage(t("monitorPath"), { path: sample.path })
        : null;
      return [capacity, bytes, path, sampled].filter(Boolean).join(" · ");
    }
    const source = metric.id === "cpu"
      ? metric.mode === "host_relative" ? t("monitorHostSource") : t("monitorTasksSource")
      : null;
    return [source, sampled].filter(Boolean).join(" · ");
  }

  function monitorSegment(host, t, locale, metric, report, stale) {
    const { jsx: h } = host;
    const sample = report && report.metrics && report.metrics[metric.id];
    if (metric.id === "disk" && !diskMonitorVisible(metric, sample)) return null;
    if (!sample) return null;
    const available = Boolean(sample.available);
    const value = monitorValue(metric, sample) || t("monitorUnavailable");
    const progress = monitorProgressPercent(metric.id, sample);
    const detail = monitorDetail(t, metric, sample, report, locale);
    const inspectableDetail = stale ? `${detail} · ${t("monitorStale")}` : detail;
    const classes = [
      "ktm-monitor-segment",
      stale ? "ktm-monitor-stale" : "",
      !available ? "ktm-monitor-unavailable" : "",
    ].filter(Boolean).join(" ");
    return h(
      "span",
      {
        key: metric.id,
        className: classes,
        "data-testid": `ktm-monitor-${metric.id}`,
        "data-stale": stale ? "true" : "false",
        title: inspectableDetail,
      },
      h("span", { className: "ktm-monitor-label" }, monitorMetricLabel(t, metric.id)),
      metric.show_bar && progress !== null
        ? h(
            "span",
            { className: "ktm-monitor-track", "aria-hidden": "true" },
            h("span", {
              className: `ktm-fill${progress >= ONE_CORE ? " ktm-fill-hot" : ""}`,
              style: { width: monitorProgressWidth(progress) },
            }),
          )
        : null,
      h("span", { className: "ktm-monitor-value" }, value),
    );
  }

  function monitorAccessibleSegment(t, locale, metric, report, stale) {
    const sample = report && report.metrics && report.metrics[metric.id];
    if (!sample) return null;
    const value = monitorValue(metric, sample) || t("monitorUnavailable");
    const detail = monitorDetail(t, metric, sample, report, locale);
    const state = stale ? ` · ${t("monitorStale")}` : "";
    return `${monitorMetricLabel(t, metric.id)}: ${value} (${detail}${state})`;
  }

  function makeAmbientMonitor(host, controller, openManager) {
    const { React, jsx: h } = host;
    const MonitorButton = host.ui?.Button || "button";
    const useMonitorState = makeUseMonitorState(host, controller);
    const useSummary = makeUseSummary(host);

    return function AmbientMonitor(props) {
      const settingsState = useMonitorState();
      const { locale, t } = usePluginTranslation(host);
      const summary = useSummary(settingsState);
      if (settingsState.phase !== "ready" || !summary.report || !settingsState.confirmed) return null;
      const metrics = enabledMonitorMetrics(settingsState.confirmed);
      const visibleMetrics = metrics.filter((metric) =>
        metric.id !== "disk" || diskMonitorVisible(metric, summary.report.metrics?.disk),
      );
      const segments = visibleMetrics
        .map((metric) => monitorSegment(host, t, locale, metric, summary.report, summary.stale))
        .filter(Boolean);
      if (segments.length === 0) return null;
      const accessibleSegments = visibleMetrics
        .map((metric) => monitorAccessibleSegment(t, locale, metric, summary.report, summary.stale))
        .filter(Boolean);
      const mobile = props && props.presentation === "mobile";
      const title = interpolateMessage(t("monitorHotkeyHint"), { hotkey: HOTKEY_HINT });
      return h(
        MonitorButton,
        {
          type: "button",
          variant: "outline",
          size: "lg",
          className: "ktm-monitor",
          style: mobile ? { minHeight: "2.75rem" } : null,
          onClick: () => openManager(),
          // aria-label replaces the button's descendant text in the
          // accessibility tree. Include the ordered values and their state
          // here so a screen reader does not hear only "Open…".
          "aria-label": `${t("monitorOpen")}: ${accessibleSegments.join("; ")}`,
          title,
          // The host keeps ordinary mobile icon actions compact. This
          // contribution contains ordered values, so it opts into the rich
          // status-control contract and owns its 44px touch geometry.
          "data-main-top-bar-rich": "true",
          "data-testid": "ktm-host-monitor",
        },
        segments,
      );
    };
  }

  function makeMonitorSettings(host, controller) {
    const { React, jsx: h } = host;
    const ui = host.ui || {};
    const SettingsCard = ui.SettingsCard || "section";
    const CardHeader = ui.CardHeader || "div";
    const CardTitle = ui.CardTitle || "h2";
    const CardContent = ui.CardContent || "div";
    const Button = ui.Button || "button";
    const useMonitorState = makeUseMonitorState(host, controller);

    function SwitchControl({ checked, onChange, id, label }) {
      if (ui.Switch) {
        return h(ui.Switch, {
          id,
          checked,
          onCheckedChange: onChange,
          "aria-label": label,
        });
      }
      return h("input", {
        id,
        type: "checkbox",
        checked,
        onChange: (event) => onChange(event.target.checked),
        "aria-label": label,
      });
    }

    function CheckboxControl({ checked, onChange, id, label }) {
      if (ui.Checkbox) {
        return h(ui.Checkbox, {
          id,
          checked,
          onCheckedChange: onChange,
          "aria-label": label,
        });
      }
      return h("input", {
        id,
        type: "checkbox",
        checked,
        onChange: (event) => onChange(event.target.checked),
        "aria-label": label,
      });
    }

    function SelectControl({ value, onChange, options, id, label }) {
      return h(
        "select",
        {
          id,
          value,
          "aria-label": label,
          onChange: (event) => onChange(event.target.value),
        },
        options.map((option) => h("option", { key: option.value, value: option.value }, option.label)),
      );
    }

    function DiskHelp({ t }) {
      const helpId = "ktm-disk-monitor-help";
      const help = t("monitorDiskHelp");
      const trigger = h(
        "button",
        {
          type: "button",
          className: "ktm-help-button",
          "aria-label": t("monitorDiskHelpLabel"),
          "aria-describedby": helpId,
          title: help,
        },
        "i",
      );
      if (ui.Tooltip && ui.TooltipTrigger && ui.TooltipContent) {
        const tooltip = h(
          ui.Tooltip,
          null,
          h(ui.TooltipTrigger, { asChild: true }, trigger),
          h(ui.TooltipContent, { id: helpId }, help),
        );
        return ui.TooltipProvider ? h(ui.TooltipProvider, null, tooltip) : tooltip;
      }
      return h(
        React.Fragment,
        null,
        trigger,
        h("span", { id: helpId, className: "ktm-visually-hidden" }, help),
      );
    }

    return function MonitorSettings() {
      const settingsState = useMonitorState();
      const { t } = usePluginTranslation(host);
      const [draggedId, setDraggedId] = React.useState(null);
      const [dragOverId, setDragOverId] = React.useState(null);

      if (typeof host.useSettingsSaveContributor === "function") {
        host.useSettingsSaveContributor({
          id: "host-monitor-display",
          order: 30,
          revision: settingsState.revision || "loading",
          isDirty: settingsState.dirty,
          canSave: settingsState.phase === "ready" && settingsState.dirty,
          invalidReason: settingsState.error || undefined,
          save: (revision) => controller.save(revision),
          discard: (revision) => controller.discard(revision),
        });
      }

      const focusMetric = (id) => {
        if (typeof document === "undefined") return;
        window.setTimeout(() => {
          document.querySelector(`[data-metric-id="${id}"] .ktm-drag-handle`)?.focus();
        }, 0);
      };
      const updateMetric = (id, changes) => {
        const draft = settingsState.draft;
        if (!draft) return;
        controller.setDraft({
          version: MONITOR_SETTINGS_VERSION,
          metrics: draft.metrics.map((metric) =>
            metric.id === id ? { ...metric, ...changes } : metric,
          ),
        });
      };
      const move = (id, direction) => {
        const draft = settingsState.draft;
        if (!draft) return;
        controller.setDraft({
          version: MONITOR_SETTINGS_VERSION,
          metrics: moveMonitorMetric(draft.metrics, id, direction),
        });
        focusMetric(id);
      };
      const reorder = (fromId, toId) => {
        const draft = settingsState.draft;
        if (!draft || !fromId || fromId === toId) return;
        controller.setDraft({
          version: MONITOR_SETTINGS_VERSION,
          metrics: reorderMonitorMetrics(draft.metrics, fromId, toId),
        });
        focusMetric(fromId);
      };

      const card = (children) =>
        h(
          SettingsCard,
          { className: "ktm-settings", "data-testid": "ktm-monitor-settings" },
          children,
        );
      if (settingsState.phase === "loading") {
        return card([
          h(CardHeader, { key: "header" }, h(CardTitle, null, t("monitorSettingsTitle"))),
          h(CardContent, { key: "content" }, h("p", { className: "ktm-settings-status" }, t("monitorLoading"))),
        ]);
      }
      if (settingsState.phase === "error" || !settingsState.draft) {
        return card([
          h(CardHeader, { key: "header" }, h(CardTitle, null, t("monitorSettingsTitle"))),
          h(
            CardContent,
            { key: "content" },
            h("p", { className: "ktm-settings-status ktm-settings-status-error" }, t("monitorSettingsLoadError")),
            h("p", { className: "ktm-settings-status ktm-settings-status-error" }, settingsState.error || t("monitorUnknownError")),
            h(
              Button,
              {
                type: "button",
                variant: "outline",
                onClick: () => controller.retry(),
                "data-testid": "ktm-monitor-settings-retry",
              },
              t("monitorSettingsRetry"),
            ),
          ),
        ]);
      }

      const metrics = settingsState.draft.metrics;
      const updateDragState = (id) => setDragOverId(id);
      const rows = metrics.map((metric, index) => {
        const label = monitorMetricLabel(t, metric.id);
        const rowClass = `ktm-setting-row${dragOverId === metric.id ? " ktm-setting-row-dragover" : ""}`;
        const row = h(
          "div",
          {
            key: metric.id,
            className: rowClass,
            "data-testid": `ktm-setting-row-${metric.id}`,
            "data-metric-id": metric.id,
            draggable: true,
            onDragStart: (event) => {
              setDraggedId(metric.id);
              event.dataTransfer?.setData("text/plain", metric.id);
              if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
            },
            onDragOver: (event) => {
              event.preventDefault();
              updateDragState(metric.id);
            },
            onDrop: (event) => {
              event.preventDefault();
              const fromId = draggedId || event.dataTransfer?.getData("text/plain");
              reorder(fromId, metric.id);
              setDraggedId(null);
              setDragOverId(null);
            },
            onDragEnd: () => {
              setDraggedId(null);
              setDragOverId(null);
            },
          },
          h(
            "div",
            { className: "ktm-setting-heading" },
            h(
              "button",
              {
                type: "button",
                className: "ktm-drag-handle",
                draggable: false,
                "aria-label": `${t("monitorDragMetric")}: ${label}`,
                onKeyDown: (event) => {
                  if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                    event.preventDefault();
                    move(metric.id, event.key === "ArrowUp" ? "up" : "down");
                  }
                },
              },
              "⋮⋮",
            ),
            h("span", { className: "ktm-setting-label" }, label),
            metric.id === "disk" ? h(DiskHelp, { t }) : null,
            h(
              "div",
              { className: "ktm-setting-actions" },
              h(
                Button,
                {
                  type: "button",
                  className: "ktm-move-button ktm-move-up",
                  variant: "ghost",
                  disabled: index === 0,
                  "aria-label": `${t("monitorMoveUp")}: ${label}`,
                  onClick: () => move(metric.id, "up"),
                },
                "↑",
              ),
              h(
                Button,
                {
                  type: "button",
                  className: "ktm-move-button ktm-move-down",
                  variant: "ghost",
                  disabled: index === metrics.length - 1,
                  "aria-label": `${t("monitorMoveDown")}: ${label}`,
                  onClick: () => move(metric.id, "down"),
                },
                "↓",
              ),
            ),
          ),
          h(
            "div",
            { className: "ktm-setting-controls" },
            h(
              "label",
              { className: "ktm-setting-control", htmlFor: `ktm-enabled-${metric.id}` },
              h(SwitchControl, {
                id: `ktm-enabled-${metric.id}`,
                checked: metric.enabled,
                onChange: (checked) => updateMetric(metric.id, { enabled: Boolean(checked) }),
                label: `${t("monitorSettingsEnabled")}: ${label}`,
              }),
              t("monitorSettingsEnabled"),
            ),
            metric.id === "cpu"
              ? h(
                  React.Fragment,
                  null,
                  h(
                    "label",
                    { className: "ktm-setting-control", htmlFor: "ktm-cpu-mode" },
                    t("monitorCpuMode"),
                    h(SelectControl, {
                      id: "ktm-cpu-mode",
                      value: metric.mode,
                      label: t("monitorCpuMode"),
                      onChange: (mode) => updateMetric(metric.id, { mode }),
                      options: [
                        { value: "host_relative", label: t("monitorCpuModeHost") },
                        { value: "tasks_relative", label: t("monitorCpuModeTasks") },
                        { value: "tasks_per_core", label: t("monitorCpuModePerCore") },
                      ],
                    }),
                  ),
                  h(
                    "label",
                    { className: "ktm-setting-control", htmlFor: "ktm-bar-cpu" },
                    h(CheckboxControl, {
                      id: "ktm-bar-cpu",
                      checked: metric.show_bar,
                      onChange: (show_bar) => updateMetric(metric.id, { show_bar: Boolean(show_bar) }),
                      label: `${t("monitorSettingsBar")}: ${label}`,
                    }),
                    t("monitorSettingsBar"),
                  ),
                )
              : null,
            metric.id === "memory"
              ? h(
                  React.Fragment,
                  null,
                  h(
                    "label",
                    { className: "ktm-setting-control", htmlFor: "ktm-memory-unit" },
                    t("monitorMemoryUnit"),
                    h(SelectControl, {
                      id: "ktm-memory-unit",
                      value: metric.unit,
                      label: t("monitorMemoryUnit"),
                      onChange: (unit) => updateMetric(metric.id, { unit }),
                      options: [
                        { value: "percent", label: t("monitorMemoryUnitPercent") },
                        { value: "gb", label: t("monitorMemoryUnitGB") },
                      ],
                    }),
                  ),
                  h(
                    "label",
                    { className: "ktm-setting-control", htmlFor: "ktm-bar-memory" },
                    h(CheckboxControl, {
                      id: "ktm-bar-memory",
                      checked: metric.show_bar,
                      onChange: (show_bar) => updateMetric(metric.id, { show_bar: Boolean(show_bar) }),
                      label: `${t("monitorSettingsBar")}: ${label}`,
                    }),
                    t("monitorSettingsBar"),
                  ),
                )
              : null,
            metric.id === "disk"
              ? h(
                  React.Fragment,
                  null,
                  h(
                    "label",
                    { className: "ktm-setting-control", htmlFor: "ktm-disk-visibility" },
                    t("monitorDiskVisibility"),
                    h(SelectControl, {
                      id: "ktm-disk-visibility",
                      value: metric.visibility,
                      label: t("monitorDiskVisibility"),
                      onChange: (visibility) => updateMetric(metric.id, { visibility }),
                      options: [
                        { value: "always", label: t("monitorDiskVisibilityAlways") },
                        { value: "threshold", label: t("monitorDiskVisibilityThreshold") },
                      ],
                    }),
                  ),
                  metric.visibility === "threshold"
                    ? h(
                        "label",
                        { className: "ktm-setting-control", htmlFor: "ktm-disk-threshold" },
                        t("monitorDiskThreshold"),
                        h("input", {
                          id: "ktm-disk-threshold",
                          type: "number",
                          min: 1,
                          max: 100,
                          step: 1,
                          value: metric.threshold_percent,
                          onChange: (event) => updateMetric(metric.id, {
                            threshold_percent: Number(event.target.value),
                          }),
                        }),
                      )
                    : null,
                  h(
                    "label",
                    { className: "ktm-setting-control", htmlFor: "ktm-bar-disk" },
                    h(CheckboxControl, {
                      id: "ktm-bar-disk",
                      checked: metric.show_bar,
                      onChange: (show_bar) => updateMetric(metric.id, { show_bar: Boolean(show_bar) }),
                      label: `${t("monitorSettingsBar")}: ${label}`,
                    }),
                    t("monitorSettingsBar"),
                  ),
                )
              : null,
          ),
        );
        return row;
      });

      return card([
        h(CardHeader, { key: "header" }, h(CardTitle, null, t("monitorSettingsTitle"))),
        h(
          CardContent,
          { key: "content" },
          h("p", { className: "ktm-settings-description" }, t("monitorSettingsDescription")),
          settingsState.conflict
            ? h("p", { className: "ktm-settings-status ktm-settings-status-conflict", role: "alert" }, t("monitorSettingsConflict"))
            : null,
          settingsState.error
            ? h("p", { className: "ktm-settings-status ktm-settings-status-error", role: "alert" }, settingsState.error)
            : null,
          h("div", { className: "ktm-settings-list" }, rows),
          enabledMonitorMetrics(settingsState.draft).length === 0
            ? h("p", { className: "ktm-settings-status" }, t("monitorNoEnabledMetrics"))
            : null,
        ),
      ]);
    };
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

      React.useEffect(() => {
        let alive = true;
        let active = null;
        const schedule = () => {
          if (!alive || !pollMs) return;
          timer.current = setTimeout(() => load(true), pollMs);
        };
        const load = async (quiet) => {
          if (!alive) return;
          if (active) active.abort();
          active = new AbortController();
          if (!quiet) setState((s) => ({ ...s, loading: !s.report, error: null }));
          try {
            // POST, not GET, and deliberately so. Kandev requires a valid
            // Origin header on session-authenticated webhook calls as CSRF
            // protection — browsers omit Origin on same-origin GET requests.
            const response = await host.api.fetch("webhooks/usage", {
              method: "POST",
              signal: active.signal,
            });
            const body = await response.json();
            if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
            if (!alive) return;
            setState({ loading: false, error: null, report: body });
          } catch (error) {
            if (!alive || error?.name === "AbortError") return;
            // Keep the last good report on screen through a transient failure:
            // a monitor that blanks itself on one dropped poll is worse than
            // one showing a reading a second or two old.
            setState((s) => ({
              loading: false,
              error: String(error?.message || error),
              report: s.report,
            }));
          } finally {
            schedule();
          }
        };
        load(false);
        return () => {
          alive = false;
          if (active) active.abort();
          if (timer.current) clearTimeout(timer.current);
          timer.current = null;
        };
      }, [host, pollMs]);

      return { ...state, reload: () => undefined };
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

  let activeMonitorController = null;

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

      if (activeMonitorController) activeMonitorController.destroy();
      const monitorController = createMonitorController(host);
      activeMonitorController = monitorController;
      monitorController.start();
      registry.registerTranslations(TRANSLATIONS);
      registry.registerKeybinding("open-task-manager", () => openManager());
      registry.registerComponent("main-top-bar", makeAmbientMonitor(host, monitorController, openManager));
      registry.registerComponent("plugin-settings", makeMonitorSettings(host, monitorController));
    },

    // The host revokes slots, keybindings and modals itself, but its style
    // cleanup only looks for <link> elements, so the injected <style> is this
    // plugin's to remove.
    destroy() {
      if (activeMonitorController) activeMonitorController.destroy();
      activeMonitorController = null;
      const style = document.getElementById(STYLE_ELEMENT_ID);
      if (style) style.remove();
    },
  });
})();
