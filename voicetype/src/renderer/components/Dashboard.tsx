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
  CheckSquare,
  Square,
  MoreHorizontal,
  ArrowUpDown,
  Calendar as CalendarIcon,
} from 'lucide-react';
import { formatHotkeyLabel, DEFAULT_PUSH_TO_TALK_HOTKEY } from '../../shared/hotkey';
import ConfirmationModal from './ConfirmationModal';
import SidebarStatsNotch from './SidebarStatsNotch';
import { Dialog, DialogContent } from './ui/dialog';

// ── Date filter helpers ──────────────────────────────────────────────────
// Format a Date as a yyyy-mm-dd string in local time so it matches what
// `<input type="date">` produces (avoids the off-by-one timezone bug you'd
// get from `.toISOString().slice(0, 10)`).
function toLocalDateString(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function shiftDays(base: Date, days: number): Date {
  const next = new Date(base);
  next.setDate(next.getDate() + days);
  return next;
}

const DATE_PRESETS: Array<{ label: string; range: () => { from: string; to: string } }> = [
  {
    label: 'Today',
    range: () => {
      const today = toLocalDateString(new Date());
      return { from: today, to: today };
    },
  },
  {
    label: 'Yesterday',
    range: () => {
      const y = toLocalDateString(shiftDays(new Date(), -1));
      return { from: y, to: y };
    },
  },
  {
    label: 'Last 7 days',
    range: () => ({
      from: toLocalDateString(shiftDays(new Date(), -6)),
      to: toLocalDateString(new Date()),
    }),
  },
  {
    label: 'Last 30 days',
    range: () => ({
      from: toLocalDateString(shiftDays(new Date(), -29)),
      to: toLocalDateString(new Date()),
    }),
  },
  {
    label: 'This month',
    range: () => {
      const now = new Date();
      const first = new Date(now.getFullYear(), now.getMonth(), 1);
      return { from: toLocalDateString(first), to: toLocalDateString(now) };
    },
  },
  {
    label: 'All time',
    range: () => ({ from: '', to: '' }),
  },
];

// Compact label for the chip rendered inside the search bar. Uses short
// month names, avoids the year for in-year ranges to save space, and shows
// "Today"/"Yesterday" for single-day filters that match a preset.
function formatDateChip(from: string, to: string): string {
  if (!from && !to) return '';
  const today = toLocalDateString(new Date());
  const yesterday = toLocalDateString(shiftDays(new Date(), -1));
  if (from === to) {
    if (from === today) return 'Today';
    if (from === yesterday) return 'Yesterday';
    return formatShortDate(from);
  }
  if (from && to) return `${formatShortDate(from)} – ${formatShortDate(to)}`;
  return from ? `From ${formatShortDate(from)}` : `Until ${formatShortDate(to)}`;
}

function formatShortDate(yyyyMmDd: string): string {
  if (!yyyyMmDd) return '';
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  const date = new Date(y, (m ?? 1) - 1, d ?? 1);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, sameYear
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: '2-digit' });
}

function Tooltip({ children, content }: { children: ReactNode; content: string }) {
  return (
    <div className="group/tooltip relative inline-block">
      {children}
      <div className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 -translate-x-1/2 rounded-md bg-foreground px-2.5 py-1.5 text-xs font-medium whitespace-nowrap text-background opacity-0 shadow-md transition-opacity duration-100 group-hover/tooltip:opacity-100" style={{ fontFamily: '"Figtree", "Aptos", "Segoe UI Variable Text", "Segoe UI", sans-serif' }}>
        {content}
      </div>
    </div>
  );
}

interface DashboardProps {
  settings: Settings | null;
  onUpdateSettings: (updates: Partial<Settings>) => void;
}

export default function Dashboard({ settings: parentSettings, onUpdateSettings }: DashboardProps) {
  const [stats, setStats] = useState({ totalWords: 0, totalSessions: 0, todayWords: 0, avgSessionMs: 0 });
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
  // Date-range filter (yyyy-mm-dd strings from <input type="date">).
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [isDateOpen, setIsDateOpen] = useState(false);
  const dateMenuRef = useRef<HTMLDivElement | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [isHistoryActionsOpen, setIsHistoryActionsOpen] = useState(false);
  const [isSortOpen, setIsSortOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  // Anchor for shift-click range selection. Reset whenever selection mode is
  // exited or the filtered list changes under it.
  const [selectionAnchorId, setSelectionAnchorId] = useState<number | null>(null);
  const [confirmBulkDeleteOpen, setConfirmBulkDeleteOpen] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const historyActionsRef = useRef<HTMLDivElement | null>(null);
  const sortMenuRef = useRef<HTMLDivElement | null>(null);
  const recordingRef = useRef(false);
  const [isRecording, setIsRecording] = useState(false);

  useEffect(() => {
    setSettings(parentSettings);
  }, [parentSettings]);

  const loadData = useCallback(async () => {
    try {
      const data = await (window as any).api.getDashboardData(1000, 0) as {
        stats: { totalWords: number; totalSessions: number; todayWords: number; avgSessionMs: number };
        history: DictationEntry[];
      };

      setStats(data.stats);
      setRecentEntries(data.history);
      setHasHistory(data.stats.totalSessions > 0);
    } catch (err) {
      console.error('Failed to load dashboard data:', err);
    }
  }, []);

  const filteredEntries = useMemo(() => (() => {
    let entries = [...recentEntries];

    if (search.trim()) {
      const searchLower = search.trim().toLowerCase();
      entries = entries.filter(e => e.text.toLowerCase().includes(searchLower));
    }

    // Date range filter — `dateFrom`/`dateTo` are inclusive yyyy-mm-dd strings
    // from native date pickers. Empty strings disable the bound on that side.
    if (dateFrom || dateTo) {
      const fromMs = dateFrom ? new Date(`${dateFrom}T00:00:00`).getTime() : -Infinity;
      const toMs = dateTo ? new Date(`${dateTo}T23:59:59.999`).getTime() : Infinity;
      entries = entries.filter((e) => {
        const t = new Date(e.createdAt).getTime();
        return t >= fromMs && t <= toMs;
      });
    }

    entries.sort((left, right) => {
      const leftTime = new Date(left.createdAt).getTime();
      const rightTime = new Date(right.createdAt).getTime();
      return sortMode === 'latest' ? rightTime - leftTime : leftTime - rightTime;
    });

    return entries;
  })(), [recentEntries, search, sortMode, dateFrom, dateTo]);

  const groupedEntries = useMemo(() => (() => {
    const groups: { [key: string]: DictationEntry[] } = {};
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);

    filteredEntries.forEach(entry => {
      const entryDate = new Date(entry.createdAt);
      const entryDay = new Date(entryDate.getFullYear(), entryDate.getMonth(), entryDate.getDate());
      const label =
        entryDay.getTime() === today.getTime()
          ? 'Today'
          : entryDay.getTime() === yesterday.getTime()
          ? 'Yesterday'
          : entryDate.toLocaleDateString(undefined, {
              weekday: 'long',
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

    const unsub = (window as any).api.onTranscriptionResult((_entry: DictationEntry | null) => {
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
    if (!isHistoryActionsOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (!historyActionsRef.current?.contains(event.target as Node)) {
        setIsHistoryActionsOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsHistoryActionsOpen(false);
      }
    };

    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isHistoryActionsOpen]);

  useEffect(() => {
    if (!isDateOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!dateMenuRef.current?.contains(event.target as Node)) {
        setIsDateOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsDateOpen(false);
    };
    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isDateOpen]);

  useEffect(() => {
    if (!isSortOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (!sortMenuRef.current?.contains(event.target as Node)) {
        setIsSortOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsSortOpen(false);
      }
    };

    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isSortOpen]);

  useEffect(() => {
    const isTypingInField = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable;
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (selectionMode) {
          exitSelectionMode();
        } else if (exportFormat) {
          setExportFormat(null);
        }
        return;
      }

      // Selection-mode shortcuts — skipped while the user is typing so we
      // never interfere with Search, inline edits, or confirm dialogs.
      if (!selectionMode || isTypingInField(e.target) || confirmBulkDeleteOpen) {
        return;
      }

      const metaOrCtrl = e.ctrlKey || e.metaKey;

      if (metaOrCtrl && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        setSelectedIds(new Set(filteredEntries.map((entry) => entry.id)));
        return;
      }

      if (metaOrCtrl && (e.key === 'c' || e.key === 'C')) {
        if (selectedIds.size === 0) return;
        e.preventDefault();
        void bulkCopySelected();
        return;
      }

      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.size > 0) {
        e.preventDefault();
        setConfirmBulkDeleteOpen(true);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [exportFormat, selectionMode, selectedIds, filteredEntries, confirmBulkDeleteOpen]);

  const toggleRecording = useCallback(() => {
    if (recordingRef.current) {
      recordingRef.current = false;
      setIsRecording(false);
      window.dispatchEvent(new Event('manual-stop-recording'));
    } else {
      recordingRef.current = true;
      setIsRecording(true);
      window.dispatchEvent(new Event('manual-start-recording'));
    }
  }, []);

  const handleDeleteClick = (id: number, event: React.MouseEvent) => {
    event.stopPropagation();
    setEntryToDelete(id);
  };

  const confirmDelete = async () => {
    if (entryToDelete === null) return;
    const id = entryToDelete;

    try {
      await (window as any).api.deleteHistoryEntry(id);
      setRecentEntries((prev) => prev.filter((entry) => entry.id !== id));

      const toastEvent = new CustomEvent('show-toast', {
        detail: { message: 'Entry deleted', type: 'success' },
      });
      window.dispatchEvent(toastEvent);
    } catch (err) {
      console.error('Failed to delete entry:', err);
    } finally {
      setEntryToDelete(null);
    }
  };

  const handleCopy = async (text: string, id: number, event: React.MouseEvent) => {
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);

      const toastEvent = new CustomEvent('show-toast', {
        detail: { message: 'Copied to clipboard', type: 'success' },
      });
      window.dispatchEvent(toastEvent);
    } catch (err) {
      console.error('Failed to copy text:', err);
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
      const updated = await (window as any).api.updateHistoryEntry(id, trimmed);
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
      const content = await (window as any).api.exportHistory(format);
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
      await (window as any).api.clearHistory();
      setRecentEntries([]);
      setStats({ totalWords: 0, totalSessions: 0, todayWords: 0, avgSessionMs: 0 });

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

  const selectRange = (fromId: number, toId: number) => {
    const ids = filteredEntries.map((e) => e.id);
    const fromIndex = ids.indexOf(fromId);
    const toIndex = ids.indexOf(toId);
    if (fromIndex === -1 || toIndex === -1) return;
    const [start, end] = fromIndex <= toIndex ? [fromIndex, toIndex] : [toIndex, fromIndex];
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (let i = start; i <= end; i += 1) next.add(ids[i]);
      return next;
    });
  };

  const toggleSelection = (id: number, event?: { shiftKey?: boolean }) => {
    // Shift-click: select the contiguous range between the last-clicked row
    // and this one. If there's no anchor yet, fall back to a plain toggle.
    if (event?.shiftKey && selectionAnchorId !== null && selectionAnchorId !== id) {
      selectRange(selectionAnchorId, id);
      setSelectionAnchorId(id);
      return;
    }
    setSelectionAnchorId(id);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === filteredEntries.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredEntries.map((e) => e.id)));
    }
  };

  const exitSelectionMode = () => {
    setSelectionMode(false);
    setSelectedIds(new Set());
    setSelectionAnchorId(null);
  };

  const enterSelectionWith = (id: number) => {
    setSelectionMode(true);
    setSelectedIds(new Set([id]));
    setSelectionAnchorId(id);
  };

  const confirmBulkDelete = async () => {
    try {
      const ids = Array.from(selectedIds);
      await (window as any).api.deleteHistoryEntries(ids);
      setRecentEntries((prev) => prev.filter((entry) => !selectedIds.has(entry.id)));

      const toastEvent = new CustomEvent('show-toast', {
        detail: { message: `${ids.length} ${ids.length === 1 ? 'entry' : 'entries'} deleted`, type: 'success' },
      });
      window.dispatchEvent(toastEvent);
    } catch (err) {
      console.error('Failed to delete entries:', err);
    } finally {
      setConfirmBulkDeleteOpen(false);
      exitSelectionMode();
      void loadData();
    }
  };

  const bulkCopySelected = async () => {
    const entries = filteredEntries.filter((e) => selectedIds.has(e.id));
    if (entries.length === 0) return;
    const text = entries.map((e) => e.text).join('\n\n');
    try {
      await navigator.clipboard.writeText(text);
      const toastEvent = new CustomEvent('show-toast', {
        detail: { message: `Copied ${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`, type: 'success' },
      });
      window.dispatchEvent(toastEvent);
      // The user has completed their action — drop selection state so the
      // dashboard returns to its normal browsing mode.
      exitSelectionMode();
    } catch (err) {
      console.error('Failed to copy entries:', err);
      const toastEvent = new CustomEvent('show-toast', {
        detail: { message: 'Failed to copy. Clipboard permission denied?', type: 'error' },
      });
      window.dispatchEvent(toastEvent);
    }
  };

  const avgSpeed = () => {
    if (stats.avgSessionMs === 0 || stats.totalSessions === 0) return '0 WPM';
    const speed = stats.totalWords / (stats.totalSessions * stats.avgSessionMs / 1000 / 60);
    return `${Math.round(speed || 0)} WPM`;
  };

  const avgSessionLength = () => {
    if (!stats.avgSessionMs) return '0s';
    const totalSeconds = Math.max(1, Math.round(stats.avgSessionMs / 1000));
    if (totalSeconds < 60) return `${totalSeconds}s`;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  };

  const hotkeyStr = formatHotkeyLabel(settings?.pushToTalkHotkey ?? DEFAULT_PUSH_TO_TALK_HOTKEY);
  const hotkeyParts = hotkeyStr.split('+').map((p) => p.trim());

  return (
    // Two-region layout: a fixed top zone (welcome header + history toolbar)
    // and an inner scroller that owns the history list. Scrolling the list
    // no longer moves the welcome/hotkey area, and the toolbar stays put so
    // search/sort/date are always reachable.
    <div className="relative flex h-full flex-col px-7 pt-6">
      <div className="shrink-0 mb-3 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between lg:gap-6">
        {/* Header: page title, hotkey hint, status */}
        <div className="min-w-0 flex-1 lg:max-w-[820px]">
          <div>
            <h1 className="page-title">Welcome back</h1>
            <div className="mt-1.5 flex items-center gap-2 text-sm text-muted-foreground">
              <span>Hold</span>
              <span className="inline-flex items-center gap-1">
                {hotkeyParts.map((part, idx) => (
                  <span key={idx} className="inline-flex items-center gap-1">
                    <kbd className="kbd-key">{part}</kbd>
                    {idx < hotkeyParts.length - 1 && (
                      <span className="text-muted-foreground/60">+</span>
                    )}
                  </span>
                ))}
              </span>
              <span>to dictate anywhere.</span>
            </div>
          </div>
        </div>

        <div className="w-full max-w-[208px] shrink-0 self-start">
          <SidebarStatsNotch />
        </div>
      </div>

      {/* History Toolbar */}
      <div className="shrink-0 mb-3 flex max-w-[820px] flex-col gap-2 border-b border-black/15 pb-3 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
        <div className="card-title">
          History
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
          {/* Search + integrated date filter */}
          <div className="relative" ref={dateMenuRef}>
            <div
              className={`flex h-7 w-[260px] items-center gap-1 rounded-lg border bg-background/60 pl-2.5 pr-1 transition-colors ${
                isDateOpen ? 'border-foreground/30' : 'border-border'
              }`}
            >
              <Search size={14} className="shrink-0 text-muted-foreground" />
              <input
                type="text"
                placeholder="Search history..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="min-w-0 flex-1 border-0 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
              />

              {/* Active date-range chip — clears the filter on click. */}
              {(dateFrom || dateTo) && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setDateFrom('');
                    setDateTo('');
                  }}
                  title="Clear date filter"
                  className="group/chip inline-flex h-6 shrink-0 items-center gap-1 rounded-md bg-foreground/10 px-1.5 text-[11px] font-semibold text-foreground hover:bg-foreground/15"
                >
                  <span className="whitespace-nowrap">
                    {formatDateChip(dateFrom, dateTo)}
                  </span>
                  <X size={11} className="opacity-60 group-hover/chip:opacity-100" />
                </button>
              )}

              {/* Calendar trigger — opens the date popover. */}
              <button
                type="button"
                onClick={() => setIsDateOpen((c) => !c)}
                title="Filter by date"
                aria-label="Filter by date"
                aria-haspopup="dialog"
                aria-expanded={isDateOpen}
                className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md transition-colors ${
                  isDateOpen
                    ? 'bg-accent text-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                }`}
              >
                <CalendarIcon size={13} />
              </button>
            </div>

            {isDateOpen && (
              <div className="absolute right-0 top-full z-20 mt-1.5 w-[300px] overflow-hidden rounded-xl border border-border bg-background p-3 shadow-lg">
                {/* Quick presets — one-click ranges for the common cases. */}
                <div className="mb-3 grid grid-cols-2 gap-1.5">
                  {DATE_PRESETS.map((preset) => {
                    const range = preset.range();
                    const isActive = dateFrom === range.from && dateTo === range.to;
                    return (
                      <button
                        key={preset.label}
                        type="button"
                        onClick={() => {
                          setDateFrom(range.from);
                          setDateTo(range.to);
                        }}
                        className={`h-8 rounded-md border px-2 text-xs font-medium transition-colors ${
                          isActive
                            ? 'border-foreground/40 bg-accent text-foreground'
                            : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground'
                        }`}
                      >
                        {preset.label}
                      </button>
                    );
                  })}
                </div>

                <div className="mb-2 h-px bg-border" />

                <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Custom range
                </label>
                <div className="mb-3 grid grid-cols-2 gap-2">
                  <input
                    type="date"
                    value={dateFrom}
                    max={dateTo || undefined}
                    onChange={(e) => setDateFrom(e.target.value)}
                    className="h-8 w-full rounded-md border border-border bg-background/60 px-2 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring/20"
                  />
                  <input
                    type="date"
                    value={dateTo}
                    min={dateFrom || undefined}
                    onChange={(e) => setDateTo(e.target.value)}
                    className="h-8 w-full rounded-md border border-border bg-background/60 px-2 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring/20"
                  />
                </div>

                <div className="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => { setDateFrom(''); setDateTo(''); }}
                    disabled={!dateFrom && !dateTo}
                    className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
                  >
                    Clear
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsDateOpen(false)}
                    className="rounded-md bg-foreground/90 px-3 py-1.5 text-xs font-semibold text-background hover:bg-foreground"
                  >
                    Done
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="relative" ref={sortMenuRef}>
            <button
              type="button"
              onClick={() => setIsSortOpen((current) => !current)}
              title="Sort messages"
              aria-label="Sort messages"
              aria-haspopup="menu"
              aria-expanded={isSortOpen}
              className={`flex h-7 items-center gap-1.5 rounded-lg border border-border px-2.5 text-[13px] font-medium transition-colors ${
                isSortOpen
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground'
              }`}
            >
              <ArrowUpDown size={13} />
              {sortMode === 'latest' ? 'Latest first' : 'Earliest first'}
            </button>

            {isSortOpen && (
              <div className="absolute right-0 top-full z-20 mt-1.5 w-[170px] overflow-hidden rounded-xl border border-border bg-background p-1 shadow-lg">
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
              </div>
            )}
          </div>

          {/* Export */}
          <div className="relative" ref={historyActionsRef}>
            <button
              type="button"
              onClick={() => setIsHistoryActionsOpen((current) => !current)}
              disabled={recentEntries.length === 0}
              title="History actions"
              aria-label="History actions"
              aria-haspopup="menu"
              aria-expanded={isHistoryActionsOpen}
              className={`flex h-7 w-7 items-center justify-center rounded-lg border border-border transition-colors disabled:opacity-40 ${
                isHistoryActionsOpen
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground'
              }`}
            >
              <MoreHorizontal size={14} />
            </button>

            {isHistoryActionsOpen && (
              <div className="absolute right-0 top-full z-20 mt-1.5 w-[190px] overflow-hidden rounded-xl border border-border bg-background p-1 shadow-lg">
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
                <HistoryActionMenuButton
                  label={selectionMode ? 'Cancel selection' : 'Select entries'}
                  icon={<CheckSquare size={12} />}
                  disabled={recentEntries.length === 0}
                  onClick={() => {
                    if (selectionMode) {
                      exitSelectionMode();
                    } else {
                      setSelectionMode(true);
                    }
                    setIsHistoryActionsOpen(false);
                  }}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Scroll region — owns the entire history list. The negative inline
          margins + matching padding bleed the scroll area to the page edge
          so the scrollbar sits where users expect it (right against the
          window), while content keeps its 28px gutter. */}
      <div
        ref={scrollContainerRef}
        className="-mx-7 flex-1 min-h-0 overflow-y-auto px-7 pb-8"
        style={{ scrollbarGutter: 'stable' }}
      >
      {/* Bulk action toolbar — sticky so it stays visible while the user
          scrolls through a long list. Shows live counts and a subtle
          keyboard-shortcut hint to make bulk actions discoverable. */}
      {selectionMode && (
        <div className="sticky top-0 z-20 mb-3 max-w-[820px] overflow-hidden transition-all duration-200">
          <div className="flex items-center gap-2 rounded-xl border border-primary/20 bg-primary/5 px-4 py-2.5 backdrop-blur-sm">
              <button
                type="button"
                onClick={toggleSelectAll}
                disabled={filteredEntries.length === 0}
                className="flex items-center gap-1.5 text-xs font-medium text-foreground transition-colors hover:text-primary disabled:opacity-40"
              >
                {selectedIds.size === filteredEntries.length && filteredEntries.length > 0 ? (
                  <CheckSquare size={14} className="text-primary" />
                ) : (
                  <Square size={14} />
                )}
                {selectedIds.size === filteredEntries.length && filteredEntries.length > 0
                  ? `Deselect all (${filteredEntries.length})`
                  : `Select all (${filteredEntries.length})`}
              </button>

              <span className="mx-1 text-xs font-medium text-foreground">
                {selectedIds.size} selected
              </span>

              <span
                className="hidden lg:inline text-[10px] text-muted-foreground"
                title="Ctrl+A select all · Ctrl+C copy · Delete to remove · Esc to cancel · Shift-click for ranges"
              >
                Shift-click for range · Ctrl+A · Ctrl+C · Del
              </span>

              <div className="flex-1" />

              <button
                type="button"
                onClick={bulkCopySelected}
                disabled={selectedIds.size === 0}
                title="Copy selected (Ctrl+C)"
                className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
              >
                <Copy size={12} />
                Copy
              </button>

              <button
                type="button"
                onClick={() => setConfirmBulkDeleteOpen(true)}
                disabled={selectedIds.size === 0}
                title="Delete selected (Delete)"
                className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-red-100 hover:text-red-500 disabled:opacity-40"
              >
                <Trash2 size={12} />
                Delete
              </button>

              <button
                type="button"
                onClick={exitSelectionMode}
                title="Exit selection (Esc)"
                className="ml-1 flex items-center justify-center rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                aria-label="Exit selection"
              >
                <X size={14} />
              </button>
            </div>
        </div>
      )}

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
          <div className="max-w-[820px] space-y-6">
            {(dateFrom || dateTo) && (
              <div className="-mt-2 flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  Showing {filteredEntries.length} of {recentEntries.length} loaded entries in range.
                </span>
                <button
                  type="button"
                  onClick={() => { setDateFrom(''); setDateTo(''); }}
                  className="text-xs font-medium text-foreground hover:text-primary"
                >
                  Clear date filter
                </button>
              </div>
            )}
            {Object.entries(groupedEntries).map(([groupLabel, entries]) => (
              <div key={groupLabel}>
                {/* Sticky day header — pins the current group's date label
                    to the top of the scroll region so the user always
                    knows which day they're looking at while scrolling. */}
                <div className="sticky top-0 z-10 mb-2 bg-background px-1 pt-2 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {groupLabel}
                </div>

                <div className="rounded-xl border border-border bg-card">
                  {entries.map((entry) => (
                    <div
                      key={entry.id}
                      className={`group flex items-start border-b border-neutral-500/10 px-5 py-3.5 transition-colors duration-75 last:border-b-0 ${
                        selectionMode && selectedIds.has(entry.id)
                          ? 'bg-primary/8 hover:bg-primary/12'
                          : 'hover:bg-accent/50'
                      }`}
                      onClick={
                        selectionMode
                          ? (e) => toggleSelection(entry.id, { shiftKey: e.shiftKey })
                          : undefined
                      }
                      style={selectionMode ? { cursor: 'pointer' } : undefined}
                    >
                      {/* Checkbox — always present when selecting; fades in on
                          row hover when not selecting, so a single click enters
                          selection mode with this row pre-ticked. */}
                      {selectionMode ? (
                        <div className="flex shrink-0 items-center pt-0.5 pr-3">
                          {selectedIds.has(entry.id) ? (
                            <CheckSquare size={16} className="text-primary" />
                          ) : (
                            <Square size={16} className="text-muted-foreground/40" />
                          )}
                        </div>
                      ) : (
                        editingId !== entry.id && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              enterSelectionWith(entry.id);
                            }}
                            title="Select (Shift-click to select range after)"
                            aria-label="Select entry"
                            className="flex shrink-0 items-center pt-0.5 pr-3 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
                          >
                            <Square size={16} className="text-muted-foreground/60 hover:text-primary" />
                          </button>
                        )
                      )}
                      <div className="min-w-0 flex-1">
                        {editingId === entry.id ? (
                          <div className="flex items-center gap-2">
                            <input
                              autoFocus
                              value={editText}
                              onChange={(e) => setEditText(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') { e.preventDefault(); saveEdit(entry.id); }
                                if (e.key === 'Escape') cancelEditing();
                              }}
                              className="flex-1 rounded-lg border border-border bg-background/60 px-2.5 py-1.5 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring/20"
                            />
                            <button type="button" onClick={(e) => { e.stopPropagation(); saveEdit(entry.id); }} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground" title="Save changes" aria-label="Save changes"><Check size={14} /></button>
                            <button type="button" onClick={(e) => { e.stopPropagation(); cancelEditing(); }} className="rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive" title="Cancel editing" aria-label="Cancel editing"><X size={14} /></button>
                          </div>
                        ) : (
                          <div className="flex items-start gap-4">
                            <span className="shrink-0 pt-0.5 text-[13px] font-medium text-muted-foreground">
                              {new Date(entry.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </span>
                            <p className="min-w-0 flex-1 text-[15px] leading-relaxed text-foreground">{entry.text}</p>
                          </div>
                        )}
                      </div>

                      {editingId !== entry.id && !selectionMode && (
                        <div className="flex shrink-0 items-center gap-1 pl-3 opacity-0 transition-opacity group-hover:opacity-100">
                          <Tooltip content="Edit entry">
                            <button type="button" onClick={(e) => startEditing(entry, e)} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground" title="Edit entry" aria-label="Edit entry"><Pencil size={14} /></button>
                          </Tooltip>
                          <Tooltip content="Copy text">
                            <button type="button" onClick={(e) => handleCopy(entry.text, entry.id, e)} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground" title="Copy text" aria-label="Copy text">
                              {copiedId === entry.id ? <Check size={14} /> : <Copy size={14} />}
                            </button>
                          </Tooltip>
                          <Tooltip content="Delete entry">
                            <button type="button" onClick={(e) => handleDeleteClick(entry.id, e)} className="rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive" title="Delete entry" aria-label="Delete entry"><Trash2 size={14} /></button>
                          </Tooltip>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
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
        confirmButtonClassName="bg-[#cf6f63] text-white hover:bg-[#c76357]"
        onConfirm={confirmClearAll}
        onClose={() => setConfirmClearAllOpen(false)}
      />

      {/* Bulk delete confirmation */}
      <ConfirmationModal
        open={confirmBulkDeleteOpen}
        title={`Delete ${selectedIds.size} ${selectedIds.size === 1 ? 'entry' : 'entries'}?`}
        description={`Are you sure you want to delete the ${selectedIds.size} selected ${selectedIds.size === 1 ? 'entry' : 'entries'}? This action cannot be undone.`}
        confirmLabel="Delete"
        confirmButtonClassName="bg-[#cf6f63] text-white hover:bg-[#c76357]"
        onConfirm={confirmBulkDelete}
        onClose={() => setConfirmBulkDeleteOpen(false)}
      />

      {/* Export Dialog — shared CSS-only Dialog for snappy open/close. */}
      <Dialog open={exportFormat !== null} onOpenChange={(next) => { if (!next) setExportFormat(null); }}>
        <DialogContent className="max-w-sm" onClose={() => setExportFormat(null)}>
          <h2 className="text-[15px] font-semibold text-foreground">Export history</h2>
          <p className="mt-1.5 text-[13px] text-muted-foreground">Choose a format for your dictation history.</p>
          <div className="mt-5 flex gap-2">
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
