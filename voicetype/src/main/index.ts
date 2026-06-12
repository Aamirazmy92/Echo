import { app, BrowserWindow, ipcMain, Notification, session, shell, screen, crashReporter, clipboard, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import path from 'path';
import fs from 'fs';
import {
  initAutoUpdater,
  checkForUpdatesNow,
  downloadUpdateNow,
  installAndRestart,
  getUpdateStatus,
  broadcastUpdateStatusTo,
} from './updater';
import type { DictionaryItemInput, Note, Settings, SnippetInput, SpeechMetrics } from '../shared/types';
import { initStore, getSettings, saveSettings } from './store';
import { installGlobalErrorHandlers, logError, logInfo, logWarn } from './logger';
import {
  initAuth,
  signInWithPassword,
  signUpWithPassword,
  signOut as authSignOut,
  sendPasswordReset,
  startGoogleSignIn,
  completeOAuthCallback,
  isExpectedOAuthCallbackUrl,
  serialiseSession,
  isAuthConfigured,
  onAuthStateChange,
  deleteAccount,
  updateDisplayName,
  updateProfilePicture,
} from './auth';
import { initSync, forceSync, getSyncStatus, syncOnFocus } from './sync';
import {
  initEntitlements,
  refreshEntitlements,
  refreshAfterBillingReturn,
  getEntitlementsSnapshot,
} from './entitlements';
import {
  startCheckout as cloudStartCheckout,
  openCustomerPortal as cloudOpenCustomerPortal,
  CloudHttpError,
  isCloudConfigured,
} from './cloud';
import { createTray, refreshTrayMenu, updateTrayState } from './tray';
import { registerHotkeys, getActiveAppName, prewarmActiveAppDetection, refreshActiveAppName, resetHotkeyState, suspendHotkey, unregisterAll as unregisterAllHotkeys } from './hotkey';
import { applyDictionary } from './dictionary';
import { getWeekStartIso } from './usageWindow';
import { expandSnippetsDetailed } from './snippets';
import { injectText, prewarmInjectHelper, shutdownInjectHelper } from './inject';
import { createOverlay, updateOverlayState, getOverlayWindow, scheduleOverlayIdle, ensureOverlayVisible, repositionOverlay, allowOverlayDisplay } from './overlay';
import { resolveGlobalStyle } from '../shared/styleConfig';
import {
  sanitizeArrayBufferPayload,
  sanitizeAudioLevels,
  sanitizeDictionaryItemInputPayload,
  sanitizeDurationMs,
  sanitizeEntryId,
  sanitizeEntryIds,
  sanitizeExportFormat,
  sanitizeHistoryText,
  sanitizeNoteInputPayload,
  sanitizeNoteLockCode,
  sanitizePagination,
  sanitizeSettingsUpdate,
  sanitizeSnippetInputPayload,
  sanitizeSpeechMetrics,
} from './validation';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string;
declare const MAIN_WINDOW_VITE_NAME: string;
const SUCCESS_PILL_MS = 0;
const TRANSCRIPTION_TIMEOUT_MS = 180_000;
const CLEANUP_TIMEOUT_MS = 12_000;
const TRANSIENT_CHROMIUM_CACHE_DIRS = ['Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'GrShaderCache', 'ShaderCache'];
const ALLOWED_EXTERNAL_URLS = new Set(['https://console.groq.com/keys']);

function resolveSessionDataPath() {
  if (process.platform === 'win32') {
    const localAppDataRoot = process.env.LOCALAPPDATA ?? path.resolve(app.getPath('appData'), '..', 'Local');
    return path.join(localAppDataRoot, app.getName(), 'session-data');
  }

  return path.join(app.getPath('userData'), 'session-data');
}

const sessionDataPath = resolveSessionDataPath();

app.setPath('sessionData', sessionDataPath);

async function removeDirectoryIfPresent(dirPath: string) {
  try {
    await fs.promises.rm(dirPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch (error) {
    logWarn('cleanup', `Failed to remove stale cache directory at ${dirPath}`, error);
  }
}

async function cleanupLegacyChromiumCaches() {
  if (process.platform !== 'win32') {
    return;
  }

  const userDataPath = app.getPath('userData');
  const currentSessionDataPath = app.getPath('sessionData');
  if (path.resolve(userDataPath) === path.resolve(currentSessionDataPath)) {
    return;
  }

  await Promise.all(TRANSIENT_CHROMIUM_CACHE_DIRS.map((dirName) =>
    removeDirectoryIfPresent(path.join(userDataPath, dirName))
  ));

  try {
    const legacyEntries = await fs.promises.readdir(userDataPath, { withFileTypes: true });
    await Promise.all(legacyEntries
      .filter((entry) =>
        entry.isDirectory() &&
        /^old_(Cache|Code Cache|GPUCache|DawnCache|GrShaderCache|ShaderCache)_\d+$/i.test(entry.name)
      )
      .map((entry) => removeDirectoryIfPresent(path.join(userDataPath, entry.name)))
    );
  } catch {
    // The app may be starting fresh with no legacy userData folder yet.
  }
}

let mainWindow: BrowserWindow | null = null;
const stickyNoteWindows = new Set<BrowserWindow>();
// Sticky windows ordered by stacking (most-recently-focused / topmost first).
// Used to resolve which overlapping window receives a torn-out tab on drop.
const stickyNoteFocusOrder: BrowserWindow[] = [];
const expandedStickyNoteWindows = new WeakSet<BrowserWindow>();
const unlockedNoteIds = new Set<number>();
let warmStickyNoteWindow: BrowserWindow | null = null;
let isQuitting = false;
let lastInjectedFingerprint = '';
let lastInjectedAt = 0;
let transcriptionSequence = 0;
let cancelledThroughSequence = 0;
let deferredStartupTasksStarted = false;
let hasShownHideToTrayNotice = false;
let historyModulePromise: Promise<typeof import('./history')> | null = null;
let historyInitialized = false;

let transcribeModulePromise: Promise<typeof import('./transcribe')> | null = null;
let cleanupModulePromise: Promise<typeof import('./cleanup')> | null = null;

function getTranscribeModule() {
  if (!transcribeModulePromise) {
    transcribeModulePromise = import('./transcribe');
  }
  return transcribeModulePromise;
}

function getCleanupModule() {
  if (!cleanupModulePromise) {
    cleanupModulePromise = import('./cleanup');
  }
  return cleanupModulePromise;
}

const DUPLICATE_TRANSCRIPT_WINDOW_MS = 8_000;

function getHistoryModule() {
  if (!historyModulePromise) {
    historyModulePromise = import('./history');
  }

  return historyModulePromise;
}

async function ensureHistoryModule() {
  const history = await getHistoryModule();

  if (!historyInitialized) {
    history.initHistory();
    historyInitialized = true;
    // Now that the DB is open, sync any data that was deferred while
    // we waited for it. This matters for cold starts where a saved
    // Supabase session triggers `startSync()` *before* the renderer
    // has caused the history module to load lazily — drainQueue and
    // pullAll bail out early in that case, so they need a nudge here.
    void forceSync();
  }

  return history;
}

function noteForRenderer(note: Note): Note {
  const lockUnlocked = !note.locked || unlockedNoteIds.has(note.id);
  return {
    ...note,
    body: lockUnlocked ? note.body : '',
    lockUnlocked,
  };
}

function notesForRenderer(notes: Note[]): Note[] {
  return notes.map(noteForRenderer);
}

function startDeferredStartupTasks() {
  if (deferredStartupTasksStarted || !mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  deferredStartupTasksStarted = true;

  // Register the global hotkey watcher synchronously — every millisecond we
  // defer here is a millisecond where the user pressing the hotkey yields
  // no feedback. `registerHotkeys` only builds a script and async-spawns a
  // child; the synchronous portion is small.
  const currentSettings = getSettings();
  const registeredHotkeys = registerHotkeys(currentSettings, mainWindow, cancelCurrentDictation);

  // Persist the resolved hotkeys off the hot path. `saveSettings` performs a
  // synchronous `electron-store` disk write which, if called here, blocks
  // Chromium's first paint and visibly stalls the splash animation.
  setImmediate(() => {
    saveSettings(registeredHotkeys);
  });

  // Stagger every expensive startup task into its own macrotask bucket. If
  // all of them run on the same tick (BrowserWindow creation, PowerShell
  // spawns, native-addon loads, module dynamic imports), the main process
  // event loop is blocked for 200–500 ms right when the splash is meant to
  // be animating. Spreading them out lets the compositor thread keep the
  // UI responsive while each warm-up completes in the background.
  //
  // Ordering is deliberate:
  //   1. Overlay — a second BrowserWindow; heaviest single step AND the
  //      first thing the hotkey handler needs. Pulled ahead of tray because
  //      if the user triggers dictation before this runs, the hot-path
  //      `createOverlay()` fallback in updateOverlayState has to spawn the
  //      window synchronously, which blocks the main thread for 100–500 ms
  //      (the "pill freeze" on startup).
  //   2. Tray — user-facing but cheap, can safely slide later.
  //   3. Inject helper — PowerShell + C# compile; first thing the critical
  //      dictation path waits on.
  //   4. Transcribe + cleanup modules — plain JS imports, cheap.
  //   5. History module — dynamically loads the `better-sqlite3` native
  //      addon, which is synchronous and heavy (~50-150 ms). Delayed far
  //      enough that the Dashboard's own deferred data fetch absorbs the
  //      cost transparently.
  //   6. Active-app detection — another PowerShell spawn, lowest priority.
  setTimeout(() => {
    if (getSettings().showOverlay) {
      createOverlay();
    }
  }, 150);

  setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    createTray(mainWindow);
  }, 400);

  setTimeout(() => {
    void prewarmInjectHelper().catch((error) => {
      logWarn('inject', 'Inject helper prewarm failed', error);
    });
  }, 600);

  setTimeout(() => {
    prepareWarmStickyNoteWindow();
  }, 650);

  setTimeout(() => {
    void getTranscribeModule();
    void getCleanupModule();
  }, 900);

  setTimeout(() => {
    // `better-sqlite3` is a native addon; `require()` blocks the event
    // loop for ~50–150 ms the first time. Push it well past first paint so
    // it never competes with the splash or early IPC traffic.
    void getHistoryModule();
  }, 1400);

  setTimeout(() => {
    prewarmActiveAppDetection();
  }, 2000);
}

function syncLauncherVisibilityPreference(showInLauncher: boolean) {
  if (process.platform === 'darwin') {
    return;
  }

  mainWindow?.setSkipTaskbar(!showInLauncher);
}

function fingerprintTranscript(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function shouldSuppressDuplicateTranscript(text: string): boolean {
  const fingerprint = fingerprintTranscript(text);
  if (!fingerprint) return false;

  const wordCount = fingerprint.split(' ').filter(Boolean).length;
  if (wordCount < 2 && fingerprint.length < 12) {
    lastInjectedFingerprint = fingerprint;
    lastInjectedAt = Date.now();
    return false;
  }

  const now = Date.now();
  const isDuplicate =
    fingerprint === lastInjectedFingerprint &&
    now - lastInjectedAt <= DUPLICATE_TRANSCRIPT_WINDOW_MS;

  lastInjectedFingerprint = fingerprint;
  lastInjectedAt = now;
  return isDuplicate;
}

const BASIC_WEEKLY_WORD_CAP = 2000;

type BasicUsageSnapshot = {
  tier: 'anonymous' | 'free' | 'pro';
  used: number;
  cap: number;
  remaining: number;
  exhausted: boolean;
};

type BasicUsageLimitPayload = BasicUsageSnapshot & {
  message: string;
};

type HistoryModule = Awaited<ReturnType<typeof ensureHistoryModule>>;

function getBasicUsageSnapshot(history: HistoryModule): BasicUsageSnapshot {
  const tier = getEntitlementsSnapshot().tier;
  const used = history.getWeeklyWordCount(getWeekStartIso());
  const remaining = Math.max(0, BASIC_WEEKLY_WORD_CAP - used);
  return {
    tier,
    used,
    cap: BASIC_WEEKLY_WORD_CAP,
    remaining,
    exhausted: tier !== 'pro' && used >= BASIC_WEEKLY_WORD_CAP,
  };
}

function getBasicUsageLimitMessage(remainingWords: number): string {
  if (remainingWords > 0) {
    return `Basic includes ${BASIC_WEEKLY_WORD_CAP.toLocaleString()} dictated words per week. You have ${remainingWords.toLocaleString()} left this week. Upgrade to Pro for more.`;
  }
  return `You've used all ${BASIC_WEEKLY_WORD_CAP.toLocaleString()} Basic words for this week. Upgrade to Pro for more.`;
}

function notifyBasicUsageLimitReached(snapshot: BasicUsageSnapshot): void {
  mainWindow?.webContents.send('basic-usage-limit-reached', {
    ...snapshot,
    message: getBasicUsageLimitMessage(snapshot.remaining),
  } satisfies BasicUsageLimitPayload);
}

async function getBasicUsageSnapshotForGate(history: HistoryModule): Promise<BasicUsageSnapshot> {
  let snapshot = getBasicUsageSnapshot(history);
  if (!snapshot.exhausted) return snapshot;

  // Only the already-blocked path pays for a network refresh — the user
  // cannot record anyway, so latency here is acceptable and it gives a
  // just-upgraded Pro user an immediate unblock.
  try {
    await refreshEntitlements();
  } catch (err) {
    logWarn('usage-limit', 'Entitlements refresh failed before Basic usage gate', err);
  }

  snapshot = getBasicUsageSnapshot(history);
  return snapshot;
}

/**
 * Dev-only: watch the rebuilt main/preload bundles and relaunch Electron as
 * soon as Vite writes a new copy. We intentionally watch the OUTPUT files in
 * `.vite/build/` rather than the TypeScript sources — by the time those
 * change, Vite has fully written the new bundle, which removes the
 * rebuild-vs-relaunch race you'd get if we watched sources directly.
 *
 * `app.relaunch()` queues a fresh instance; `app.quit()` lets `before-quit`
 * run so the hotkey watcher, inject helper, SQLite handle, etc. shut down
 * cleanly before the new process boots.
 */
function setupMainProcessHotReload(): void {
  // Poll the bundles' mtime instead of using `fs.watch`. On Windows,
  // `ReadDirectoryChangesW` (the native backend for `fs.watch`) surfaces
  // EPERM during Vite's atomic rename-on-write faster than the JS-side
  // `error` event listener can intercept, which crashes the main process
  // with "A JavaScript error occurred in the main process". Polling the
  // stat info is boring, robust, and has negligible overhead in dev.
  const bundleDir = __dirname;
  const watched = ['main.js', 'preload.js']
    .map((name) => path.join(bundleDir, name))
    .filter((p) => fs.existsSync(p));

  if (!watched.length) {
    logWarn('dev', `Skipping main-process hot reload: no bundles found in ${bundleDir}`);
    return;
  }

  const lastMtime = new Map<string, number>();
  for (const p of watched) {
    try {
      lastMtime.set(p, fs.statSync(p).mtimeMs);
    } catch {
      // File will settle in the first poll; nothing to do.
    }
  }

  let relaunchTimer: NodeJS.Timeout | null = null;
  const scheduleRelaunch = (changedFile: string) => {
    if (isQuitting) return;
    if (relaunchTimer) clearTimeout(relaunchTimer);
    relaunchTimer = setTimeout(() => {
      logInfo('dev', `${path.basename(changedFile)} changed — relaunching Electron.`);
      isQuitting = true;
      app.relaunch();
      app.quit();
    }, 250);
  };

  const pollInterval = setInterval(() => {
    for (const p of watched) {
      let mtime: number;
      try {
        mtime = fs.statSync(p).mtimeMs;
      } catch {
        // Bundle is transiently missing during atomic replace — skip this
        // tick and re-check on the next one.
        continue;
      }
      const prev = lastMtime.get(p);
      lastMtime.set(p, mtime);
      if (prev !== undefined && mtime > prev) {
        scheduleRelaunch(p);
        return;
      }
    }
  }, 500);

  app.on('before-quit', () => {
    clearInterval(pollInterval);
    if (relaunchTimer) clearTimeout(relaunchTimer);
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function cancelCurrentDictation() {
  cancelledThroughSequence = transcriptionSequence;
  resetHotkeyState(false);
  updateTrayState('idle');
  updateOverlayState('idle');
}

// Register Echo as the OS handler for `echo://` URLs so OAuth callbacks
// (Supabase Google sign-in) launch us back into focus instead of opening
// a browser tab no-op. Must run BEFORE requestSingleInstanceLock or the
// registration race-conditions on first install.
const PROTOCOL = 'echo';
if (process.defaultApp) {
  // Dev mode: pass the script path so the OS launches `electron .` with
  // the URL appended, rather than a non-existent installer alias.
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient(PROTOCOL);
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
}

let ipcsRegistered = false;

function isTrustedAppSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  if (!senderWindow || senderWindow.isDestroyed()) return false;
  if (mainWindow && senderWindow === mainWindow) return true;
  if (stickyNoteWindows.has(senderWindow)) return true;
  // The prewarmed sticky window is intentionally absent from
  // stickyNoteWindows (countAsOpen: false) but its renderer still makes
  // boot-time IPC calls (settings, notes) that must not be rejected.
  if (warmStickyNoteWindow && senderWindow === warmStickyNoteWindow) return true;
  const overlayWindow = getOverlayWindow();
  return !!overlayWindow && senderWindow === overlayWindow;
}

function assertTrustedAppSender(event: IpcMainInvokeEvent): void {
  if (isTrustedAppSender(event)) return;
  const url = event.senderFrame?.url ?? event.sender.getURL();
  logWarn('ipc', `blocked invoke from untrusted sender on ${event.processId}:${event.frameId} (${url})`);
  throw new Error('Untrusted IPC sender.');
}

const trustedIpcMain = {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown): void {
    ipcMain.handle(channel, (event, ...args) => {
      assertTrustedAppSender(event);
      return listener(event, ...args);
    });
  },
  on(channel: string, listener: (event: IpcMainEvent, ...args: any[]) => void): void {
    ipcMain.on(channel, (event, ...args) => {
      if (!isTrustedAppSender(event)) {
        const url = event.senderFrame?.url ?? event.sender.getURL();
        logWarn('ipc', `blocked send from untrusted sender on ${event.processId}:${event.frameId} (${url})`);
        return;
      }
      listener(event, ...args);
    });
  },
};

function registerAllIpcs() {
  if (ipcsRegistered) return;
  ipcsRegistered = true;
  const ipcMain = trustedIpcMain;

  // Handle IPCs
  ipcMain.handle('get-app-version', () => app.getVersion());
  ipcMain.handle('get-settings', () => getSettings());
  ipcMain.handle('refresh-tray-menu', () => {
    void refreshTrayMenu();
  });
  ipcMain.on('get-initial-theme', (event) => {
    event.returnValue = 'light';
  });
  ipcMain.handle('suspend-hotkey', () => {
    suspendHotkey();
  });
  ipcMain.handle('cancel-recording-start', () => {
    resetHotkeyState(false);
    updateTrayState('idle');
    updateOverlayState('idle');
  });
  ipcMain.handle('cancel-dictation', () => {
    cancelCurrentDictation();
  });
  ipcMain.handle('resume-hotkey', () => {
    if (mainWindow) {
      const currentSettings = getSettings();
      const registeredHotkeys = registerHotkeys(currentSettings, mainWindow, cancelCurrentDictation);
      saveSettings(registeredHotkeys);
    }
    void refreshTrayMenu();
    return getSettings();
  });
  ipcMain.handle('save-settings', (_, overrides: unknown) => {
    const sanitizedOverrides = sanitizeSettingsUpdate(overrides);

    if (
      sanitizedOverrides.toggleHotkey !== undefined ||
      sanitizedOverrides.pushToTalkHotkey !== undefined ||
      sanitizedOverrides.cancelHotkey !== undefined
    ) {
      applyRegisteredHotkeys(sanitizedOverrides);
      return getSettings();
    }

    saveSettings(sanitizedOverrides);
    // Toggle overlay visibility after persisting the setting so the show path
    // uses the same source of truth as the overlay readiness handler.
    if (sanitizedOverrides.showOverlay !== undefined) {
      const overlayWindow = getOverlayWindow();
      if (sanitizedOverrides.showOverlay) {
        if (overlayWindow) {
          ensureOverlayVisible();
        } else {
          createOverlay();
        }
      } else if (overlayWindow) {
        overlayWindow.hide();
      }
    }
    if (sanitizedOverrides.overlayPosition !== undefined) {
      const overlayWindow = getOverlayWindow();
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        repositionOverlay();
      }
    }
    if (sanitizedOverrides.showAppInDock !== undefined) {
      syncLauncherVisibilityPreference(sanitizedOverrides.showAppInDock);
    }
    void refreshTrayMenu();
    return getSettings();
  });
  ipcMain.handle('get-history', async (_, limit: number, offset: number) => {
    const history = await ensureHistoryModule();
    const paging = sanitizePagination(limit, offset);
    return history.getEntries(paging.limit, paging.offset);
  });
  ipcMain.handle('get-dashboard-data', async (_, limit = 50, offset = 0) => {
    const history = await ensureHistoryModule();
    const paging = sanitizePagination(limit, offset, 50);
    return {
      stats: history.getStats(),
      history: history.getEntries(paging.limit, paging.offset),
    };
  });
  ipcMain.handle('basic-usage-get', async () => {
    const history = await ensureHistoryModule();
    return getBasicUsageSnapshotForGate(history);
  });
  ipcMain.handle('export-history', async (_, format: 'csv' | 'json') => {
    const history = await ensureHistoryModule();
    const entries = history.getAllEntries();
    const sanitizedFormat = sanitizeExportFormat(format);
    if (sanitizedFormat === 'csv') {
      return history.exportToCsv(entries);
    }
    return history.exportToJson(entries);
  });
  ipcMain.handle('update-history-entry', async (_, id: number, text: string) => {
    const history = await ensureHistoryModule();
    const updated = history.updateEntry(sanitizeEntryId(id), sanitizeHistoryText(text));
    void refreshTrayMenu();
    return updated;
  });
  ipcMain.handle('delete-history-entry', async (_, id: number) => {
    const history = await ensureHistoryModule();
    history.deleteEntry(sanitizeEntryId(id));
    void refreshTrayMenu();
  });
  ipcMain.handle('delete-history-entries', async (_, ids: number[]) => {
    const history = await ensureHistoryModule();
    history.deleteEntries(sanitizeEntryIds(ids));
    void refreshTrayMenu();
  });
  ipcMain.handle('clear-history', async () => {
    const history = await ensureHistoryModule();
    history.clearAll();
    void refreshTrayMenu();
  });
  ipcMain.handle('get-dictionary-items', async () => {
    const history = await ensureHistoryModule();
    return history.getDictionaryItems();
  });
  ipcMain.handle('save-dictionary-item', async (_, item: DictionaryItemInput | unknown) => {
    const history = await ensureHistoryModule();
    return history.saveDictionaryItem(sanitizeDictionaryItemInputPayload(item));
  });
  ipcMain.handle('delete-dictionary-item', async (_, id: number) => {
    const history = await ensureHistoryModule();
    return history.deleteDictionaryItem(sanitizeEntryId(id));
  });
  ipcMain.handle('get-snippets', async () => {
    const history = await ensureHistoryModule();
    return history.getSnippets();
  });
  ipcMain.handle('save-snippet', async (_, s: SnippetInput | unknown) => {
    const history = await ensureHistoryModule();
    return history.saveSnippet(sanitizeSnippetInputPayload(s));
  });
  ipcMain.handle('delete-snippet', async (_, id: number) => {
    const history = await ensureHistoryModule();
    return history.deleteSnippet(sanitizeEntryId(id));
  });
  ipcMain.handle('get-notes', async () => {
    const history = await ensureHistoryModule();
    return notesForRenderer(history.getNotes());
  });
  ipcMain.handle('open-sticky-note-window', async (_, noteId?: number, options?: unknown) => {
    await openStickyNoteWindow(noteId, options);
  });
  ipcMain.handle('create-new-sticky-note-window', async (_, noteArg?: unknown, options?: unknown) => {
    await openStickyNoteWindow(noteArg, options, { forceNew: true });
  });
  ipcMain.handle('attach-note-to-sticky-window', async (event, payload: unknown, point: unknown) => {
    const sourceWindow = BrowserWindow.fromWebContents(event.sender);
    const parsedPayload = sanitizeStickyNoteAttachPayload(payload);
    const parsedPoint = sanitizeStickyNoteDropPoint(point);
    if (!sourceWindow || !parsedPoint) return false;

    const targetWindow = findStickyNoteWindowAtPoint(parsedPoint, sourceWindow);
    if (!targetWindow) return false;

    targetWindow.webContents.send('attach-note-in-sticky', { ...parsedPayload, keepAsNewTab: true });
    if (targetWindow.isMinimized()) targetWindow.restore();
    targetWindow.show();
    targetWindow.moveTop();
    targetWindow.focus();
    return true;
  });
  ipcMain.handle('save-note', async (_, note: unknown) => {
    const history = await ensureHistoryModule();
    const sanitized = sanitizeNoteInputPayload(note);
    if (sanitized.id && history.isNoteLocked(sanitized.id) && !unlockedNoteIds.has(sanitized.id)) {
      throw new Error('Unlock this note before editing it.');
    }
    const result = history.saveNote(sanitized);
    broadcastNotesUpdated();
    return noteForRenderer(result);
  });
  ipcMain.handle('toggle-note-pin', async (_, id: number, pinned: boolean) => {
    const history = await ensureHistoryModule();
    const result = history.toggleNotePin(sanitizeEntryId(id), pinned);
    broadcastNotesUpdated();
    return noteForRenderer(result);
  });
  ipcMain.handle('lock-note', async (_, id: number, code: unknown) => {
    const history = await ensureHistoryModule();
    const noteId = sanitizeEntryId(id);
    const result = history.setNoteLock(noteId, sanitizeNoteLockCode(code));
    unlockedNoteIds.delete(noteId);
    broadcastNotesUpdated();
    return noteForRenderer(result);
  });
  ipcMain.handle('unlock-note', async (_, id: number, code: unknown) => {
    const history = await ensureHistoryModule();
    const noteId = sanitizeEntryId(id);
    const result = history.unlockNote(noteId, sanitizeNoteLockCode(code));
    if (!result) return { ok: false };
    unlockedNoteIds.add(noteId);
    broadcastNotesUpdated();
    return { ok: true, note: noteForRenderer(result) };
  });
  ipcMain.handle('relock-note', async (_, id: number) => {
    const history = await ensureHistoryModule();
    const noteId = sanitizeEntryId(id);
    unlockedNoteIds.delete(noteId);
    const note = history.getNote(noteId);
    broadcastNotesUpdated();
    return note ? noteForRenderer(note) : null;
  });
  ipcMain.handle('remove-note-lock', async (_, id: number) => {
    const history = await ensureHistoryModule();
    const noteId = sanitizeEntryId(id);
    if (history.isNoteLocked(noteId) && !unlockedNoteIds.has(noteId)) {
      throw new Error('Unlock this note before removing its lock.');
    }
    const result = history.removeNoteLock(noteId);
    unlockedNoteIds.delete(noteId);
    broadcastNotesUpdated();
    return noteForRenderer(result);
  });
  ipcMain.handle('delete-note', async (_, id: number) => {
    const history = await ensureHistoryModule();
    const result = history.deleteNote(sanitizeEntryId(id));
    broadcastNotesUpdated();
    return result;
  });
  ipcMain.handle('get-stats', async () => {
    const history = await ensureHistoryModule();
    return history.getStats();
  });
  ipcMain.handle('get-current-app', async () => refreshActiveAppName());

  // ─────────────────────── Auth / cloud sync ──────────────────────────
  // The renderer's <AuthGate> calls these. All return plain shapes
  // safe to ship through ipcRenderer.invoke (no Error objects, no
  // Supabase client instances).
  ipcMain.handle('auth-config-status', () => ({ configured: isAuthConfigured() }));
  ipcMain.handle('auth-get-session', () => serialiseSession());
  ipcMain.handle('auth-sign-in', (_e, email: string, password: string) =>
    signInWithPassword(email, password)
  );
  ipcMain.handle('auth-sign-up', (_e, email: string, password: string, displayName?: string) =>
    signUpWithPassword(email, password, displayName)
  );
  ipcMain.handle('auth-sign-out', () => authSignOut());
  ipcMain.handle('auth-reset-password', (_e, email: string) => sendPasswordReset(email));
  ipcMain.handle('auth-google-sign-in', () => startGoogleSignIn());
  ipcMain.handle('auth-delete-account', () => deleteAccount());
  ipcMain.handle('auth-update-display-name', (_e, name: string) => updateDisplayName(name));
  ipcMain.handle('auth-update-profile-picture', (_e, profilePictureDataUrl: string | null) =>
    updateProfilePicture(profilePictureDataUrl)
  );

  ipcMain.handle('sync-get-status', () => getSyncStatus());
  ipcMain.handle('sync-force', () => forceSync());

  // ─────────────────────── Billing / entitlements ─────────────────────
  ipcMain.handle('billing-config-status', () => ({ configured: isCloudConfigured() }));
  ipcMain.handle('entitlements-get', () => getEntitlementsSnapshot());
  ipcMain.handle('entitlements-refresh', () => refreshEntitlements());
  ipcMain.handle('billing-start-checkout', async (_e, plan: 'pro_monthly' | 'pro_yearly') => {
    if (plan !== 'pro_monthly' && plan !== 'pro_yearly') {
      return { error: 'invalid_plan' };
    }
    try {
      const url = await cloudStartCheckout(plan);
      await shell.openExternal(url);
      return { ok: true as const };
    } catch (err) {
      logWarn('billing', 'start-checkout failed', err);
      const code = err instanceof CloudHttpError ? err.code : 'internal_error';
      const message = err instanceof Error ? err.message : 'Could not open checkout.';
      return { ok: false as const, code, error: message };
    }
  });
  ipcMain.handle('billing-open-portal', async () => {
    try {
      const url = await cloudOpenCustomerPortal();
      await shell.openExternal(url);
      return { ok: true as const };
    } catch (err) {
      logWarn('billing', 'open-portal failed', err);
      const code = err instanceof CloudHttpError ? err.code : 'internal_error';
      const message = err instanceof Error ? err.message : 'Could not open portal.';
      return { ok: false as const, code, error: message };
    }
  });

  // Auto-update IPC. The renderer drives the "Download" / "Restart"
  // buttons; the state itself is pushed proactively over the
  // `update-status` channel via `broadcastUpdateStatusTo`.
  ipcMain.handle('update-get-status', () => getUpdateStatus());
  ipcMain.handle('update-check', () => {
    checkForUpdatesNow();
  });
  ipcMain.handle('update-download', () => {
    downloadUpdateNow();
  });
  ipcMain.handle('update-install', () => {
    installAndRestart();
  });

  // Hotkey -> transcribe flow (optimized: parallel operations)
  ipcMain.handle('transcribe-audio', async (_, arrayBuffer: ArrayBuffer, durationMs: number, speechMetrics?: SpeechMetrics) => {
    const requestSequence = ++transcriptionSequence;
    const isCancelled = () => requestSequence <= cancelledThroughSequence;

    try {
      const sanitizedAudioBuffer = sanitizeArrayBufferPayload(arrayBuffer);
      const sanitizedDurationMs = sanitizeDurationMs(durationMs);
      const sanitizedSpeechMetrics = sanitizeSpeechMetrics(speechMetrics);
      const processingStart = Date.now();
      updateTrayState('processing');
      updateOverlayState('processing');
      const settings = getSettings();

      // Kick off every downstream dependency in parallel with transcription.
      // The cleanup module, history store (SQLite open), and SendInput helper
      // all have small but non-zero warm-up costs that previously ran
      // serially AFTER transcription, stretching the perceived delay by up
      // to a second on a cold app. Running them concurrently means the only
      // thing we still wait on is the unavoidable speech-to-text latency
      // plus the Groq cleanup round-trip.
      const historyModulePromise = ensureHistoryModule();
      const cleanupModulePromise = getCleanupModule();
      const transcribeModulePromise = getTranscribeModule();
      void prewarmInjectHelper().catch(() => { /* logged via waiter */ });

      const history = await historyModulePromise;
      const currentBasicUsage = await getBasicUsageSnapshotForGate(history);
      if (currentBasicUsage.exhausted) {
        updateTrayState('idle');
        updateOverlayState('error');
        resetHotkeyState(false);
        notifyBasicUsageLimitReached(currentBasicUsage);
        setTimeout(() => {
          updateTrayState('idle');
          updateOverlayState('idle');
        }, 1800);
        return;
      }

      const { transcribeAudio } = await transcribeModulePromise;

      // Retrieve the app name that was captured when recording started
      const appName = getActiveAppName();

      // Only await the transcription itself so it returns instantly
      const result = await withTimeout(
        transcribeAudio(sanitizedAudioBuffer, settings, sanitizedDurationMs, sanitizedSpeechMetrics),
        TRANSCRIPTION_TIMEOUT_MS,
        'Transcription'
      );
      if (isCancelled()) {
        return;
      }
      const rawText = result.text;

      if (result.cloudError && mainWindow) {
        mainWindow.webContents.send(
          'error',
          'Cloud transcription failed — used local model as fallback.'
        );
      }

      if (!rawText || rawText.trim() === '') {
        updateTrayState('idle');
        updateOverlayState('success');
        scheduleOverlayIdle(SUCCESS_PILL_MS);
        if (mainWindow) mainWindow.webContents.send('transcription-result', null);
        return;
      }

      // Cleanup + snippet expansion + injection. `cleanupModulePromise` is
      // already resolved by this point in the common case, so the only real
      // wait is the LLM call itself.
      const resolvedStyle = resolveGlobalStyle(settings);
      const toneId = resolvedStyle.toneId;
      const cleanupModule = await cleanupModulePromise;
      const cleaned = await withTimeout(
        cleanupModule.cleanupText(rawText, toneId, settings, result.detectedLanguage),
        CLEANUP_TIMEOUT_MS,
        'Cleanup'
      );
      if (isCancelled()) {
        return;
      }
      const dictionaryApplied = applyDictionary(cleaned, history.getDictionaryItems());
      const { text: finalText, usedSnippetIds } = expandSnippetsDetailed(
        dictionaryApplied,
        history.getSnippets(),
      );
      if (isCancelled()) {
        return;
      }
      if (usedSnippetIds.length > 0) {
        try {
          history.recordSnippetUsage(usedSnippetIds);
        } catch {
          // Usage telemetry is best-effort; never block the dictation.
        }
      }

      if (!finalText.trim()) {
        updateTrayState('idle');
        updateOverlayState('success');
        scheduleOverlayIdle(SUCCESS_PILL_MS);
        resetHotkeyState(false);
        if (mainWindow) mainWindow.webContents.send('transcription-result', null);
        return;
      }

      if (shouldSuppressDuplicateTranscript(finalText)) {
        updateTrayState('idle');
        updateOverlayState('success');
        scheduleOverlayIdle(SUCCESS_PILL_MS);
        resetHotkeyState(false);
        if (mainWindow) mainWindow.webContents.send('transcription-result', null);
        return;
      }
      if (isCancelled()) {
        return;
      }

      const wordCount = finalText.split(/\s+/).filter(w => w.length > 0).length;
      // Reuse the usage snapshot taken before transcription. No history rows
      // are written until after injection (`addEntry` below), so `used` is
      // still current here. Re-scanning the whole dictations table at this
      // point only adds latency to the instant the user is waiting for the
      // paste to land.
      if (currentBasicUsage.tier !== 'pro') {
        if (currentBasicUsage.used + wordCount > BASIC_WEEKLY_WORD_CAP) {
          updateTrayState('idle');
          updateOverlayState('error');
          resetHotkeyState(false);
          notifyBasicUsageLimitReached(currentBasicUsage);
          setTimeout(() => {
            updateTrayState('idle');
            updateOverlayState('idle');
          }, 1800);
          return;
        }
      }

      await injectText(finalText, appName);
      if (isCancelled()) {
        return;
      }

      const entry = history.addEntry({
        text: finalText,
        rawText,
        wordCount,
        durationMs: sanitizedDurationMs,
        appName,
        mode: resolvedStyle.key,
        method: result.method,
        createdAt: new Date().toISOString()
      });

      const processingTimeMs = Date.now() - processingStart;
      updateTrayState('idle');
      updateOverlayState('success');
      scheduleOverlayIdle(SUCCESS_PILL_MS);
      resetHotkeyState(false);

      void refreshTrayMenu();
      if (mainWindow) mainWindow.webContents.send('transcription-result', { ...entry, processingTimeMs });
    } catch (e: unknown) {
      if (isCancelled()) {
        return;
      }
      logError('transcribe', 'Transcription flow failed', e);
      updateTrayState('error');
      updateOverlayState('error');
      resetHotkeyState(false);
      if (mainWindow) {
        // Never forward raw SDK/OS error strings to the renderer — they can
        // contain paths, headers, or API payload fragments. Map to a small
        // set of user-friendly messages based on common root causes.
        const rawMessage = e instanceof Error ? e.message : String(e ?? '');
        const friendly = /timeout|timed out/i.test(rawMessage)
          ? 'Transcription took too long. Please try again.'
          : /401|unauthorized|api key|invalid_api_key/i.test(rawMessage)
            ? 'Groq API key is missing or invalid. Update it in Settings.'
            : /429|rate limit/i.test(rawMessage)
              ? 'Groq rate limit reached. Please wait a moment and try again.'
              : /network|ENOTFOUND|ECONNRESET|ETIMEDOUT|fetch failed|connection error/i.test(rawMessage)
                ? 'Network error while transcribing. Check your internet connection.'
                : 'Dictation failed. Please try again.';
        mainWindow.webContents.send('error', friendly);
      }
      setTimeout(() => {
        updateTrayState('idle');
      }, 5000);
      scheduleOverlayIdle(5000);
    }
  });

  ipcMain.on('audio-level', (_, level: number[]) => {
    const overlay = getOverlayWindow();
    if (overlay && overlay.isVisible() && !overlay.webContents.isLoadingMainFrame()) {
      overlay.webContents.send('audio-level', sanitizeAudioLevels(level));
    }
  });

  ipcMain.on('window-minimize', () => {
    mainWindow?.minimize();
  });

  ipcMain.on('window-toggle-maximize', () => {
    if (!mainWindow) return;

    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
      return;
    }

    mainWindow.maximize();
  });

  ipcMain.handle('window-is-maximized', (event) => {
    const target = BrowserWindow.fromWebContents(event.sender);
    return target ? target.isMaximized() : false;
  });

  ipcMain.on('window-close', () => {
    mainWindow?.hide();
  });
  ipcMain.on('close-current-window', (event) => {
    const target = BrowserWindow.fromWebContents(event.sender);
    target?.close();
  });

  ipcMain.on('force-close-current-window', (event) => {
    const target = BrowserWindow.fromWebContents(event.sender);
    if (!target || target.isDestroyed()) return;
    target.destroy();
  });

  ipcMain.on('toggle-current-window-maximize', (event) => {
    const target = BrowserWindow.fromWebContents(event.sender);
    if (!target) return;
    expandWindowForWriting(target);
  });

  ipcMain.on('expand-current-window-for-writing', (event) => {
    const target = BrowserWindow.fromWebContents(event.sender);
    if (!target) return;
    expandWindowForWriting(target);
  });

  ipcMain.handle('clipboard-write-text', (_, text: unknown) => {
    if (typeof text !== 'string') {
      throw new Error('Clipboard text must be a string.');
    }
    clipboard.writeText(text);
  });
  ipcMain.handle('open-external-url', async (_, url: unknown) => {
    if (typeof url !== 'string') {
      throw new Error('External URL must be a string.');
    }
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Only http and https links can be opened.');
    }
    await shell.openExternal(parsed.toString());
  });

  // Renderer-side errors flow into the same log file as main-process
  // errors so a single `dictation.log` is the one place to look when a
  // user reports a problem. The payload is sanitised on the renderer
  // side already (we just stringify what's there), but we cap individual
  // fields so a runaway loop can't blow up our 1 MB log budget.
  ipcMain.on('report-renderer-error', (_, payload: unknown) => {
    if (!payload || typeof payload !== 'object') return;
    const { scope, message, stack } = payload as { scope?: unknown; message?: unknown; stack?: unknown };
    const safeScope = typeof scope === 'string' ? scope.slice(0, 64) : 'renderer';
    const safeMessage = typeof message === 'string' ? message.slice(0, 1000) : 'Renderer error';
    const safeStack = typeof stack === 'string' ? stack.slice(0, 4000) : undefined;
    logError(`renderer:${safeScope}`, safeMessage, safeStack ? new Error(safeStack) : undefined);
  });
}

function applyRegisteredHotkeys(overrides: Partial<Settings>) {
  if (!mainWindow) {
    saveSettings(overrides);
    return getSettings();
  }

  const currentSettings = getSettings();
  const nextSettings: Settings = {
    ...currentSettings,
    ...overrides,
  };
  const registeredHotkeys = registerHotkeys(nextSettings, mainWindow, cancelCurrentDictation);
  saveSettings({
    ...overrides,
    ...registeredHotkeys,
  });
  void refreshTrayMenu();
  return getSettings();
}

function registerWindowSecurityHandlers(window: BrowserWindow) {
  const allowedDevOrigin = MAIN_WINDOW_VITE_DEV_SERVER_URL
    ? new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL).origin
    : null;
  const allowedFilePrefix = `file://${path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/`).replace(/\\/g, '/')}`;

  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        void shell.openExternal(parsed.toString());
      }
    } catch {
      if (ALLOWED_EXTERNAL_URLS.has(url)) {
        void shell.openExternal(url);
      }
    }

    return { action: 'deny' };
  });

  window.webContents.on('will-navigate', (event, url) => {
    if (allowedDevOrigin) {
      try {
        if (new URL(url).origin === allowedDevOrigin) {
          return;
        }
      } catch {
        // Fall through to deny unknown/invalid URLs.
      }
    }

    if (url.startsWith(allowedFilePrefix)) {
      return;
    }

    event.preventDefault();
  });

  window.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
}

function broadcastNotesUpdated(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      try {
        win.webContents.send('notes-updated');
      } catch {
        // ignore — window may be torn down mid-send
      }
    }
  }
}

type StickyNoteWindowOptions = {
  x?: number;
  y?: number;
};

type StickyNoteAttachPayload = {
  noteId?: number;
  title: string;
  body: string;
  // When true the receiving window keeps this as its own tab instead of
  // merging it into a blank placeholder tab (used when re-attaching a tab the
  // user dragged from another window).
  keepAsNewTab?: boolean;
};

const STICKY_NOTE_WINDOW_WIDTH = 620;
const STICKY_NOTE_WINDOW_HEIGHT = 500;
const STICKY_NOTE_EXPANDED_WIDTH = 1040;
const STICKY_NOTE_EXPANDED_HEIGHT = 720;
function expandWindowForWriting(target: BrowserWindow) {
  if (target.isDestroyed()) return;

  if (target.isMaximized()) target.unmaximize();
  const current = target.getBounds();
  const area = screen.getDisplayMatching(current).workArea;
  const isExpanded = expandedStickyNoteWindows.has(target);
  const width = Math.min(isExpanded ? STICKY_NOTE_WINDOW_WIDTH : STICKY_NOTE_EXPANDED_WIDTH, area.width);
  const height = Math.min(isExpanded ? STICKY_NOTE_WINDOW_HEIGHT : STICKY_NOTE_EXPANDED_HEIGHT, area.height);
  const x = Math.round(area.x + (area.width - width) / 2);
  const y = Math.round(area.y + (area.height - height) / 2);
  target.setBounds({ x, y, width, height }, true);
  if (isExpanded) {
    expandedStickyNoteWindows.delete(target);
  } else {
    expandedStickyNoteWindows.add(target);
  }
}

function sanitizeStickyNoteWindowOptions(options: unknown): StickyNoteWindowOptions | undefined {
  if (!options || typeof options !== 'object') return undefined;
  const candidate = options as Record<string, unknown>;
  const x = typeof candidate.x === 'number' && Number.isFinite(candidate.x) ? candidate.x : undefined;
  const y = typeof candidate.y === 'number' && Number.isFinite(candidate.y) ? candidate.y : undefined;
  if (x === undefined && y === undefined) return undefined;
  return { x, y };
}

function resolveStickyNoteWindowPosition(options: StickyNoteWindowOptions | undefined): { x: number; y: number } {
  const parentBounds = mainWindow?.getBounds();
  const offset = stickyNoteWindows.size * 28;
  const fallbackX = (parentBounds?.x ?? 160) + 80 + offset;
  const fallbackY = (parentBounds?.y ?? 120) + 80 + offset;
  const rawX = Math.round(options?.x ?? fallbackX);
  const rawY = Math.round(options?.y ?? fallbackY);
  const display = screen.getDisplayNearestPoint({ x: rawX, y: rawY });
  const area = display.workArea;
  const maxX = Math.max(area.x, area.x + area.width - STICKY_NOTE_WINDOW_WIDTH);
  const maxY = Math.max(area.y, area.y + area.height - STICKY_NOTE_WINDOW_HEIGHT);
  return {
    x: Math.min(Math.max(rawX, area.x), maxX),
    y: Math.min(Math.max(rawY, area.y), maxY),
  };
}

function sanitizeStickyNoteAttachPayload(payload: unknown): StickyNoteAttachPayload {
  const candidate = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const noteId = typeof candidate.noteId === 'number' && Number.isFinite(candidate.noteId)
    ? Math.trunc(candidate.noteId)
    : undefined;
  const title = typeof candidate.title === 'string' ? candidate.title.slice(0, 200) : 'Untitled';
  const body = typeof candidate.body === 'string' ? candidate.body : '';
  return {
    noteId,
    title: title.trim() || 'Untitled',
    body,
  };
}

function sanitizeStickyNoteDropPoint(point: unknown): { x: number; y: number } | null {
  if (!point || typeof point !== 'object') return null;
  const candidate = point as Record<string, unknown>;
  const x = typeof candidate.x === 'number' && Number.isFinite(candidate.x) ? Math.round(candidate.x) : null;
  const y = typeof candidate.y === 'number' && Number.isFinite(candidate.y) ? Math.round(candidate.y) : null;
  return x === null || y === null ? null : { x, y };
}

function markStickyNoteWindowFocused(win: BrowserWindow): void {
  const index = stickyNoteFocusOrder.indexOf(win);
  if (index !== -1) stickyNoteFocusOrder.splice(index, 1);
  stickyNoteFocusOrder.unshift(win);
}

function removeStickyNoteWindowFromFocusOrder(win: BrowserWindow): void {
  const index = stickyNoteFocusOrder.indexOf(win);
  if (index !== -1) stickyNoteFocusOrder.splice(index, 1);
}

function findStickyNoteWindowAtPoint(
  point: { x: number; y: number },
  sourceWindow: BrowserWindow,
): BrowserWindow | null {
  const containsPoint = (win: BrowserWindow): boolean => {
    const bounds = win.getBounds();
    return (
      point.x >= bounds.x &&
      point.x <= bounds.x + bounds.width &&
      point.y >= bounds.y &&
      point.y <= bounds.y + bounds.height
    );
  };
  const isCandidate = (win: BrowserWindow): boolean =>
    win !== sourceWindow && !win.isDestroyed() && stickyNoteWindows.has(win);

  // Prefer the topmost window under the cursor. We approximate stacking order
  // with focus order (most-recently-focused first) so a dropped tab lands in
  // the window the user actually sees on top, not one hidden behind it.
  for (const win of stickyNoteFocusOrder) {
    if (isCandidate(win) && containsPoint(win)) return win;
  }

  // Fallback for any window not yet tracked in the focus order.
  for (const win of stickyNoteWindows) {
    if (isCandidate(win) && !stickyNoteFocusOrder.includes(win) && containsPoint(win)) {
      return win;
    }
  }

  return null;
}

type StickyNoteCreateOptions = {
  show?: boolean;
  focusOnLoad?: boolean;
  countAsOpen?: boolean;
};

function loadStickyNoteRenderer(stickyWindow: BrowserWindow): void {
  const query = 'stickyNote=new';
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    const stickyUrl = new URL('/sticky.html', MAIN_WINDOW_VITE_DEV_SERVER_URL);
    stickyUrl.search = query;
    void stickyWindow.loadURL(stickyUrl.href);
  } else {
    void stickyWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/sticky.html`), {
      search: query,
    });
  }
}

async function resolveStickyNoteById(noteId: number): Promise<Note | undefined> {
  const history = await ensureHistoryModule();
  const note = history.getNote(noteId);
  return note ? noteForRenderer(note) : undefined;
}

function sendOpenNoteInSticky(stickyWindow: BrowserWindow, note: Note): void {
  const deliver = () => {
    if (stickyWindow.isDestroyed()) return;
    try {
      stickyWindow.webContents.send('open-note-in-sticky', note);
    } catch {
      // Window torn down mid-send.
    }
  };

  if (stickyWindow.webContents.isLoading()) {
    stickyWindow.webContents.once('did-finish-load', deliver);
    return;
  }
  deliver();
}

function sendAttachNoteInSticky(stickyWindow: BrowserWindow, payload: StickyNoteAttachPayload): void {
  const deliver = () => {
    if (stickyWindow.isDestroyed()) return;
    try {
      stickyWindow.webContents.send('attach-note-in-sticky', payload);
    } catch {
      // Window torn down mid-send.
    }
  };

  if (stickyWindow.webContents.isLoading()) {
    stickyWindow.webContents.once('did-finish-load', deliver);
    return;
  }
  deliver();
}

function scheduleWarmStickyNoteWindow(): void {
  setTimeout(() => {
    prepareWarmStickyNoteWindow();
  }, 100);
}

type StickyNoteOpenOptions = {
  forceNew?: boolean;
};

function parseStickyNoteWindowTarget(
  noteArg: unknown,
): { noteId?: number; attachPayload?: StickyNoteAttachPayload } {
  if (typeof noteArg === 'number' && Number.isFinite(noteArg)) {
    return { noteId: noteArg };
  }
  if (noteArg && typeof noteArg === 'object') {
    const attachPayload = sanitizeStickyNoteAttachPayload(noteArg);
    return { noteId: attachPayload.noteId, attachPayload };
  }
  return {};
}

function spawnStickyNoteWindow(
  parsedOptions: StickyNoteWindowOptions | undefined,
  target: { noteId?: number; attachPayload?: StickyNoteAttachPayload },
): BrowserWindow {
  const warmWindow = showWarmStickyNoteWindow(parsedOptions);
  const targetWindow = warmWindow ?? createStickyNoteWindow(parsedOptions);
  if (!warmWindow) scheduleWarmStickyNoteWindow();

  if (target.attachPayload) {
    sendAttachNoteInSticky(targetWindow, target.attachPayload);
  } else if (target.noteId !== undefined) {
    void resolveStickyNoteById(target.noteId).then((note) => {
      if (note) sendOpenNoteInSticky(targetWindow, note);
    });
  }

  return targetWindow;
}

async function openStickyNoteWindow(
  noteArg?: unknown,
  options?: unknown,
  openOptions: StickyNoteOpenOptions = {},
): Promise<void> {
  const parsedOptions = sanitizeStickyNoteWindowOptions(options);
  const { noteId, attachPayload } = parseStickyNoteWindowTarget(noteArg);
  const forceNew = openOptions.forceNew ?? false;

  // If a sticky note window already exists, route into it as a new tab
  // rather than spawning another window — both for "open this saved note"
  // (noteId set) and for "+ new blank note" (noteId undefined).
  if (!forceNew && stickyNoteWindows.size > 0) {
    const existingWindow = stickyNoteWindows.values().next().value as BrowserWindow | undefined;
    if (existingWindow && !existingWindow.isDestroyed()) {
      existingWindow.focus();
      try {
        if (attachPayload) {
          sendAttachNoteInSticky(existingWindow, attachPayload);
        } else if (noteId !== undefined) {
          void resolveStickyNoteById(noteId).then((note) => {
            if (note) sendOpenNoteInSticky(existingWindow, note);
          });
        } else {
          existingWindow.webContents.send('new-blank-tab-in-sticky');
        }
      } catch {
        // Window torn down mid-send; fall through to create a new one.
      }
      return;
    }
  }

  spawnStickyNoteWindow(parsedOptions, { noteId, attachPayload });
}

function createStickyNoteWindow(
  options?: StickyNoteWindowOptions,
  createOptions: StickyNoteCreateOptions = {},
): BrowserWindow {
  const position = resolveStickyNoteWindowPosition(options);
  const showImmediately = createOptions.show ?? true;
  const focusOnLoad = createOptions.focusOnLoad ?? showImmediately;
  const countAsOpen = createOptions.countAsOpen ?? showImmediately;
  const stickyWindow = new BrowserWindow({
    width: STICKY_NOTE_WINDOW_WIDTH,
    height: STICKY_NOTE_WINDOW_HEIGHT,
    x: position.x,
    y: position.y,
    minWidth: 572,
    minHeight: 442,
    frame: false,
    hasShadow: true,
    resizable: true,
    alwaysOnTop: false,
    skipTaskbar: false,
    title: 'Note',
    // Opaque window so the desktop never bleeds through the corners and the
    // BrowserWindow can paint cream from frame zero — eliminates the brief
    // empty/transparent flash the user perceived as a "loading screen".
    // Win11 DWM applies subtle native rounded corners on frameless windows;
    // older platforms render square corners (acceptable trade-off for zero
    // styling artefacts).
    transparent: false,
    backgroundColor: '#F4EFE5',
    roundedCorners: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
    // Always start hidden; we only show after the renderer has finished
    // loading so the user never sees a blank cream window mid-mount.
    show: false,
    paintWhenInitiallyHidden: true,
  });

  if (countAsOpen) stickyNoteWindows.add(stickyWindow);
  registerWindowSecurityHandlers(stickyWindow);
  stickyWindow.on('focus', () => {
    markStickyNoteWindowFocused(stickyWindow);
  });
  stickyWindow.once('closed', () => {
    stickyNoteWindows.delete(stickyWindow);
    removeStickyNoteWindowFromFocusOrder(stickyWindow);
    expandedStickyNoteWindows.delete(stickyWindow);
    if (warmStickyNoteWindow === stickyWindow) warmStickyNoteWindow = null;
  });

  // Hide the Echo splash at the native level before any paint can happen.
  stickyWindow.webContents.once('dom-ready', () => {
    try {
      stickyWindow.webContents.insertCSS('#splash{display:none!important;visibility:hidden!important;}');
    } catch { /* no-op */ }
  });

  stickyWindow.once('ready-to-show', () => {
    if (stickyWindow.isDestroyed()) return;
    if (showImmediately) stickyWindow.show();
    if (focusOnLoad) stickyWindow.focus();
  });

  loadStickyNoteRenderer(stickyWindow);
  return stickyWindow;
}

function prepareWarmStickyNoteWindow(): void {
  if (warmStickyNoteWindow && !warmStickyNoteWindow.isDestroyed()) return;

  warmStickyNoteWindow = createStickyNoteWindow(undefined, {
    show: false,
    focusOnLoad: false,
    countAsOpen: false,
  });
}

function showWarmStickyNoteWindow(options?: StickyNoteWindowOptions, note?: Note): BrowserWindow | null {
  const stickyWindow = warmStickyNoteWindow;
  if (!stickyWindow || stickyWindow.isDestroyed()) {
    warmStickyNoteWindow = null;
    return null;
  }

  warmStickyNoteWindow = null;
  const position = resolveStickyNoteWindowPosition(options);
  stickyWindow.setPosition(position.x, position.y, false);
  stickyNoteWindows.add(stickyWindow);
  stickyWindow.show();
  stickyWindow.focus();

  if (note) {
    sendOpenNoteInSticky(stickyWindow, note);
  }

  scheduleWarmStickyNoteWindow();

  return stickyWindow;
}
// ---------- Content Security Policy ----------
//
// We inject CSP at the response-header level rather than via a `<meta>`
// tag in `index.html`. The reason: dev needs to allow Vite's HMR
// WebSocket (`ws://localhost:5173`) and module fetches, but production
// must NOT allow arbitrary `ws:`/`wss:` connections. A single meta tag
// can't express that split, so historically the dev policy ("ws: wss:")
// was shipping to packaged builds — meaning any future XSS or supply-
// chain compromise in the renderer could phone home over WebSocket to
// any host on the internet.
//
// `connect-src 'self'` in production is sufficient because Supabase is
// only ever called from the main process; the renderer never makes a
// network request directly. `https://flagcdn.com` is allowed in
// `img-src` for country flags in the language picker.
function setupContentSecurityPolicy(): void {
  const isDev = !app.isPackaged;

  // In packaged builds the renderer is served from `file://`, and
  // Chromium does NOT treat `'self'` as matching the `file:` scheme for
  // scheme-restricted directives (script-src, img-src, font-src, style-src,
  // media-src). Without `file:` listed explicitly, the Vite-emitted
  // `<script type="module" src="./assets/...js">` is blocked and React
  // never mounts — the splash just sits there. Allowing `file:` keeps
  // the production CSP strict (no remote code / images / fonts) while
  // unblocking the locally-shipped bundle. In dev everything is served
  // from http://localhost by Vite, so `'self'` is enough there.
  const localScheme = isDev ? '' : ' file:';

  const directives = [
    "default-src 'self'",
    `script-src 'self'${localScheme}`,
    `style-src 'self'${localScheme} 'unsafe-inline'`,
    `img-src 'self'${localScheme} data: blob: https://flagcdn.com`,
    `font-src 'self'${localScheme} data:`,
    isDev
      // Dev: Vite serves modules over http and HMR over ws on localhost.
      // Scope the allowance tightly to localhost loopback so we don't
      // accidentally re-introduce the wide-open dev policy.
      ? "connect-src 'self' http://localhost:* ws://localhost:* http://127.0.0.1:* ws://127.0.0.1:*"
      // Prod: renderer talks to nobody directly. All network egress
      // (Supabase, Groq, GitHub releases) happens from main.
      : "connect-src 'self'",
    `media-src 'self'${localScheme} blob:`,
    "object-src 'none'",
    "base-uri 'self'",
    "frame-src 'none'",
    "form-action 'self'",
  ];

  const policy = directives.join('; ');

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = { ...details.responseHeaders } as Record<string, string[] | string>;

    // Strip any pre-existing CSP headers from upstream (Vite dev server,
    // file:// protocol handler) so our policy is the single source of
    // truth. Header keys are case-insensitive in HTTP.
    for (const key of Object.keys(responseHeaders)) {
      if (key.toLowerCase() === 'content-security-policy' || key.toLowerCase() === 'content-security-policy-report-only') {
        delete responseHeaders[key];
      }
    }

    responseHeaders['Content-Security-Policy'] = [policy];

    callback({ responseHeaders });
  });
}

// ---------- Window state persistence ----------
//
// We persist the last window size + position to a small JSON file in
// userData so the app feels stable across launches (especially across
// multi-monitor setups where the user dragged the window to a secondary
// display). We deliberately use a separate file from `electron-store`
// because the Settings type is strongly typed and shouldn't be polluted
// with cosmetic state.

type WindowBounds = {
  width: number;
  height: number;
  x?: number;
  y?: number;
  isMaximized?: boolean;
};

function getWindowStatePath(): string {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function readPersistedWindowBounds(): WindowBounds | null {
  try {
    const raw = fs.readFileSync(getWindowStatePath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof parsed.width === 'number' &&
      typeof parsed.height === 'number' &&
      Number.isFinite(parsed.width) &&
      Number.isFinite(parsed.height)
    ) {
      return {
        width: Math.max(0, Math.floor(parsed.width)),
        height: Math.max(0, Math.floor(parsed.height)),
        x: typeof parsed.x === 'number' && Number.isFinite(parsed.x) ? Math.floor(parsed.x) : undefined,
        y: typeof parsed.y === 'number' && Number.isFinite(parsed.y) ? Math.floor(parsed.y) : undefined,
        isMaximized: parsed.isMaximized === true,
      };
    }
  } catch {
    // Missing or corrupt — caller falls back to defaults.
  }
  return null;
}

function isBoundsOnScreen(bounds: WindowBounds): boolean {
  if (typeof bounds.x !== 'number' || typeof bounds.y !== 'number') return false;
  // Treat the window as on-screen if any visible display contains the
  // window's centre. This is more forgiving than requiring the entire
  // rectangle to be inside one display, which would reject windows the
  // user intentionally straddles between two screens.
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  return screen.getAllDisplays().some((display) => {
    const wa = display.workArea;
    return cx >= wa.x && cx <= wa.x + wa.width && cy >= wa.y && cy <= wa.y + wa.height;
  });
}

let saveBoundsTimer: NodeJS.Timeout | null = null;
function scheduleWindowBoundsSave() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (saveBoundsTimer) clearTimeout(saveBoundsTimer);
  saveBoundsTimer = setTimeout(() => {
    saveBoundsTimer = null;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      const isMaximized = mainWindow.isMaximized();
      // When maximized, `getBounds()` returns the maximized rectangle which
      // would be wrong to restore on a smaller display. Always store the
      // *normal* bounds so the restored size is sane regardless of state.
      const normalBounds = mainWindow.getNormalBounds();
      const payload: WindowBounds = {
        width: normalBounds.width,
        height: normalBounds.height,
        x: normalBounds.x,
        y: normalBounds.y,
        isMaximized,
      };
      fs.writeFileSync(getWindowStatePath(), JSON.stringify(payload, null, 2), 'utf8');
    } catch {
      // Best-effort; failing to persist window state must never crash the app.
    }
  }, 400);
}

function attachWindowStatePersistence(window: BrowserWindow, restoreMaximized: boolean) {
  if (restoreMaximized) {
    // Wait for the window to be ready before maximizing so we don't fight
    // with the initial show animation.
    window.once('ready-to-show', () => window.maximize());
  }
  // Subscribed individually so TypeScript can resolve the per-event overloads
  // for `BrowserWindow.on` (the union of literal event names doesn't match
  // a single overload signature).
  window.on('resize', scheduleWindowBoundsSave);
  window.on('move', scheduleWindowBoundsSave);
  // Keep the renderer's maximize/restore titlebar button in sync.
  const sendMaximizedState = (maximized: boolean) => () => {
    if (!window.isDestroyed()) {
      window.webContents.send('window-maximized-state', maximized);
    }
  };
  window.on('maximize', scheduleWindowBoundsSave);
  window.on('maximize', sendMaximizedState(true));
  window.on('unmaximize', scheduleWindowBoundsSave);
  window.on('unmaximize', sendMaximizedState(false));
}

function resolveAssetPath(filename: string): string {
  // Mirrors the resolver in `tray.ts`. We can't import it directly because
  // tray.ts wires up event handlers we don't want to spin up just to read a
  // filename, so duplicate the lookup table — both paths must agree.
  const candidates = [
    path.join(__dirname, '..', '..', 'assets', filename),
    path.join(app.getAppPath(), 'assets', filename),
    typeof process.resourcesPath === 'string'
      ? path.join(process.resourcesPath, 'assets', filename)
      : '',
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // existsSync can throw inside asar on some Electron versions.
    }
  }

  return candidates[0] ?? filename;
}

const createWindow = () => {
  const settings = getSettings();
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;
  // Launch at a stable "designed" size so the layout feels intentional on
  // first open. Users can enlarge the window, but not shrink below this
  // baseline. On smaller displays, clamp to the available work area.
  const idealWidth = 1240;
  const idealHeight = 780;
  const screenMarginX = 96;
  const screenMarginY = 96;
  const maxWidth = Math.max(900, screenWidth - screenMarginX);
  const maxHeight = Math.max(680, screenHeight - screenMarginY);
  const defaultWidth = Math.min(idealWidth, maxWidth);
  const defaultHeight = Math.min(idealHeight, maxHeight);
  // The "designed" launch size doubles as the resize floor — users can
  // grow the window freely on bigger displays, but never shrink below the
  // baseline that the Dashboard/Settings layouts were tuned for.
  const minWidth = defaultWidth;
  const minHeight = defaultHeight;

  // Restore the previous window bounds if they look sane and still fit on
  // an attached display. Fresh installs (no file) and bad payloads fall
  // back to the centered design size.
  const persistedBounds = readPersistedWindowBounds();
  const useRestoredBounds = !!(
    persistedBounds &&
    persistedBounds.width >= minWidth &&
    persistedBounds.height >= minHeight &&
    isBoundsOnScreen(persistedBounds)
  );
  const launchWidth = useRestoredBounds ? persistedBounds.width : defaultWidth;
  const launchHeight = useRestoredBounds ? persistedBounds.height : defaultHeight;
  const launchX = useRestoredBounds ? persistedBounds.x : undefined;
  const launchY = useRestoredBounds ? persistedBounds.y : undefined;
  const restoreMaximized = useRestoredBounds && persistedBounds?.isMaximized === true;

  // Decide up-front whether the user expects to see the window. A manual
  // launch should surface the window immediately with the branded splash
  // (rendered by renderer/index.html) — waiting for `ready-to-show` before
  // showing makes the OS display its own generic loading indicator, which
  // defeats the purpose of the splash. Only suppress on auto-start at login.
  const loginItemSettings = typeof app.getLoginItemSettings === 'function'
    ? app.getLoginItemSettings()
    : { wasOpenedAtLogin: false };
  const launchedHidden =
    process.argv.includes('--hidden') ||
    Boolean((loginItemSettings as { wasOpenedAtLogin?: boolean }).wasOpenedAtLogin);

  // Resolve the brand icon for the window/taskbar. Packaged Windows builds
  // also pick the .exe icon up from the binary's resource table, but passing
  // `icon` here makes the dev `npm start` taskbar match production.
  const iconPath = resolveAssetPath('icon.ico');
  const windowIcon = fs.existsSync(iconPath) ? iconPath : undefined;

  mainWindow = new BrowserWindow({
    width: launchWidth,
    height: launchHeight,
    ...(typeof launchX === 'number' && typeof launchY === 'number' ? { x: launchX, y: launchY } : {}),
    minWidth,
    minHeight,
    resizable: true,
    maximizable: true,
    // Only auto-centre when we don't have valid restored coordinates;
    // otherwise the explicit x/y above places the window precisely.
    center: !useRestoredBounds,
    frame: false,
    ...(windowIcon ? { icon: windowIcon } : {}),
    // Matches the splash/app-shell cream (`hsl(38 35% 93%)` / #F4EFE5) so
    // the window paints the brand colour instantly instead of flashing white.
    backgroundColor: '#F4EFE5',
    skipTaskbar: process.platform === 'darwin' ? false : !settings.showAppInDock,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false
    },
    show: !launchedHidden
  });
  registerWindowSecurityHandlers(mainWindow);
  attachWindowStatePersistence(mainWindow, restoreMaximized);
  const stopUpdateStatusBroadcast = broadcastUpdateStatusTo(mainWindow);
  mainWindow.once('closed', stopUpdateStatusBroadcast);

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }

  mainWindow.once('ready-to-show', () => {
    allowOverlayDisplay();
    startDeferredStartupTasks();
  });

  // Sync on focus — gives users near-instant cross-device updates
  // without the cost of a real-time websocket connection. The 30-second
  // background timer in the sync engine still runs as a fallback.
  mainWindow.on('focus', () => {
    syncOnFocus();
  });

  mainWindow.on('close', (event) => {
    if (isQuitting) return;

    // Hide to tray instead of closing during normal window closes.
    event.preventDefault();

    // On the first close, show a one-time OS notification so the user knows
    // Echo is still running in the tray rather than fully quit.
    if (!hasShownHideToTrayNotice) {
      hasShownHideToTrayNotice = true;
      try {
        if (Notification.isSupported()) {
          new Notification({
            title: 'Echo is still running',
            body: 'Echo stays active in the system tray. Right-click the tray icon to quit.',
            silent: true,
          }).show();
        }
      } catch {
        // Notifications are best-effort and must never block hiding the window.
      }
    }

    mainWindow?.hide();
  });

  mainWindow.on('minimize', () => {
    setTimeout(() => {
      ensureOverlayVisible();
    }, 50);
  });
};

function showExistingWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.show();
  mainWindow.focus();
}

// Install global error handlers as early as possible — before any other
// module gets a chance to throw asynchronously. Calling at module load
// (rather than inside `ready`) means we even capture failures during the
// `app.on('ready')` work itself.
installGlobalErrorHandlers();

app.on('ready', async () => {
  await Promise.all([
    fs.promises.mkdir(app.getPath('userData'), { recursive: true }),
    fs.promises.mkdir(app.getPath('sessionData'), { recursive: true }),
  ]);
  initStore();

  // Cloud auth + sync (v1.1.0). initAuth attempts to restore the
  // previous Supabase session from disk; initSync subscribes to auth
  // state and starts/stops the push/pull engine accordingly. Both are
  // safe no-ops when VITE_SUPABASE_URL is unset (lets dev builds run
  // without a backend configured).
  await initAuth();
  initSync();
  // Entitlements rides on top of auth: it subscribes to auth state and
  // refreshes the cached plan whenever the session changes.
  initEntitlements();

  // Push the renderer back into a "logged-out, sync paused" state if
  // Supabase ever revokes the session (e.g. user deletes their account
  // from another device).
  onAuthStateChange((session) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('auth-state', session ? serialiseSession() : null);
    }
  });

  // Crash reporting. We always start the reporter so Chromium-level
  // crashes (renderer GPU, native addons, segfaults) drop a minidump in
  // `%APPDATA%/Echo/Crashpad/`. If a submit URL is configured we also
  // upload; otherwise the dumps stay local for postmortem inspection.
  try {
    const crashSubmitUrl = process.env.ECHO_CRASH_SUBMIT_URL;
    const uploadToServer = !!(crashSubmitUrl && /^https?:\/\//i.test(crashSubmitUrl));
    crashReporter.start({
      productName: 'Echo',
      companyName: 'Echo',
      // The Electron type insists on a string here even when uploads are
      // disabled. An empty string is the documented sentinel.
      submitURL: uploadToServer ? crashSubmitUrl! : '',
      uploadToServer,
    });
  } catch (error) {
    logWarn('crash-reporter', 'Crash reporter failed to start', error);
  }

  // Lock down renderer permissions: only media (microphone) is ever needed.
  // Everything else (geolocation, notifications, midi, usb, etc.) is denied.
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media');
  });
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    return permission === 'media';
  });

  setupContentSecurityPolicy();

  registerAllIpcs();
  createWindow();
  // Overlay creation is deferred to `startDeferredStartupTasks` so we don't
  // spin up a second BrowserWindow on the same tick as the main window.
  // Stacking two Electron window inits blocks the main process for ~300 ms
  // before the main window can even begin painting.

  // Auto-update (production builds only). All the feed-URL plumbing,
  // event wiring, and state-machine bookkeeping lives in `./updater`.
  // Window-specific status forwarding is attached in `createWindow()` so
  // recreated windows also receive the current updater state.
  initAutoUpdater();

  // Defer non-critical I/O to keep startup responsive. The SendInput helper
  // and dictation modules are prewarmed eagerly inside
  // `startDeferredStartupTasks`, which fires from the window's
  // `ready-to-show` — we don't redundantly schedule them here.
  setTimeout(() => {
    void cleanupLegacyChromiumCaches();
  }, 1000);

  // In local development, restart if the built main/preload bundles change.
  if (!app.isPackaged) {
    setupMainProcessHotReload();
  }
});

/** Dispatch a deep link to the right handler. */
function handleDeepLink(url: string): void {
  if (!url.startsWith(`${PROTOCOL}://`)) return;
  // Anything under echo://billing/* (success, cancel, return) is the
  // user coming back from a Stripe Checkout or Customer Portal session.
  // Trigger a few quick entitlements refreshes so the UI picks up the
  // new plan as soon as the webhook lands, and notify the renderer.
  if (/^echo:\/\/billing\b/i.test(url)) {
    refreshAfterBillingReturn();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('billing-deep-link', url);
    }
    return;
  }
  if (isExpectedOAuthCallbackUrl(url)) {
    void completeOAuthCallback(url);
    return;
  }
  logWarn('protocol', `ignored unsupported deep link: ${url}`);
}

app.on('second-instance', (_event, argv) => {
  showExistingWindow();
  // Windows deep links arrive in argv when the OS hands the URL off to
  // the already-running Echo instance.
  for (const arg of argv) {
    if (typeof arg === 'string' && arg.startsWith(`${PROTOCOL}://`)) {
      handleDeepLink(arg);
    }
  }
});

// macOS-style deep-link delivery (also fires on Windows for some OAuth
// providers that round-trip through a system browser handler).
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

// On startup, the original argv may contain an OAuth callback if the
// user kicked off the flow from a browser tab that launched Echo as the
// `echo://` handler. Drain those before the renderer mounts so the
// session is already restored when the app paints.
const initialDeepLink = process.argv.find((a) => typeof a === 'string' && a.startsWith(`${PROTOCOL}://`));
if (initialDeepLink) {
  app.whenReady().then(() => handleDeepLink(initialDeepLink));
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  // Order matters: kill the long-lived PowerShell helpers FIRST so they
  // don't survive as orphan processes if any later step throws.
  try {
    unregisterAllHotkeys();
  } catch {
    // Swallow — we're quitting anyway.
  }
  shutdownInjectHelper();
  void import('./localTranscribe').then(({ shutdownLocalServer }) => shutdownLocalServer()).catch(() => {});
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
