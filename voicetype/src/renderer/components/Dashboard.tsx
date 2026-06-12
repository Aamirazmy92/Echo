import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Settings, type DictationEntry } from '../../shared/types';
import {
  Copy,
  Trash2,
  Check,
  Search,
  Pencil,
  X,
  Download,
  MoreHorizontal,
  ArrowUpDown,
} from 'lucide-react';
import { formatHotkeyLabel, DEFAULT_PUSH_TO_TALK_HOTKEY } from '../../shared/hotkey';
import type { AuthSession } from '../api';
import ConfirmationModal from './ConfirmationModal';
import SidebarStatsNotch from './SidebarStatsNotch';
import { Dialog, DialogContent } from './ui/dialog';
import { Popover, PopoverContent } from './ui/popover';
import { rowActionsClassName } from '../lib/rowActions';

function Tooltip({ children, content }: { children: ReactNode; content: string }) {
  return (
    <div className="group/tooltip relative inline-block">
      {children}
      <div role="tooltip" className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 -translate-x-1/2 rounded-md bg-foreground px-2.5 py-1.5 text-xs font-medium whitespace-nowrap text-background opacity-0 shadow-md transition-opacity duration-100 group-hover/tooltip:opacity-100 group-hover/tooltip:delay-300" style={{ fontFamily: 'var(--font-body)' }}>
        {content}
      </div>
    </div>
  );
}

interface DashboardProps {
  settings: Settings | null;
}

export default function Dashboard({ settings: parentSettings }: DashboardProps) {
  const [settings, setSettings] = useState<Settings | null>(parentSettings);
  const [recentEntries, setRecentEntries] = useState<DictationEntry[]>([]);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [entryToDelete, setEntryToDelete] = useState<number | null>(null);
  const [confirmClearAllOpen, setConfirmClearAllOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editText, setEditText] = useState('');
  const [exportFormat, setExportFormat] = useState<'csv' | 'json' | null>(null);
  const [hasHistory, setHasHistory] = useState(false);
  const [search, setSearch] = useState('');
  const [sortMode, setSortMode] = useState<'latest' | 'earliest'>('latest');
  const [isHistoryActionsOpen, setIsHistoryActionsOpen] = useState(false);
  const [isSortOpen, setIsSortOpen] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const lastSyncReloadAtRef = useRef<string | null>(null);
  // Signed-in user (null when cloud sync isn't configured). Drives the
  // "Welcome back, {name}" greeting and refreshes live whenever the
  // user updates their display name in Account settings.
  const [authSession, setAuthSession] = useState<AuthSession | null>(null);

  useEffect(() => {
    setSettings(parentSettings);
  }, [parentSettings]);

  // Pull the current Supabase session and stay subscribed for changes.
  // The greeting text rerenders the moment Account.tsx pushes a new
  // display name through the auth-state event.
  useEffect(() => {
    let cancelled = false;
    void window.api
      .authGetSession()
      .then((next) => {
        if (!cancelled) setAuthSession(next);
      })
      .catch(() => undefined);
    const off = window.api.onAuthState((next) => setAuthSession(next));
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  const loadData = useCallback(async () => {
    try {
      const data = await window.api.getDashboardData(1000, 0) as {
        stats: { totalWords: number; totalSessions: number; todayWords: number; avgSessionMs: number };
        history: DictationEntry[];
      };

      setRecentEntries(data.history);
      setHasHistory(data.stats.totalSessions > 0);
    } catch (err) {
      console.error('Failed to load dashboard data:', err);
    }
  }, []);

  useEffect(() => {
    if (!authSession?.userId) return;

    let cancelled = false;
    (async () => {
      await loadData();
      try {
        await window.api.syncForce();
      } catch (err) {
        console.error('Failed to refresh dashboard sync after sign-in:', err);
      }
      if (!cancelled) {
        await loadData();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [authSession?.userId, loadData]);

  useEffect(() => {
    const off = window.api.onSyncStatus((payload) => {
      if (payload.status === 'signed-out') {
        lastSyncReloadAtRef.current = null;
        setRecentEntries([]);
        setHasHistory(false);
        return;
      }

      if (payload.status !== 'idle' || !payload.lastSyncedAt) return;
      if (payload.lastSyncedAt === lastSyncReloadAtRef.current) return;

      lastSyncReloadAtRef.current = payload.lastSyncedAt;
      void loadData();
    });

    return off;
  }, [loadData]);

  const filteredEntries = useMemo(() => (() => {
    let entries = [...recentEntries];

    if (search.trim()) {
      const searchLower = search.trim().toLowerCase();
      entries = entries.filter(e => e.text.toLowerCase().includes(searchLower));
    }

    entries.sort((left, right) => {
      const leftTime = new Date(left.createdAt).getTime();
      const rightTime = new Date(right.createdAt).getTime();
      return sortMode === 'latest' ? rightTime - leftTime : leftTime - rightTime;
    });

    return entries;
  })(), [recentEntries, search, sortMode]);

  const groupedEntries = useMemo(() => (() => {
    const groups: { [key: string]: DictationEntry[] } = {};

    filteredEntries.forEach(entry => {
      const entryDate = new Date(entry.createdAt);
      const label = entryDate.toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });

      if (!groups[label]) groups[label] = [];
      groups[label].push(entry);
    });

    return groups;
  })(), [filteredEntries]);

  useEffect(() => {
    let idleCallbackId: number | null = null;
    let timeoutId: number | null = null;

    if (typeof window.requestIdleCallback === 'function') {
      idleCallbackId = window.requestIdleCallback(() => {
        void loadData();
      }, { timeout: 300 });
    } else {
      timeoutId = window.setTimeout(() => {
        void loadData();
      }, 120);
    }

    const unsub = window.api.onTranscriptionResult((_entry: DictationEntry | null) => {
      void loadData();
    });
    return () => {
      if (idleCallbackId !== null && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(idleCallbackId);
      }
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
      if (unsub) unsub();
    };
  }, [loadData]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && exportFormat) {
        setExportFormat(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [exportFormat]);

  const handleDeleteClick = (id: number, event: React.MouseEvent) => {
    event.stopPropagation();
    setEntryToDelete(id);
  };

  const confirmDelete = async () => {
    if (entryToDelete === null) return;
    const id = entryToDelete;

    try {
      await window.api.deleteHistoryEntry(id);
      setRecentEntries((prev) => prev.filter((entry) => entry.id !== id));

      const toastEvent = new CustomEvent('show-toast', {
        detail: { message: 'Entry deleted', type: 'success' },
      });
      window.dispatchEvent(toastEvent);
    } catch (err) {
      console.error('Failed to delete entry:', err);
      const toastEvent = new CustomEvent('show-toast', {
        detail: { message: 'Could not delete entry. Try again.', type: 'error' },
      });
      window.dispatchEvent(toastEvent);
    } finally {
      setEntryToDelete(null);
    }
  };

  const handleCopy = async (text: string, id: number, event: React.MouseEvent) => {
    event.stopPropagation();
    try {
      await window.api.writeClipboardText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);

      const toastEvent = new CustomEvent('show-toast', {
        detail: { message: 'Copied to clipboard', type: 'success' },
      });
      window.dispatchEvent(toastEvent);
    } catch (err) {
      console.error('Failed to copy text:', err);
      const toastEvent = new CustomEvent('show-toast', {
        detail: { message: 'Could not copy. Clipboard permission denied?', type: 'error' },
      });
      window.dispatchEvent(toastEvent);
    }
  };

  const startEditing = (entry: DictationEntry, event: React.MouseEvent) => {
    event.stopPropagation();
    setEditingId(entry.id);
    setEditText(entry.text);
  };

  const cancelEditing = () => {
    setEditingId(null);
    setEditText('');
  };

  const saveEdit = async (id: number) => {
    const trimmed = editText.trim();
    if (!trimmed) {
      cancelEditing();
      return;
    }
    try {
      const updated = await window.api.updateHistoryEntry(id, trimmed);
      if (updated) {
        setRecentEntries((prev) =>
          prev.map((e) => (e.id === id ? { ...e, text: updated.text } : e))
        );
        const toastEvent = new CustomEvent('show-toast', {
          detail: { message: 'Entry updated', type: 'success' },
        });
        window.dispatchEvent(toastEvent);
      }
      cancelEditing();
    } catch (err) {
      console.error('Failed to update entry:', err);
    }
  };

  const handleExport = async (format: 'csv' | 'json') => {
    try {
      const content = await window.api.exportHistory(format);
      const blob = new Blob([content], { type: format === 'csv' ? 'text/csv' : 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `echo-history-${new Date().toISOString().split('T')[0]}.${format}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      const toastEvent = new CustomEvent('show-toast', {
        detail: { message: `Exported to ${format.toUpperCase()}`, type: 'success' },
      });
      window.dispatchEvent(toastEvent);
    } catch (err) {
      console.error('Failed to export:', err);
      const toastEvent = new CustomEvent('show-toast', {
        detail: { message: 'Failed to export history', type: 'error' },
      });
      window.dispatchEvent(toastEvent);
    } finally {
      setExportFormat(null);
    }
  };

  const confirmClearAll = async () => {
    try {
      await window.api.clearHistory();
      setRecentEntries([]);
      const toastEvent = new CustomEvent('show-toast', {
        detail: { message: 'History cleared', type: 'success' },
      });
      window.dispatchEvent(toastEvent);
    } catch (err) {
      console.error('Failed to clear history:', err);
    } finally {
      setConfirmClearAllOpen(false);
      void loadData();
    }
  };

  const hotkeyStr = formatHotkeyLabel(settings?.pushToTalkHotkey ?? DEFAULT_PUSH_TO_TALK_HOTKEY);
  const hotkeyParts = hotkeyStr.split('+').map((p) => p.trim());

  // Build the greeting. Falls back to plain "Welcome back" when the
  // session hasn't loaded yet or cloud sync isn't configured. We pull
  // just the first word of the display name so a long name like
  // "Aamir Azmy" greets as "Welcome back, Aamir" instead of cramping
  // the header.
  const greetingName = (() => {
    if (!authSession) return null;
    const raw = authSession.displayName || authSession.email.split('@')[0];
    if (!raw) return null;
    return raw.trim().split(/\s+/)[0];
  })();
  const greetingTimeOfDay = (() => {
    const hour = new Date().getHours();
    if (hour < 5) return 'Still up';
    if (hour < 12) return 'Good morning';
    if (hour < 18) return 'Good afternoon';
    return 'Good evening';
  })();
  const greetingHeadline = greetingName
    ? `${greetingTimeOfDay}, ${greetingName}.`
    : `${greetingTimeOfDay}.`;
  const todayKicker = new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });

  return (
    // Two-region layout: a fixed top zone (greeting + CTA + history toolbar)
    // and an inner scroller that owns the history list. The greeting layer
    // mirrors the Echo redesign — serif headline, hotkey-in-lede, corner stat
    // chip, and a soft CTA-press card with the clay mic orb.
    <div className="relative flex h-full flex-col px-10 pt-6">
      <div className="echo-greeting-block shrink-0">
        <div className="min-w-0">
          <div className="echo-h-section" style={{ marginBottom: 10 }}>{todayKicker}</div>
          <h1 className="echo-h-display">{greetingHeadline}</h1>
          <p className="echo-lede" style={{ marginTop: 12, marginBottom: 0 }}>
            Hold{' '}
            {hotkeyParts.map((part, idx) => (
              <span key={idx} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <kbd className="echo-kbd echo-kbd-lg">{part}</kbd>
                {idx < hotkeyParts.length - 1 && (
                  <span style={{ color: 'var(--ink-muted)', margin: '0 2px' }}>+</span>
                )}
              </span>
            ))}{' '}
            and speak — Echo is listening when you are.
          </p>
        </div>
        <div className="shrink-0">
          <SidebarStatsNotch />
        </div>
      </div>

      {/* History Toolbar */}
      <div className="shrink-0 mb-4 flex max-w-[920px] flex-col gap-3 sm:flex-row sm:items-center sm:justify-between" style={{ marginTop: 14 }}>
        <h2 className="echo-h-title" style={{ fontSize: 22 }}>History</h2>
        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
          <div className="echo-search" style={{ width: 280, minWidth: 0 }}>
            <Search size={14} className="shrink-0" style={{ color: 'var(--ink-muted)' }} />
            <input
              type="text"
              placeholder="Search transcripts…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <Popover open={isSortOpen} onOpenChange={setIsSortOpen} align="end">
            <button
              type="button"
              onClick={() => setIsSortOpen((current) => !current)}
              title="Sort messages"
              aria-label="Sort messages"
              aria-haspopup="menu"
              aria-expanded={isSortOpen}
              className="echo-btn echo-btn-outline"
            >
              <ArrowUpDown size={13} />
              {sortMode === 'latest' ? 'Latest first' : 'Earliest first'}
            </button>

            <PopoverContent className="w-[170px] p-1">
              <SortMenuButton
                label="Latest first"
                active={sortMode === 'latest'}
                onClick={() => {
                  scrollContainerRef.current?.scrollTo({ top: 0, behavior: 'instant' });
                  setSortMode('latest');
                  setIsSortOpen(false);
                }}
              />
              <SortMenuButton
                label="Earliest first"
                active={sortMode === 'earliest'}
                onClick={() => {
                  scrollContainerRef.current?.scrollTo({ top: 0, behavior: 'instant' });
                  setSortMode('earliest');
                  setIsSortOpen(false);
                }}
              />
            </PopoverContent>
          </Popover>

          {/* Export */}
          <Popover open={isHistoryActionsOpen} onOpenChange={setIsHistoryActionsOpen} align="end">
            <button
              type="button"
              onClick={() => setIsHistoryActionsOpen((current) => !current)}
              disabled={recentEntries.length === 0}
              title="History actions"
              aria-label="History actions"
              aria-haspopup="menu"
              aria-expanded={isHistoryActionsOpen}
              className="echo-icon-btn"
              style={{ opacity: recentEntries.length === 0 ? 0.4 : 1 }}
            >
              <MoreHorizontal size={14} />
            </button>

            <PopoverContent className="w-[190px] p-1">
              <HistoryActionMenuButton
                label="Export history"
                icon={<Download size={12} />}
                disabled={!hasHistory}
                onClick={() => {
                  setExportFormat('csv');
                  setIsHistoryActionsOpen(false);
                }}
              />
              <HistoryActionMenuButton
                label="Delete all history"
                icon={<Trash2 size={12} />}
                disabled={recentEntries.length === 0}
                destructive
                onClick={() => {
                  setConfirmClearAllOpen(true);
                  setIsHistoryActionsOpen(false);
                }}
              />
            </PopoverContent>
          </Popover>
        </div>
      </div>

      {/* Scroll region — owns the entire history list. The negative inline
          margins + matching padding bleed the scroll area to the page edge
          so the scrollbar sits where users expect it (right against the
          window), while content keeps its 28px gutter. */}
      <div
        ref={scrollContainerRef}
        className="scroll-hover -mx-8 flex-1 min-h-0 overflow-y-auto px-8 pb-8"
        style={{ scrollbarGutter: 'stable' }}
      >
      {/* History List */}
      <div className="min-h-[300px]">
        {Object.keys(groupedEntries).length === 0 ? (
          <div className="py-16 text-center">
            <Search size={20} className="mx-auto mb-3 text-muted-foreground" />
            <p className="text-sm font-medium text-foreground">
              {search.trim() ? 'No results match your search.' : 'No dictation history yet.'}
            </p>
            <p className="mt-1.5 text-xs text-muted-foreground">
              {search.trim() ? 'Try a different search term.' : 'Hold your hotkey and start talking to fill this up!'}
            </p>
          </div>
        ) : (
          <div className="echo-history-list max-w-[920px]">
            {Object.entries(groupedEntries).map(([groupLabel, entries]) => (
              <div key={groupLabel}>
                {/* Day divider — hairline rule with the label on the left
                    and the entry count on the right, per the bundle's
                    journal-style timeline. */}
                <div className="echo-day-divider">
                  <span className="label">{groupLabel}</span>
                  <div className="rule" />
                  <span className="count">
                    {entries.length} {entries.length === 1 ? 'entry' : 'entries'}
                  </span>
                </div>

                {entries.map((entry) => {
                  const isRowActive = entryToDelete === entry.id || editingId === entry.id;
                  const isEditing = editingId === entry.id;
                  return (
                  <div key={entry.id} className="echo-history-item group">
                    <div className="time">
                      {new Date(entry.createdAt).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </div>
                    <div>
                      {isEditing ? (
                        <div className="flex items-center gap-2">
                          <input
                            autoFocus
                            value={editText}
                            onChange={(e) => setEditText(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') { e.preventDefault(); saveEdit(entry.id); }
                              if (e.key === 'Escape') cancelEditing();
                            }}
                            className="flex-1 rounded-lg px-2.5 py-1.5 text-[15px] outline-none"
                            style={{
                              border: '1px solid var(--line)',
                              background: 'var(--card-raw)',
                              color: 'var(--ink)',
                            }}
                          />
                        </div>
                      ) : (
                        <>
                          <div className="text">{entry.text}</div>
                        </>
                      )}
                    </div>

                    <div className={rowActionsClassName(isRowActive)}>
                      {isEditing ? (
                        <>
                          <Tooltip content="Save changes">
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); saveEdit(entry.id); }}
                              className="flex h-[30px] w-[30px] items-center justify-center rounded-md"
                              style={{ color: 'var(--ink-soft)' }}
                              title="Save changes"
                              aria-label="Save changes"
                            >
                              <Check size={14} />
                            </button>
                          </Tooltip>
                          <Tooltip content="Cancel editing">
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); cancelEditing(); }}
                              className="flex h-[30px] w-[30px] items-center justify-center rounded-md"
                              style={{ color: 'var(--ink-soft)' }}
                              title="Cancel editing"
                              aria-label="Cancel editing"
                            >
                              <X size={14} />
                            </button>
                          </Tooltip>
                        </>
                      ) : (
                        <>
                        <Tooltip content="Edit entry">
                          <button
                            type="button"
                            onClick={(e) => startEditing(entry, e)}
                            className="flex h-[30px] w-[30px] items-center justify-center rounded-md"
                            style={{ color: 'var(--ink-soft)' }}
                            title="Edit entry"
                            aria-label="Edit entry"
                          >
                            <Pencil size={14} />
                          </button>
                        </Tooltip>
                        <Tooltip content="Copy text">
                          <button
                            type="button"
                            onClick={(e) => handleCopy(entry.text, entry.id, e)}
                            className="flex h-[30px] w-[30px] items-center justify-center rounded-md"
                            style={{ color: 'var(--ink-soft)' }}
                            title="Copy text"
                            aria-label="Copy text"
                          >
                            {copiedId === entry.id ? <Check size={14} /> : <Copy size={14} />}
                          </button>
                        </Tooltip>
                        <Tooltip content="Delete entry">
                          <button
                            type="button"
                            onClick={(e) => handleDeleteClick(entry.id, e)}
                            className="flex h-[30px] w-[30px] items-center justify-center rounded-md"
                            style={{ color: 'var(--ink-soft)' }}
                            title="Delete entry"
                            aria-label="Delete entry"
                          >
                            <Trash2 size={14} />
                          </button>
                        </Tooltip>
                        </>
                      )}
                    </div>
                  </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>
      </div>

      {/* Delete entry confirmation */}
      <ConfirmationModal
        open={entryToDelete !== null}
        title="Delete transcription"
        description="Are you sure you want to delete this transcription? This action cannot be undone."
        confirmLabel="Delete"
        onConfirm={confirmDelete}
        onClose={() => setEntryToDelete(null)}
      />

      {/* Clear all confirmation */}
      <ConfirmationModal
        open={confirmClearAllOpen}
        title="Delete all history"
        description="Are you sure you want to delete all dashboard history entries? This action cannot be undone."
        confirmLabel="Delete all"
        onConfirm={confirmClearAll}
        onClose={() => setConfirmClearAllOpen(false)}
      />

      {/* Export Dialog — shared Framer Motion Dialog for snappy open/close. */}
      <Dialog open={exportFormat !== null} onOpenChange={(next) => { if (!next) setExportFormat(null); }}>
        <DialogContent onClose={() => setExportFormat(null)}>
          <div className="echo-modal-header">
            <h2 className="echo-modal-title">Export history</h2>
            <p className="echo-modal-description">Choose a format for your dictation history.</p>
          </div>
          <div className="echo-modal-footer">
            <button type="button" onClick={() => handleExport('csv')} className="btn-primary flex-1">CSV</button>
            <button type="button" onClick={() => handleExport('json')} className="btn-secondary flex-1">JSON</button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function HistoryActionMenuButton({
  label,
  icon,
  onClick,
  disabled = false,
  destructive = false,
}: {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        destructive
          ? 'text-destructive hover:bg-destructive/10'
          : 'text-foreground hover:bg-accent'
      }`}
    >
      <span className="flex h-4 w-4 items-center justify-center">{icon}</span>
      <span>{label}</span>
    </button>
  );
}

function SortMenuButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-[13px] font-medium text-foreground transition-colors hover:bg-accent"
    >
      <span>{label}</span>
      {active ? <Check size={13} className="text-foreground" /> : null}
    </button>
  );
}




