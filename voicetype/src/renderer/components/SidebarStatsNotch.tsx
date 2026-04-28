import { useCallback, useEffect, useMemo, useState } from 'react';

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

function formatAvgSpeed(stats: DashboardStats) {
  if (stats.avgSessionMs === 0 || stats.totalSessions === 0) {
    return '0';
  }

  const speed = stats.totalWords / (stats.totalSessions * stats.avgSessionMs / 1000 / 60);
  return String(Math.round(speed || 0));
}

function formatSessionLength(avgSessionMs: number): { value: string; unit: string } {
  if (!avgSessionMs) {
    return { value: '0', unit: 'secs' };
  }

  const totalSeconds = Math.max(1, Math.round(avgSessionMs / 1000));
  if (totalSeconds < 60) {
    return { value: String(totalSeconds), unit: 'secs' };
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds
    ? { value: `${minutes}:${seconds.toString().padStart(2, '0')}`, unit: '' }
    : { value: String(minutes), unit: 'mins' };
}

export default function SidebarStatsNotch() {
  const [stats, setStats] = useState<DashboardStats>(emptyStats);

  const loadData = useCallback(async () => {
    try {
      const data = await (window as any).api.getDashboardData(50, 0) as {
        stats: DashboardStats;
      };
      setStats(data.stats);
    } catch (error) {
      console.error('Failed to load sidebar stats:', error);
    }
  }, []);

  useEffect(() => {
    void loadData();

    const unsub = (window as any).api.onTranscriptionResult(() => {
      void loadData();
    });

    return () => {
      if (unsub) {
        unsub();
      }
    };
  }, [loadData]);

  const sidebarStats = useMemo(() => {
    const session = formatSessionLength(stats.avgSessionMs);
    return [
      {
        label: 'Words',
        value: stats.totalWords.toLocaleString(),
        unit: '',
      },
      {
        label: 'Session',
        value: session.value,
        unit: session.unit,
      },
      {
        label: 'Streak',
        value: stats.todayWords > 0 ? '1' : '0',
        unit: 'days',
      },
      {
        label: 'Speed',
        value: formatAvgSpeed(stats),
        unit: 'wpm',
      },
    ];
  }, [stats]);

  return (
    <section className="rounded-[22px] border border-black/[0.07] bg-white/78 px-5 py-5 shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
      <div className="flex flex-col gap-3">
        {sidebarStats.map((stat) => (
          <div
            key={stat.label}
            className="flex items-baseline justify-between gap-3"
          >
            <p className="text-[14px] font-medium leading-none text-foreground/68">
              {stat.label}
            </p>
            <div className="inline-flex items-baseline gap-1.5 text-right">
              <span className="stat-num text-[22px] font-medium leading-none tabular-nums text-foreground">
                {stat.value}
              </span>
              {stat.unit && (
                <span className="stat-num text-[15px] font-medium leading-none text-foreground/68">
                  {stat.unit}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
