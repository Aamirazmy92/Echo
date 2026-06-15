import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Flame } from 'lucide-react';
import type { DictationEntry } from '../../shared/types';

type DashboardStats = {
  totalWords: number;
  totalSessions: number;
  todayWords: number;
  avgSessionMs: number;
};

const emptyStats: DashboardStats = {
  totalWords: 0,
  totalSessions: 0,
  todayWords: 0,
  avgSessionMs: 0,
};

function computeWpm(stats: DashboardStats): number {
  if (stats.avgSessionMs === 0 || stats.totalSessions === 0) return 0;
  const speed = stats.totalWords / (stats.totalSessions * stats.avgSessionMs / 1000 / 60);
  return Math.round(speed || 0);
}

function startOfWeek(d: Date): Date {
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = out.getDay();
  const mondayOffset = (day + 6) % 7;
  out.setDate(out.getDate() - mondayOffset);
  out.setHours(0, 0, 0, 0);
  return out;
}

function computeWeekStreak(entries: ReadonlyArray<DictationEntry>): number {
  if (entries.length === 0) return 0;

  const weeks = new Set<number>();
  for (const entry of entries) {
    const t = Date.parse(entry.createdAt);
    if (!Number.isFinite(t)) continue;
    weeks.add(startOfWeek(new Date(t)).getTime());
  }

  let cursor = startOfWeek(new Date()).getTime();
  let streak = 0;
  while (weeks.has(cursor)) {
    streak += 1;
    const prev = new Date(cursor);
    prev.setDate(prev.getDate() - 7);
    cursor = prev.getTime();
  }
  return streak;
}

export default function SidebarStatsNotch() {
  const [stats, setStats] = useState<DashboardStats>(emptyStats);
  const [history, setHistory] = useState<DictationEntry[] | null>(null);
  const lastSyncReloadAtRef = useRef<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      const data = await window.api.getDashboardData(500, 0) as {
        stats: DashboardStats;
        history: DictationEntry[];
      };
      setStats(data.stats);
      setHistory(data.history);
    } catch (error) {
      console.error('Failed to load sidebar stats:', error);
    }
  }, []);

  useEffect(() => {
    void loadData();
    const unsub = window.api.onTranscriptionResult(() => {
      void loadData();
    });
    return () => {
      if (unsub) unsub();
    };
  }, [loadData]);

  useEffect(() => {
    let cancelled = false;
    const refreshAfterSignIn = async () => {
      await loadData();
      try {
        await window.api.syncForce();
      } catch (error) {
        console.error('Failed to refresh sidebar stats sync after sign-in:', error);
      }
      if (!cancelled) await loadData();
    };

    void window.api.authGetSession().then((session) => {
      if (!cancelled && session?.userId) void refreshAfterSignIn();
    }).catch(() => undefined);

    const offAuth = window.api.onAuthState((session) => {
      if (!session?.userId) {
        lastSyncReloadAtRef.current = null;
        setStats(emptyStats);
        setHistory([]);
        return;
      }
      void refreshAfterSignIn();
    });

    const offSync = window.api.onSyncStatus((payload) => {
      if (payload.status === 'signed-out') {
        lastSyncReloadAtRef.current = null;
        setStats(emptyStats);
        setHistory([]);
        return;
      }
      if (payload.status !== 'idle' || !payload.lastSyncedAt) return;
      if (payload.lastSyncedAt === lastSyncReloadAtRef.current) return;
      lastSyncReloadAtRef.current = payload.lastSyncedAt;
      void loadData();
    });

    return () => {
      cancelled = true;
      offAuth();
      offSync();
    };
  }, [loadData]);

  const { streakLabel, wordsLabel, wpmLabel } = useMemo(() => {
    const streak = history === null ? null : computeWeekStreak(history);
    return {
      streakLabel: streak === null ? '—' : String(streak),
      wordsLabel: stats.totalWords.toLocaleString(),
      wpmLabel: String(computeWpm(stats)),
    };
  }, [stats, history]);

  return (
    <div className="echo-stat-chip" aria-label="Recent dictation stats">
      <div className="echo-stat-cell is-streak">
        <span className="num">
          <span className="flame" aria-hidden="true">
            <Flame size={14} strokeWidth={2} fill="currentColor" />
          </span>
          {streakLabel}
        </span>
        <span className="label">wk streak</span>
      </div>
      <span className="div" aria-hidden="true" />
      <div className="echo-stat-cell">
        <span className="num">{wordsLabel}</span>
        <span className="label">words</span>
      </div>
      <span className="div" aria-hidden="true" />
      <div className="echo-stat-cell">
        <span className="num">{wpmLabel}</span>
        <span className="label">wpm</span>
      </div>
    </div>
  );
}
