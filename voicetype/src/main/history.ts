import Database from 'better-sqlite3';
import { app } from 'electron';
import path from 'path';
import crypto from 'crypto';
import { DictionaryItem, DictionaryItemInput, DictationEntry, Snippet, SnippetInput } from '../shared/types';
import { escapeCsvField } from './csv';

let db: Database.Database;

let snippetsCache: Snippet[] | null = null;
let dictionaryCache: DictionaryItem[] | null = null;

// Tables that participate in cloud sync. Each gets cloud_id (UUID),
// updated_at, and deleted_at columns added by the migration block in
// initHistory(). The sync engine reads/writes to these via getDb().
const SYNCABLE_TABLES = ['dictations', 'snippets', 'dictionary_items'] as const;

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
    db.prepare('DELETE FROM sync_queue').run();
    db.prepare('DELETE FROM sync_meta').run();
  });
  tx();
  snippetsCache = null;
  dictionaryCache = null;
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

  const dictionaryColumns = db.pragma('table_info(dictionary_items)') as { name: string }[];
  if (!dictionaryColumns.some(c => c.name === 'misspelling')) {
    db.exec(`ALTER TABLE dictionary_items ADD COLUMN misspelling TEXT`);
  }
  if (!dictionaryColumns.some(c => c.name === 'created_at')) {
    db.exec(`ALTER TABLE dictionary_items ADD COLUMN created_at TEXT NOT NULL DEFAULT ''`);
    db.exec(`UPDATE dictionary_items SET created_at = CURRENT_TIMESTAMP WHERE created_at = ''`);
  }

  // Create indexes for frequently queried columns
  db.exec(`CREATE INDEX IF NOT EXISTS idx_dictations_created_at ON dictations(created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_dictations_app_name ON dictations(app_name)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_snippets_category ON snippets(category)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_dictionary_items_phrase ON dictionary_items(phrase)`);

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

export function getSnippets(): Snippet[] {
  if (snippetsCache) return snippetsCache;
  
  const rows = db.prepare('SELECT * FROM snippets WHERE deleted_at IS NULL ORDER BY trigger COLLATE NOCASE ASC').all() as Array<{
    id: number;
    trigger: string;
    expansion: string;
    category: string;
    shared: number;
    created_at: string;
  }>;

  snippetsCache = rows.map((row) => ({
    id: row.id,
    trigger: row.trigger,
    expansion: row.expansion,
    category: row.category ?? '',
    shared: Boolean(row.shared),
    createdAt: row.created_at,
  }));
  return snippetsCache;
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
      return {
        id: saved.id,
        trigger: saved.trigger,
        expansion: saved.expansion,
        category: saved.category ?? '',
        shared: Boolean(saved.shared),
        createdAt: saved.created_at,
      };
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
    return {
      id: saved.id,
      trigger: saved.trigger,
      expansion: saved.expansion,
      category: saved.category ?? '',
      shared: Boolean(saved.shared),
      createdAt: saved.created_at,
    };
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
  };
}

export function deleteSnippet(id: number): void {
  snippetsCache = null;
  // Read cloud_id BEFORE deleting so we can push a tombstone to Supabase.
  const row = db.prepare('SELECT cloud_id FROM snippets WHERE id = ?').get(id) as { cloud_id?: string } | undefined;
  db.prepare('DELETE FROM snippets WHERE id = ?').run(id);
  if (row?.cloud_id) enqueueSync('snippets', row.cloud_id, 'delete', null);
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
