import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Monitor,
  Clock,
  Sparkles,
  Cloud,
  HardDrive,
  ChevronLeft,
  ChevronRight,
  MessageSquare,
  Mail,
  FileText,
  Briefcase,
  Infinity as InfinityIcon,
  type LucideIcon,
} from 'lucide-react';
import type { DictationEntry } from '../../shared/types';
import { ALL_CATEGORIES, classifyApp, type AppCategory } from '../../shared/app-categories';

type InsightsTab = 'usage' | 'voice';

const HISTORY_FETCH_LIMIT = 5000;

// Data extension we use to talk about the diff between raw and cleaned text.
type EntryWithDiff = DictationEntry & { wordsCorrected: number; wasCorrected: boolean };

function countWords(text: string | undefined | null): number {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function computeWordsCorrected(entry: DictationEntry): number {
  const cleanedWords = countWords(entry.text);
  const rawWords = countWords(entry.rawText);
  // Conservative: only count when cleanup *removed* words (filler words /
  // re-phrasings). Prevents the figure from blowing up when cleanup expands
  // contractions ("don't" -> "do not").
  return Math.max(0, rawWords - cleanedWords);
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function dateKey(d: Date): string {
  // Local-date YYYY-MM-DD key.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((startOfDay(a).getTime() - startOfDay(b).getTime()) / 86_400_000);
}

function formatNumber(n: number): string {
  return new Intl.NumberFormat().format(Math.round(n));
}

// -------- Sub-components --------

function ScopeTab({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative pb-2.5 text-sm font-medium transition-colors ${
        active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
      }`}
    >
      {label}
      {active && <span className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-foreground" />}
    </button>
  );
}

function StatCard({
  value,
  label,
  children,
  className = '',
}: {
  value: string;
  label: string;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex min-h-[160px] flex-col rounded-xl p-5 ${className}`}
      style={{ background: 'hsl(var(--app-bg))' }}
    >
      <div className="text-[30px] font-semibold leading-none tracking-tight text-foreground">{value}</div>
      <div className="mt-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-foreground">
        {label}
      </div>
      {children !== undefined && (
        <>
          <div className="my-3 h-px w-full bg-border" />
          <div className="flex flex-1 flex-col">{children}</div>
        </>
      )}
    </div>
  );
}

// Half-arc gauge that fills from 0..1 with a smooth 0 -> target sweep on
// mount. Uses an SMIL <animate> element so the animation auto-plays the
// instant the path is created in the DOM, regardless of React's commit /
// batching timing. SMIL is well-supported in Chromium (Electron) and freezes
// on the final value via `fill="freeze"`.
function ArcGauge({ ratio, label }: { ratio: number; label: string }) {
  const target = Math.max(0, Math.min(1, ratio)) * 100;
  const finalOffset = 100 - target;

  return (
    <div className="relative flex flex-1 items-end justify-center">
      <svg viewBox="0 0 100 56" className="w-[180px]">
        <path
          d="M5 50 A 45 45 0 0 1 95 50"
          fill="none"
          stroke="hsl(var(--border-strong))"
          strokeWidth={9}
          strokeLinecap="round"
          pathLength={100}
        />
        <path
          d="M5 50 A 45 45 0 0 1 95 50"
          fill="none"
          stroke="#1E3A5F"
          strokeWidth={9}
          strokeLinecap="round"
          pathLength={100}
          strokeDasharray="100 100"
          strokeDashoffset={finalOffset}
        >
          <animate
            attributeName="stroke-dashoffset"
            from="100"
            to={String(finalOffset)}
            dur="1.1s"
            begin="0s"
            fill="freeze"
            calcMode="spline"
            keySplines="0.22 1 0.36 1"
            keyTimes="0;1"
            values={`100;${finalOffset}`}
          />
        </path>
      </svg>
      <div className="absolute bottom-0 flex flex-col items-center pb-1">
        <div className="text-sm font-medium text-foreground">{label}</div>
      </div>
    </div>
  );
}

// -------- Usage tab --------

function UsageTab({ entries }: { entries: EntryWithDiff[] }) {
  const stats = useMemo(() => {
    const totalWords = entries.reduce((s, e) => s + e.wordCount, 0);
    const totalMs = entries.reduce((s, e) => s + e.durationMs, 0);
    const totalMinutes = totalMs / 60_000;
    const avgWpm = totalMinutes > 0 ? totalWords / totalMinutes : 0;

    const correctedEntries = entries.filter((e) => e.wasCorrected).length;
    const wordsCorrected = entries.reduce((s, e) => s + e.wordsCorrected, 0);

    // Per-category aggregation: count *dictations* per category (the metric
    // used by the breakdown rows) and track which raw process names landed
    // in each bucket so the row tooltip can show exactly what was captured.
    type Bucket = { dictations: number; apps: Map<string, number> };
    const perCategory = new Map<AppCategory, Bucket>();
    for (const cat of ALL_CATEGORIES) {
      perCategory.set(cat, { dictations: 0, apps: new Map() });
    }
    const allApps = new Set<string>();
    for (const e of entries) {
      const raw = e.appName?.trim() || 'Unknown';
      allApps.add(raw);
      const { category } = classifyApp(raw);
      const bucket = perCategory.get(category)!;
      bucket.dictations += 1;
      bucket.apps.set(raw, (bucket.apps.get(raw) ?? 0) + 1);
    }
    const totalDictations = entries.length || 1;
    const categoryBreakdown = ALL_CATEGORIES.map((category) => {
      const bucket = perCategory.get(category)!;
      const apps = Array.from(bucket.apps.entries())
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count);
      return {
        category,
        dictations: bucket.dictations,
        pct: Math.round((bucket.dictations / totalDictations) * 100),
        apps,
      };
    }).sort((a, b) => {
      if (b.dictations !== a.dictations) return b.dictations - a.dictations;
      return a.category.localeCompare(b.category);
    });

    return {
      totalWords,
      totalMinutes,
      avgWpm,
      correctedEntries,
      wordsCorrected,
      categoryBreakdown,
      totalAppsUsed: allApps.size,
    };
  }, [entries]);

  const streak = useMemo(() => computeStreaks(entries), [entries]);

  // Cap the WPM gauge at 250 WPM (rare conversational speed) for a nicely
  // proportioned arc on typical usage.
  const wpmRatio = stats.avgWpm / 250;

  return (
    <div className="space-y-5">
      {/* Top stat row */}
      <div className="grid gap-5 md:grid-cols-3">
        <StatCard value={formatNumber(stats.avgWpm)} label="Words per minute">
          <ArcGauge ratio={wpmRatio} label={stats.avgWpm > 0 ? 'Average pace' : 'No data yet'} />
        </StatCard>

        <StatCard value={formatNumber(stats.correctedEntries)} label="Fixes made by Echo">
          <div className="text-sm text-foreground/65">
            {stats.wordsCorrected > 0
              ? `${formatNumber(stats.wordsCorrected)} words corrected`
              : 'No edits yet — Echo only steps in when needed.'}
          </div>
        </StatCard>

        <StatCard value={formatNumber(stats.totalWords)} label="Total words dictated">
          <div className="flex items-center gap-2 text-sm text-foreground/65">
            <Monitor size={15} />
            <span>Desktop</span>
          </div>
          <div className="mt-0.5 text-sm text-foreground/55">
            {formatNumber(stats.totalWords)} {stats.totalWords === 1 ? 'word' : 'words'}
          </div>
        </StatCard>
      </div>

      {/* Bottom row */}
      <div className="grid gap-5 lg:grid-cols-2">
        {/* Desktop usage — grouped by category */}
        <div className="rounded-xl p-6" style={{ background: 'hsl(var(--app-bg))' }}>
          <div className="flex items-baseline justify-between gap-3">
            <h3 className="card-title">Desktop usage</h3>
            <span className="text-xs font-semibold uppercase tracking-[0.1em] text-foreground">
              Total apps used | {stats.totalAppsUsed}
            </span>
          </div>

          <div className="mt-4 space-y-2">
            {stats.categoryBreakdown.map((row) => (
              <CategoryRow
                key={row.category}
                category={row.category}
                pct={row.pct}
                count={row.dictations}
                apps={row.apps}
              />
            ))}
          </div>
        </div>

        {/* Streak heatmap */}
        <div className="rounded-xl p-6" style={{ background: 'hsl(var(--app-bg))' }}>
          <div className="flex items-baseline justify-between gap-3">
            <h3 className="card-title">
              {streak.currentStreak} {streak.currentStreak === 1 ? 'day' : 'day'} streak
            </h3>
            <span className="text-xs font-semibold uppercase tracking-[0.1em] text-foreground">
              Longest streak | {streak.longestStreak}{' '}
              {streak.longestStreak === 1 ? 'day' : 'days'}
            </span>
          </div>

          <div className="mt-4">
            <Heatmap dailyStats={streak.dailyStats} />
          </div>
        </div>
      </div>
    </div>
  );
}

const CATEGORY_ICONS: Record<AppCategory, LucideIcon> = {
  'AI Prompts': Sparkles,
  Documents: FileText,
  Emails: Mail,
  'Work Messages': Briefcase,
  'Personal Messages': MessageSquare,
  'Other Tasks': InfinityIcon,
};

// Plural label used in the trailing text: "30 AI prompts", "12 emails", …
const CATEGORY_NOUN_PLURAL: Record<AppCategory, string> = {
  'AI Prompts': 'AI prompts',
  Documents: 'documents',
  Emails: 'emails',
  'Work Messages': 'work messages',
  'Personal Messages': 'personal messages',
  'Other Tasks': 'other tasks',
};

// Bar layout constants. The chip's pixel width is computed from `pct` so the
// trailing label can sit *right next to* the bar's actual end via flex
// layout — no manual `marginLeft` math required, and the label slides along
// smoothly while the bar animates.
const BAR_MAX_PX = 180;
const BAR_MIN_PX = 32;

// Per-row chip colour: heavier usage → deeper navy (#1E3A5F at 100%),
// lighter usage → pastel sky-blue. Returns a background HSL plus a
// contrasting label colour so the "0%" pill stays readable on its light
// tint and "77%" stays readable on a saturated dark bar.
function blueShade(pct: number): { bg: string; label: string } {
  // Lightness ramps from a soft pastel at 0% down to the navy anchor
  // (#1E3A5F ≈ hsl(212, 52%, 24%)) at 100%. Saturation lifts slightly so
  // the deeper end reads as a richer brand blue rather than washed grey.
  const lightness = 86 - (pct / 100) * 62; // 86% → 24%
  const saturation = 50 + (pct / 100) * 15; // 50% → 65%
  return {
    bg: `hsl(212, ${saturation}%, ${lightness}%)`,
    label: lightness < 55 ? 'hsl(0, 0%, 100%)' : 'hsl(212, 50%, 18%)',
  };
}

function CategoryRow({
  category,
  pct,
  count,
  apps,
}: {
  category: AppCategory;
  pct: number;
  count: number;
  apps: { name: string; count: number }[];
}) {
  const Icon = CATEGORY_ICONS[category] ?? Monitor;
  const noun = CATEGORY_NOUN_PLURAL[category] ?? 'tasks';
  const trailing = `${formatNumber(count)} ${noun}`;
  // Build a multi-line tooltip listing the raw process names that landed in
  // this bucket. This is the user's diagnostic: if a real app shows up in
  // the wrong row, the tooltip shows what raw process name was captured.
  const tooltip = apps.length
    ? `${category}\n${apps
        .slice(0, 8)
        .map((a) => `• ${a.name} (${a.count})`)
        .join('\n')}${apps.length > 8 ? `\n…and ${apps.length - 8} more` : ''}`
    : category;

  // Final pixel width of the chip (clamped to a minimum so 0% rows still
  // render a visible "0%" pill). Animating the *outer* element's width via a
  // CSS transition lets the flex container reflow the trailing label so it
  // tracks the bar's edge throughout the animation.
  const targetPx = Math.max(BAR_MIN_PX, Math.round((pct / 100) * BAR_MAX_PX));
  const shade = blueShade(pct);
  const [barPx, setBarPx] = useState(BAR_MIN_PX);
  useEffect(() => {
    let r1 = 0;
    let r2 = 0;
    setBarPx(BAR_MIN_PX); // reset for replay on remount/key change
    r1 = requestAnimationFrame(() => {
      r2 = requestAnimationFrame(() => setBarPx(targetPx));
    });
    return () => {
      cancelAnimationFrame(r1);
      cancelAnimationFrame(r2);
    };
  }, [targetPx]);

  return (
    <div className="flex items-center gap-3" title={tooltip}>
      <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center text-black">
        <Icon size={20} strokeWidth={2} />
      </span>
      <div
        className="relative flex h-5 shrink-0 items-center overflow-hidden rounded-[3px]"
        style={{
          width: `${barPx}px`,
          background: shade.bg,
          transition: 'width 750ms cubic-bezier(0.22, 1, 0.36, 1), background-color 300ms ease',
        }}
      >
        <span
          className="pointer-events-none px-1.5 text-[11px] font-semibold leading-none"
          style={{ color: shade.label }}
        >
          {pct}%
        </span>
      </div>
      <span
        className="whitespace-nowrap text-xs font-semibold uppercase tracking-[0.08em] text-black"
        title={trailing}
      >
        {trailing}
      </span>
    </div>
  );
}

// -------- Voice tab --------

function VoiceTab({ entries }: { entries: EntryWithDiff[] }) {
  const stats = useMemo(() => {
    const total = entries.length;
    const totalWords = entries.reduce((s, e) => s + e.wordCount, 0);
    const totalMs = entries.reduce((s, e) => s + e.durationMs, 0);
    const avgWordsPerEntry = total > 0 ? totalWords / total : 0;
    const avgDurationSec = total > 0 ? totalMs / total / 1000 : 0;
    const longestWords = entries.reduce((m, e) => Math.max(m, e.wordCount), 0);
    const totalMinutes = totalMs / 60_000;

    // Hour-of-day distribution (0..23).
    const hours = new Array(24).fill(0) as number[];
    for (const e of entries) {
      const t = Date.parse(e.createdAt);
      if (!Number.isFinite(t)) continue;
      hours[new Date(t).getHours()] += 1;
    }
    const hoursPeak = Math.max(1, ...hours);

    // Method breakdown.
    let cloud = 0;
    let local = 0;
    for (const e of entries) {
      if (e.method === 'cloud') cloud += 1;
      else local += 1;
    }
    const methodTotal = cloud + local || 1;

    return {
      total,
      avgWordsPerEntry,
      avgDurationSec,
      longestWords,
      totalMinutes,
      hours,
      hoursPeak,
      cloud,
      local,
      cloudPct: Math.round((cloud / methodTotal) * 100),
      localPct: 100 - Math.round((cloud / methodTotal) * 100),
    };
  }, [entries]);

  return (
    <div className="space-y-5">
      <div className="grid gap-5 md:grid-cols-3">
        <StatCard value={formatNumber(stats.avgWordsPerEntry)} label="Avg words / dictation">
          <div className="flex items-center gap-2 text-sm text-foreground/65">
            <span>Across {formatNumber(stats.total)} dictations</span>
          </div>
        </StatCard>

        <StatCard value={`${stats.avgDurationSec.toFixed(1)}s`} label="Avg dictation length">
          <div className="flex items-center gap-2 text-sm text-foreground/65">
            <span>Hold-and-speak average</span>
          </div>
        </StatCard>

        <StatCard value={`${stats.totalMinutes.toFixed(0)}m`} label="Total time spoken">
          <div className="flex items-center gap-2 text-sm text-foreground/65">
            <span>Longest: {formatNumber(stats.longestWords)} words</span>
          </div>
        </StatCard>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.6fr_1fr]">
        {/* Hour-of-day distribution */}
        <div className="rounded-xl p-6" style={{ background: 'hsl(var(--app-bg))' }}>
          <div className="flex items-baseline justify-between gap-3">
            <h3 className="card-title">When you dictate</h3>
            <span className="text-xs font-semibold uppercase tracking-[0.1em] text-foreground">
              Hour of day · local time
            </span>
          </div>
          {stats.total === 0 ? (
            <EmptyHint icon={<Clock size={18} />} text="Your dictation activity will plot here as you speak." />
          ) : (
            <div className="mt-5">
              <div className="flex h-[140px] items-end gap-[3px]">
                {stats.hours.map((count, hour) => {
                  const targetHeight = `${count > 0 ? Math.max(4, (count / stats.hoursPeak) * 100) : 2}%`;
                  return (
                    <div key={hour} className="flex flex-1 flex-col items-center gap-1" title={`${hour}:00 — ${count} ${count === 1 ? 'dictation' : 'dictations'}`}>
                      <div
                        className="w-full rounded-sm bg-foreground/85"
                        style={{ height: targetHeight, opacity: count === 0 ? 0.12 : 1 }}
                      />
                    </div>
                  );
                })}
              </div>
              <div className="mt-2 flex justify-between text-xs font-medium text-foreground">
                <span>12 AM</span>
                <span>6 AM</span>
                <span>12 PM</span>
                <span>6 PM</span>
                <span>11 PM</span>
              </div>
            </div>
          )}
        </div>

        {/* Method breakdown */}
        <div className="rounded-xl p-6" style={{ background: 'hsl(var(--app-bg))' }}>
          <div className="flex items-baseline justify-between gap-3">
            <h3 className="card-title">Transcription split</h3>
            <span className="text-xs font-semibold uppercase tracking-[0.1em] text-foreground">
              {formatNumber(stats.total)} total
            </span>
          </div>
          {stats.total === 0 ? (
            <EmptyHint icon={<Sparkles size={18} />} text="Cloud vs local breakdown shows up here once you dictate." />
          ) : (
            <div className="mt-5 space-y-3">
              <MethodRow
                icon={<Cloud size={14} />}
                label="Cloud"
                count={stats.cloud}
                pct={stats.cloudPct}
                color="#1E3A5F"
              />
              <MethodRow
                icon={<HardDrive size={14} />}
                label="Local"
                count={stats.local}
                pct={stats.localPct}
                color="#A8C5E4"
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MethodRow({
  icon,
  label,
  count,
  pct,
  color,
}: {
  icon: React.ReactNode;
  label: string;
  count: number;
  pct: number;
  color: string;
}) {
  // Mount-time 0% -> target% fill via the Web Animations API. Driving the
  // animation imperatively on the actual DOM node sidesteps React's
  // commit/batching timing — the previous useState + requestAnimationFrame
  // approach left the bar already at full width by the time the browser
  // painted, so no transition was visible.
  const fillRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = fillRef.current;
    if (!el) return;
    const anim = el.animate(
      [{ width: '0%' }, { width: `${pct}%` }],
      {
        duration: 750,
        easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
        fill: 'forwards',
      },
    );
    return () => {
      anim.cancel();
    };
  }, [pct]);

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between text-sm font-medium text-foreground">
        <span className="flex items-center gap-2">
          <span className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-black/15 bg-muted/60 text-foreground">
            {icon}
          </span>
          {label}
        </span>
        <span className="text-foreground">{count}</span>
      </div>
      <div className="h-2.5 overflow-hidden rounded-full bg-muted/60">
        <div
          ref={fillRef}
          className="h-full rounded-full"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
      <div className="mt-1 text-right text-xs font-medium text-foreground">{pct}%</div>
    </div>
  );
}

// -------- Heatmap --------

type HeatmapCell = {
  date: Date;
  words: number;
  apps: number;
  topApp: string | null;
};

type TooltipState = {
  cell: HeatmapCell;
  // Coords are relative to the heatmap container so `position: absolute`
  // works without dealing with portals or scroll offsets.
  left: number;
  top: number;
};

function Heatmap({ dailyStats }: { dailyStats: Map<string, DailyStat> }) {
  const today = startOfDay(new Date());
  // Always span Jan 1 of the current year through the end of the current
  // month so the labels read "Jan, Feb, Mar, …, <currentMonth>" and the
  // window grows automatically as new months pass.
  const yearStart = new Date(today.getFullYear(), 0, 1);
  const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  // Roll the grid origin back to the previous Sunday so each column is a
  // clean Sun..Sat week.
  const earliest = new Date(yearStart);
  earliest.setDate(earliest.getDate() - earliest.getDay());

  // Cell + gap dimensions (kept in JS so absolute month labels can align to
  // the grid columns precisely).
  const CELL = 18;
  const GAP = 5;
  const STRIDE = CELL + GAP;

  const weeks: HeatmapCell[][] = [];
  const cursor = new Date(earliest);
  while (cursor <= monthEnd) {
    const week: HeatmapCell[] = [];
    for (let i = 0; i < 7; i += 1) {
      const date = new Date(cursor);
      const stat = dailyStats.get(dateKey(date));
      let topApp: string | null = null;
      if (stat) {
        let best = -1;
        for (const [name, count] of stat.apps) {
          if (count > best) {
            best = count;
            topApp = name;
          }
        }
      }
      week.push({
        date,
        words: stat?.words ?? 0,
        apps: stat?.apps.size ?? 0,
        topApp,
      });
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(week);
  }

  const maxWords = Math.max(
    1,
    ...Array.from(dailyStats.values()).map((s) => s.words),
  );

  // Month labels — show every month from Jan up to and including the current
  // month, anchored to the first week-column whose Saturday lands in that
  // month so the label sits over its own cells rather than over the trailing
  // tail of the previous month.
  const monthLabels: { weekIndex: number; text: string }[] = [];
  for (let m = 0; m <= today.getMonth(); m += 1) {
    const monthStart = new Date(today.getFullYear(), m, 1);
    const weekIndex = weeks.findIndex((week) => week[6] && week[6].date >= monthStart);
    if (weekIndex >= 0) {
      monthLabels.push({ weekIndex, text: monthName(monthStart) });
    }
  }

  const rowLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const gridWidth = weeks.length * STRIDE - GAP;

  // Scrollable viewport ref for the prev/next arrow buttons.
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  // Delay (ms) before the hover tooltip appears so brief mouse passes don't
  // trigger flickering popups.
  const TOOLTIP_DELAY_MS = 250;
  const hoverTimerRef = useRef<number | null>(null);

  const cancelHoverTimer = () => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  };

  // Clean up any pending timer on unmount so we don't fire setState on a
  // dead component.
  useEffect(() => () => cancelHoverTimer(), []);

  // Scroll one month's worth of weeks at a time. Picks the next/previous
  // month's first column based on the current scroll position.
  const scrollByMonths = (direction: -1 | 1) => {
    const el = scrollerRef.current;
    if (!el) return;
    const currentLeft = el.scrollLeft;
    const monthOffsets = monthLabels.map((m) => m.weekIndex * STRIDE);
    if (direction > 0) {
      const next = monthOffsets.find((x) => x > currentLeft + 4);
      el.scrollTo({ left: next ?? el.scrollWidth, behavior: 'smooth' });
    } else {
      const prev = [...monthOffsets].reverse().find((x) => x < currentLeft - 4);
      el.scrollTo({ left: prev ?? 0, behavior: 'smooth' });
    }
  };

  const handleCellEnter = (cell: HeatmapCell, target: HTMLElement) => {
    cancelHoverTimer();
    // Capture rects synchronously — `target` may not be valid by the time
    // the timer fires (React reuses event objects).
    const container = containerRef.current;
    if (!container) return;
    const cRect = container.getBoundingClientRect();
    const tRect = target.getBoundingClientRect();
    const next: TooltipState = {
      cell,
      left: tRect.left - cRect.left + tRect.width / 2,
      top: tRect.top - cRect.top,
    };
    hoverTimerRef.current = window.setTimeout(() => {
      hoverTimerRef.current = null;
      setTooltip(next);
    }, TOOLTIP_DELAY_MS);
  };

  const handleCellLeave = () => {
    cancelHoverTimer();
    setTooltip(null);
  };

  const formatTooltipDate = (date: Date) =>
    date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

  return (
    <div ref={containerRef} className="relative">
      {/* Header row: navigation arrows above the grid */}
      <div className="mb-2 flex items-center justify-end gap-1">
        <button
          type="button"
          aria-label="Previous month"
          onClick={() => scrollByMonths(-1)}
          className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-black/15 text-foreground/70 transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
        >
          <ChevronLeft size={18} />
        </button>
        <button
          type="button"
          aria-label="Next month"
          onClick={() => scrollByMonths(1)}
          className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-black/15 text-foreground/70 transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
        >
          <ChevronRight size={18} />
        </button>
      </div>

      <div className="flex items-stretch gap-3">
        {/* Day-of-week labels — light grey, every row visible. */}
        <div
          className="grid pr-1 text-xs font-medium text-foreground/45"
          style={{
            gridTemplateRows: `repeat(7, ${CELL}px)`,
            rowGap: GAP,
            paddingTop: 24,
          }}
        >
          {rowLabels.map((d) => (
            <span key={d} className="leading-none">
              {d}
            </span>
          ))}
        </div>

        <div ref={scrollerRef} className="min-w-0 flex-1 overflow-x-auto">
          <div style={{ width: gridWidth }}>
            {/* Month labels row — absolutely positioned so adjacent months
                never overlap. */}
            <div className="relative mb-1.5 h-5 text-xs font-semibold text-foreground/70">
              {monthLabels.map(({ weekIndex, text }) => (
                <span
                  key={`${weekIndex}-${text}`}
                  className="absolute top-0 whitespace-nowrap"
                  style={{ left: weekIndex * STRIDE }}
                >
                  {text}
                </span>
              ))}
            </div>
            {/* Grid */}
            <div className="flex" style={{ gap: GAP }}>
              {weeks.map((week, wi) => (
                <div key={wi} className="flex flex-col" style={{ gap: GAP }}>
                  {week.map((cell) => {
                    const inRange = cell.date >= yearStart && cell.date <= today;
                    const isFutureSameMonth = cell.date > today && cell.date <= monthEnd;
                    return (
                      <div
                        key={dateKey(cell.date)}
                        className="rounded-[3px] transition-transform"
                        style={{
                          height: CELL,
                          width: CELL,
                          background: inRange
                            ? heatmapColor(cell.words, maxWords)
                            : isFutureSameMonth
                              ? 'hsl(var(--muted) / 0.5)'
                              : 'transparent',
                          // Pointer cursor only on cells that actually
                          // surface a tooltip — future days stay default.
                          cursor: cell.date > today ? 'default' : 'pointer',
                        }}
                        onMouseEnter={(e) => {
                          if (cell.date > today) return;
                          handleCellEnter(cell, e.currentTarget);
                        }}
                        onMouseLeave={handleCellLeave}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-end gap-1.5 text-xs font-medium text-foreground/55">
        <span>Less</span>
        {[0, 0.25, 0.5, 0.75, 1].map((r, i) => (
          <span
            key={i}
            className="h-[12px] w-[12px] rounded-[3px]"
            style={{ background: heatmapColor(r * 100, 100) }}
          />
        ))}
        <span>More</span>
      </div>

      {/* Hover tooltip: positioned above the cell, centered horizontally. */}
      {tooltip && (
        <div
          className="pointer-events-none absolute z-50 w-[200px] -translate-x-1/2 -translate-y-full rounded-lg border border-black/15 bg-background px-3.5 py-3 text-foreground shadow-[0_10px_30px_-12px_rgba(15,23,42,0.25)]"
          style={{ left: tooltip.left, top: tooltip.top - 6 }}
        >
          <div className="text-sm font-semibold">{formatTooltipDate(tooltip.cell.date)}</div>
          <div className="my-2 h-px w-full bg-border" />
          <div className="flex items-center justify-between text-[12px]">
            <span className="text-foreground/65">Total words</span>
            <span className="font-semibold text-foreground">{formatNumber(tooltip.cell.words)}</span>
          </div>
          <div className="mt-1 flex items-center justify-between text-[12px]">
            <span className="text-foreground/65">Total apps used</span>
            <span className="font-semibold text-foreground">{tooltip.cell.apps}</span>
          </div>
          <div className="mt-1 flex items-center justify-between gap-3 text-[12px]">
            <span className="text-foreground/65">Top app</span>
            <span className="truncate font-semibold text-foreground">
              {tooltip.cell.topApp ?? '—'}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function heatmapColor(words: number, max: number): string {
  if (words <= 0) return 'hsl(var(--muted))';
  const ratio = Math.min(1, words / max);
  // Map 0..1 → 0.40..1.0 alpha against the dark foreground. The higher
  // floor keeps low-activity days clearly distinguishable from empty days,
  // which were previously almost invisible at 0.18 alpha.
  const alpha = 0.40 + ratio * 0.60;
  return `hsl(var(--foreground) / ${alpha.toFixed(3)})`;
}

function monthName(date: Date): string {
  return date.toLocaleString(undefined, { month: 'short' });
}

// -------- Streaks --------

type DailyStat = {
  words: number;
  apps: Map<string, number>;
};

function computeStreaks(entries: DictationEntry[]): {
  currentStreak: number;
  longestStreak: number;
  dailyStats: Map<string, DailyStat>;
} {
  const dailyStats = new Map<string, DailyStat>();
  for (const e of entries) {
    const t = Date.parse(e.createdAt);
    if (!Number.isFinite(t)) continue;
    const key = dateKey(new Date(t));
    let stat = dailyStats.get(key);
    if (!stat) {
      stat = { words: 0, apps: new Map() };
      dailyStats.set(key, stat);
    }
    stat.words += e.wordCount;
    const appName = e.appName?.trim() || 'Unknown';
    stat.apps.set(appName, (stat.apps.get(appName) ?? 0) + e.wordCount);
  }

  if (dailyStats.size === 0) {
    return { currentStreak: 0, longestStreak: 0, dailyStats };
  }

  const sortedKeys = Array.from(dailyStats.keys()).sort();
  // Longest streak.
  let longest = 1;
  let run = 1;
  let prev = new Date(sortedKeys[0]);
  for (let i = 1; i < sortedKeys.length; i += 1) {
    const cur = new Date(sortedKeys[i]);
    const gap = daysBetween(cur, prev);
    if (gap === 1) {
      run += 1;
      longest = Math.max(longest, run);
    } else if (gap > 1) {
      run = 1;
    }
    prev = cur;
  }

  // Current streak: count consecutive days ending today (or yesterday).
  const today = startOfDay(new Date());
  let current = 0;
  let cursor = new Date(today);
  // If no entry today, allow yesterday to count as the start of the streak so
  // we don't penalize a user who hasn't dictated yet today.
  if (!dailyStats.has(dateKey(cursor))) {
    cursor.setDate(cursor.getDate() - 1);
  }
  while (dailyStats.has(dateKey(cursor))) {
    current += 1;
    cursor.setDate(cursor.getDate() - 1);
  }

  return { currentStreak: current, longestStreak: longest, dailyStats };
}

// -------- Empty hint --------

function EmptyHint({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="mt-6 flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-black/15 py-10 text-center">
      <span className="text-foreground">{icon}</span>
      <p className="max-w-[34ch] text-sm text-foreground/65">{text}</p>
    </div>
  );
}

// -------- Page --------

export default function InsightsView() {
  const [tab, setTab] = useState<InsightsTab>('usage');
  const [entries, setEntries] = useState<EntryWithDiff[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const raw = (await window.api.getHistory(HISTORY_FETCH_LIMIT, 0)) as DictationEntry[];
      if (cancelled) return;
      const enriched: EntryWithDiff[] = raw.map((e) => {
        const wordsCorrected = computeWordsCorrected(e);
        return {
          ...e,
          wordsCorrected,
          wasCorrected: !!e.rawText && e.rawText.trim() !== e.text.trim(),
        };
      });
      setEntries(enriched);
    }
    void load();

    // Live-refresh: when a new dictation lands while the user is on the
    // Insights page, re-fetch so the new entry's app shows up in the
    // category breakdown immediately.
    const api = window.api;
    const offTranscription =
      typeof api?.onTranscriptionResult === 'function'
        ? api.onTranscriptionResult(() => {
            if (!cancelled) void load();
          })
        : undefined;

    return () => {
      cancelled = true;
      if (typeof offTranscription === 'function') offTranscription();
    };
  }, []);

  return (
    // Two-region layout: header + tabs stay pinned, only the chosen tab's
    // content scrolls. Mirrors the Dashboard treatment so the page reads
    // as one consistent shell across the app.
    <div className="relative flex h-full flex-col px-7 pt-6">
      <div className="page-header shrink-0">
        <div>
          <h1 className="page-title">Insights</h1>
          <p className="page-subtitle">A clear view of how often, how fast, and where you dictate.</p>
        </div>
      </div>

      <div className="shrink-0 mb-5 flex items-end gap-5 border-b border-black/15">
        <ScopeTab label="Your Usage" active={tab === 'usage'} onClick={() => setTab('usage')} />
        <ScopeTab label="Your Voice" active={tab === 'voice'} onClick={() => setTab('voice')} />
      </div>

      {/* Inner scroll region — bleeds to the page edge so the scrollbar
          sits flush with the window while content keeps its 28px gutter. */}
      <div
        className="-mx-7 flex-1 min-h-0 overflow-y-auto px-7 pb-8"
        style={{ scrollbarGutter: 'stable' }}
      >
        {entries === null ? (
          <div className="grid gap-5 md:grid-cols-3">
            <StatSkeleton />
            <StatSkeleton />
            <StatSkeleton />
          </div>
        ) : tab === 'usage' ? (
          // `key` forces a fresh mount on tab change so each AnimatedBar
          // replays its 0 -> target transition.
          <UsageTab key="usage" entries={entries} />
        ) : (
          <VoiceTab key="voice" entries={entries} />
        )}
      </div>
    </div>
  );
}

function StatSkeleton() {
  return <div className="h-[180px] animate-pulse rounded-xl bg-muted/40" />;
}

