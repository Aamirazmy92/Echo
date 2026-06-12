import Database from 'better-sqlite3';
import { app } from 'electron';
import path from 'path';
import crypto from 'crypto';
import { DictionaryItem, DictionaryItemInput, DictationEntry, Note, NoteInput, Snippet, SnippetInput } from '../shared/types';
import { escapeCsvField } from './csv';

let db: Database.Database;

let snippetsCache: Snippet[] | null = null;
let dictionaryCache: DictionaryItem[] | null = null;
let notesCache: Note[] | null = null;

// Tables that participate in cloud sync. Each gets cloud_id (UUID),
// updated_at, and deleted_at columns added by the migration block in
// initHistory(). The sync engine reads/writes to these via getDb().
const SYNCABLE_TABLES = ['dictations', 'snippets', 'dictionary_items', 'notes'] as const;

type DictationRow = {
  id: number;
  text: string;
  raw_text: string;
  word_count: number;
  duration_ms: number;
  app_name: string | null;
  mode: DictationEntry['mode'];
  method?: DictationEntry['method'] | null;
  created_at: string;
  cloud_id?: string | null;
};

type StatsRow = {
  c?: number | null;
  w?: number | null;
  a?: number | null;
};

type SnippetRow = {
  id: number;
  trigger: string;
  expansion: string;
  category: string | null;
  shared: number;
  created_at: string;
  cloud_id: string;
  use_count: number | null;
  last_used_at: string | null;
};

type DictionaryRow = {
  id: number;
  phrase: string;
  misspelling: string | null;
  correct_misspelling: number;
  shared: number;
  created_at: string;
  cloud_id: string;
};

type NoteRow = {
  id: number;
  title: string;
  body: string;
  created_at: string;
  updated_at: string;
  pinned: number;
  cloud_id: string;
  lock_code_hash: string | null;
  lock_code_salt: string | null;
};

export function getDb(): Database.Database {
  if (!db) throw new Error('history db not initialised');
  return db;
}

/** True once `initHistory()` has opened the SQLite file. Used by the
 *  sync engine to skip cleanup work that depends on a live DB handle
 *  (e.g. clearing `sync_meta` on the very first auth event, which
 *  fires before the renderer has triggered any history operation). */
export function isHistoryReady(): boolean {
  return !!db;
}

/**
 * Wipe every locally-cached, synced row + the queued push events +
 * the pull watermarks. Called on sign-out so that signing into a
 * different account on the same machine starts from a clean slate
 * instead of inheriting the previous user's data.
 *
 * Notes:
 *   - Settings (`store.ts`), API keys, and window state are NOT
 *     touched — those are device-local even when signed in.
 *   - We DELETE rather than tombstone: the cloud is the source of
 *     truth, so anything we'd "tombstone" was already either pushed
 *     or in the queue we're also wiping.
 */
export function clearLocalSyncedData(): void {
  if (!db) return;
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM dictations').run();
    db.prepare('DELETE FROM snippets').run();
    db.prepare('DELETE FROM dictionary_items').run();
    db.prepare('DELETE FROM notes').run();
    db.prepare('DELETE FROM sync_queue').run();
    db.prepare('DELETE FROM sync_meta').run();
  });
  tx();
  snippetsCache = null;
  dictionaryCache = null;
  notesCache = null;
}

/** Invalidate the in-memory cache for a table after the sync engine writes
 *  rows directly via getDb(), bypassing the mutating helpers in this module.
 *  Without this, pulled changes stay invisible until the app restarts. */
export function invalidateCachesForTable(
  table: 'dictations' | 'snippets' | 'dictionary_items' | 'notes' | 'custom_styles',
): void {
  if (table === 'snippets') snippetsCache = null;
  else if (table === 'dictionary_items') dictionaryCache = null;
  else if (table === 'notes') notesCache = null;
}

export function initHistory() {
  const dbPath = path.join(app.getPath('userData'), 'echo.db');
  db = new Database(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS dictations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      raw_text TEXT NOT NULL,
      word_count INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      app_name TEXT,
      mode TEXT NOT NULL,
      method TEXT NOT NULL DEFAULT 'local',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS snippets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trigger TEXT NOT NULL UNIQUE,
      expansion TEXT NOT NULL,
      shared INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS dictionary_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phrase TEXT NOT NULL UNIQUE,
      misspelling TEXT,
      correct_misspelling INTEGER NOT NULL DEFAULT 0,
      shared INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT '',
      lock_code_hash TEXT,
      lock_code_salt TEXT
    );

    -- Sync state for outgoing changes. Every local mutation enqueues a
    -- row here; the sync engine drains the queue against Supabase. The
    -- queue itself never leaves the device.
    CREATE TABLE IF NOT EXISTS sync_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name TEXT NOT NULL,
      cloud_id TEXT NOT NULL,
      op TEXT NOT NULL,                  -- 'upsert' | 'delete'
      payload TEXT,                      -- JSON of the row payload
      enqueued_at TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sync_queue_id ON sync_queue(id);
    -- Speeds up the dedup lookup in enqueueSync (which deletes any
    -- pending entries for the same (table, cloud_id) before inserting
    -- the latest op). Without this index the dedup is a linear scan
    -- of the whole queue on every local edit.
    CREATE INDEX IF NOT EXISTS idx_sync_queue_table_cloud ON sync_queue(table_name, cloud_id);

    -- Per-table sync watermark. We pull rows where remote.updated_at >
    -- last_pulled_at and merge them into local. Stored as ISO timestamps.
    CREATE TABLE IF NOT EXISTS sync_meta (
      table_name TEXT PRIMARY KEY,
      last_pulled_at TEXT
    );
  `);

  // Migrate: add method column if missing (existing databases)
  const columns = db.pragma('table_info(dictations)') as { name: string }[];
  if (!columns.some(c => c.name === 'method')) {
    db.exec(`ALTER TABLE dictations ADD COLUMN method TEXT NOT NULL DEFAULT 'local'`);
  }

  const snippetColumns = db.pragma('table_info(snippets)') as { name: string }[];
  if (!snippetColumns.some(c => c.name === 'shared')) {
    db.exec(`ALTER TABLE snippets ADD COLUMN shared INTEGER NOT NULL DEFAULT 0`);
  }
  if (!snippetColumns.some(c => c.name === 'created_at')) {
    db.exec(`ALTER TABLE snippets ADD COLUMN created_at TEXT NOT NULL DEFAULT ''`);
    db.exec(`UPDATE snippets SET created_at = CURRENT_TIMESTAMP WHERE created_at = ''`);
  }
  if (!snippetColumns.some(c => c.name === 'category')) {
    db.exec(`ALTER TABLE snippets ADD COLUMN category TEXT NOT NULL DEFAULT ''`);
  }
  // Local-only usage telemetry. These columns deliberately stay out of the
  // cloud sync payload — counts are per-device.
  if (!snippetColumns.some(c => c.name === 'use_count')) {
    db.exec(`ALTER TABLE snippets ADD COLUMN use_count INTEGER NOT NULL DEFAULT 0`);
  }
  if (!snippetColumns.some(c => c.name === 'last_used_at')) {
    db.exec(`ALTER TABLE snippets ADD COLUMN last_used_at TEXT`);
  }

  const dictionaryColumns = db.pragma('table_info(dictionary_items)') as { name: string }[];
  if (!dictionaryColumns.some(c => c.name === 'misspelling')) {
    db.exec(`ALTER TABLE dictionary_items ADD COLUMN misspelling TEXT`);
  }
  if (!dictionaryColumns.some(c => c.name === 'created_at')) {
    db.exec(`ALTER TABLE dictionary_items ADD COLUMN created_at TEXT NOT NULL DEFAULT ''`);
    db.exec(`UPDATE dictionary_items SET created_at = CURRENT_TIMESTAMP WHERE created_at = ''`);
  }

  const noteColumns = db.pragma('table_info(notes)') as { name: string }[];
  if (!noteColumns.some(c => c.name === 'pinned')) {
    db.exec(`ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`);
  }
  if (!noteColumns.some(c => c.name === 'lock_code_hash')) {
    db.exec(`ALTER TABLE notes ADD COLUMN lock_code_hash TEXT`);
  }
  if (!noteColumns.some(c => c.name === 'lock_code_salt')) {
    db.exec(`ALTER TABLE notes ADD COLUMN lock_code_salt TEXT`);
  }

  // Create indexes for frequently queried columns
  db.exec(`CREATE INDEX IF NOT EXISTS idx_dictations_created_at ON dictations(created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_dictations_app_name ON dictations(app_name)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_snippets_category ON snippets(category)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_dictionary_items_phrase ON dictionary_items(phrase)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_notes_created_at ON notes(created_at)`);

  // ── v1.1.0 cloud sync migration ────────────────────────────────────
  // Add cloud_id (UUID), updated_at, deleted_at to every syncable table.
  // For existing rows, backfill cloud_id with a fresh UUID and
  // updated_at with the current timestamp. This is idempotent — the
  // pragma checks make it safe to run on every launch.
  for (const table of SYNCABLE_TABLES) {
    const cols = db.pragma(`table_info(${table})`) as { name: string }[];
    const colNames = new Set(cols.map((c) => c.name));
    if (!colNames.has('cloud_id')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN cloud_id TEXT`);
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_${table}_cloud_id ON ${table}(cloud_id)`);
    }
    if (!colNames.has('updated_at')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN updated_at TEXT`);
    }
    if (!colNames.has('deleted_at')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN deleted_at TEXT`);
    }
    // Backfill cloud_id for rows that pre-date the migration. We call
    // crypto.randomUUID() per row in a transaction so this stays fast
    // even on large history tables.
    const backfillStmt = db.prepare(`UPDATE ${table} SET cloud_id = ? WHERE cloud_id IS NULL AND id = ?`);
    const missingIds = db.prepare(`SELECT id FROM ${table} WHERE cloud_id IS NULL`).all() as { id: number }[];
    if (missingIds.length > 0) {
      const tx = db.transaction((rows: { id: number }[]) => {
        for (const row of rows) {
          backfillStmt.run(crypto.randomUUID(), row.id);
        }
      });
      tx(missingIds);
    }
    // Backfill updated_at with created_at (or now) for rows missing it.
    db.exec(`UPDATE ${table} SET updated_at = COALESCE(updated_at, created_at, datetime('now'))`);
  }
}

// ───────────────────────── sync queue helpers ──────────────────────────
// Every local mutation calls enqueueSync('upsert' | 'delete', ...) so the
// sync engine can later push the change to Supabase. The actual network
// call lives in src/main/sync/index.ts; this file just records intent.

type SyncOp = 'upsert' | 'delete';

export function enqueueSync(table: string, cloudId: string, op: SyncOp, payload: Record<string, unknown> | null): void {
  if (!db) return;
  try {
    // Coalesce queue entries for the same row so rapid local edits
    // (typical in the snippets editor or dictionary forms) don't stack
    // 30+ identical upserts that all need to drain to Supabase later.
    //
    // Rules:
    //   - A new 'upsert' supersedes any pending 'upsert' for the same
    //     row — we only need to push the latest payload, last write
    //     wins.
    //   - A new 'delete' supersedes any pending 'upsert' AND any
    //     pending 'delete' for the same row — once we know the row is
    //     gone, replaying earlier upserts would resurrect it.
    //   - We deliberately do NOT collapse an 'upsert' that comes after
    //     a pending 'delete'. That would only happen if the same
    //     cloud_id was reused for a different row (we don't do that),
    //     so leaving both rows lets the sync engine fail loudly if it
    //     ever does.
    const tx = db.transaction(() => {
      if (op === 'upsert') {
        db!.prepare(
          `DELETE FROM sync_queue WHERE table_name = ? AND cloud_id = ? AND op = 'upsert'`
        ).run(table, cloudId);
      } else {
        db!.prepare(
          `DELETE FROM sync_queue WHERE table_name = ? AND cloud_id = ?`
        ).run(table, cloudId);
      }

      db!.prepare(
        `INSERT INTO sync_queue (table_name, cloud_id, op, payload, enqueued_at) VALUES (?, ?, ?, ?, ?)`
      ).run(table, cloudId, op, payload ? JSON.stringify(payload) : null, new Date().toISOString());
    });
    tx();
  } catch (err) {
    // Sync failures must never break local writes — log and move on.
    console.warn('[history] enqueueSync failed:', (err as Error).message);
  }
}

export function addEntry(entry: Omit<DictationEntry, 'id'>): DictationEntry {
  const cloudId = crypto.randomUUID();
  const updatedAt = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO dictations (text, raw_text, word_count, duration_ms, app_name, mode, method, created_at, cloud_id, updated_at)
    VALUES (@text, @rawText, @wordCount, @durationMs, @appName, @mode, @method, @createdAt, @cloudId, @updatedAt)
  `);
  const info = stmt.run({ ...entry, cloudId, updatedAt });
  enqueueSync('history', cloudId, 'upsert', {
    id: cloudId,
    text: entry.text,
    raw_text: entry.rawText,
    word_count: entry.wordCount,
    duration_ms: entry.durationMs,
    app_name: entry.appName,
    mode: entry.mode,
    method: entry.method,
    client_created_at: entry.createdAt,
  });
  return { ...entry, id: info.lastInsertRowid as number };
}

export function getEntries(limit: number, offset: number): DictationEntry[] {
  const stmt = db.prepare('SELECT * FROM dictations WHERE deleted_at IS NULL ORDER BY id DESC LIMIT ? OFFSET ?');
  const rows = stmt.all(limit, offset) as DictationRow[];
  return rows.map(r => ({
    id: r.id,
    text: r.text,
    rawText: r.raw_text,
    wordCount: r.word_count,
    durationMs: r.duration_ms,
    appName: r.app_name ?? 'Unknown',
    mode: r.mode,
    method: r.method ?? 'local',
    createdAt: r.created_at
  }));
}

export function getAllEntries(): DictationEntry[] {
  const stmt = db.prepare('SELECT * FROM dictations WHERE deleted_at IS NULL ORDER BY id DESC');
  const rows = stmt.all() as DictationRow[];
  return rows.map(r => ({
    id: r.id,
    text: r.text,
    rawText: r.raw_text,
    wordCount: r.word_count,
    durationMs: r.duration_ms,
    appName: r.app_name ?? 'Unknown',
    mode: r.mode,
    method: r.method ?? 'local',
    createdAt: r.created_at
  }));
}

export function exportToCsv(entries: DictationEntry[]): string {
  const headers = ['ID', 'Text', 'Word Count', 'Duration (ms)', 'App Name', 'Mode', 'Method', 'Created At'];
  const rows = entries.map(e => [
    e.id,
    escapeCsvField(e.text),
    e.wordCount,
    e.durationMs,
    escapeCsvField(e.appName),
    escapeCsvField(e.mode),
    escapeCsvField(e.method),
    escapeCsvField(e.createdAt),
  ]);
  return [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
}

export function exportToJson(entries: DictationEntry[]): string {
  return JSON.stringify(entries, null, 2);
}

export function updateEntry(id: number, text: string): DictationEntry | null {
  const wordCount = text.split(/\s+/).filter(w => w.length > 0).length;
  const updatedAt = new Date().toISOString();
  const info = db
    .prepare('UPDATE dictations SET text = ?, word_count = ?, updated_at = ? WHERE id = ?')
    .run(text, wordCount, updatedAt, id);
  if (info.changes === 0) return null;
  const row = db.prepare('SELECT * FROM dictations WHERE id = ?').get(id) as DictationRow;
  if (row.cloud_id) {
    enqueueSync('history', row.cloud_id, 'upsert', {
      id: row.cloud_id,
      text: row.text,
      raw_text: row.raw_text,
      word_count: row.word_count,
      duration_ms: row.duration_ms,
      app_name: row.app_name,
      mode: row.mode,
      method: row.method,
      client_created_at: row.created_at,
    });
  }
  return {
    id: row.id,
    text: row.text,
    rawText: row.raw_text,
    wordCount: row.word_count,
    durationMs: row.duration_ms,
    appName: row.app_name ?? 'Unknown',
    mode: row.mode,
    method: row.method ?? 'local',
    createdAt: row.created_at
  };
}

export function deleteEntry(id: number): void {
  // Soft-delete locally (keep the row so the sync engine can propagate
  // the tombstone to the cloud); the row is purged on next pull cycle.
  const row = db.prepare('SELECT cloud_id FROM dictations WHERE id = ?').get(id) as { cloud_id?: string } | undefined;
  const deletedAt = new Date().toISOString();
  db.prepare('UPDATE dictations SET deleted_at = ?, updated_at = ? WHERE id = ?').run(deletedAt, deletedAt, id);
  if (row?.cloud_id) enqueueSync('history', row.cloud_id, 'delete', null);
}

export function deleteEntries(ids: number[]): void {
  if (!ids.length) return;
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT cloud_id FROM dictations WHERE id IN (${placeholders})`)
    .all(...ids) as { cloud_id?: string }[];
  const deletedAt = new Date().toISOString();
  db.prepare(`UPDATE dictations SET deleted_at = ?, updated_at = ? WHERE id IN (${placeholders})`).run(deletedAt, deletedAt, ...ids);
  for (const r of rows) {
    if (r.cloud_id) enqueueSync('history', r.cloud_id, 'delete', null);
  }
}

export function clearAll(): void {
  // Clearing all history: tombstone each row so cloud copies are also
  // cleared on next push.
  const rows = db.prepare('SELECT cloud_id FROM dictations WHERE deleted_at IS NULL').all() as { cloud_id?: string }[];
  const deletedAt = new Date().toISOString();
  db.prepare('UPDATE dictations SET deleted_at = ?, updated_at = ? WHERE deleted_at IS NULL').run(deletedAt, deletedAt);
  for (const r of rows) {
    if (r.cloud_id) enqueueSync('history', r.cloud_id, 'delete', null);
  }
}

export function getStats(): { totalWords: number; totalSessions: number; todayWords: number; avgSessionMs: number } {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const startOfTomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
  const totalRow = db.prepare('SELECT COUNT(id) as c, SUM(word_count) as w, AVG(duration_ms) as a FROM dictations WHERE deleted_at IS NULL').get() as StatsRow;
  const todayRow = db.prepare('SELECT SUM(word_count) as w FROM dictations WHERE deleted_at IS NULL AND created_at >= ? AND created_at < ?').get(startOfToday, startOfTomorrow) as StatsRow;

  return {
    totalWords: totalRow?.w || 0,
    totalSessions: totalRow?.c || 0,
    todayWords: todayRow?.w || 0,
    avgSessionMs: totalRow?.a || 0
  };
}

function mapSnippetRow(row: SnippetRow): Snippet {
  return {
    id: row.id,
    trigger: row.trigger,
    expansion: row.expansion,
    category: row.category ?? '',
    shared: Boolean(row.shared),
    createdAt: row.created_at,
    useCount: row.use_count ?? 0,
    lastUsedAt: row.last_used_at ?? null,
  };
}

export function getSnippets(): Snippet[] {
  if (snippetsCache) return snippetsCache;

  const rows = db.prepare('SELECT * FROM snippets WHERE deleted_at IS NULL ORDER BY trigger COLLATE NOCASE ASC').all() as SnippetRow[];

  snippetsCache = rows.map(mapSnippetRow);
  return snippetsCache;
}

/** Increment local usage counters for snippets that expanded in a dictation.
 *  Deliberately does not enqueue a sync op — usage stats are per-device. */
export function recordSnippetUsage(ids: number[]): void {
  if (ids.length === 0) return;
  snippetsCache = null;
  const nowIso = new Date().toISOString();
  const stmt = db.prepare('UPDATE snippets SET use_count = use_count + 1, last_used_at = ? WHERE id = ?');
  const apply = db.transaction((snippetIds: number[]) => {
    for (const id of snippetIds) stmt.run(nowIso, id);
  });
  apply(ids);
}

function pushSnippetUpsert(row: { cloud_id: string; trigger: string; expansion: string; category: string; shared: number; created_at: string }) {
  enqueueSync('snippets', row.cloud_id, 'upsert', {
    id: row.cloud_id,
    trigger: row.trigger,
    expansion: row.expansion,
    category: row.category,
    shared: !!row.shared,
    client_created_at: row.created_at,
  });
}

export function saveSnippet(snippet: SnippetInput): Snippet {
  snippetsCache = null;
  const nowIso = new Date().toISOString();
  const trimmedTrigger = snippet.trigger.trim();
  const trimmedExpansion = snippet.expansion.trim();
  const trimmedCategory = snippet.category?.trim() ?? '';
  const sharedFlag = snippet.shared ? 1 : 0;

  // Update by id
  if (snippet.id !== undefined) {
    const existing = db.prepare('SELECT cloud_id, created_at FROM snippets WHERE id = ?').get(snippet.id) as
      | { cloud_id: string | null; created_at: string }
      | undefined;
    if (existing) {
      const cloudId = existing.cloud_id ?? crypto.randomUUID();
      db.prepare(`
        UPDATE snippets
        SET trigger = ?, expansion = ?, category = ?, shared = ?, cloud_id = ?, updated_at = ?
        WHERE id = ?
      `).run(trimmedTrigger, trimmedExpansion, trimmedCategory, sharedFlag, cloudId, nowIso, snippet.id);
      const saved = db.prepare('SELECT * FROM snippets WHERE id = ?').get(snippet.id) as SnippetRow;
      pushSnippetUpsert({
        cloud_id: cloudId,
        trigger: saved.trigger,
        expansion: saved.expansion,
        category: saved.category ?? '',
        shared: saved.shared,
        created_at: saved.created_at,
      });
      return mapSnippetRow(saved);
    }
  }

  // Update by trigger (no explicit id)
  const byTrigger = db.prepare('SELECT id, cloud_id, created_at FROM snippets WHERE trigger = ?').get(trimmedTrigger) as
    | { id: number; cloud_id: string | null; created_at: string }
    | undefined;
  if (byTrigger) {
    const cloudId = byTrigger.cloud_id ?? crypto.randomUUID();
    db.prepare(`
      UPDATE snippets
      SET expansion = ?, category = ?, shared = ?, cloud_id = ?, updated_at = ?
      WHERE id = ?
    `).run(trimmedExpansion, trimmedCategory, sharedFlag, cloudId, nowIso, byTrigger.id);
    const saved = db.prepare('SELECT * FROM snippets WHERE id = ?').get(byTrigger.id) as SnippetRow;
    pushSnippetUpsert({
      cloud_id: cloudId,
      trigger: saved.trigger,
      expansion: saved.expansion,
      category: saved.category ?? '',
      shared: saved.shared,
      created_at: saved.created_at,
    });
    return mapSnippetRow(saved);
  }

  // Insert
  const cloudId = crypto.randomUUID();
  const info = db.prepare(`
    INSERT INTO snippets (trigger, expansion, category, shared, created_at, cloud_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(trimmedTrigger, trimmedExpansion, trimmedCategory, sharedFlag, nowIso, cloudId, nowIso);
  pushSnippetUpsert({
    cloud_id: cloudId,
    trigger: trimmedTrigger,
    expansion: trimmedExpansion,
    category: trimmedCategory,
    shared: sharedFlag,
    created_at: nowIso,
  });
  return {
    id: info.lastInsertRowid as number,
    trigger: trimmedTrigger,
    expansion: trimmedExpansion,
    category: trimmedCategory,
    shared: Boolean(sharedFlag),
    createdAt: nowIso,
    useCount: 0,
    lastUsedAt: null,
  };
}

export function deleteSnippet(id: number): void {
  snippetsCache = null;
  // Read cloud_id BEFORE deleting so we can push a tombstone to Supabase.
  const row = db.prepare('SELECT cloud_id FROM snippets WHERE id = ?').get(id) as { cloud_id?: string } | undefined;
  db.prepare('DELETE FROM snippets WHERE id = ?').run(id);
  if (row?.cloud_id) enqueueSync('snippets', row.cloud_id, 'delete', null);
}

// ── Notes ─────────────────────────────────────────────────────────────

const NOTE_LOCK_HASH_ITERATIONS = 120_000;
const NOTE_LOCK_HASH_BYTES = 32;
const NOTE_LOCK_DIGEST = 'sha256';

function hashNoteLockCode(code: string, salt: string): string {
  return crypto
    .pbkdf2Sync(code, salt, NOTE_LOCK_HASH_ITERATIONS, NOTE_LOCK_HASH_BYTES, NOTE_LOCK_DIGEST)
    .toString('base64');
}

function verifyNoteLockCode(code: string, salt: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashNoteLockCode(code, salt), 'base64');
  const expected = Buffer.from(expectedHash, 'base64');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function noteRowToNote(row: NoteRow): Note {
  const locked = Boolean(row.lock_code_hash && row.lock_code_salt);
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
    pinned: Boolean(row.pinned),
    locked,
    lockUnlocked: false,
  };
}

function pushNoteUpsert(row: NoteRow): void {
  enqueueSync('notes', row.cloud_id, 'upsert', {
    id: row.cloud_id,
    title: row.title,
    body: row.body,
    pinned: Boolean(row.pinned),
    lock_code_hash: row.lock_code_hash ?? null,
    lock_code_salt: row.lock_code_salt ?? null,
    client_created_at: row.created_at,
    updated_at: row.updated_at || row.created_at,
  });
}

function getNoteRowById(id: number): NoteRow | undefined {
  return db.prepare(`
    SELECT id, title, body, created_at, updated_at, pinned, cloud_id, lock_code_hash, lock_code_salt
    FROM notes
    WHERE id = ? AND deleted_at IS NULL
  `).get(id) as NoteRow | undefined;
}

export function getNotes(): Note[] {
  if (notesCache) return notesCache;

  const rows = db.prepare(`
    SELECT id, title, body, created_at, updated_at, pinned, cloud_id, lock_code_hash, lock_code_salt
    FROM notes
    WHERE deleted_at IS NULL
    ORDER BY pinned DESC, updated_at DESC, created_at DESC
  `).all() as NoteRow[];

  notesCache = rows.map(noteRowToNote);
  return notesCache;
}

export function getNote(id: number): Note | null {
  const row = getNoteRowById(id);
  return row ? noteRowToNote(row) : null;
}

export function isNoteLocked(id: number): boolean {
  const row = db
    .prepare('SELECT lock_code_hash, lock_code_salt FROM notes WHERE id = ? AND deleted_at IS NULL')
    .get(id) as { lock_code_hash?: string | null; lock_code_salt?: string | null } | undefined;
  return Boolean(row?.lock_code_hash && row.lock_code_salt);
}

export function saveNote(note: NoteInput): Note {
  notesCache = null;
  const nowIso = new Date().toISOString();
  const trimmedTitle = note.title.trim();
  const trimmedBody = note.body.trim();

  if (note.id) {
    const existing = db.prepare('SELECT cloud_id, created_at FROM notes WHERE id = ?').get(note.id) as
      | { cloud_id?: string; created_at?: string }
      | undefined;
    const cloudId = existing?.cloud_id || crypto.randomUUID();
    const createdAt = existing?.created_at || nowIso;
    db.prepare(`
      UPDATE notes
      SET title = ?, body = ?, updated_at = ?, cloud_id = COALESCE(cloud_id, ?)
      WHERE id = ?
    `).run(trimmedTitle, trimmedBody, nowIso, cloudId, note.id);
    const row = getNoteRowById(note.id);
    if (!row) throw new Error('Note not found.');
    pushNoteUpsert({ ...row, cloud_id: cloudId, created_at: createdAt, updated_at: nowIso });
    return noteRowToNote({ ...row, cloud_id: cloudId, created_at: createdAt, updated_at: nowIso });
  }

  const cloudId = crypto.randomUUID();
  const info = db.prepare(`
    INSERT INTO notes (title, body, created_at, updated_at, cloud_id, pinned, lock_code_hash, lock_code_salt)
    VALUES (?, ?, ?, ?, ?, 0, NULL, NULL)
  `).run(trimmedTitle, trimmedBody, nowIso, nowIso, cloudId);
  const row: NoteRow = {
    id: info.lastInsertRowid as number,
    title: trimmedTitle,
    body: trimmedBody,
    created_at: nowIso,
    updated_at: nowIso,
    cloud_id: cloudId,
    pinned: 0,
    lock_code_hash: null,
    lock_code_salt: null,
  };
  pushNoteUpsert(row);
  return noteRowToNote(row);
}

export function toggleNotePin(id: number, pinned: boolean): Note {
  notesCache = null;
  const nowIso = new Date().toISOString();
  db.prepare(`UPDATE notes SET pinned = ?, updated_at = ? WHERE id = ?`).run(pinned ? 1 : 0, nowIso, id);
  const updated = getNoteRowById(id);
  if (!updated) throw new Error('Note not found.');
  pushNoteUpsert(updated);
  return noteRowToNote(updated);
}

export function setNoteLock(id: number, code: string): Note {
  notesCache = null;
  const nowIso = new Date().toISOString();
  const salt = crypto.randomBytes(16).toString('base64');
  const hash = hashNoteLockCode(code, salt);
  db.prepare(`
    UPDATE notes
    SET lock_code_hash = ?, lock_code_salt = ?, updated_at = ?
    WHERE id = ? AND deleted_at IS NULL
  `).run(hash, salt, nowIso, id);
  const updated = getNoteRowById(id);
  if (!updated) throw new Error('Note not found.');
  pushNoteUpsert(updated);
  return noteRowToNote(updated);
}

export function unlockNote(id: number, code: string): Note | null {
  const row = getNoteRowById(id);
  if (!row) throw new Error('Note not found.');
  if (!row.lock_code_hash || !row.lock_code_salt) return noteRowToNote(row);
  return verifyNoteLockCode(code, row.lock_code_salt, row.lock_code_hash) ? noteRowToNote(row) : null;
}

export function removeNoteLock(id: number): Note {
  notesCache = null;
  const nowIso = new Date().toISOString();
  db.prepare(`
    UPDATE notes
    SET lock_code_hash = NULL, lock_code_salt = NULL, updated_at = ?
    WHERE id = ? AND deleted_at IS NULL
  `).run(nowIso, id);
  const updated = getNoteRowById(id);
  if (!updated) throw new Error('Note not found.');
  pushNoteUpsert(updated);
  return noteRowToNote(updated);
}

export function deleteNote(id: number): void {
  notesCache = null;
  const row = db.prepare('SELECT cloud_id FROM notes WHERE id = ?').get(id) as { cloud_id?: string } | undefined;
  db.prepare('DELETE FROM notes WHERE id = ?').run(id);
  if (row?.cloud_id) enqueueSync('notes', row.cloud_id, 'delete', null);
}

export function getDictionaryItems(): DictionaryItem[] {
  if (dictionaryCache) return dictionaryCache;
  
  const rows = db.prepare(`
    SELECT id, phrase, misspelling, correct_misspelling, shared, created_at, cloud_id
    FROM dictionary_items
    WHERE deleted_at IS NULL
    ORDER BY phrase COLLATE NOCASE ASC
  `).all() as Array<{
    id: number;
    phrase: string;
    misspelling: string | null;
    correct_misspelling: number;
    shared: number;
    created_at: string;
  }>;

  dictionaryCache = rows.map((row) => ({
    id: row.id,
    phrase: row.phrase,
    misspelling: row.misspelling,
    correctMisspelling: Boolean(row.correct_misspelling),
    shared: Boolean(row.shared),
    createdAt: row.created_at,
  }));
  return dictionaryCache;
}

function pushDictionaryUpsert(row: { cloud_id: string; phrase: string; misspelling: string | null; correct_misspelling: number; shared: number; created_at: string }) {
  enqueueSync('dictionary', row.cloud_id, 'upsert', {
    id: row.cloud_id,
    phrase: row.phrase,
    misspelling: row.misspelling,
    correct_misspelling: !!row.correct_misspelling,
    shared: !!row.shared,
    client_created_at: row.created_at,
  });
}

export function saveDictionaryItem(item: DictionaryItemInput): DictionaryItem {
  dictionaryCache = null;
  const nowIso = new Date().toISOString();
  const trimmedPhrase = item.phrase.trim();
  const trimmedMisspelling = item.misspelling?.trim() ? item.misspelling.trim() : null;
  const correctMisspellingFlag = item.correctMisspelling ? 1 : 0;
  const sharedFlag = item.shared ? 1 : 0;

  if (item.id !== undefined) {
    const existing = db.prepare('SELECT cloud_id, created_at FROM dictionary_items WHERE id = ?').get(item.id) as
      | { cloud_id: string | null; created_at: string }
      | undefined;
    if (existing) {
      const cloudId = existing.cloud_id ?? crypto.randomUUID();
      db.prepare(`
        UPDATE dictionary_items
        SET phrase = ?, misspelling = ?, correct_misspelling = ?, shared = ?, cloud_id = ?, updated_at = ?
        WHERE id = ?
      `).run(trimmedPhrase, trimmedMisspelling, correctMisspellingFlag, sharedFlag, cloudId, nowIso, item.id);
      const saved = db.prepare('SELECT * FROM dictionary_items WHERE id = ?').get(item.id) as DictionaryRow;
      pushDictionaryUpsert({
        cloud_id: cloudId,
        phrase: saved.phrase,
        misspelling: saved.misspelling,
        correct_misspelling: saved.correct_misspelling,
        shared: saved.shared,
        created_at: saved.created_at,
      });
      return {
        id: saved.id,
        phrase: saved.phrase,
        misspelling: saved.misspelling,
        correctMisspelling: Boolean(saved.correct_misspelling),
        shared: Boolean(saved.shared),
        createdAt: saved.created_at,
      };
    }
  }

  const byPhrase = db.prepare('SELECT id, cloud_id, created_at FROM dictionary_items WHERE phrase = ?').get(trimmedPhrase) as
    | { id: number; cloud_id: string | null; created_at: string }
    | undefined;
  if (byPhrase) {
    const cloudId = byPhrase.cloud_id ?? crypto.randomUUID();
    db.prepare(`
      UPDATE dictionary_items
      SET misspelling = ?, correct_misspelling = ?, shared = ?, cloud_id = ?, updated_at = ?
      WHERE id = ?
    `).run(trimmedMisspelling, correctMisspellingFlag, sharedFlag, cloudId, nowIso, byPhrase.id);
    const saved = db.prepare('SELECT * FROM dictionary_items WHERE id = ?').get(byPhrase.id) as DictionaryRow;
    pushDictionaryUpsert({
      cloud_id: cloudId,
      phrase: saved.phrase,
      misspelling: saved.misspelling,
      correct_misspelling: saved.correct_misspelling,
      shared: saved.shared,
      created_at: saved.created_at,
    });
    return {
      id: saved.id,
      phrase: saved.phrase,
      misspelling: saved.misspelling,
      correctMisspelling: Boolean(saved.correct_misspelling),
      shared: Boolean(saved.shared),
      createdAt: saved.created_at,
    };
  }

  const cloudId = crypto.randomUUID();
  const info = db.prepare(`
    INSERT INTO dictionary_items (phrase, misspelling, correct_misspelling, shared, created_at, cloud_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(trimmedPhrase, trimmedMisspelling, correctMisspellingFlag, sharedFlag, nowIso, cloudId, nowIso);
  pushDictionaryUpsert({
    cloud_id: cloudId,
    phrase: trimmedPhrase,
    misspelling: trimmedMisspelling,
    correct_misspelling: correctMisspellingFlag,
    shared: sharedFlag,
    created_at: nowIso,
  });
  return {
    id: info.lastInsertRowid as number,
    phrase: trimmedPhrase,
    misspelling: trimmedMisspelling,
    correctMisspelling: Boolean(correctMisspellingFlag),
    shared: Boolean(sharedFlag),
    createdAt: nowIso,
  };
}

export function deleteDictionaryItem(id: number): void {
  dictionaryCache = null;
  const row = db.prepare('SELECT cloud_id FROM dictionary_items WHERE id = ?').get(id) as { cloud_id?: string } | undefined;
  db.prepare('DELETE FROM dictionary_items WHERE id = ?').run(id);
  if (row?.cloud_id) enqueueSync('dictionary', row.cloud_id, 'delete', null);
}
