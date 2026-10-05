import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startStaticServer } from "./server.mjs";

const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(process.env.HARNESS_OUT || resolve(REPO_DIR, ".harness/screenshots"));
await mkdir(OUT, { recursive: true });
const staticServer = process.env.HARNESS_URL ? null : await startStaticServer(REPO_DIR);
const BASE = process.env.HARNESS_URL || `${staticServer.url}/.harness/index.html`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });

const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForSelector(".ktm-frame", { timeout: 10000 });
await page.waitForSelector("[data-testid=ktm-host-monitor]", { timeout: 10000 });
await page.waitForSelector("[data-testid=ktm-monitor-settings]", { timeout: 10000 });
await page.waitForTimeout(300);

// The overflow check that matters: does any element stick out past the
// dialog, and does the table scroll horizontally?
const overflow = await page.evaluate(() => {
  const dialog = document.getElementById("dialog");
  const scroll = document.querySelector(".ktm-list");
  const dialogRect = dialog.getBoundingClientRect();
  const strays = [];
  document.querySelectorAll("#dialog *").forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && (r.right > dialogRect.right + 1 || r.left < dialogRect.left - 1)) {
      strays.push(`${el.className || el.tagName} right=${Math.round(r.right)}`);
    }
  });
  return {
    dialogWidth: Math.round(dialogRect.width),
    scrollHorizontal: scroll.scrollWidth - scroll.clientWidth,
    bodyHorizontal: document.body.scrollWidth - document.body.clientWidth,
    strays: strays.slice(0, 5),
  };
});
console.log("overflow check:", JSON.stringify(overflow));
if (overflow.scrollHorizontal > 1 || overflow.bodyHorizontal > 1 || overflow.strays.length) {
  console.error("FAIL: content overflows the dialog");
  process.exitCode = 1;
}

// The styles must be in effect, not merely present. This is the check that
// would have caught the bundle rendering as an unstyled wall of text because
// its stylesheet never resolved.
const styling = await page.evaluate(() => {
  const frame = document.querySelector(".ktm-frame");
  const spark = document.querySelector(".ktm-spark");
  const head = document.querySelector(".ktm-task-head");
  const sparkRect = spark.getBoundingClientRect();
  return {
    injectedStyleTag: Boolean(document.getElementById("ktm-styles")),
    frameIsFlexColumn: getComputedStyle(frame).flexDirection === "column",
    frameHeight: Math.round(frame.getBoundingClientRect().height),
    // A row that renders as plain inline spans is the signature of missing
    // styles, so assert the grid took effect and the sparkline has real
    // geometry with a drawn path inside it.
    headIsGrid: getComputedStyle(head).display === "grid",
    headColumns: getComputedStyle(head).gridTemplateColumns.split(" ").length,
    sparkWidth: Math.round(sparkRect.width),
    sparkHeight: Math.round(sparkRect.height),
    sparkHasPath: Boolean(spark.querySelector("path.ktm-spark-line")?.getAttribute("d")),
  };
});
console.log("styling in effect:", JSON.stringify(styling));
if (
  !styling.injectedStyleTag ||
  !styling.frameIsFlexColumn ||
  !styling.headIsGrid ||
  styling.headColumns !== 5 ||
  styling.sparkHeight === 0 ||
  styling.sparkWidth < 40 ||
  !styling.sparkHasPath
) {
  console.error("FAIL: plugin styles are not applied");
  process.exitCode = 1;
}

// Idle tasks must fold away rather than burying the working ones.
const grouping = await page.evaluate(() => ({
  activeRows: document.querySelectorAll(".ktm-list > .ktm-task").length,
  idleRowText: document.querySelector(".ktm-idle-head")?.innerText.replace(/\s+/g, " ") ?? null,
}));
console.log("grouping:", JSON.stringify(grouping));

// The monitor is a <button>, which does not inherit colour; a missing rule
// leaves its value in the UA's dark grey, invisible on a dark background.
const chip = await page.evaluate(() => {
  const value = document.querySelector(".ktm-monitor-value");
  if (!value) return null;
  const monitor = document.querySelector("[data-testid=ktm-host-monitor]");
  return {
    color: getComputedStyle(value).color,
    text: value.innerText,
    accessibleLabel: monitor?.getAttribute("aria-label") || null,
  };
});
console.log("host monitor value:", JSON.stringify(chip));
if (
  !chip ||
  !chip.text ||
  chip.color === "rgb(128, 128, 128)" ||
  !chip.accessibleLabel?.includes("CPU") ||
  !chip.accessibleLabel.includes(chip.text)
) {
  console.error("FAIL: host monitor did not render a readable value");
  process.exitCode = 1;
}

// A successful 300-second response must control the retry after a transient
// error. This fires the pending production timer directly so the test stays
// fast while still exercising the actual useSummary closure.
await page.evaluate(() => window.__setSummaryFailure(true));
await page.evaluate(async () => {
  await window.__runScheduledTimer(300000);
});
await page.waitForTimeout(100);
const retryCadence = await page.evaluate(() => ({
  pending: window.__pendingTimerDelays(),
  accessibleLabel: document.querySelector("[data-testid=ktm-host-monitor]")?.getAttribute("aria-label") || null,
}));
console.log("summary retry cadence and accessible state:", JSON.stringify(retryCadence));
if (!retryCadence.pending.includes(300000) || retryCadence.pending.includes(5000) || !retryCadence.accessibleLabel?.includes("stale")) {
  console.error("FAIL: summary retry cadence or stale accessible status regressed");
  process.exitCode = 1;
}
await page.evaluate(() => {
  window.__setSummaryFailure(false);
  window.__setSummaryInterval(1);
});

const settingsShape = await page.evaluate(() => ({
  rows: document.querySelectorAll("[data-testid^=ktm-monitor-settings] [data-metric-id]").length,
  diskHelpLabel: document.querySelector(".ktm-help-button")?.getAttribute("aria-label") || null,
  diskHelpRelation: document.querySelector(".ktm-help-button")?.getAttribute("aria-describedby") || null,
  diskHelpText: document.getElementById("ktm-disk-monitor-help")?.textContent || null,
  initialRequest: window.__lastSummaryRequest(),
}));
console.log("settings shape:", JSON.stringify(settingsShape));
if (
  settingsShape.rows !== 5 ||
  !settingsShape.diskHelpLabel ||
  !settingsShape.diskHelpRelation ||
  !settingsShape.diskHelpText ||
  JSON.stringify(settingsShape.initialRequest) !== JSON.stringify({ metric_ids: ["cpu"], cpu_source: "tasks" })
) {
  console.error("FAIL: monitor settings or disk help is incomplete");
  process.exitCode = 1;
}

// Keyboard ordering must preserve the moved metric's focus target. Discard
// restores the confirmed order before the next setting is changed.
await page.locator("[data-testid=ktm-monitor-settings] [data-metric-id=cpu] .ktm-drag-handle").focus();
await page.keyboard.press("ArrowDown");
await page.waitForTimeout(100);
const movedOrder = await page.locator("[data-testid=ktm-monitor-settings] [data-metric-id]").evaluateAll(
  (rows) => rows.map((row) => row.dataset.metricId),
);
console.log("keyboard order:", JSON.stringify(movedOrder));
if (movedOrder[1] !== "cpu") {
  console.error("FAIL: keyboard metric ordering did not move CPU");
  process.exitCode = 1;
}
await page.evaluate(() => window.__discardMonitorSettings());
await page.waitForTimeout(100);

await page.locator("#ktm-enabled-memory").check();
await page.evaluate(() => window.__saveMonitorSettings());
await page.waitForSelector("[data-testid=ktm-monitor-memory]", { timeout: 5000 });
console.log("saved memory metric:", await page.locator("[data-testid=ktm-monitor-memory]").innerText());

// A threshold controls presentation only. The disk selector must remain in
// the request so a later threshold crossing can appear without changing the
// administrator's sampling policy.
await page.locator("#ktm-enabled-disk").check();
await page.locator("#ktm-disk-visibility").selectOption("threshold");
await page.locator("#ktm-disk-threshold").fill("83");
await page.evaluate(() => window.__saveMonitorSettings());
await page.waitForFunction(() => window.__lastSummaryRequest()?.metric_ids?.includes("disk"), null, { timeout: 5000 });
await page.waitForFunction(() => !document.querySelector("[data-testid=ktm-monitor-disk]"), null, { timeout: 5000 });
const hiddenDisk = await page.evaluate(() => ({
  visible: Boolean(document.querySelector("[data-testid=ktm-monitor-disk]")),
  requested: window.__lastSummaryRequest()?.metric_ids || [],
}));
console.log("disk threshold below value:", JSON.stringify(hiddenDisk));
if (hiddenDisk.visible || !hiddenDisk.requested.includes("disk")) {
  console.error("FAIL: disk threshold hid sampling or rendered below threshold");
  process.exitCode = 1;
}
await page.locator("#ktm-disk-threshold").fill("82");
await page.evaluate(() => window.__saveMonitorSettings());
await page.waitForSelector("[data-testid=ktm-monitor-disk]", { timeout: 5000 });
console.log("disk threshold at value:", await page.locator("[data-testid=ktm-monitor-disk]").innerText());
const fetchesBeforeDisable = await page.evaluate(() => window.__summaryFetchCount());

await page.locator(".ktm-help-button").focus();
const focusedHelp = await page.evaluate(() => ({
  focused: document.activeElement?.classList.contains("ktm-help-button"),
  text: document.getElementById("ktm-disk-monitor-help")?.textContent || "",
}));
console.log("keyboard disk help:", JSON.stringify(focusedHelp));
if (!focusedHelp.focused || !focusedHelp.text.includes("does not scan files or directories")) {
  console.error("FAIL: disk help is not keyboard accessible");
  process.exitCode = 1;
}

// Disable every metric and save. The top bar disappears and no new summary
// request is scheduled; re-enable CPU to leave the harness in a usable state.
for (const checkbox of await page.locator("[id^=ktm-enabled-]").all()) {
  if (await checkbox.isChecked()) await checkbox.uncheck();
}
await page.evaluate(() => window.__saveMonitorSettings());
await page.waitForTimeout(1300);
const disabledState = await page.evaluate((before) => ({
  monitor: Boolean(document.querySelector("[data-testid=ktm-host-monitor]")),
  fetches: window.__summaryFetchCount(),
  before,
}), fetchesBeforeDisable);
console.log("all-disabled state:", JSON.stringify(disabledState));
if (disabledState.monitor || disabledState.fetches !== disabledState.before) {
  console.error("FAIL: all-disabled monitor still rendered or polled");
  process.exitCode = 1;
}
await page.locator("#ktm-enabled-cpu").check();
await page.evaluate(() => window.__saveMonitorSettings());
await page.waitForSelector("[data-testid=ktm-host-monitor]", { timeout: 5000 });

await page.setViewportSize({ width: 390, height: 844 });
const mobileMonitor = await page.locator("[data-testid=ktm-host-monitor]").evaluate((element) => ({
  height: Math.round(element.getBoundingClientRect().height),
  bodyOverflow: document.body.scrollWidth - document.body.clientWidth,
  richStatus: element.getAttribute("data-main-top-bar-rich"),
}));
console.log("mobile monitor:", JSON.stringify(mobileMonitor));
if (mobileMonitor.height < 44 || mobileMonitor.bodyOverflow > 1 || mobileMonitor.richStatus !== "true") {
  console.error("FAIL: mobile monitor is not touch-sized or overflows");
  process.exitCode = 1;
}
await page.setViewportSize({ width: 1400, height: 1000 });

await page.screenshot({ path: `${OUT}/01-collapsed-dark.png` });

// Expand the two hottest tasks to reveal their process rows — the long
// command lines are the thing that used to blow the layout out.
const carets = page.locator(".ktm-task-head");
await carets.nth(0).click();
await carets.nth(1).click();
await page.waitForTimeout(400);
console.log("process rows visible:", await page.locator(".ktm-proc").count());

const expandedOverflow = await page.evaluate(() => {
  const scroll = document.querySelector(".ktm-list");
  return scroll.scrollWidth - scroll.clientWidth;
});
console.log("horizontal overflow with processes expanded:", expandedOverflow);

// Every process row of an expanded task must be fully visible inside its
// card: flex children default to shrinking, which clipped them mid-row.
const clipping = await page.evaluate(() => {
  const clipped = [];
  document.querySelectorAll(".ktm-task").forEach((card) => {
    const cardRect = card.getBoundingClientRect();
    card.querySelectorAll(".ktm-proc").forEach((row) => {
      const r = row.getBoundingClientRect();
      if (r.bottom > cardRect.bottom + 1 || r.top < cardRect.top - 1) {
        clipped.push(row.innerText.slice(0, 40));
      }
    });
  });
  return clipped;
});
console.log("clipped process rows:", clipping.length ? clipping : "none");
if (clipping.length) {
  console.error("FAIL: process rows are clipped by their card");
  process.exitCode = 1;
}
await page.screenshot({ path: `${OUT}/02-expanded-dark.png` });

// Filter.
await page.locator(".ktm-filter").fill("fake-worker");
await page.waitForTimeout(300);
console.log("rows after filtering for a process name:", await page.locator(".ktm-task").count());
await page.screenshot({ path: `${OUT}/04-filtered.png` });
await page.locator(".ktm-filter").fill("");

// Light theme.
await page.evaluate(() => document.body.classList.add("light"));
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/05-light.png` });

// Narrow viewport: the table must still not overflow.
await page.setViewportSize({ width: 780, height: 900 });
await page.waitForTimeout(300);
const narrow = await page.evaluate(() => {
  const scroll = document.querySelector(".ktm-list");
  return {
    horizontal: scroll.scrollWidth - scroll.clientWidth,
    body: document.body.scrollWidth - document.body.clientWidth,
  };
});
console.log("narrow viewport overflow:", JSON.stringify(narrow));
if (narrow.horizontal > 1 || narrow.body > 1) {
  console.error("FAIL: content overflows the dialog at a narrow viewport");
  process.exitCode = 1;
}
await page.screenshot({ path: `${OUT}/06-narrow.png` });

// --- ordering stability ---------------------------------------------------
// The harness swaps the top two tasks' CPU on every poll. Ranking strictly by
// the latest reading would reshuffle the list roughly once a second.
await page.setViewportSize({ width: 1400, height: 1000 });
await page.locator(".ktm-filter").fill("");
await page.waitForTimeout(300);

const titles = () => page.locator(".ktm-task-title").allInnerTexts();

// Collapse everything and move the pointer away so the list is free to rank.
for (const head of await page.locator(".ktm-task-head").all()) {
  if ((await head.getAttribute("aria-expanded")) === "true") await head.click();
}
await page.mouse.move(5, 5);
await page.waitForTimeout(300);

// An expanded row must stay put and stay visible while the rest of the list
// re-ranks around it — the panel must not go stale just because a row is open.
await page.locator(".ktm-task-head").first().click();
await page.mouse.move(5, 5);
await page.waitForTimeout(600);
const openedTitle = (await titles())[await page.evaluate(() => {
  const heads = [...document.querySelectorAll(".ktm-task-head")];
  return heads.findIndex((el) => el.getAttribute("aria-expanded") === "true");
})];
const indexOfOpened = async () => (await titles()).indexOf(openedTitle);
const posBefore = await indexOfOpened();
const pollsBefore = await page.evaluate(() => window.__pollCount());
await page.waitForTimeout(6000);
const posAfter = await indexOfOpened();
const pollsAfter = await page.evaluate(() => window.__pollCount());
console.log("polls elapsed with a row open:", pollsAfter - pollsBefore);
console.log(`expanded row stayed put: ${posBefore === posAfter} (index ${posBefore} -> ${posAfter})`);
console.log("expanded row still visible:", posAfter >= 0);
if (posBefore !== posAfter || posAfter < 0) {
  console.error("FAIL: expanded row moved or disappeared");
  process.exitCode = 1;
}
console.log("process rows still shown:", await page.locator(".ktm-proc").count());

// Values must still be live while a row is open.
const cpuCells = () =>
  page
    .locator(".ktm-task", { hasText: "Synthetic workload alpha" })
    .locator(".ktm-cpu")
    .first()
    .innerText();
const cpuBefore = await cpuCells();
await page.waitForTimeout(2500);
const cpuAfter = await cpuCells();
console.log("values still updating:", cpuBefore !== cpuAfter, `(${cpuBefore} -> ${cpuAfter})`);

// Collapse before the remaining checks.
const openHead = page.locator('.ktm-task-head[aria-expanded="true"]').first();
if (await openHead.count()) await openHead.click();
await page.mouse.move(5, 5);
await page.waitForTimeout(400);

// A steadily climbing task must eventually rise through the ranks: holding
// the order must not mean ignoring real change forever.
const climber = "Synthetic idle task 8";
const rankOf = async () => (await titles()).findIndex((t) => t.startsWith(climber));
await page.evaluate(() => window.__resetClimb());
// Let it fall back to idle and the list settle there before measuring.
await page.waitForTimeout(6000);
await page.mouse.move(5, 5);
const rankBefore = await rankOf();
console.log("  working list at climb start:", (await titles()).map((t) => t.slice(0, 28)));
await page.waitForTimeout(7000);
const rankAfter = await rankOf();
console.log("  working list after climb:  ", (await titles()).map((t) => t.slice(0, 28)));
console.log(`climbing task rank: ${rankBefore} -> ${rankAfter} (rose: ${rankAfter < rankBefore})`);

// A task oscillating across the idle threshold must not hop between the
// working list and the idle group on every poll.
await page.evaluate(() => window.__resetClimb());
await page.mouse.move(5, 5);
await page.waitForTimeout(1500);
const straddler = "Synthetic idle task 7";
const whereIs = async () => {
  const inWorking = await page
    .locator(".ktm-list > .ktm-task", { hasText: straddler })
    .count();
  return inWorking > 0 ? "working" : "idle";
};
const placements = [];
for (let i = 0; i < 8; i += 1) {
  placements.push(await whereIs());
  await page.waitForTimeout(700);
}
const hops = placements.filter((p, i) => i > 0 && p !== placements[i - 1]).length;
console.log(`threshold-straddling task moved groups ${hops} times over 8 polls`, placements.join(","));
if (hops > 1) {
  console.error("FAIL: task hops between working and idle groups");
  process.exitCode = 1;
}

await page.screenshot({ path: `${OUT}/07-stable.png` });

// Older hosts retain the rich monitor and its independent summary cadence.
if (!process.env.HARNESS_URL) {
  const legacyPage = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const legacyUrl = new URL(BASE);
  legacyUrl.searchParams.set("host", "legacy");
  await legacyPage.goto(legacyUrl.href, { waitUntil: "networkidle" });
  await legacyPage.waitForSelector(".ktm-monitor-value", { timeout: 10000 });
  const before = await legacyPage.evaluate(() => window.__summaryFetchCount());
  await legacyPage.evaluate(() => window.__runScheduledTimer(300000));
  await legacyPage.waitForFunction((count) => window.__summaryFetchCount() > count, before);
  const legacy = await legacyPage.locator("[data-testid=ktm-host-monitor]").evaluate((button) => ({
    label: button.getAttribute("aria-label"),
    color: getComputedStyle(button).color,
    valueColor: getComputedStyle(button.querySelector(".ktm-monitor-value")).color,
  }));
  if (!legacy.label.includes("CPU") || legacy.color !== legacy.valueColor) {
    console.error("FAIL: legacy monitor accessibility or foreground color regressed");
    process.exitCode = 1;
  }
  await legacyPage.close();
  await page.evaluate(() => window.__notifyMonitorStorage({ version: 1, metrics: [{ id: "cpu", enabled: true, mode: "tasks_per_core", show_bar: false }] }));
  await page.waitForFunction(() => !document.querySelector(".ktm-monitor") && Boolean(document.querySelector('[data-testid="ktm-host-monitor"]')));
  const compact = page.locator('[data-testid="ktm-host-monitor"]');
  if (!(await compact.getAttribute("aria-label"))?.includes("42%")) {
    console.error("FAIL: compact Action lost the CPU value from its accessible label");
    process.exitCode = 1;
  }
  await compact.screenshot({ path: `${OUT}/host-action-cpu-percentage.png` });
}
console.log("console errors:", errors.length ? errors.slice(0, 5) : "none");
if (errors.length) process.exitCode = 1;
await browser.close();
if (staticServer) await staticServer.close();
