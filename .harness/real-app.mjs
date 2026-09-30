import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ID = "kandev-plugin-task-manager";
const hostUrl = process.env.KANDEV_URL;
const packageFile = process.env.PACKAGE_FILE;
const hostAction = process.env.HOST_ACTION;
if (!hostUrl || !packageFile || !["0", "1"].includes(hostAction || "")) {
  throw new Error("Set KANDEV_URL, PACKAGE_FILE, and HOST_ACTION=0 or 1.");
}

const base = new URL(hostUrl);
if (!["localhost", "127.0.0.1", "::1"].includes(base.hostname)) {
  throw new Error("The host smoke test only accepts a disposable loopback Kandev host.");
}
const archive = resolve(packageFile);
const outputDir = resolve(dirname(fileURLToPath(import.meta.url)), "screenshots");
await mkdir(outputDir, { recursive: true });

const sampleReport = {
  sampled_at: new Date().toISOString(),
  interval_seconds: 0.74,
  platform: "linux",
  cpu_cores: 4,
  total_memory_bytes: 8 * 1024 * 1024 * 1024,
  supported: true,
  tasks: [
    {
      task_id: "f0000000-0000-4000-8000-000000000001",
      title: "Synthetic CPU fixture task",
      identifier: "TEST-CPU-01",
      state: "IN_PROGRESS",
      session_ids: ["f0000000-0000-4000-8000-000000000002"],
      cpu_percent: 37.5,
      memory_bytes: 128 * 1024 * 1024,
      memory_basis: "pss",
      processes: [
        {
          pid: 43210,
          ppid: 1,
          name: "fake-worker",
          cpu_percent: 37.5,
          memory_bytes: 128 * 1024 * 1024,
          command: "fake-worker --fixture synthetic",
        },
      ],
    },
  ],
};

const browser = await chromium.launch();
const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const mobile = await browser.newContext({
  viewport: { width: 393, height: 851 },
  deviceScaleFactor: 2,
  hasTouch: true,
  isMobile: true,
});
const page = await desktop.newPage();
const mobilePage = await mobile.newPage();
let installed = false;
let usageRequests = 0;
for (const [name, target] of [["desktop", page], ["mobile", mobilePage]]) {
  target.on("crash", () => console.error(`${name} browser page crashed.`));
  target.on("pageerror", (error) => console.error(`${name} page error: ${error.message}`));
  target.on("console", (message) => {
    if (message.type() === "error") console.error(`${name} console error: ${message.text()}`);
  });
}

async function useSyntheticUsage(target) {
  await target.route(`**/api/plugins/${PLUGIN_ID}/webhooks/usage`, async (route) => {
    usageRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...sampleReport, sampled_at: new Date().toISOString() }),
    });
  });
}

function actionButton(target) {
  return target.getByRole("button", { name: "Task Manager CPU usage", exact: true });
}

function assertControlPath(target) {
  if (hostAction === "1") {
    return expect(target.locator('[data-slot="surface-action"][data-surface="topbar"]')).toBeVisible();
  }
  return expect(target.locator(".ktm-chip")).toBeVisible();
}

try {
  for (const context of [desktop, mobile]) {
    await context.addInitScript(() => localStorage.setItem("kandev.onboarding.completed", "true"));
  }
  await useSyntheticUsage(page);
  const workspaceListResponse = await page.request.get(new URL("/api/v1/workspaces", base).href);
  if (!workspaceListResponse.ok()) {
    throw new Error(`Could not list workspaces on the disposable host (HTTP ${workspaceListResponse.status()}).`);
  }
  const workspaceList = await workspaceListResponse.json();
  let workspace = workspaceList.workspaces?.[0];
  if (!workspace) {
    const createWorkspaceResponse = await page.request.post(new URL("/api/v1/workspaces", base).href, {
      data: { name: "Synthetic Task Manager smoke workspace" },
    });
    if (!createWorkspaceResponse.ok()) {
      throw new Error(`Could not create a synthetic workspace (HTTP ${createWorkspaceResponse.status()}).`);
    }
    workspace = await createWorkspaceResponse.json();
  }
  const settingsResponse = await page.request.patch(new URL("/api/v1/user/settings", base).href, {
    data: { workspace_id: workspace.id, startup_page: "task_overview" },
  });
  if (!settingsResponse.ok()) {
    throw new Error(`Could not select the synthetic workspace (HTTP ${settingsResponse.status()}).`);
  }

  await page.goto(new URL("/settings/plugins", base).href);
  await page.getByTestId("install-plugin-trigger").click();
  await expect(page.getByTestId("install-plugin-dialog")).toBeVisible();
  await page.getByTestId("install-plugin-tab-upload").click();
  await page.getByTestId("install-plugin-file-input").setInputFiles(archive);
  await page.getByTestId("install-plugin-upload-submit").click();
  await expect(page.getByTestId("install-plugin-dialog")).toBeHidden({ timeout: 30_000 });
  const pluginRow = page.getByTestId(`plugin-row-${PLUGIN_ID}`);
  await expect(pluginRow).toBeVisible({ timeout: 30_000 });
  await expect(pluginRow.getByText("Active", { exact: true })).toBeVisible();
  installed = true;

  await page.goto(new URL("/tasks", base).href);
  const desktopAction = actionButton(page);
  await expect(desktopAction).toBeVisible({ timeout: 15_000 });
  await assertControlPath(page);
  if (hostAction === "1") {
    await expect(desktopAction).toContainText(/\d+(?:\.\d+)?%/);
    await expect(page.locator(".ktm-chip")).toHaveCount(0);
    await desktopAction.hover();
    await expect(page.getByRole("tooltip")).toContainText("CPU 38%", { timeout: 5_000 });
    await expect(page.getByRole("tooltip")).toContainText("Shortcut:");
  } else {
    await expect(page.locator(".ktm-chip-track")).toBeVisible();
    await expect(page.locator(".ktm-chip-value")).toContainText(/\d+(?:\.\d+)?%/);
    await expect(desktopAction).toHaveAttribute("title", /CPU .*Shortcut:/);
    await expect(page.locator('[data-slot="surface-action"][data-surface="topbar"]')).toHaveCount(0);
  }
  const desktopBox = await desktopAction.boundingBox();
  if (!desktopBox || desktopBox.x < 0 || desktopBox.x + desktopBox.width > 1440) {
    throw new Error("The top-bar action does not fit the desktop viewport.");
  }

  await desktopAction.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Task Manager", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".ktm-frame")).toBeVisible();
  await expect(dialog.getByRole("button", { name: /Synthetic CPU fixture task/ })).toBeVisible({
    timeout: 10_000,
  });
  await expect.poll(() => usageRequests).toBeGreaterThan(0);
  await page.screenshot({ path: `${outputDir}/host-${hostAction === "1" ? "action" : "legacy"}-desktop.png` });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  await useSyntheticUsage(mobilePage);
  await mobilePage.goto(new URL("/tasks", base).href);
  const navTrigger = mobilePage.getByTestId("app-nav-trigger");
  await expect(navTrigger).toBeVisible();
  await navTrigger.tap();
  const menu = mobilePage.getByRole("dialog", { name: "Menu", exact: true });
  await expect(menu).toBeVisible();
  const pluginSection = menu.getByTestId("mobile-plugin-nav-section");
  const mobileAction = actionButton(pluginSection);
  await expect(mobileAction).toBeVisible({ timeout: 15_000 });
  await assertControlPath(pluginSection);
  const [mobileBox, sectionBox] = await Promise.all([
    mobileAction.boundingBox(),
    pluginSection.boundingBox(),
  ]);
  if (!mobileBox || !sectionBox) throw new Error("Mobile action geometry is unavailable.");
  if (mobileBox.width < 44 || mobileBox.height < 44) {
    throw new Error(`Mobile action hit target is ${mobileBox.width}x${mobileBox.height}px; expected at least 44x44px.`);
  }
  if (mobileBox.x < sectionBox.x - 1 || mobileBox.x + mobileBox.width > sectionBox.x + sectionBox.width + 1) {
    throw new Error("The mobile action extends outside the Plugins section.");
  }
  if (mobileBox.x + mobileBox.width > 393 || await mobilePage.evaluate(() => document.documentElement.scrollWidth > innerWidth)) {
    throw new Error("The mobile action causes horizontal overflow.");
  }
  await mobilePage.screenshot({ path: `${outputDir}/host-${hostAction === "1" ? "action" : "legacy"}-mobile.png` });
  await mobileAction.tap();
  const mobileDialog = mobilePage.getByRole("dialog", { name: "Task Manager", exact: true });
  await expect(mobileDialog.locator(".ktm-frame")).toBeVisible();
  await expect(mobileDialog.getByRole("button", { name: /Synthetic CPU fixture task/ })).toBeVisible();
  await mobilePage.keyboard.press("Escape");

  await page.goto(new URL("/settings/plugins", base).href);
  await pluginRow.getByRole("button", { name: "Disable" }).click();
  await expect(pluginRow.getByText("Disabled", { exact: true })).toBeVisible();
  await page.goto(new URL("/tasks", base).href);
  await expect(desktopAction).toHaveCount(0);
  await expect(page.locator(".ktm-chip")).toHaveCount(0);

  await page.goto(new URL("/settings/plugins", base).href);
  await pluginRow.getByRole("button", { name: "Enable" }).click();
  await expect(pluginRow.getByText("Active", { exact: true })).toBeVisible();
  await page.goto(new URL("/tasks", base).href);
  await expect(actionButton(page)).toBeVisible({ timeout: 15_000 });
  await assertControlPath(page);
  console.log(`PASS: packaged plugin ${PLUGIN_ID}, ${hostAction === "1" ? "Action" : "legacy"} path, desktop, mobile touch, keyboard, disable/re-enable, synthetic usage reports.`);
} finally {
  if (installed) {
    const response = await page.request.delete(new URL(`/api/plugins/${PLUGIN_ID}`, base).href);
    if (!response.ok() && response.status() !== 404) {
      throw new Error(`Failed to remove the test plugin from the disposable host (HTTP ${response.status()}).`);
    }
  }
  await mobile.close();
  await desktop.close();
  await browser.close();
}
