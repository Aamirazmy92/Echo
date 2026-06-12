// Entitlements cache + change broadcaster.
//
// We keep a single in-memory snapshot of the signed-in user's plan
// (free / pro), refresh it on:
//   * sign-in
//   * sign-out (clears to anonymous)
//   * a successful return from Stripe Checkout/Portal (deep link)
//   * an explicit refresh call from the renderer
//   * a periodic timer (every 10 minutes) so we eventually notice
//     server-side changes (cancel, upgrade by support, etc.)
//
// Anything that wants to react to plan changes subscribes via
// onEntitlementsChanged. The IPC layer (preload + index) bridges this
// to the renderer.

import { BrowserWindow } from 'electron';
import { fetchEntitlements, RawEntitlementsRpcResult } from './cloud';
import { ensureCurrentSession, getCurrentSession, onAuthStateChange } from './auth';
import { logInfo, logWarn } from './logger';

export type EntitlementTier = 'anonymous' | 'free' | 'pro';

export interface Entitlements {
  tier: EntitlementTier;
  status: string;
  plan: 'pro_monthly' | 'pro_yearly' | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  trialEnd: string | null;
  fairUseExceeded: boolean;
  fairUseRemainingSeconds: number;
  fairUseUsedSeconds: number;
  fairUseCapSeconds: number;
  fetchedAt: number;
  /** Set to true while a refresh request is in flight. */
  loading: boolean;
  /** Last error from a refresh, if any. */
  error: string | null;
}

const ANONYMOUS: Entitlements = {
  tier: 'anonymous',
  status: 'anonymous',
  plan: null,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  trialEnd: null,
  fairUseExceeded: false,
  fairUseRemainingSeconds: 0,
  fairUseUsedSeconds: 0,
  fairUseCapSeconds: 0,
  fetchedAt: 0,
  loading: false,
  error: null,
};

const REFRESH_INTERVAL_MS = 10 * 60_000; // every 10 minutes
const POST_BILLING_RETRY_DELAYS_MS = [1_000, 3_000, 8_000];

let current: Entitlements = { ...ANONYMOUS };
let refreshTimer: NodeJS.Timeout | null = null;
let inflight: Promise<Entitlements> | null = null;
const listeners = new Set<(ent: Entitlements) => void>();

function fromRpc(raw: RawEntitlementsRpcResult): Entitlements {
  return {
    tier: raw.tier,
    status: raw.status,
    plan: raw.plan,
    currentPeriodEnd: raw.currentPeriodEnd,
    cancelAtPeriodEnd: !!raw.cancelAtPeriodEnd,
    trialEnd: raw.trialEnd,
    fairUseExceeded: !!raw.fairUseExceeded,
    fairUseRemainingSeconds: raw.fairUseRemainingSeconds ?? 0,
    fairUseUsedSeconds: raw.fairUseUsedSeconds ?? 0,
    fairUseCapSeconds: raw.fairUseCapSeconds ?? 0,
    fetchedAt: Date.now(),
    loading: false,
    error: null,
  };
}

function broadcast(): void {
  for (const listener of listeners) {
    try {
      listener(current);
    } catch (err) {
      logWarn('entitlements', 'listener threw', err);
    }
  }
  // Push to all renderer windows so the UI can update without polling.
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send('entitlements-changed', current);
  }
}

export function onEntitlementsChanged(listener: (ent: Entitlements) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getEntitlementsSnapshot(): Entitlements {
  return current;
}

export function isProUser(): boolean {
  return current.tier === 'pro' && !current.fairUseExceeded;
}

/**
 * Refresh from the server. If a refresh is already in flight, return
 * that same promise so we don't hammer the RPC.
 */
export async function refreshEntitlements(): Promise<Entitlements> {
  if (inflight) return inflight;

  const session = await ensureCurrentSession();
  if (!session) {
    current = { ...ANONYMOUS, fetchedAt: Date.now() };
    logInfo('entitlements', 'refresh skipped: no signed-in session');
    broadcast();
    return current;
  }

  current = { ...current, loading: true, error: null };
  broadcast();

  inflight = (async () => {
    try {
      const raw = await fetchEntitlements();
      current = fromRpc(raw);
      logInfo('entitlements', `refresh ok tier=${current.tier} status=${current.status} plan=${current.plan ?? 'none'} fairUseExceeded=${current.fairUseExceeded}`);
    } catch (err) {
      current = {
        ...current,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      };
      logWarn('entitlements', `refresh failed tier=${current.tier} status=${current.status}`, err);
    }
    broadcast();
    return current;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

function startTimer(): void {
  stopTimer();
  refreshTimer = setInterval(() => {
    void refreshEntitlements();
  }, REFRESH_INTERVAL_MS);
  refreshTimer.unref?.();
}

function stopTimer(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

export function initEntitlements(): void {
  // Auth state drives everything: when the user signs in we refresh
  // immediately, when they sign out we go back to anonymous and stop
  // the timer.
  onAuthStateChange((session) => {
    if (session) {
      void refreshEntitlements();
      startTimer();
    } else {
      stopTimer();
      current = { ...ANONYMOUS, fetchedAt: Date.now() };
      broadcast();
    }
  });

  // If the app booted with a restored session already in place, prime
  // the cache straight away.
  if (getCurrentSession()) {
    void refreshEntitlements();
    startTimer();
  }
}

/**
 * Fire-and-forget refresh used from latency-critical paths (recording
 * start). Skips the network entirely when the cached snapshot is fresh,
 * and never throws — callers must not await this on the hot path.
 */
export function refreshEntitlementsInBackground(maxAgeMs = 60_000): void {
  if (current.loading) return;
  if (Date.now() - current.fetchedAt < maxAgeMs) return;
  void refreshEntitlements().catch((err) => {
    logWarn('entitlements', 'background refresh failed', err);
  });
}

/**
 * Schedule a few quick refreshes after the user comes back from a
 * Stripe Checkout or Portal flow. Stripe webhooks usually land within
 * 1–5s, but the user is staring at the app waiting for Pro to flip on,
 * so we poll a couple of times to feel snappy.
 */
export function refreshAfterBillingReturn(): void {
  for (const delay of POST_BILLING_RETRY_DELAYS_MS) {
    setTimeout(() => {
      void refreshEntitlements();
    }, delay);
  }
}
