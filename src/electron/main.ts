import {
  app,
  BrowserWindow,
  Menu,
  nativeTheme,
  shell,
  type MenuItemConstructorOptions,
} from "electron";
import { execFileSync } from "node:child_process";
import { Notification } from "electron";
import { join } from "node:path";
import { broadcast, registerIpc } from "./ipc.js";
import { startDeliveryNotifications, type DeliveryPoller } from "./libs/deliveryNotifications.js";
import { startApprovalRelay, type ApprovalRelay } from "./libs/approvalRelay.js";
import { getEvents, registerDevice } from "./libs/deliveryService.js";
import { kv } from "./libs/profiles.js";
import { disconnect, initRuntime, listPendingApprovals } from "./libs/runtime.js";
import { migrateLegacySettings } from "./libs/settings.js";
import type { AppEvent } from "./types.js";
import { DEV_URL, getIconPath, getPreloadPath, getUIPath, isAppUrl, isDev } from "./util.js";

const isMac = process.platform === "darwin";
const QUIT_TIMEOUT_MS = 3_000;

let mainWindow: BrowserWindow | null = null;
let quitting = false;
let deliveryPoller: DeliveryPoller | null = null;
let approvalRelay: ApprovalRelay | null = null;

/** The delivery service base URL (fleet infra; the service runs on the dashboards pattern). */
const DELIVERY_SERVICE_URL = process.env.DELIVERY_SERVICE_URL ?? "http://localhost:8788";
/** Single-operator fleet: the service's user namespace. */
const DELIVERY_USER_ID = "operator";

/** In development, a `.env` in the project root provides connection defaults. */
function loadDevEnv(): void {
  if (app.isPackaged) return;
  try {
    process.loadEnvFile(join(process.cwd(), ".env"));
  } catch {
    // No .env file - settings come from the Settings dialog.
  }
}

/**
 * Apps launched from Finder or a desktop launcher get a minimal PATH, so tools
 * the agent runs (git, node, package managers) would not be found. Take PATH
 * from the user's login shell instead.
 */
function inheritShellPath(): void {
  if (process.platform === "win32" || !app.isPackaged) return;
  try {
    const output = execFileSync(
      process.env.SHELL || "/bin/sh",
      ["-ilc", 'printf "__PATH__%s__PATH__" "$PATH"'],
      { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] },
    );
    const path = output.match(/__PATH__(.+)__PATH__/s)?.[1];
    if (path) process.env.PATH = path;
  } catch {
    // Keep the inherited PATH.
  }
}

function sendMenuCommand(command: Extract<AppEvent, { type: "menu" }>["command"]): void {
  if (!mainWindow) createWindow();
  mainWindow?.show();
  broadcast({ type: "menu", command });
}

function buildMenu(): Menu {
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              {
                label: "Settings...",
                accelerator: "CmdOrCtrl+,",
                click: () => sendMenuCommand("settings"),
              },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    {
      label: "File",
      submenu: [
        { label: "New Chat", accelerator: "CmdOrCtrl+N", click: () => sendMenuCommand("new-chat") },
        ...(isMac
          ? []
          : ([
              {
                label: "Settings...",
                accelerator: "CmdOrCtrl+,",
                click: () => sendMenuCommand("settings"),
              },
            ] satisfies MenuItemConstructorOptions[])),
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  return Menu.buildFromTemplate(template);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 760,
    minHeight: 520,
    show: false,
    icon: getIconPath(),
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1d1d1d" : "#ffffff",
    ...(isMac
      ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 15, y: 18 } }
      : {}),
    webPreferences: { preload: getPreloadPath() },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Links in agent output open in the browser, never inside the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
  });

  if (isDev()) void mainWindow.loadURL(DEV_URL);
  else void mainWindow.loadFile(getUIPath());
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  void app.whenReady().then(async () => {
    loadDevEnv();
    inheritShellPath();
    Menu.setApplicationMenu(buildMenu());
    registerIpc();
    // One-shot: fold the pre-profiles single-connection settings into a
    // profile before anything reads the connection config.
    await migrateLegacySettings().catch(() => undefined);
    initRuntime(broadcast);
    createWindow();

    // While-running delivery notifications (D6): poll the fleet service for
    // events; approvals + problems notify, completions refresh silently. No
    // tray, no daemon — the loop dies with the app.
    void startDeliveryNotifications({
      kv: kv(),
      register: (token) => registerDevice(DELIVERY_SERVICE_URL, DELIVERY_USER_ID, token),
      poll: (deviceId, since) => getEvents(DELIVERY_SERVICE_URL, deviceId, since),
      notify: (title, body, onClick) => {
        if (!Notification.isSupported()) return;
        const notification = new Notification({ title, body });
        notification.on("click", () => {
          mainWindow?.show();
          mainWindow?.focus();
          onClick();
        });
        notification.show();
      },
      broadcast,
      log: (message) => console.log(`[delivery] ${message}`),
      intervalMs: Number.parseInt(process.env.DELIVERY_POLL_INTERVAL_MS ?? "30000", 10),
    }).then((poller) => {
      deliveryPoller = poller;
    });

    // The P4 probe-relay: this desktop is the fleet's approval-discovery
    // source (D4) — probe on a minutes-bounded cadence and relay NEW
    // approvals to the service so phones get them as pushes. Same D6
    // lifecycle: while-running, no daemon, dies with the app.
    void startApprovalRelay({
      probe: listPendingApprovals,
      send: async (event) => {
        const response = await fetch(`${DELIVERY_SERVICE_URL}/events`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(event),
        });
        if (!response.ok) {
          throw new Error(`Delivery service rejected approval relay (${response.status}).`);
        }
      },
      kv: kv(),
      log: (message) => console.log(`[delivery-relay] ${message}`),
      intervalMs: Number.parseInt(process.env.DELIVERY_RELAY_INTERVAL_MS ?? "300000", 10),
    }).then((relay) => {
      approvalRelay = relay;
    });

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (!isMac) app.quit();
  });

  // Stop running turns and the Letta runtime, then exit. `app.exit` is used
  // for the second step because the quit sequence was already interrupted once.
  app.on("before-quit", (event) => {
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    deliveryPoller?.stop();
    approvalRelay?.stop();
    const timeout = new Promise((resolve) => setTimeout(resolve, QUIT_TIMEOUT_MS));
    void Promise.race([disconnect(), timeout]).finally(() => app.exit(0));
  });

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => app.quit());
  }
}
