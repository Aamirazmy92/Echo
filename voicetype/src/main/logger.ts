import { app } from 'electron';
import fs from 'fs';
import path from 'path';

/*
 * Lightweight structured logger for the main process.
 *
 * Why this exists: in packaged Windows installs, anything written to
 * `console.*` goes nowhere a user can find. Echo previously had a
 * one-off `appendDictationLog` helper in `index.ts` for the
 * transcription error path; this module generalises that so every
 * subsystem (hotkey watcher, overlay, auto-updater, store) writes to
 * the same rolling file.
 *
 * The log lives at `%APPDATA%/Echo/dictation.log` (kept the same
 * filename so existing user docs and bug-report instructions still
 * work). It rotates to `dictation.log.1` once it crosses 1 MB so we
 * can never balloon a user's disk. In development we also mirror to
 * the console so devs see output in the terminal.
 */

// Swallow EPIPE errors on the std streams: after a dev self-relaunch the
// inherited pipes are dead, and an unhandled 'error' event would crash the
// main process before the uncaught-exception logger can even run.
process.stdout?.on('error', () => { /* no-op */ });
process.stderr?.on('error', () => { /* no-op */ });

const LOG_FILE_NAME = 'dictation.log';
const LOG_MAX_BYTES = 1_000_000; // 1 MB before rotation
const ROTATED_SUFFIX = '.1';

type Level = 'info' | 'warn' | 'error';

const NETWORK_ERROR_MESSAGE = 'Network request failed';

function errorDetails(error: unknown): string {
  if (!(error instanceof Error)) {
    if (error && typeof error === 'object') {
      const detail = error as Record<string, unknown>;
      const parts = [
        typeof detail.code === 'string' ? `code=${detail.code}` : null,
        typeof detail.message === 'string' ? detail.message : null,
        typeof detail.details === 'string' ? `details=${detail.details}` : null,
        typeof detail.hint === 'string' ? `hint=${detail.hint}` : null,
      ].filter(Boolean);
      if (parts.length > 0) return parts.join(' | ');

      try {
        return JSON.stringify(detail);
      } catch {
        return Object.prototype.toString.call(error);
      }
    }

    return String(error);
  }

  const cause = (error as Error & { cause?: unknown }).cause as { code?: string; message?: string } | undefined;
  const combined = `${error.name} ${error.message} ${cause?.code ?? ''} ${cause?.message ?? ''}`;
  if (/fetch failed|network|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|socket disconnected|TLS connection/i.test(combined)) {
    return `${error.name}: ${NETWORK_ERROR_MESSAGE}${cause?.code ? ` (${cause.code})` : ''}`;
  }

  return error.stack ?? `${error.name}: ${error.message}`;
}

function getLogPath(): string {
  return path.join(app.getPath('userData'), LOG_FILE_NAME);
}

function formatLine(level: Level, scope: string, message: string, error?: unknown): string {
  const timestamp = new Date().toISOString();
  const errPart = error
    ? ` :: ${errorDetails(error)}`
    : '';
  return `[${timestamp}] [${level}] [${scope}] ${message}${errPart}\n`;
}

let rotateCheckPromise: Promise<void> | null = null;
async function rotateIfNeeded(filePath: string): Promise<void> {
  if (rotateCheckPromise) return rotateCheckPromise;
  rotateCheckPromise = (async () => {
    try {
      const stats = await fs.promises.stat(filePath);
      if (stats.size > LOG_MAX_BYTES) {
        const rotatedPath = `${filePath}${ROTATED_SUFFIX}`;
        await fs.promises.rm(rotatedPath, { force: true });
        await fs.promises.rename(filePath, rotatedPath);
      }
    } catch {
      // The log file simply doesn't exist yet — fine, it'll be created.
    }
  })().finally(() => {
    rotateCheckPromise = null;
  });
  return rotateCheckPromise;
}

async function appendToFile(line: string): Promise<void> {
  try {
    const filePath = getLogPath();
    await rotateIfNeeded(filePath);
    await fs.promises.appendFile(filePath, line);
  } catch {
    // Logging must never block or crash the main flow. If we can't write
    // to disk, give up silently — the user has bigger problems than a
    // missing log line.
  }
}

function emit(level: Level, scope: string, message: string, error?: unknown): void {
  const line = formatLine(level, scope, message, error);

  // Mirror to console only in dev. In packaged builds, console.* goes to
  // a hidden detached process and just adds noise.
  if (!app.isPackaged) {
    const consoleFn = level === 'error'
      ? console.error
      : level === 'warn' ? console.warn : console.log;
    try {
      consoleFn(line.trimEnd());
    } catch {
      // After a dev self-relaunch the inherited stdout/stderr pipe is dead
      // and console writes throw EPIPE. The file log below is the source
      // of truth; never let the mirror crash the process.
    }
  }

  void appendToFile(line);
}

export function logInfo(scope: string, message: string): void {
  emit('info', scope, message);
}

export function logWarn(scope: string, message: string, error?: unknown): void {
  emit('warn', scope, message, error);
}

export function logError(scope: string, message: string, error?: unknown): void {
  emit('error', scope, message, error);
}

/**
 * Install global handlers for `unhandledRejection` and `uncaughtException`
 * so a rogue throw anywhere in the main process is recorded instead of
 * crashing silently. Call once near process startup.
 */
export function installGlobalErrorHandlers(): void {
  process.on('unhandledRejection', (reason) => {
    logError('unhandled-rejection', 'A promise was rejected without a handler', reason);
  });
  process.on('uncaughtException', (error) => {
    logError('uncaught-exception', 'An uncaught exception escaped the event loop', error);
  });
}
