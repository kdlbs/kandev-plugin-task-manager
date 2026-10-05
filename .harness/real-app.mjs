import { chromium, devices, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isLoopbackUrl } from "./loopback.mjs";

const PLUGIN_ID = "kandev-plugin-task-manager";
const CHIP_POLL_INTERVAL_MS = 4_000;
const hostUrl = process.env.KANDEV_URL;
const packageFile = process.env.PACKAGE_FILE;
if (!hostUrl || !packageFile) {
  throw new Error("Set KANDEV_URL and PACKAGE_FILE.");
}

const base = new URL(hostUrl);
if (!isLoopbackUrl(hostUrl)) {
  throw new Error("The host smoke test only accepts a disposable loopback Kandev host.");
}
const archive = resolve(packageFile);
const outputDir = resolve(
  process.env.SMOKE_ARTIFACT_DIR || resolve(dirname(fileURLToPath(import.meta.url)), "screenshots"),
);
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
const mobile = await browser.newContext({ ...devices["Pixel 5"] });
const page = await desktop.newPage();
const mobilePage = await mobile.newPage();
let installed = false;
const usageRequests = { desktop: 0, mobile: 0 };
for (const [name, target] of [["desktop", page], ["mobile", mobilePage]]) {
  target.on("crash", () => console.error(`${name} browser page crashed.`));
  target.on("pageerror", (error) => console.error(`${name} page error: ${error.message}`));
  target.on("console", (message) => {
    if (message.type() === "error") console.error(`${name} console error: ${message.text()}`);
  });
}

async function useSyntheticUsage(target, device) {
  await target.route(`**/api/plugins/${PLUGIN_ID}/webhooks/summary`, async (route) => {
    usageRequests[device] += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      sampled_at: new Date().toISOString(), refresh_interval_seconds: 1, cpu_cores: 4,
      metrics: { cpu: { available: true, source: "tasks", core_percent: 37.5, relative_percent: 9.375 } },
    }) });
  });
  await target.route(`**/api/plugins/${PLUGIN_ID}/webhooks/usage`, async (route) => {
    usageRequests[device] += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...sampleReport, sampled_at: new Date().toISOString() }),
    });
  });
}

function actionButton(target) {
  return target.getByTestId("ktm-host-monitor");
}

function assertControlPath(target) {
  return expect(target.locator(".ktm-monitor")).toBeVisible();
}

try {
  for (const context of [desktop, mobile]) {
    await context.addInitScript(() => localStorage.setItem("kandev.onboarding.completed", "true"));
  }
  await useSyntheticUsage(page, "desktop");
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
  await expect(page.locator(".ktm-monitor-track")).toBeVisible();
  await expect(page.locator(".ktm-monitor-value")).toContainText("38%");
  await expect(desktopAction).toHaveAttribute("aria-label", /CPU: 38%/);
  const desktopBox = await desktopAction.boundingBox();
  if (!desktopBox || desktopBox.x < 0 || desktopBox.x + desktopBox.width > 1440) {
    throw new Error("The top-bar action does not fit the desktop viewport.");
  }

  await desktopAction.focus();
  await expect(desktopAction).toBeFocused();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Task Manager", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".ktm-frame")).toBeVisible();
  await expect(dialog.getByRole("button", { name: /Synthetic CPU fixture task/ })).toBeVisible({
    timeout: 10_000,
  });
  await expect.poll(() => usageRequests.desktop, { timeout: 10_000 }).toBeGreaterThan(1);
  await page.screenshot({ path: `${outputDir}/host-monitor-desktop.png` });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await page.keyboard.press("Control+Shift+Escape");
  await expect(dialog).toBeVisible({ timeout: 5_000 });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  await useSyntheticUsage(mobilePage, "mobile");
  await mobilePage.goto(new URL("/tasks", base).href);
  const coarsePointer = await mobilePage.evaluate(() => matchMedia("(pointer: coarse)").matches);
  if (!coarsePointer) throw new Error("The Pixel 5 mobile context did not expose a coarse pointer.");
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
  await mobilePage.screenshot({ path: `${outputDir}/host-monitor-mobile.png` });
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
  await expect(page.locator(".ktm-monitor")).toHaveCount(0);
  const requestsWhenDisabled = usageRequests.desktop;
  await page.waitForTimeout(CHIP_POLL_INTERVAL_MS + 250);
  if (usageRequests.desktop !== requestsWhenDisabled) {
    throw new Error("The disabled desktop Action kept polling synthetic usage data.");
  }

  await page.goto(new URL("/settings/plugins", base).href);
  await pluginRow.getByRole("button", { name: "Enable" }).click();
  await expect(pluginRow.getByText("Active", { exact: true })).toBeVisible();
  await page.goto(new URL("/tasks", base).href);
  await expect(actionButton(page)).toBeVisible({ timeout: 15_000 });
  await assertControlPath(page);
  await expect.poll(() => usageRequests.desktop, { timeout: 10_000 }).toBeGreaterThan(requestsWhenDisabled);
  console.log(
    `PASS: packaged plugin ${PLUGIN_ID}, rich monitor, desktop ${desktopBox?.width}x${desktopBox?.height}px, Pixel 5 target ${mobileBox.width}x${mobileBox.height}px (coarse pointer), keyboard/keybinding, polling lifecycle, disable/re-enable, synthetic usage and summary reports.`,
  );
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
