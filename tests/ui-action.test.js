import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

let importCount = 0;

function element(type, props, ...children) {
  return { type, props: props || {}, children };
}

function installDocument() {
  const styles = new Map();
  globalThis.document = {
    head: {
      appendChild(style) {
        styles.set(style.id, style);
      },
    },
    createElement(tag) {
      return {
        tagName: tag,
        dataset: {},
        remove() {
          styles.delete(this.id);
        },
      };
    },
    getElementById(id) {
      return styles.get(id) || null;
    },
  };
}

async function loadPlugin({
  action = false,
  uiNamespace = true,
  i18n = true,
  registerTranslations = true,
  report = null,
  showBar = false,
} = {}) {
  let pluginId;
  let definition;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      registerKandevPlugin(id, pluginDefinition) {
        pluginId = id;
        definition = pluginDefinition;
      },
    },
  });
  installDocument();

  const bundle = await readFile(new URL("../ui/bundle.js", import.meta.url));
  await import(`data:text/javascript;base64,${bundle.toString("base64")}#${importCount++}`);

  const components = [];
  const translations = [];
  const keybindings = [];
  const modals = [];
  const ui = {};
  if (action) ui.Action = function Action() {};
  const host = {
    React: {
      useState(initial) {
        const state = typeof initial === "function" ? initial() : initial;
        return [state && typeof state === "object" && "report" in state ? { ...state, report } : state, () => {}];
      },
      useRef(initial) {
        return { current: initial };
      },
      useCallback(callback) {
        return callback;
      },
      useEffect() {},
    },
    jsx: element,
    api: { fetch: () => Promise.reject(new Error("unexpected usage request")) },
    storage: {
      async get() { return { value: { version: 1, metrics: [{ id: "cpu", enabled: true, mode: "tasks_per_core", show_bar: showBar }] } }; },
      async set() {},
    },
    openModal(options) {
      modals.push(options);
      return { close() {} };
    },
  };
  if (uiNamespace) host.ui = ui;
  if (i18n) {
    let catalog = {};
    host.i18n = {
      useTranslation() {
        return {
          t(key, options = {}) {
            const message = catalog[key] || options.defaultValue || key;
            return message.replace(/\{\{(\w+)\}\}/g, (match, name) => options.values?.[name] ?? match);
          },
        };
      },
    };
    host.__setCatalog = (next) => {
      catalog = next;
    };
  }

  const registry = {
    registerKeybinding(id, handler) {
      keybindings.push({ id, handler });
    },
    registerComponent(slot, component) {
      components.push({ slot, component });
    },
  };
  if (registerTranslations) {
    registry.registerTranslations = (catalogs) => {
      translations.push(catalogs);
      host.__setCatalog?.(catalogs.en || {});
    };
  }
  definition.initialize(registry, host);
  await new Promise((resolve) => setImmediate(resolve));
  return { pluginId, components, translations, keybindings, modals, host };
}

const sampleReport = {
  cpu_cores: 8,
  metrics: { cpu: { available: true, source: "tasks", core_percent: 36.2, relative_percent: 4.525 } },
};

test("uses one host Action with a localized label, CPU value, and interpolated tooltip", async () => {
  const loaded = await loadPlugin({ action: true, report: sampleReport });
  const registrations = loaded.components.filter((entry) => entry.slot === "main-top-bar");

  assert.equal(loaded.pluginId, "kandev-plugin-task-manager");
  assert.equal(registrations.length, 1);
  assert.equal(loaded.translations.length, 1);
  assert.match(loaded.translations[0].en.monitorOpen, /Task Manager/);

  const action = registrations[0].component({ slotProps: { presentation: "desktop" } });
  assert.equal(action.type, loaded.host.ui.Action);
  assert.match(action.props.label, /CPU: 36%/);
  assert.equal(action.props.text, "36%");
  assert.match(action.props.tooltip, /CPU: 36%.*⌘\/Ctrl \+ Shift \+ Esc/);
  assert.equal(action.props.icon.type, "svg");
  assert.equal(action.props["data-testid"], "ktm-host-monitor");

  action.props.onClick();
  assert.equal(loaded.modals.length, 1);
  assert.equal(loaded.modals[0].title, "Task Manager");
  assert.equal(typeof loaded.modals[0].content, "function");
  assert.equal(loaded.keybindings[0].id, "open-task-manager");
});

test("keeps the legacy CPU meter and sizes it from nested mobile slot props", async () => {
  const loaded = await loadPlugin({ action: false, i18n: false, registerTranslations: false, report: sampleReport });
  const registrations = loaded.components.filter((entry) => entry.slot === "main-top-bar");
  const chip = registrations[0].component({ slotProps: { presentation: "mobile" } });

  assert.equal(registrations.length, 1);
  assert.equal(chip.type, "button");
  assert.equal(chip.props.className, "ktm-monitor");
  assert.deepEqual(chip.props.style, { minHeight: "2.75rem" });
  assert.match(chip.props["aria-label"], /CPU: 36%/);
  assert.match(chip.props.title, /⌘\/Ctrl \+ Shift \+ Esc/);
  assert.equal(chip.children[0][0].children[2].children[0], "36%");
  assert.equal(loaded.translations.length, 0);

  chip.props.onClick();
  assert.equal(loaded.modals.length, 1);
  loaded.keybindings[0].handler();
  assert.equal(loaded.modals.length, 2);
});

test("uses the desktop legacy presentation outside the mobile slot surface", async () => {
  const loaded = await loadPlugin({ action: false, i18n: false, registerTranslations: false, report: sampleReport });
  const chip = loaded.components[0].component({ slotProps: { presentation: "desktop" } });

  assert.equal(chip.props.style, null);
});

test("keeps the legacy CPU meter when the host omits the ui namespace", async () => {
  const loaded = await loadPlugin({ uiNamespace: false, i18n: false, registerTranslations: false, report: sampleReport });
  const chip = loaded.components[0].component({ slotProps: { presentation: "desktop" } });

  assert.equal(loaded.host.ui, undefined);
  assert.equal(chip.type, "button");
  assert.equal(chip.children[0][0].children[2].children[0], "36%");
});

test("keeps rich progress segments even when host Action exists", async () => {
  const loaded = await loadPlugin({ action: true, showBar: true, report: sampleReport });
  const monitor = loaded.components[0].component({ slotProps: { presentation: "mobile" } });
  assert.equal(monitor.type, "button");
  assert.equal(monitor.props["data-main-top-bar-rich"], "true");
  assert.deepEqual(monitor.props.style, { minHeight: "2.75rem" });
});
