import Database from 'better-sqlite3';
import { app } from 'electron';
import path from 'path';
import { DictionaryItem, DictionaryItemInput, DictationEntry, Snippet, SnippetInput } from '../shared/types';
import { escapeCsvField } from './csv';

let db: Database.Database;

let snippetsCache: Snippet[] | null = null;
let dictionaryCache: DictionaryItem[] | null = null;

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
}

export function addEntry(entry: Omit<DictationEntry, 'id'>): DictationEntry {
  const stmt = db.prepare(`
    INSERT INTO dictations (text, raw_text, word_count, duration_ms, app_name, mode, method, created_at)
    VALUES (@text, @rawText, @wordCount, @durationMs, @appName, @mode, @method, @createdAt)
  `);
  const info = stmt.run(entry);
  return { ...entry, id: info.lastInsertRowid as number };
}

export function getEntries(limit: number, offset: number): DictationEntry[] {
  const stmt = db.prepare('SELECT * FROM dictations ORDER BY id DESC LIMIT ? OFFSET ?');
  const rows = stmt.all(limit, offset) as any[];
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
  const stmt = db.prepare('SELECT * FROM dictations ORDER BY id DESC');
  const rows = stmt.all() as any[];
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
  const info = db.prepare('UPDATE dictations SET text = ?, word_count = ? WHERE id = ?').run(text, wordCount, id);
  if (info.changes === 0) return null;
  const row = db.prepare('SELECT * FROM dictations WHERE id = ?').get(id) as any;
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
  db.prepare('DELETE FROM dictations WHERE id = ?').run(id);
}

export function deleteEntries(ids: number[]): void {
  if (!ids.length) return;
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM dictations WHERE id IN (${placeholders})`).run(...ids);
}

export function clearAll(): void {
  db.prepare('DELETE FROM dictations').run();
}

export function getStats(): { totalWords: number; totalSessions: number; todayWords: number; avgSessionMs: number } {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const startOfTomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
  const totalRow = db.prepare('SELECT COUNT(id) as c, SUM(word_count) as w, AVG(duration_ms) as a FROM dictations').get() as any;
  const todayRow = db.prepare('SELECT SUM(word_count) as w FROM dictations WHERE created_at >= ? AND created_at < ?').get(startOfToday, startOfTomorrow) as any;

  return {
    totalWords: totalRow?.w || 0,
    totalSessions: totalRow?.c || 0,
    todayWords: todayRow?.w || 0,
    avgSessionMs: totalRow?.a || 0
  };
}

export function getSnippets(): Snippet[] {
  if (snippetsCache) return snippetsCache;
  
  const rows = db.prepare('SELECT * FROM snippets ORDER BY trigger COLLATE NOCASE ASC').all() as Array<{
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

export function saveSnippet(snippet: SnippetInput): Snippet {
  snippetsCache = null;
  const createdAt = new Date().toISOString();
  const normalized = {
    id: snippet.id,
    trigger: snippet.trigger.trim(),
    expansion: snippet.expansion.trim(),
    category: snippet.category?.trim() ?? '',
    shared: snippet.shared ? 1 : 0,
    created_at: createdAt,
  };

  if (normalized.id !== undefined) {
    const updateById = db.prepare(`
      UPDATE snippets
      SET trigger = @trigger, expansion = @expansion, category = @category, shared = @shared
      WHERE id = @id
    `);
    const info = updateById.run(normalized);
    if (info.changes > 0) {
      const saved = db.prepare('SELECT * FROM snippets WHERE id = ?').get(normalized.id) as {
        id: number;
        trigger: string;
        expansion: string;
        category: string;
        shared: number;
        created_at: string;
      };
      return { ...saved, category: saved.category ?? '', shared: Boolean(saved.shared), createdAt: saved.created_at };
    }
  }

  const updateByTrigger = db.prepare(`
    UPDATE snippets
    SET expansion = @expansion, category = @category, shared = @shared
    WHERE trigger = @trigger
  `);
  const info = updateByTrigger.run(normalized);
  if (info.changes > 0) {
    const saved = db.prepare('SELECT * FROM snippets WHERE trigger = ?').get(normalized.trigger) as {
      id: number;
      trigger: string;
      expansion: string;
      category: string;
      shared: number;
      created_at: string;
    };
    return { ...saved, category: saved.category ?? '', shared: Boolean(saved.shared), createdAt: saved.created_at };
  }

  const insertStmt = db.prepare(`
    INSERT INTO snippets (trigger, expansion, category, shared, created_at)
    VALUES (@trigger, @expansion, @category, @shared, @created_at)
  `);
  const insInfo = insertStmt.run(normalized);
  return {
    id: insInfo.lastInsertRowid as number,
    trigger: normalized.trigger,
    expansion: normalized.expansion,
    category: normalized.category,
    shared: Boolean(normalized.shared),
    createdAt: normalized.created_at,
  };
}

export function deleteSnippet(id: number): void {
  snippetsCache = null;
  db.prepare('DELETE FROM snippets WHERE id = ?').run(id);
}

export function getDictionaryItems(): DictionaryItem[] {
  if (dictionaryCache) return dictionaryCache;
  
  const rows = db.prepare(`
    SELECT id, phrase, misspelling, correct_misspelling, shared, created_at
    FROM dictionary_items
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

export function saveDictionaryItem(item: DictionaryItemInput): DictionaryItem {
  dictionaryCache = null;
  const createdAt = new Date().toISOString();
  const normalized = {
    id: item.id,
    phrase: item.phrase.trim(),
    misspelling: item.misspelling?.trim() ? item.misspelling.trim() : null,
    correct_misspelling: item.correctMisspelling ? 1 : 0,
    shared: item.shared ? 1 : 0,
    created_at: createdAt,
  };

  if (normalized.id !== undefined) {
    const updateById = db.prepare(`
      UPDATE dictionary_items
      SET phrase = @phrase, misspelling = @misspelling, correct_misspelling = @correct_misspelling, shared = @shared
      WHERE id = @id
    `);
    const info = updateById.run(normalized);
    if (info.changes > 0) {
      const saved = db.prepare('SELECT * FROM dictionary_items WHERE id = ?').get(normalized.id) as {
        id: number;
        phrase: string;
        misspelling: string | null;
        correct_misspelling: number;
        shared: number;
        created_at: string;
      };
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

  const updateByPhrase = db.prepare(`
    UPDATE dictionary_items
    SET misspelling = @misspelling, correct_misspelling = @correct_misspelling, shared = @shared
    WHERE phrase = @phrase
  `);
  const info = updateByPhrase.run(normalized);
  if (info.changes > 0) {
    const saved = db.prepare('SELECT * FROM dictionary_items WHERE phrase = ?').get(normalized.phrase) as {
      id: number;
      phrase: string;
      misspelling: string | null;
      correct_misspelling: number;
      shared: number;
      created_at: string;
    };
    return {
      id: saved.id,
      phrase: saved.phrase,
      misspelling: saved.misspelling,
      correctMisspelling: Boolean(saved.correct_misspelling),
      shared: Boolean(saved.shared),
      createdAt: saved.created_at,
    };
  }

  const insertStmt = db.prepare(`
    INSERT INTO dictionary_items (phrase, misspelling, correct_misspelling, shared, created_at)
    VALUES (@phrase, @misspelling, @correct_misspelling, @shared, @created_at)
  `);
  const insInfo = insertStmt.run(normalized);
  return {
    id: insInfo.lastInsertRowid as number,
    phrase: normalized.phrase,
    misspelling: normalized.misspelling,
    correctMisspelling: Boolean(normalized.correct_misspelling),
    shared: Boolean(normalized.shared),
    createdAt: normalized.created_at,
  };
}

export function deleteDictionaryItem(id: number): void {
  dictionaryCache = null;
  db.prepare('DELETE FROM dictionary_items WHERE id = ?').run(id);
}
