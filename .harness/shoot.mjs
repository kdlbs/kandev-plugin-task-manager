import { chromium } from "/home/jcfs/playground/kandev/apps/web/node_modules/@playwright/test/index.mjs";

const BASE = process.env.HARNESS_URL || "http://127.0.0.1:8977/.harness/index.html";
const OUT = process.env.HARNESS_OUT || "/home/jcfs/kandev-plugins/kandev-plugin-task-manager/.harness";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });

const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForSelector(".ktm-frame", { timeout: 10000 });
await page.waitForTimeout(500);

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

// The chip is a <button>, which does not inherit colour; a missing rule
// leaves its value in the UA's dark grey, invisible on a dark background.
const chip = await page.evaluate(() => {
  const value = document.querySelector(".ktm-chip-value");
  if (!value) return null;
  return { color: getComputedStyle(value).color, text: value.innerText };
});
console.log("chip value:", JSON.stringify(chip));

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
await page.locator(".ktm-filter").fill("vitest");
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
    .locator(".ktm-task", { hasText: "Use shared formatBytes" })
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
const climber = "Idle background task number 8";
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
const straddler = "Idle background task number 7";
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
console.log("console errors:", errors.length ? errors.slice(0, 5) : "none");
await browser.close();
