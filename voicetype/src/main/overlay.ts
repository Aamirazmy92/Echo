import { BrowserWindow, screen, ipcMain } from 'electron';
import path from 'path';
import { getSettings } from './store';
import { AppState } from '../shared/types';

let overlayWindow: BrowserWindow | null = null;
let hideTimer: NodeJS.Timeout | null = null;
let ipcRegistered = false;
let currentOverlayState: AppState = 'idle';
let currentOverlayExtraData: unknown;
let overlayReady = false;
let overlayReadyWaiters: Array<(ready: boolean) => void> = [];
let overlayHasRenderedFrame = false;
let overlayDisplayAllowed = false;
let overlayDisplayPollTimer: NodeJS.Timeout | null = null;
let lastOverlayDisplayId: number | null = null;
const OVERLAY_CLEAR_COLOR = '#00000000';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string;
declare const MAIN_WINDOW_VITE_NAME: string;

const OVERLAY_EXPANDED_WIDTH = 80;
const OVERLAY_EXPANDED_HEIGHT = 30;
const OVERLAY_DISPLAY_POLL_INTERVAL_MS = 150;
const OVERLAY_TOP_INSET = 4;
const OVERLAY_BOTTOM_INSET = 12;

function shouldShowOverlay(): boolean {
  return getSettings().showOverlay;
}

function isExpandedState(state: AppState) {
  return state === 'recording' || state === 'processing';
}

function shouldExpandOverlay() {
  return isExpandedState(currentOverlayState);
}

function getCursorDisplay() {
  const cursorPoint = screen.getCursorScreenPoint();
  return screen.getDisplayNearestPoint(cursorPoint) ?? screen.getPrimaryDisplay();
}

function getOverlayBounds() {
  // Track the display the cursor is currently on so the overlay appears on
  // the monitor the user is actively using, not the primary.
  const display = getCursorDisplay();
  const { x: workAreaX, y: workAreaY, width: screenW, height: screenH } = display.workArea;
  // Always use expanded size so the window never resizes — CSS transform handles the pill animation
  const width = OVERLAY_EXPANDED_WIDTH;
  const height = OVERLAY_EXPANDED_HEIGHT;
  const position = getSettings().overlayPosition;

  let x: number;
  let y: number;

  switch (position) {
    case 'top-center':
      x = Math.floor(workAreaX + screenW / 2 - width / 2);
      y = Math.floor(workAreaY + OVERLAY_TOP_INSET);
      break;
    case 'bottom-center':
      x = Math.floor(workAreaX + screenW / 2 - width / 2);
      y = Math.floor(workAreaY + screenH - height - OVERLAY_BOTTOM_INSET);
      break;
  }

  return { width, height, x, y };
}

function applyOverlayBounds() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;

  const bounds = getOverlayBounds();
  const currentBounds = overlayWindow.getBounds();

  if (
    currentBounds.x === bounds.x &&
    currentBounds.y === bounds.y &&
    currentBounds.width === bounds.width &&
    currentBounds.height === bounds.height
  ) {
    return;
  }

  overlayWindow.setBounds(bounds, false);
}

function stopOverlayDisplayTracking() {
  if (overlayDisplayPollTimer) {
    clearInterval(overlayDisplayPollTimer);
    overlayDisplayPollTimer = null;
  }

  lastOverlayDisplayId = null;
}

function syncOverlayDisplayTracking() {
  const shouldTrackDisplay =
    !!overlayWindow &&
    !overlayWindow.isDestroyed() &&
    overlayWindow.isVisible() &&
    overlayDisplayAllowed &&
    overlayHasRenderedFrame &&
    shouldShowOverlay() &&
    currentOverlayState === 'idle';

  if (!shouldTrackDisplay) {
    stopOverlayDisplayTracking();
    return;
  }

  lastOverlayDisplayId = getCursorDisplay().id;

  if (overlayDisplayPollTimer) {
    return;
  }

  overlayDisplayPollTimer = setInterval(() => {
    if (
      !overlayWindow ||
      overlayWindow.isDestroyed() ||
      !overlayWindow.isVisible() ||
      !overlayDisplayAllowed ||
      !overlayHasRenderedFrame ||
      !shouldShowOverlay() ||
      currentOverlayState !== 'idle'
    ) {
      stopOverlayDisplayTracking();
      return;
    }

    const display = getCursorDisplay();
    if (display.id === lastOverlayDisplayId) {
      return;
    }

    lastOverlayDisplayId = display.id;
    applyOverlayBounds();
  }, OVERLAY_DISPLAY_POLL_INTERVAL_MS);
}

function flushOverlayReady(ready: boolean) {
  overlayReady = ready;
  const waiters = overlayReadyWaiters;
  overlayReadyWaiters = [];
  for (const waiter of waiters) {
    waiter(ready);
  }
}

function sendCurrentOverlayState() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  if (overlayWindow.webContents.isLoadingMainFrame()) return;
  overlayWindow.webContents.send('overlay-state', currentOverlayState, currentOverlayExtraData);
}

export function repositionOverlay() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  applyOverlayBounds();
}

export function ensureOverlayVisible() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  if (!overlayDisplayAllowed || !overlayHasRenderedFrame || !shouldShowOverlay()) {
    syncOverlayDisplayTracking();
    return;
  }

  applyOverlayBounds();
  sendCurrentOverlayState();

  if (!overlayWindow.isVisible()) {
    overlayWindow.showInactive();
  }

  const expanded = shouldExpandOverlay();
  overlayWindow.setIgnoreMouseEvents(true, { forward: expanded });
  syncOverlayDisplayTracking();
}

function registerOverlayIpc() {
  if (ipcRegistered) return;
  ipcRegistered = true;

  ipcMain.on('overlay-mouse-enter', () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.setIgnoreMouseEvents(false);
    }
  });
  ipcMain.on('overlay-mouse-leave', () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.setIgnoreMouseEvents(true, { forward: true });
    }
  });
  ipcMain.handle('get-overlay-state', () => ({
    state: currentOverlayState,
    extraData: currentOverlayExtraData,
  }));
  ipcMain.on('overlay-render-ready', (event) => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    if (event.sender.id !== overlayWindow.webContents.id) return;

    overlayHasRenderedFrame = true;
    overlayWindow.webContents.setBackgroundThrottling(currentOverlayState === 'idle');
    flushOverlayReady(true);

    if (overlayDisplayAllowed && shouldShowOverlay()) {
      ensureOverlayVisible();
    } else if (overlayWindow.isVisible()) {
      stopOverlayDisplayTracking();
      overlayWindow.hide();
    }
  });
}

function registerOverlaySecurityHandlers(window: BrowserWindow) {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });
  window.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
}

export function allowOverlayDisplay() {
  overlayDisplayAllowed = true;

  if (overlayWindow && !overlayWindow.isDestroyed() && overlayHasRenderedFrame && shouldShowOverlay()) {
    ensureOverlayVisible();
    return;
  }

  syncOverlayDisplayTracking();
}

export function createOverlay(): BrowserWindow {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    return overlayWindow;
  }

  registerOverlayIpc();
  overlayReady = false;
  overlayHasRenderedFrame = false;

  const initialBounds = getOverlayBounds();

  overlayWindow = new BrowserWindow({
    width: initialBounds.width,
    height: initialBounds.height,
    frame: false,
    transparent: true,
    backgroundColor: OVERLAY_CLEAR_COLOR,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false
    }
  });
  registerOverlaySecurityHandlers(overlayWindow);

  // Forward mouse events only when expanded (idle pill is too small to interact with)
  overlayWindow.setIgnoreMouseEvents(true, { forward: false });

  overlayWindow.on('closed', () => {
    stopOverlayDisplayTracking();
    overlayHasRenderedFrame = false;
    flushOverlayReady(false);
    overlayWindow = null;
  });

  overlayWindow.setPosition(initialBounds.x, initialBounds.y);

  // Re-anchor when displays change (monitor added/removed/resized).
  const handleDisplayChange = () => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    applyOverlayBounds();
    syncOverlayDisplayTracking();
  };
  screen.on('display-added', handleDisplayChange);
  screen.on('display-removed', handleDisplayChange);
  screen.on('display-metrics-changed', handleDisplayChange);

  overlayWindow.once('closed', () => {
    screen.removeListener('display-added', handleDisplayChange);
    screen.removeListener('display-removed', handleDisplayChange);
    screen.removeListener('display-metrics-changed', handleDisplayChange);
  });

  const overlayQuery = { anchor: getSettings().overlayPosition };
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    const baseUrl = new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    const overlayUrl = new URL('overlay/overlay.html', baseUrl);
    overlayUrl.searchParams.set('anchor', overlayQuery.anchor);
    overlayWindow.loadURL(overlayUrl.href).catch((err: unknown) => {
      console.warn('Overlay load failed (dev):', err instanceof Error ? err.message : err);
    });
  } else {
    overlayWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/overlay/overlay.html`), {
      search: `anchor=${encodeURIComponent(overlayQuery.anchor)}`,
    }).catch((err: unknown) => {
      console.warn('Overlay load failed (prod):', err instanceof Error ? err.message : err);
    });
  }

  overlayWindow.webContents.on('did-finish-load', () => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    overlayWindow.webContents.send('overlay-state', currentOverlayState, currentOverlayExtraData);
  });

  overlayWindow.webContents.on('did-fail-load', () => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    stopOverlayDisplayTracking();
    overlayHasRenderedFrame = false;
    overlayWindow.hide();
  });

  overlayWindow.webContents.on('render-process-gone', () => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    stopOverlayDisplayTracking();
    overlayHasRenderedFrame = false;
    overlayWindow.hide();
  });

  overlayWindow.once('ready-to-show', () => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    if (overlayDisplayAllowed && overlayHasRenderedFrame && shouldShowOverlay()) {
      overlayWindow.showInactive();
      syncOverlayDisplayTracking();
    } else {
      stopOverlayDisplayTracking();
      overlayWindow.hide();
    }
  });

  return overlayWindow;
}

export function updateOverlayState(state: AppState, extraData?: unknown) {
  currentOverlayState = state;
  currentOverlayExtraData = extraData;

  if (state !== 'idle' && hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }

  // If the overlay window doesn't exist yet (hotkey pressed during the first
  // few hundred milliseconds of startup, before deferred startup created it)
  // NEVER call `new BrowserWindow(...)` synchronously here. On Windows a
  // transparent + alwaysOnTop BrowserWindow blocks the main thread for
  // 100–500 ms while Chromium spawns the renderer process and sets up the
  // transparent-composition path — which manifests as the app freezing the
  // instant the user triggers dictation. Defer creation by one tick; the
  // buffered `currentOverlayState` is re-applied by `overlay-render-ready`
  // once the new window actually mounts.
  if (
    state !== 'idle' &&
    shouldShowOverlay() &&
    (!overlayWindow || overlayWindow.isDestroyed())
  ) {
    setImmediate(() => {
      if (!overlayWindow || overlayWindow.isDestroyed()) {
        createOverlay();
      }
    });
    return;
  }

  if (overlayWindow && !overlayWindow.isDestroyed()) {
    // Unthrottle when active so animations run smoothly; throttle when idle to save CPU
    overlayWindow.webContents.setBackgroundThrottling(state === 'idle');

    if (overlayHasRenderedFrame && shouldShowOverlay()) {
      ensureOverlayVisible();
    } else if (!shouldShowOverlay() && overlayWindow.isVisible()) {
      stopOverlayDisplayTracking();
      overlayWindow.hide();
    }
  }

  syncOverlayDisplayTracking();
}

export function scheduleOverlayIdle(delayMs: number) {
  if (hideTimer) {
    clearTimeout(hideTimer);
  }

  hideTimer = setTimeout(() => {
    hideTimer = null;
    updateOverlayState('idle');
  }, delayMs);
}

export function getOverlayWindow() {
  if (overlayWindow && overlayWindow.isDestroyed()) {
    overlayWindow = null;
  }
  return overlayWindow;
}

export function waitForOverlayReady(timeoutMs = 2500): Promise<boolean> {
  if (overlayReady) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ready);
    };

    const timer = setTimeout(() => finish(false), timeoutMs);
    overlayReadyWaiters.push(finish);
  });
}
