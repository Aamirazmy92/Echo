import { BrowserWindow } from 'electron';
import { getCurrentUserId, getSupabase, onAuthStateChange } from '../auth';
import { getDb, isHistoryReady, clearLocalSyncedData } from '../history';
import { logError, logWarn } from '../logger';

/*
 * Sync engine — bridges the local SQLite database and Supabase.
 *
 * Push side:
 *   - Each mutating function in history.ts inserts a row into the
 *     sync_queue table. We drain that queue here, fire-and-forget.
 *   - On network failure, the queue row stays put so the next pass
 *     retries. `attempts` is incremented for visibility; the engine
 *     does not currently apply backoff (overkill for a friends-only
 *     app — a 30 s timer is plenty).
 *
 * Pull side:
 *   - Every PULL_INTERVAL_MS and on window-focus, we ask Supabase for
 *     rows updated since `sync_meta.last_pulled_at` for each table.
 *     Newer remote rows overwrite local ones (last-write-wins).
 *     Tombstones (deleted_at IS NOT NULL) propagate the delete.
 *
 * Identity:
 *   - The cloud row primary key is `cloud_id` (UUID) on local tables.
 *     Local autoincrement `id` is internal-only.
 *
 * Status broadcast:
 *   - The renderer subscribes to `sync-status` IPC events to render
 *     the sidebar indicator. Statuses: 'idle' | 'syncing' | 'offline'
 *     | 'error'. We also expose the last error message + queue depth.
 */

type TableMap = {
  cloudTable: 'history' | 'snippets' | 'dictionary' | 'custom_styles';
  localTable: 'dictations' | 'snippets' | 'dictionary_items' | 'custom_styles';
  /** Map a cloud row to the local-column shape used for upsert. */
  toLocal: (row: Record<string, unknown>) => SyncLocalRow;
};

type SyncLocalRow = Record<string, unknown> & {
  cloud_id?: unknown;
  updated_at?: unknown;
  deleted_at?: unknown;
};

const TABLES: Record<TableMap['cloudTable'], TableMap> = {
  history: {
    cloudTable: 'history',
    localTable: 'dictations',
    toLocal: (r) => ({
      cloud_id: r.id,
      text: r.text,
      raw_text: r.raw_text,
      word_count: r.word_count,
      duration_ms: r.duration_ms,
      app_name: r.app_name,
      mode: r.mode,
      method: r.method,
      created_at: r.client_created_at,
      updated_at: r.updated_at,
      deleted_at: r.deleted_at,
    }),
  },
  snippets: {
    cloudTable: 'snippets',
    localTable: 'snippets',
    toLocal: (r) => ({
      cloud_id: r.id,
      trigger: r.trigger,
      expansion: r.expansion,
      category: r.category ?? '',
      shared: r.shared ? 1 : 0,
      created_at: r.client_created_at,
      updated_at: r.updated_at,
      deleted_at: r.deleted_at,
    }),
  },
  dictionary: {
    cloudTable: 'dictionary',
    localTable: 'dictionary_items',
    toLocal: (r) => ({
      cloud_id: r.id,
      phrase: r.phrase,
      misspelling: r.misspelling,
      correct_misspelling: r.correct_misspelling ? 1 : 0,
      shared: r.shared ? 1 : 0,
      created_at: r.client_created_at,
      updated_at: r.updated_at,
      deleted_at: r.deleted_at,
    }),
  },
  // custom_styles is wired schema-side but not yet pushed/pulled
  // (no local table exists for it yet — added in a later step).
  custom_styles: {
    cloudTable: 'custom_styles',
    localTable: 'custom_styles',
    toLocal: (r) => r,
  },
};

const PULL_INTERVAL_MS = 30_000;
const PULL_PAGE_SIZE = 500;

let pullTimer: NodeJS.Timeout | null = null;
let pushInFlight = false;
let pullInFlight = false;
let lastPushError: string | null = null;
let lastPullError: string | null = null;
let pendingLocalDataClear = false;

export type SyncStatus = 'idle' | 'syncing' | 'offline' | 'error' | 'signed-out';

interface SyncStatusPayload {
  status: SyncStatus;
  queueDepth: number;
  lastError: string | null;
  lastSyncedAt: string | null;
}

let lastSyncedAt: string | null = null;

function getLastError(): string | null {
  return lastPushError ?? lastPullError;
}

function getQueueDepth(): number {
  if (!isHistoryReady()) return 0;
  try {
    const row = getDb().prepare('SELECT COUNT(*) as c FROM sync_queue').get() as { c: number };
    return row.c;
  } catch {
    return 0;
  }
}

function broadcastStatus(status: SyncStatus): void {
  const payload: SyncStatusPayload = {
    status,
    queueDepth: getQueueDepth(),
    lastError: getLastError(),
    lastSyncedAt,
  };
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('sync-status', payload);
    }
  }
}

export function getSyncStatus(): SyncStatusPayload {
  const userId = getCurrentUserId();
  let status: SyncStatus;
  if (!userId) status = 'signed-out';
  else if (getLastError()) status = 'error';
  else if (pushInFlight || pullInFlight) status = 'syncing';
  else status = 'idle';
  return {
    status,
    queueDepth: getQueueDepth(),
    lastError: getLastError(),
    lastSyncedAt,
  };
}

function broadcastLocalDataCleared(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('local-data-cleared');
  }
}

function applyPendingLocalDataClearIfReady(): void {
  if (!pendingLocalDataClear || !isHistoryReady()) return;
  clearLocalSyncedData();
  pendingLocalDataClear = false;
  lastPushError = null;
  lastPullError = null;
  lastSyncedAt = null;
  broadcastLocalDataCleared();
}

async function drainQueue(): Promise<void> {
  if (pushInFlight) return;
  const supabase = getSupabase();
  const userId = getCurrentUserId();
  if (!supabase || !userId) return;
  // The history DB is opened lazily on the renderer's first call.
  // If sync fires before that (e.g. INITIAL_SESSION at boot when a
  // previous session restored, or window-focus before the renderer
  // has mounted), there is nothing to push and trying to read from
  // it would throw.
  if (!isHistoryReady()) return;

  pushInFlight = true;
  broadcastStatus('syncing');
  try {
    lastPushError = null;
    while (true) {
      const batch = getDb()
        .prepare('SELECT id, table_name, cloud_id, op, payload FROM sync_queue ORDER BY id ASC LIMIT 50')
        .all() as Array<{ id: number; table_name: string; cloud_id: string; op: 'upsert' | 'delete'; payload: string | null }>;
      if (batch.length === 0) break;

      // Group by table+op to minimise round trips. Keep deletes separate
      // since they don't share payload shape.
      const upsertsByTable = new Map<string, Array<{ queueId: number; payload: Record<string, unknown> }>>();
      const deletesByTable = new Map<string, Array<{ queueId: number; cloudId: string }>>();

      for (const row of batch) {
        if (row.op === 'upsert' && row.payload) {
          const list = upsertsByTable.get(row.table_name) ?? [];
          const parsed = JSON.parse(row.payload) as Record<string, unknown>;
          list.push({ queueId: row.id, payload: { ...parsed, user_id: userId } });
          upsertsByTable.set(row.table_name, list);
        } else if (row.op === 'delete') {
          const list = deletesByTable.get(row.table_name) ?? [];
          list.push({ queueId: row.id, cloudId: row.cloud_id });
          deletesByTable.set(row.table_name, list);
        }
      }

      const completedQueueIds: number[] = [];
      const erroredQueueIds: number[] = [];

      for (const [table, items] of upsertsByTable) {
        const { error } = await supabase
          .from(table)
          .upsert(items.map((i) => i.payload), { onConflict: 'id' });
        if (error) {
          lastPushError = `upsert ${table}: ${error.message}`;
          erroredQueueIds.push(...items.map((i) => i.queueId));
          logWarn('sync', `upsert into ${table} failed`, error);
        } else {
          completedQueueIds.push(...items.map((i) => i.queueId));
        }
      }

      for (const [table, items] of deletesByTable) {
        // Cloud-side soft-delete: set deleted_at instead of DELETE, so a
        // peer device can pull the tombstone and remove its own copy.
        const deletedAt = new Date().toISOString();
        const { error } = await supabase
          .from(table)
          .update({ deleted_at: deletedAt })
          .in(
            'id',
            items.map((i) => i.cloudId)
          );
        if (error) {
          lastPushError = `delete ${table}: ${error.message}`;
          erroredQueueIds.push(...items.map((i) => i.queueId));
          logWarn('sync', `tombstone in ${table} failed`, error);
        } else {
          completedQueueIds.push(...items.map((i) => i.queueId));
        }
      }

      if (completedQueueIds.length > 0) {
        const placeholders = completedQueueIds.map(() => '?').join(',');
        getDb().prepare(`DELETE FROM sync_queue WHERE id IN (${placeholders})`).run(...completedQueueIds);
      }
      if (erroredQueueIds.length > 0) {
        const placeholders = erroredQueueIds.map(() => '?').join(',');
        getDb()
          .prepare(`UPDATE sync_queue SET attempts = attempts + 1, last_error = ? WHERE id IN (${placeholders})`)
          .run(lastPushError, ...erroredQueueIds);
        // Bail out — don't keep hammering the network if Supabase is down.
        break;
      }
      // No errors but maybe more rows — loop again.
    }
  } catch (err) {
    lastPushError = (err as Error).message;
    logError('sync', 'drainQueue threw', err);
  } finally {
    pushInFlight = false;
    broadcastStatus(getLastError() ? 'error' : 'idle');
  }
}

function getLastPulledAt(table: string): string | null {
  try {
    const row = getDb().prepare('SELECT last_pulled_at FROM sync_meta WHERE table_name = ?').get(table) as
      | { last_pulled_at: string | null }
      | undefined;
    return row?.last_pulled_at ?? null;
  } catch {
    return null;
  }
}

function setLastPulledAt(table: string, when: string): void {
  getDb()
    .prepare(
      `INSERT INTO sync_meta (table_name, last_pulled_at) VALUES (?, ?)
       ON CONFLICT(table_name) DO UPDATE SET last_pulled_at = excluded.last_pulled_at`
    )
    .run(table, when);
}

async function pullTable(map: TableMap): Promise<void> {
  const supabase = getSupabase();
  const userId = getCurrentUserId();
  if (!supabase || !userId) return;

  const since = getLastPulledAt(map.cloudTable);
  let page = 0;
  let maxUpdatedAt: string | null = since;

  while (true) {
    const from = page * PULL_PAGE_SIZE;
    const to = from + PULL_PAGE_SIZE - 1;
    let query = supabase
      .from(map.cloudTable)
      .select('*')
      .eq('user_id', userId)
      .order('updated_at', { ascending: true })
      .range(from, to);
    if (since) {
      query = query.gt('updated_at', since);
    }
    const { data, error } = await query;
    if (error) {
      lastPullError = `pull ${map.cloudTable}: ${error.message}`;
      logWarn('sync', `pull from ${map.cloudTable} failed`, error);
      return;
    }
    if (!data || data.length === 0) return;

    const db = getDb();

    // Apply each row to the local table. We use cloud_id to find the
    // existing row; if none exists we INSERT, otherwise we UPDATE only
    // when the remote updated_at is newer.
    const tx = db.transaction((rows: Record<string, unknown>[]) => {
      for (const r of rows) {
        const local = map.toLocal(r);
        if (!maxUpdatedAt || (typeof local.updated_at === 'string' && local.updated_at > maxUpdatedAt)) {
          maxUpdatedAt = local.updated_at as string;
        }
        // Tombstone — remove or soft-delete locally. For dictations we
        // soft-delete; for snippets/dictionary the unique constraints
        // mean we hard-delete.
        if (local.deleted_at) {
          if (map.localTable === 'dictations') {
            db.prepare(
              `UPDATE ${map.localTable} SET deleted_at = ?, updated_at = ? WHERE cloud_id = ?`
            ).run(local.deleted_at, local.updated_at, local.cloud_id);
          } else {
            db.prepare(`DELETE FROM ${map.localTable} WHERE cloud_id = ?`).run(local.cloud_id);
          }
          continue;
        }
        // Upsert by cloud_id.
        const existing = db
          .prepare(`SELECT id, updated_at FROM ${map.localTable} WHERE cloud_id = ?`)
          .get(local.cloud_id) as { id: number; updated_at?: string } | undefined;
        if (existing) {
          // Last-write-wins. Skip if local is newer.
          if (existing.updated_at && local.updated_at && existing.updated_at >= local.updated_at) continue;
          applyUpdate(map.localTable, existing.id, local);
        } else {
          applyInsert(map.localTable, local);
        }
      }
    });
    tx(data);
    if (data.length < PULL_PAGE_SIZE) break;
    page += 1;
  }

  if (maxUpdatedAt && maxUpdatedAt !== since) {
    setLastPulledAt(map.cloudTable, maxUpdatedAt);
  }
  lastPullError = null;
}

function applyInsert(table: string, row: SyncLocalRow): void {
  const db = getDb();
  if (table === 'dictations') {
    db.prepare(
      `INSERT INTO dictations (text, raw_text, word_count, duration_ms, app_name, mode, method, created_at, cloud_id, updated_at, deleted_at)
       VALUES (@text, @raw_text, @word_count, @duration_ms, @app_name, @mode, @method, @created_at, @cloud_id, @updated_at, @deleted_at)`
    ).run({
      text: row.text ?? '',
      raw_text: row.raw_text ?? '',
      word_count: row.word_count ?? 0,
      duration_ms: row.duration_ms ?? 0,
      app_name: row.app_name ?? null,
      mode: row.mode ?? 'standard',
      method: row.method ?? 'local',
      created_at: row.created_at ?? new Date().toISOString(),
      cloud_id: row.cloud_id,
      updated_at: row.updated_at ?? new Date().toISOString(),
      deleted_at: row.deleted_at ?? null,
    });
  } else if (table === 'snippets') {
    db.prepare(
      `INSERT OR REPLACE INTO snippets (trigger, expansion, category, shared, created_at, cloud_id, updated_at)
       VALUES (@trigger, @expansion, @category, @shared, @created_at, @cloud_id, @updated_at)`
    ).run({
      trigger: row.trigger ?? '',
      expansion: row.expansion ?? '',
      category: row.category ?? '',
      shared: row.shared ?? 0,
      created_at: row.created_at ?? new Date().toISOString(),
      cloud_id: row.cloud_id,
      updated_at: row.updated_at ?? new Date().toISOString(),
    });
  } else if (table === 'dictionary_items') {
    db.prepare(
      `INSERT OR REPLACE INTO dictionary_items (phrase, misspelling, correct_misspelling, shared, created_at, cloud_id, updated_at)
       VALUES (@phrase, @misspelling, @correct_misspelling, @shared, @created_at, @cloud_id, @updated_at)`
    ).run({
      phrase: row.phrase ?? '',
      misspelling: row.misspelling ?? null,
      correct_misspelling: row.correct_misspelling ?? 0,
      shared: row.shared ?? 0,
      created_at: row.created_at ?? new Date().toISOString(),
      cloud_id: row.cloud_id,
      updated_at: row.updated_at ?? new Date().toISOString(),
    });
  }
}

function applyUpdate(table: string, id: number, row: SyncLocalRow): void {
  const db = getDb();
  if (table === 'dictations') {
    db.prepare(
      `UPDATE dictations SET text=?, raw_text=?, word_count=?, duration_ms=?, app_name=?, mode=?, method=?, updated_at=?, deleted_at=? WHERE id=?`
    ).run(
      row.text ?? '',
      row.raw_text ?? '',
      row.word_count ?? 0,
      row.duration_ms ?? 0,
      row.app_name ?? null,
      row.mode ?? 'standard',
      row.method ?? 'local',
      row.updated_at,
      row.deleted_at ?? null,
      id
    );
  } else if (table === 'snippets') {
    db.prepare(
      `UPDATE snippets SET trigger=?, expansion=?, category=?, shared=?, updated_at=? WHERE id=?`
    ).run(
      row.trigger ?? '',
      row.expansion ?? '',
      row.category ?? '',
      row.shared ?? 0,
      row.updated_at,
      id
    );
  } else if (table === 'dictionary_items') {
    db.prepare(
      `UPDATE dictionary_items SET phrase=?, misspelling=?, correct_misspelling=?, shared=?, updated_at=? WHERE id=?`
    ).run(
      row.phrase ?? '',
      row.misspelling ?? null,
      row.correct_misspelling ?? 0,
      row.shared ?? 0,
      row.updated_at,
      id
    );
  }
}

async function pullAll(): Promise<void> {
  if (pullInFlight) return;
  if (!getSupabase() || !getCurrentUserId()) return;
  if (!isHistoryReady()) return;
  pullInFlight = true;
  broadcastStatus('syncing');
  try {
    lastPullError = null;
    await pullTable(TABLES.history);
    await pullTable(TABLES.snippets);
    await pullTable(TABLES.dictionary);
    lastSyncedAt = new Date().toISOString();
  } catch (err) {
    lastPullError = (err as Error).message;
    logError('sync', 'pullAll threw', err);
  } finally {
    pullInFlight = false;
    broadcastStatus(getLastError() ? 'error' : 'idle');
  }
}

export async function forceSync(): Promise<void> {
  applyPendingLocalDataClearIfReady();
  await drainQueue();
  applyPendingLocalDataClearIfReady();
  await pullAll();
}

export function startSync(): void {
  if (pullTimer) return;
  void forceSync();
  pullTimer = setInterval(() => {
    void drainQueue();
    void pullAll();
  }, PULL_INTERVAL_MS);
}

export function stopSync(): void {
  if (pullTimer) {
    clearInterval(pullTimer);
    pullTimer = null;
  }
  broadcastStatus('signed-out');
}

export function initSync(): void {
  // Auto-wire to auth. When a session arrives → start; when it goes
  // away (sign-out / token revoked) → stop and clear watermarks so the
  // next sign-in pulls everything fresh.
  onAuthStateChange((session) => {
    if (session) startSync();
    else {
      stopSync();
      // Wipe local synced data on sign-out so the *next* user that
      // signs into this machine doesn't inherit the previous user's
      // history/snippets/dictionary. Guarded because Supabase fires an
      // `INITIAL_SESSION` event during boot, before the renderer has
      // triggered any history operation — calling clearLocalSyncedData
      // before the DB exists would throw and log a noisy stack trace.
      try {
        if (isHistoryReady()) {
          clearLocalSyncedData();
          pendingLocalDataClear = false;
          lastPushError = null;
          lastPullError = null;
          lastSyncedAt = null;
          // Tell the renderer to drop any in-memory copies it cached
          // from the previous user (e.g. <History> page).
          broadcastLocalDataCleared();
        } else {
          pendingLocalDataClear = true;
        }
      } catch (err) {
        logWarn('sync', 'failed to clear local data on sign-out', err);
      }
    }
  });

  // Also kick a sync on window focus so users don't have to wait the
  // full 30 s for newly-typed entries to flow in.
  // (BrowserWindow listeners are wired in main/index.ts via getOnFocusHandler below.)
}

export function syncOnFocus(): void {
  void forceSync();
}
