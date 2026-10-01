// Drives the plugin inside a REAL kandev instance, not the stub harness.
//
// The stub harness models the host's DialogContent; this proves it. Every
// overflow bug in this plugin so far survived the stub and only showed up in
// the real app, so this is the check that actually counts.
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { loadPlaywright } from "./modules.mjs";

const { chromium } = await loadPlaywright();

const BASE = process.env.KANDEV_URL || "http://127.0.0.1:38773";
const OUT = process.env.OUT || fileURLToPath(new URL(".", import.meta.url));
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch();
const results = [];

for (const viewport of [
  { width: 1440, height: 900, name: "wide" },
  { width: 1024, height: 768, name: "medium" },
  { width: 820, height: 700, name: "narrow" },
  { width: 390, height: 844, name: "mobile" },
]) {
  const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(4000);

  await page.keyboard.press("Control+Shift+Escape");
  await page.waitForSelector(".ktm-frame", { timeout: 15000 });
  await page.waitForSelector("[data-testid=ktm-host-monitor]", { timeout: 15000 });
  // Let a couple of poll cycles land so CPU numbers are real, not zeros.
  await page.waitForTimeout(4000);

  // Expand the first task so the long command lines are on screen — that is
  // the content that blew the layout out every previous time.
  const firstHead = page.locator(".ktm-task-head").first();
  if (await firstHead.count()) {
    await firstHead.click();
    await page.waitForTimeout(1500);
  }

  const measured = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    const frame = document.querySelector(".ktm-frame");
    const dialogRect = dialog.getBoundingClientRect();
    const frameRect = frame.getBoundingClientRect();
    const strays = [];
    dialog.querySelectorAll("*").forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > dialogRect.right + 1) {
        strays.push(`${el.className || el.tagName}@${Math.round(r.right)}`);
      }
    });
    return {
      dialogWidth: Math.round(dialogRect.width),
      dialogRight: Math.round(dialogRect.right),
      frameWidth: Math.round(frameRect.width),
      frameRight: Math.round(frameRect.right),
      frameOverflowsDialog: Math.round(frameRect.right - dialogRect.right),
      documentHorizontalScroll:
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
      strays: strays.slice(0, 6),
      taskCards: document.querySelectorAll(".ktm-list > .ktm-task").length,
      processRows: document.querySelectorAll(".ktm-proc").length,
      idleRow: document.querySelector(".ktm-idle-head")?.innerText.replace(/\s+/g, " ") ?? null,
      styleTag: Boolean(document.getElementById("ktm-styles")),
      ambientMonitor: Boolean(document.querySelector("[data-testid=ktm-host-monitor]")),
      ambientMonitorHeight: Math.round(document.querySelector("[data-testid=ktm-host-monitor]")?.getBoundingClientRect().height || 0),
    };
  });

  console.log(`[${viewport.name} ${viewport.width}px]`, JSON.stringify(measured));
  if (errors.length) console.log(`  console errors:`, errors.slice(0, 3));

  await page.screenshot({ path: `${OUT}/real-${viewport.name}.png` });
  results.push({ viewport: viewport.name, ...measured, errors: errors.length });
  await page.close();
}

const bad = results.filter(
  (r) => r.frameOverflowsDialog > 1 || r.documentHorizontalScroll > 1 || r.strays.length > 0,
);
const missingMonitor = results.filter((result) => !result.ambientMonitor || result.ambientMonitorHeight < 24);
if (bad.length || missingMonitor.length) {
  console.error("FAIL: overflow in the real app at:", bad.map((b) => b.viewport).join(", "));
  if (missingMonitor.length) console.error("FAIL: ambient monitor missing or too small at:", missingMonitor.map((b) => b.viewport).join(", "));
  process.exitCode = 1;
} else {
  console.log("PASS: no overflow in the real app at any viewport");
}

await browser.close();
