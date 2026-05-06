import { app, BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';
import { logError, logInfo, logWarn } from './logger';

/*
 * Auto-update module.
 *
 * Goal: ship a release on GitHub → users automatically receive it from
 * inside the app. No more "click the GitHub link to download".
 *
 * Engine: `electron-updater` (already a runtime dep). It pairs with
 * the GitHub publisher we configure in `forge.config.ts`, reads the
 * `latest.yml` that the publisher uploads alongside the installer,
 * and on Windows uses a Squirrel-compatible install flow.
 *
 * State machine surfaced to the renderer:
 *   - 'unsupported': dev build / Linux / no signed installer. Banner stays hidden.
 *   - 'idle':        we've checked (or will), but no update is pending.
 *   - 'checking':    a check is in flight (rarely visible — usually <1s).
 *   - 'available':   a newer version exists, user must click "Download" to start.
 *   - 'downloading': bytes are flowing; we report `progress` 0..100.
 *   - 'ready':       download complete, ready to install on quit/restart.
 *   - 'error':       transient failure; we'll retry on the next interval.
 *
 * The renderer shows a small notch in the sidebar driven by this
 * state. Errors stay silent in the UI (logged for debugging) — we
 * don't want auto-update flakiness to bother end-users.
 */

export type UpdateState =
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'error';

export interface UpdateStatusPayload {
  state: UpdateState;
  /** Version of the pending update (set in 'available' / 'downloading' / 'ready'). */
  version: string | null;
  /** 0..100, only meaningful in 'downloading'. */
  progress: number | null;
  /** Last error message (only set in 'error'). */
  error: string | null;
  /** ISO timestamp of the last successful check. */
  lastCheckedAt: string | null;
}

const REPO_OWNER = 'Aamirazmy92';
const REPO_NAME = 'Echo';
// Re-check the GitHub feed every hour. The first check fires on init
// so users running an older app for days still pick up new releases.
const PERIODIC_CHECK_MS = 60 * 60 * 1000;

let currentStatus: UpdateStatusPayload = {
  state: 'unsupported',
  version: null,
  progress: null,
  error: null,
  lastCheckedAt: null,
};

let initialised = false;

const listeners = new Set<(status: UpdateStatusPayload) => void>();

function setStatus(patch: Partial<UpdateStatusPayload>): void {
  currentStatus = { ...currentStatus, ...patch };
  for (const listener of listeners) {
    try {
      listener(currentStatus);
    } catch (err) {
      logWarn('updater', 'listener threw');
      void err;
    }
  }
}

/**
 * Subscribe to status changes. The current status is replayed
 * synchronously so late subscribers never miss a state.
 */
export function onUpdateStatus(callback: (status: UpdateStatusPayload) => void): () => void {
  listeners.add(callback);
  try {
    callback(currentStatus);
  } catch {
    /* ignore */
  }
  return () => listeners.delete(callback);
}

export function getUpdateStatus(): UpdateStatusPayload {
  return currentStatus;
}

/**
 * Initialise auto-updates. Idempotent — safe to call once at app
 * startup. In dev / unpackaged builds we mark state 'unsupported' and
 * return without touching `autoUpdater` (which would otherwise throw
 * because there's no `app-update.yml` baked into the app dir).
 */
export function initAutoUpdater(): void {
  if (initialised) return;
  initialised = true;

  if (!app.isPackaged) {
    logInfo('updater', 'skipping auto-update (dev / unpackaged build)');
    setStatus({ state: 'unsupported' });
    return;
  }

  // Point electron-updater at our GitHub releases. PublisherGithub in
  // forge.config.ts uploads the installer + `latest.yml` to each
  // release; that's exactly what electron-updater consumes.
  try {
    autoUpdater.setFeedURL({
      provider: 'github',
      owner: REPO_OWNER,
      repo: REPO_NAME,
    });
  } catch (err) {
    logError('updater', 'failed to configure update feed', err);
    setStatus({ state: 'unsupported' });
    return;
  }

  // We trigger downloads explicitly from the renderer ("click Download"),
  // not the moment a check finds something. Setting `autoDownload = false`
  // means the `update-available` event fires but no bytes flow until
  // we call `downloadUpdate()`.
  autoUpdater.autoDownload = false;
  // If the user closes the app *with a downloaded update staged*, apply
  // it on the next launch. Belt-and-braces: the in-app "Restart now"
  // button is the primary path.
  autoUpdater.autoInstallOnAppQuit = true;

  // Pipe electron-updater's chatty logs into our existing logger so
  // a single `dictation.log` covers everything when debugging.
  autoUpdater.logger = {
    debug: (msg: string) => logInfo('updater', msg),
    info:  (msg: string) => logInfo('updater', msg),
    warn:  (msg: string) => logWarn('updater', msg),
    error: (msg: string) => logError('updater', msg),
  } as unknown as typeof autoUpdater.logger;

  autoUpdater.on('checking-for-update', () => {
    // Don't blow away an already-known 'available' / 'ready' state if
    // the periodic re-check kicks in while a download is queued.
    if (currentStatus.state === 'idle' || currentStatus.state === 'error') {
      setStatus({ state: 'checking', error: null });
    }
  });

  autoUpdater.on('update-available', (info: { version?: string } | undefined) => {
    setStatus({
      state: 'available',
      version: info?.version ?? null,
      progress: 0,
      error: null,
      lastCheckedAt: new Date().toISOString(),
    });
  });

  autoUpdater.on('update-not-available', () => {
    setStatus({
      state: 'idle',
      version: null,
      progress: null,
      error: null,
      lastCheckedAt: new Date().toISOString(),
    });
  });

  autoUpdater.on('download-progress', (info: { percent?: number }) => {
    const percent = typeof info?.percent === 'number'
      ? Math.max(0, Math.min(100, Math.round(info.percent)))
      : null;
    setStatus({ state: 'downloading', progress: percent });
  });

  autoUpdater.on('update-downloaded', (info: { version?: string } | undefined) => {
    logInfo('updater', `update downloaded: ${info?.version ?? 'unknown version'}`);
    setStatus({
      state: 'ready',
      version: info?.version ?? currentStatus.version,
      progress: 100,
      error: null,
    });
  });

  autoUpdater.on('error', (err: Error) => {
    logWarn('updater', `autoUpdater error: ${err?.message ?? err}`);
    setStatus({ state: 'error', error: err?.message ?? String(err) });
  });

  setStatus({ state: 'idle' });

  // Kick an initial check, then poll on an interval. Both are wrapped
  // so a transient network blip just logs without crashing startup.
  void runCheck('initial');
  setInterval(() => {
    // Skip periodic checks once a download is already queued — no
    // point re-asking the feed when we know there's something newer.
    if (currentStatus.state === 'available' ||
        currentStatus.state === 'downloading' ||
        currentStatus.state === 'ready') {
      return;
    }
    void runCheck('periodic');
  }, PERIODIC_CHECK_MS);
}

async function runCheck(label: string): Promise<void> {
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    logWarn('updater', `${label} check failed`, err);
  }
}

/**
 * Force an update check on demand. No-op outside packaged builds.
 */
export function checkForUpdatesNow(): void {
  if (!app.isPackaged) return;
  void runCheck('manual');
}

/**
 * Start downloading the available update. Caller should verify
 * `state === 'available'` first; calling otherwise is a soft no-op.
 */
export function downloadUpdateNow(): void {
  if (!app.isPackaged) return;
  if (currentStatus.state !== 'available') {
    logWarn('updater', `downloadUpdateNow called in state '${currentStatus.state}', ignoring`);
    return;
  }
  // Switch state preemptively so the UI shows the spinner the moment
  // the user clicks — `download-progress` may take a second to fire.
  setStatus({ state: 'downloading', progress: 0 });
  autoUpdater.downloadUpdate().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    logError('updater', 'downloadUpdate failed', err);
    setStatus({ state: 'error', error: message });
  });
}

/**
 * Quit the app and install the downloaded update. Caller must verify
 * `state === 'ready'` first.
 */
export function installAndRestart(): void {
  if (currentStatus.state !== 'ready') {
    logWarn('updater', `installAndRestart called in state '${currentStatus.state}', ignoring`);
    return;
  }
  logInfo('updater', 'quitAndInstall — restarting into new version');
  // (isSilent = false, isForceRunAfter = true) so the new version
  // launches automatically after the install finishes — the user
  // explicitly chose to restart, so dropping them at the desktop
  // would be surprising.
  autoUpdater.quitAndInstall(false, true);
}

/**
 * Helper used by `index.ts` to forward status changes to a window
 * over the `update-status` channel.
 */
export function broadcastUpdateStatusTo(window: BrowserWindow): () => void {
  return onUpdateStatus((status) => {
    if (window.isDestroyed()) return;
    window.webContents.send('update-status', status);
  });
}
