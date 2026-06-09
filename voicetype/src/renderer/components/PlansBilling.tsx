import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Check,
  ExternalLink,
  Loader2,
  Sparkles,
  X as XIcon,
} from 'lucide-react';
import type { EntitlementsPayload } from '../api';
import type { DictationEntry } from '../../shared/types';
import { toast } from './toast/useToast';

/*
 * Plans & Billing — redesigned to match the Echo redesign mockup.
 *
 * Layout: monthly usage hero card with progress bar, billing-cycle toggle,
 * and a flat two-column plan grid (Basic on the left, Pro on the right
 * with a clay "RECOMMENDED" badge). Stripe + entitlements wiring is
 * preserved from the previous implementation.
 */

const SECONDS_PER_HOUR = 3600;
const BASIC_WEEKLY_WORDS_CAP = 2000;
const PRICE_MONTHLY = '£8';
const PRICE_YEARLY = '£80';
const YEARLY_PER_MONTH = '£6.67';
// (8 * 12 - 80) / (8 * 12) = 16.67% — round to nearest whole.
const YEARLY_SAVINGS_PCT = 17;
const YEARLY_SAVINGS_LABEL = `Save ${YEARLY_SAVINGS_PCT}%`;

type BillingCycle = 'monthly' | 'yearly';
type Busy = 'checkout-monthly' | 'checkout-yearly' | 'portal' | null;
type FairUseSummary = {
  usedPct: number;
  used: string;
  cap: string;
  remaining: string;
};

type WeeklyUsageSummary = {
  usedWords: number;
  capWords: number;
  usedPct: number;
  remainingWords: number;
  projectedRunOutLabel: string | null;
};

function formatHours(seconds: number): string {
  const hours = seconds / SECONDS_PER_HOUR;
  if (hours < 1) return `${Math.round(seconds / 60)} min`;
  if (hours < 10) return `${hours.toFixed(1)} hrs`;
  return `${Math.round(hours)} hrs`;
}

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function formatPlanEnd(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }).toUpperCase();
}

function startOfWeek(d: Date): Date {
  // Monday as the first day of the week.
  const day = d.getDay();
  const offset = day === 0 ? -6 : 1 - day;
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset);
  return monday;
}

function startOfNextWeek(d: Date): Date {
  const monday = startOfWeek(d);
  return new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 7);
}

function summarizeWeeklyUsage(history: DictationEntry[]): WeeklyUsageSummary {
  const now = new Date();
  const weekStart = startOfWeek(now).getTime();
  let usedWords = 0;
  for (const entry of history) {
    const t = Date.parse(entry.createdAt);
    if (!Number.isFinite(t) || t < weekStart) continue;
    usedWords += Math.max(0, entry.wordCount ?? 0);
  }
  const cap = BASIC_WEEKLY_WORDS_CAP;
  const usedPct = Math.min(100, Math.round((usedWords / cap) * 100));
  const remaining = Math.max(0, cap - usedWords);
  const resetDate = startOfNextWeek(now);

  // Project the day this week the user will run out at current daily pace.
  const msSinceWeekStart = now.getTime() - weekStart;
  const daysIntoWeek = Math.max(1, msSinceWeekStart / 86_400_000);
  const dailyAverage = usedWords / daysIntoWeek;
  let projectedLabel: string | null = null;
  if (dailyAverage > 0 && usedWords < cap) {
    const daysUntilCap = (cap - usedWords) / dailyAverage;
    const projected = new Date(now.getTime() + Math.ceil(daysUntilCap) * 86_400_000);
    if (projected < resetDate) {
      projectedLabel = projected.toLocaleDateString(undefined, { weekday: 'long' });
    }
  }

  return {
    usedWords,
    capWords: cap,
    usedPct,
    remainingWords: remaining,
    projectedRunOutLabel: projectedLabel,
  };
}

const BASIC_INCLUDED: ReadonlyArray<string> = [
  '90 minutes of dictation / month',
  'Personal dictionary (up to 25 terms)',
  'Filler-word cleanup',
  '5 custom shortcuts',
  'Local history (last 30 days)',
];

const BASIC_NOT_INCLUDED: ReadonlyArray<string> = [
  'Custom writing tones',
  'Voice training',
  'Cloud sync across devices',
];

const PRO_FEATURES: ReadonlyArray<string> = [
  'Unlimited dictation',
  'Unlimited dictionary terms',
  'Filler-word cleanup + polish',
  'Unlimited custom shortcuts',
  'Cloud history, searchable forever',
  'Custom writing tones (up to 12)',
  'Voice training on your speech',
  'Sync across Mac, iPhone, iPad',
];

export default function PlansBilling() {
  const [billingConfigured, setBillingConfigured] = useState<boolean | null>(null);
  const [ent, setEnt] = useState<EntitlementsPayload | null>(null);
  const [usage, setUsage] = useState<WeeklyUsageSummary | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [cycle, setCycle] = useState<BillingCycle>('yearly');

  async function refreshUsage() {
    const data = await window.api.getDashboardData(10_000, 0);
    setUsage(summarizeWeeklyUsage(data.history));
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [cfg, current] = await Promise.all([
        window.api.billingConfigStatus(),
        window.api.entitlementsGet(),
      ]);
      if (cancelled) return;
      setBillingConfigured(cfg.configured);
      setEnt(current);
      void refreshUsage();
      if (cfg.configured && current.tier !== 'pro' && !current.fetchedAt) {
        await window.api.entitlementsRefresh();
      }
    })();
    const offEnt = window.api.onEntitlementsChanged((next) => setEnt(next));
    const offTranscription = window.api.onTranscriptionResult(() => {
      void refreshUsage();
    });
    const offDeepLink = window.api.onBillingDeepLink((url) => {
      if (/billing\/success/i.test(url)) {
        toast.success('Welcome to Echo Pro! Cloud features are now unlocked.');
      } else if (/billing\/cancel/i.test(url)) {
        toast.info('Checkout cancelled. You can upgrade any time.');
      }
    });
    return () => {
      cancelled = true;
      offEnt();
      offTranscription();
      offDeepLink();
    };
  }, []);

  async function handleCheckout(plan: 'pro_monthly' | 'pro_yearly') {
    setBusy(plan === 'pro_monthly' ? 'checkout-monthly' : 'checkout-yearly');
    try {
      const result = await window.api.billingStartCheckout(plan);
      if (!result.ok) {
        toast.error(result.error || 'Could not start checkout.');
        return;
      }
      toast.info("Opened checkout in your browser. Come back when you're done!");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Could not start checkout.');
    } finally {
      setBusy(null);
    }
  }

  async function handlePortal() {
    setBusy('portal');
    try {
      const result = await window.api.billingOpenPortal();
      if (!result.ok) {
        toast.error(result.error || 'Could not open the billing portal.');
        return;
      }
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Could not open the billing portal.');
    } finally {
      setBusy(null);
    }
  }

  const isLoading = !ent || ent.loading;
  const tier = ent?.tier ?? 'anonymous';
  const isPro = tier === 'pro';
  const isInternalGrant = ent?.status === 'developer' || ent?.status === 'admin';
  const needsPortalNotCheckout = ent?.status === 'past_due' || ent?.status === 'unpaid';

  const fairUseSummary = useMemo<FairUseSummary | null>(() => {
    if (!ent) return null;
    if (ent.fairUseCapSeconds <= 0) return null;
    const usedPct = Math.min(
      100,
      Math.round((ent.fairUseUsedSeconds / ent.fairUseCapSeconds) * 100),
    );
    return {
      usedPct,
      used: formatHours(ent.fairUseUsedSeconds),
      cap: formatHours(ent.fairUseCapSeconds),
      remaining: formatHours(ent.fairUseRemainingSeconds),
    };
  }, [ent]);

  if (billingConfigured === false) {
    return (
      <div className="rounded-xl bg-popover/70 px-5 py-10 text-center">
        <div className="text-base font-semibold text-foreground">Billing isn't configured</div>
        <div className="mt-1.5 text-sm text-muted-foreground">
          This build of Echo doesn't have billing wired up. You're using the local-only edition.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {isLoading ? (
        <div className="rounded-2xl bg-popover px-5 py-8">
          <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading your plan…
          </div>
        </div>
      ) : isInternalGrant ? (
        <InternalGrantHero ent={ent} />
      ) : isPro ? (
        <ActiveProHero
          ent={ent}
          busy={busy}
          onPortal={handlePortal}
          fairUseSummary={fairUseSummary}
        />
      ) : (
        <>
          <UsageHero usage={usage} tier={tier} ent={ent} />

          {needsPortalNotCheckout ? (
            <div className="rounded-2xl bg-popover p-5">
              <div className="flex items-start gap-3">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                <div className="flex-1">
                  <div className="text-[15px] font-semibold text-foreground">
                    Your last payment didn't go through
                  </div>
                  <p className="mt-1 text-[13px] text-muted-foreground">
                    Update your card in the Stripe portal and Pro will resume automatically.
                  </p>
                  <button
                    type="button"
                    onClick={handlePortal}
                    disabled={busy !== null}
                    className="echo-btn echo-btn-dark mt-4 disabled:opacity-60"
                  >
                    {busy === 'portal' ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <ExternalLink className="h-3.5 w-3.5" />
                    )}
                    Update payment method
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <>
              <div className="flex justify-center">
                <CycleToggle value={cycle} onChange={setCycle} />
              </div>
              <div data-plans-grid className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <BasicPlanCard isCurrent />
                <ProPlanCard
                  cycle={cycle}
                  busy={busy}
                  onUpgrade={() =>
                    handleCheckout(cycle === 'monthly' ? 'pro_monthly' : 'pro_yearly')
                  }
                />
              </div>
            </>
          )}
        </>
      )}

      {ent?.error ? (
        <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-700">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{ent.error}</span>
        </div>
      ) : null}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────
 * Sections
 * ──────────────────────────────────────────────────────────────────── */

function UsageHero({
  usage,
  tier,
  ent,
}: {
  usage: WeeklyUsageSummary | null;
  tier: string;
  ent: EntitlementsPayload | null;
}) {
  if (!usage) {
    return (
      <div
        style={{
          border: '1px solid var(--line)',
          background: 'var(--card-soft)',
          borderRadius: 14,
          padding: '18px 22px',
        }}
      >
        <div style={{ fontSize: 13, color: 'var(--ink-muted)' }}>Loading usage…</div>
      </div>
    );
  }

  const planLabel = tier === 'pro' ? 'PRO' : 'BASIC';
  const captionLeft =
    usage.projectedRunOutLabel
      ? `You typically run out by ${usage.projectedRunOutLabel}. Pro removes the cap.`
      : usage.usedWords >= usage.capWords
        ? 'You hit this week’s cap. Pro removes the cap.'
        : 'Upgrade to Pro to have unlimited dictation!';

  // RESETS only makes sense when a plan is actually active. Free / anonymous
  // tiers don't have a plan period, so we show N/A. Trialing users get the
  // trial end; everyone else with a subscription gets currentPeriodEnd.
  const hasActivePlan = tier === 'pro' || ent?.status === 'trialing';
  const planEndIso =
    ent?.status === 'trialing' ? ent?.trialEnd ?? null : ent?.currentPeriodEnd ?? null;
  const planEndLabel = hasActivePlan && planEndIso ? formatPlanEnd(planEndIso) : null;
  const resetsValue = planEndLabel ?? 'N/A';
  const resetsRow = ent?.cancelAtPeriodEnd ? 'Ends' : 'Renews';
  const resetsLabel = hasActivePlan ? resetsRow : 'Renews';

  return (
    <div
      style={{
        border: '1px solid var(--line)',
        background: 'var(--card-soft)',
        borderRadius: 14,
        padding: '14px 20px',
      }}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div
            style={{
              fontSize: 10.5,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: 'var(--ink-muted)',
              fontWeight: 500,
            }}
          >
            Your usage this week
          </div>
          <div
            style={{
              marginTop: 6,
              fontFamily: 'var(--font-display)',
              fontSize: 26,
              color: 'var(--ink)',
              letterSpacing: '-0.01em',
              lineHeight: 1,
            }}
          >
            <span style={{ fontWeight: 500 }}>{usage.usedWords.toLocaleString()}</span>
            <span style={{ color: 'var(--ink-muted)', fontWeight: 400 }}>
              {' '}/ {usage.capWords.toLocaleString()}
            </span>
            <span style={{ fontSize: 15, color: 'var(--ink-soft)', marginLeft: 6 }}>words</span>
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <UsageMeta label="Plan" value={planLabel} />
          <UsageMeta label={resetsLabel} value={resetsValue} style={{ marginTop: 4 }} />
        </div>
      </div>

      <div
        style={{
          marginTop: 12,
          height: 5,
          width: '100%',
          background: 'var(--line-soft)',
          borderRadius: 999,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${usage.usedPct}%`,
            height: '100%',
            background: 'var(--clay)',
            borderRadius: 999,
            transition: 'width 220ms ease',
          }}
          aria-hidden
        />
      </div>

      <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--ink-soft)' }}>{captionLeft}</div>
    </div>
  );
}

function UsageMeta({
  label,
  value,
  style,
}: {
  label: string;
  value: string;
  style?: React.CSSProperties;
}) {
  return (
    <div style={{ ...style }}>
      <span
        style={{
          fontSize: 10,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--ink-muted)',
          fontWeight: 500,
          marginRight: 8,
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: 11,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          color: 'var(--ink-2)',
          fontWeight: 600,
        }}
      >
        {value}
      </span>
    </div>
  );
}

function BasicPlanCard({ isCurrent }: { isCurrent: boolean }) {
  return (
    <div
      style={{
        background: 'var(--card-raw)',
        border: '1px solid var(--line-soft)',
        borderRadius: 13,
        padding: '14px 16px 15px',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div className="flex items-start justify-between">
        <h3
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 19,
            fontWeight: 500,
            color: 'var(--ink)',
            margin: 0,
            letterSpacing: '-0.01em',
          }}
        >
          Basic
        </h3>
        <span
          style={{
            fontSize: 9.5,
            letterSpacing: '0.13em',
            textTransform: 'uppercase',
            color: 'var(--ink-muted)',
            fontWeight: 500,
          }}
        >
          {isCurrent ? 'Current plan' : 'Forever free'}
        </span>
      </div>

      <div
        style={{
          marginTop: 7,
          fontFamily: 'var(--font-display)',
          fontSize: 20,
          color: 'var(--ink)',
          fontWeight: 500,
          letterSpacing: '-0.01em',
        }}
      >
        £0
        <span style={{ fontSize: 12, color: 'var(--ink-muted)', fontWeight: 400, marginLeft: 4 }}>
          / forever
        </span>
      </div>

      <button
        type="button"
        disabled
        className="echo-btn echo-btn-outline"
        style={{ marginTop: 11, height: 34, cursor: 'default' }}
      >
        {isCurrent ? 'Your current plan' : 'Stay on Basic'}
      </button>

      <div style={{ marginTop: 12, height: 1, background: 'var(--line-soft)' }} />

      <ul style={{ listStyle: 'none', margin: 0, padding: '8px 0 0' }}>
        {BASIC_INCLUDED.map((label) => (
          <FeatureRow key={label} label={label} included />
        ))}
        {BASIC_NOT_INCLUDED.map((label) => (
          <FeatureRow key={label} label={label} included={false} />
        ))}
      </ul>
    </div>
  );
}

function ProPlanCard({
  cycle,
  busy,
  onUpgrade,
}: {
  cycle: BillingCycle;
  busy: Busy;
  onUpgrade: () => void;
}) {
  const isYearly = cycle === 'yearly';
  const priceLine = isYearly ? PRICE_YEARLY : PRICE_MONTHLY;
  const priceSuffix = isYearly ? '/ year' : '/ month';
  const ctaLoading = busy === (isYearly ? 'checkout-yearly' : 'checkout-monthly');

  return (
    <div
      style={{
        position: 'relative',
        background: 'var(--card-raw)',
        border: '1px solid var(--line-soft)',
        borderRadius: 13,
        padding: '14px 16px 15px',
        display: 'flex',
        flexDirection: 'column',
        boxShadow: '0 12px 32px -22px rgba(201, 100, 66, 0.45)',
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: -8,
          right: 16,
          background: 'var(--clay)',
          color: 'var(--ivory)',
          fontSize: 9.5,
          letterSpacing: '0.13em',
          textTransform: 'uppercase',
          fontWeight: 600,
          padding: '2px 8px',
          borderRadius: 5,
          boxShadow: '0 6px 16px -8px rgba(201, 100, 66, 0.7)',
        }}
      >
        Recommended
      </span>

      <div className="flex items-start justify-between">
        <h3
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 19,
            fontWeight: 500,
            color: 'var(--ink)',
            margin: 0,
            letterSpacing: '-0.01em',
          }}
        >
          Pro
        </h3>
        <span
          style={{
            fontSize: 9.5,
            letterSpacing: '0.13em',
            textTransform: 'uppercase',
            color: 'var(--ink-muted)',
            fontWeight: 500,
          }}
        >
        </span>
      </div>

      <div
        style={{
          marginTop: 7,
          fontFamily: 'var(--font-display)',
          fontSize: 20,
          color: 'var(--ink)',
          fontWeight: 500,
          letterSpacing: '-0.01em',
          display: 'flex',
          alignItems: 'baseline',
          gap: 7,
          flexWrap: 'wrap',
        }}
      >
        <span>
          {priceLine}
          <span style={{ fontSize: 12, color: 'var(--ink-muted)', fontWeight: 400, marginLeft: 4 }}>
            {priceSuffix}
          </span>
        </span>
        {isYearly ? (
          <span
            style={{
              fontFamily: 'var(--font-sans, inherit)',
              fontSize: 10.5,
              fontWeight: 500,
              color: 'var(--ink-2)',
              background: 'var(--card-soft)',
              border: '1px solid var(--line-soft)',
              padding: '2px 8px',
              borderRadius: 999,
              letterSpacing: 0,
              textTransform: 'none',
            }}
          >
            {YEARLY_PER_MONTH} per month
          </span>
        ) : null}
      </div>

      <button
        type="button"
        onClick={onUpgrade}
        disabled={busy !== null}
        className="echo-btn echo-btn-dark"
        style={{
          marginTop: 11,
          height: 34,
          width: '100%',
          justifyContent: 'center',
          fontSize: 13.5,
        }}
      >
        {ctaLoading ? <Loader2 size={13} className="animate-spin" /> : null}
        Upgrade to Pro
      </button>

      <div style={{ marginTop: 12, height: 1, background: 'var(--line-soft)' }} />

      <div
        style={{
          marginTop: 8,
          fontSize: 12,
          color: 'var(--ink-2)',
          fontWeight: 500,
        }}
      >
        Everything in Basic, plus:
      </div>

      <ul style={{ listStyle: 'none', margin: 0, padding: '5px 0 0' }}>
        {PRO_FEATURES.map((label) => (
          <FeatureRow key={label} label={label} included pro />
        ))}
      </ul>
    </div>
  );
}

function FeatureRow({
  label,
  included,
  pro,
}: {
  label: string;
  included: boolean;
  pro?: boolean;
}) {
  const tickColor = included ? (pro ? 'var(--moss)' : 'var(--ink-2)') : 'var(--ink-faint)';
  const labelColor = included ? 'var(--ink-2)' : 'var(--ink-muted)';
  const Icon = included ? Check : XIcon;
  return (
    <li
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 7,
        padding: '2.5px 0',
        fontSize: 12,
        lineHeight: 1.38,
        color: labelColor,
      }}
    >
      <span style={{ marginTop: 1.5, flexShrink: 0, color: tickColor, display: 'inline-flex' }}>
        <Icon size={11.5} strokeWidth={2.4} />
      </span>
      <span style={{ textDecoration: included ? 'none' : 'none' }}>{label}</span>
    </li>
  );
}

function ActiveProHero({
  ent,
  busy,
  onPortal,
  fairUseSummary,
}: {
  ent: EntitlementsPayload;
  busy: Busy;
  onPortal: () => void;
  fairUseSummary: FairUseSummary | null;
}) {
  const renews = formatDate(ent.currentPeriodEnd);
  const planLabel = ent.plan === 'pro_yearly' ? 'Echo Pro · Yearly' : 'Echo Pro · Monthly';
  const stateLine =
    ent.cancelAtPeriodEnd && renews
      ? `Cancels on ${renews}. You'll keep Pro access until then.`
      : ent.status === 'trialing' && ent.trialEnd
        ? `Trial ends ${formatDate(ent.trialEnd) ?? 'soon'}.`
        : renews
          ? `Renews on ${renews}.`
          : 'Active.';

  return (
    <div
      style={{
        background: 'var(--card-raw)',
        border: '1px solid var(--line-soft)',
        borderRadius: 16,
        padding: '22px 24px',
      }}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              background: 'var(--clay)',
              color: 'var(--ivory)',
              padding: '3px 8px',
              fontSize: 10,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              fontWeight: 600,
              borderRadius: 999,
            }}
          >
            <Sparkles size={11} /> Pro
          </span>
          <h2
            style={{
              marginTop: 10,
              fontFamily: 'var(--font-display)',
              fontSize: 22,
              fontWeight: 500,
              color: 'var(--ink)',
              letterSpacing: '-0.01em',
            }}
          >
            {planLabel}
          </h2>
          <p style={{ marginTop: 4, fontSize: 13, color: 'var(--ink-soft)' }}>{stateLine}</p>
        </div>

        <button
          type="button"
          onClick={onPortal}
          disabled={busy !== null}
          className="echo-btn echo-btn-dark"
        >
          {busy === 'portal' ? <Loader2 size={13} className="animate-spin" /> : <ExternalLink size={13} />}
          Manage
        </button>
      </div>

      {fairUseSummary ? (
        <div
          style={{
            marginTop: 18,
            background: 'var(--card-soft)',
            borderRadius: 10,
            padding: '14px 16px',
          }}
        >
          <div className="flex items-baseline justify-between gap-3">
            <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--ink-2)' }}>
              Cloud usage · last 30 days
            </span>
            <span style={{ fontSize: 11, color: 'var(--ink-muted)' }}>
              {fairUseSummary.used} of {fairUseSummary.cap}
            </span>
          </div>
          <div
            style={{
              marginTop: 8,
              height: 5,
              background: 'var(--line-soft)',
              borderRadius: 999,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: `${fairUseSummary.usedPct}%`,
                height: '100%',
                background: 'var(--clay)',
                borderRadius: 999,
              }}
              aria-hidden
            />
          </div>
        </div>
      ) : null}

      <ul style={{ listStyle: 'none', margin: '20px 0 0', padding: 0 }}>
        {PRO_FEATURES.map((label) => (
          <FeatureRow key={label} label={label} included pro />
        ))}
      </ul>
    </div>
  );
}

function InternalGrantHero({ ent }: { ent: EntitlementsPayload | null }) {
  const role = ent?.status === 'admin' ? 'Admin' : 'Developer';
  return (
    <div
      style={{
        background: 'var(--card-raw)',
        border: '1px solid var(--line-soft)',
        borderRadius: 16,
        padding: '22px 24px',
      }}
    >
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          background: 'var(--clay)',
          color: 'var(--ivory)',
          padding: '3px 8px',
          fontSize: 10,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          fontWeight: 600,
          borderRadius: 999,
        }}
      >
        <Sparkles size={11} /> Pro · {role}
      </span>
      <h2
        style={{
          marginTop: 10,
          fontFamily: 'var(--font-display)',
          fontSize: 22,
          fontWeight: 500,
          color: 'var(--ink)',
          letterSpacing: '-0.01em',
        }}
      >
        Echo Pro · {role}
      </h2>
      <p style={{ marginTop: 4, fontSize: 13, color: 'var(--ink-soft)' }}>
        Lifetime internal access. Cloud features are unlocked without Stripe billing.
      </p>
      <ul style={{ listStyle: 'none', margin: '20px 0 0', padding: 0 }}>
        {PRO_FEATURES.map((label) => (
          <FeatureRow key={label} label={label} included pro />
        ))}
      </ul>
    </div>
  );
}

function CycleToggle({
  value,
  onChange,
}: {
  value: BillingCycle;
  onChange: (next: BillingCycle) => void;
}) {
  const monthlyRef = useRef<HTMLButtonElement>(null);
  const yearlyRef = useRef<HTMLButtonElement>(null);
  const [thumb, setThumb] = useState<{ left: number; width: number }>({ left: 0, width: 0 });
  const [ready, setReady] = useState(false);

  useLayoutEffect(() => {
    const target = value === 'monthly' ? monthlyRef.current : yearlyRef.current;
    if (!target) return;
    setThumb({ left: target.offsetLeft, width: target.offsetWidth });
    setReady(true);
  }, [value]);

  useEffect(() => {
    function update() {
      const target = value === 'monthly' ? monthlyRef.current : yearlyRef.current;
      if (!target) return;
      setThumb({ left: target.offsetLeft, width: target.offsetWidth });
    }
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [value]);

  return (
    <div
      role="tablist"
      aria-label="Billing cycle"
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        background: 'var(--card-soft)',
        border: '1px solid var(--line-soft)',
        borderRadius: 999,
        padding: 3,
        fontSize: 12,
        fontWeight: 500,
      }}
    >
      <span
        aria-hidden
        style={{
          position: 'absolute',
          top: 3,
          bottom: 3,
          left: thumb.left,
          width: thumb.width,
          background: 'var(--card-raw)',
          borderRadius: 999,
          boxShadow: '0 1px 2px rgba(31, 27, 22, 0.08)',
          opacity: ready ? 1 : 0,
          transition: 'left 220ms cubic-bezier(0.4, 0, 0.2, 1), width 220ms cubic-bezier(0.4, 0, 0.2, 1)',
        }}
      />
      <button
        ref={monthlyRef}
        type="button"
        role="tab"
        aria-selected={value === 'monthly'}
        onClick={() => onChange('monthly')}
        style={{
          position: 'relative',
          zIndex: 1,
          height: 24,
          padding: '0 18px',
          background: 'transparent',
          border: 'none',
          color: value === 'monthly' ? 'var(--ink)' : 'var(--ink-muted)',
          fontWeight: 500,
          cursor: 'pointer',
          borderRadius: 999,
          fontFamily: 'inherit',
        }}
      >
        Monthly
      </button>
      <button
        ref={yearlyRef}
        type="button"
        role="tab"
        aria-selected={value === 'yearly'}
        onClick={() => onChange('yearly')}
        style={{
          position: 'relative',
          zIndex: 1,
          height: 24,
          padding: '0 12px 0 18px',
          background: 'transparent',
          border: 'none',
          color: value === 'yearly' ? 'var(--ink)' : 'var(--ink-muted)',
          fontWeight: 500,
          cursor: 'pointer',
          borderRadius: 999,
          fontFamily: 'inherit',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        Yearly
        <span
          style={{
            background: 'rgba(110, 139, 92, 0.18)',
            color: '#4F6940',
            fontSize: 9.5,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            fontWeight: 600,
            padding: '2px 6px',
            borderRadius: 999,
          }}
        >
          {YEARLY_SAVINGS_LABEL}
        </span>
      </button>
    </div>
  );
}
