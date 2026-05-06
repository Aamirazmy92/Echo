import { useCallback, useEffect, useState } from 'react';
import LoginScreen from './LoginScreen';
import SignupScreen from './SignupScreen';
import ForgotPasswordScreen from './ForgotPasswordScreen';
import type { AuthSession } from '../api';

/*
 * <AuthGate> — top-level wrapper that decides whether to render the
 * normal app shell or one of the auth screens.
 *
 * Three states:
 *   1. loading: querying main for the persisted session.
 *   2. unauthenticated: no session → show login/signup/forgot screens.
 *   3. authenticated: render `children` (the existing App tree).
 *
 * The component subscribes to `onAuthState` so the app drops back to
 * the login screen if the token is revoked from another device or the
 * user clicks "Sign out" in the Account panel.
 *
 * If the build was packaged without `VITE_SUPABASE_URL` set,
 * `authConfigStatus()` returns `{ configured: false }` and we let the
 * user through unconditionally. That keeps dev builds usable without a
 * backend, and gives any release built before sync setup a graceful
 * fallback instead of an unrecoverable lock-out.
 */

type Mode = 'login' | 'signup' | 'forgot';

export default function AuthGate({ children }: { children: React.ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [authConfigured, setAuthConfigured] = useState(true);
  const [authLoadError, setAuthLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('login');

  // Initial load: check if Supabase is wired up and pull any saved session.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await window.api.authConfigStatus();
        if (cancelled) return;
        setAuthConfigured(cfg.configured);
        if (!cfg.configured) {
          // No backend → behave like local-only Echo.
          setLoading(false);
          return;
        }
        const current = await window.api.authGetSession();
        if (cancelled) return;
        setSession(current);
        setAuthLoadError(null);
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        setAuthLoadError(message || 'Could not check your session.');
        setAuthConfigured(false);
        window.api.reportRendererError?.('auth-gate', message || 'Could not check auth session.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Keep state in sync if main pushes auth changes (sign-in via OAuth
  // deep link, token revocation, sign-out from another tab/device).
  useEffect(() => {
    const off = window.api.onAuthState((next) => setSession(next));
    return off;
  }, []);

  // Called by LoginScreen / SignupScreen after a successful submit.
  // We re-fetch the session through IPC because the actual state lives
  // in the main process; this call is what populates the renderer.
  const refresh = useCallback(async () => {
    const next = await window.api.authGetSession();
    setSession(next);
  }, []);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-[hsl(220,20%,94%)] text-[hsl(220,14%,40%)]">
        <span className="text-sm">Checking your session…</span>
      </div>
    );
  }

  if (!authConfigured || session) {
    return (
      <>
        {authLoadError ? (
          <div className="fixed bottom-4 left-1/2 z-[9999] -translate-x-1/2 rounded-full border border-border bg-background px-4 py-2 text-xs text-muted-foreground shadow-lg">
            Cloud sign-in is unavailable right now. Running locally.
          </div>
        ) : null}
        {children}
      </>
    );
  }

  if (mode === 'signup') {
    return (
      <SignupScreen
        onSwitchToLogin={() => setMode('login')}
        onSignedIn={refresh}
      />
    );
  }
  if (mode === 'forgot') {
    return (
      <ForgotPasswordScreen
        onBack={() => setMode('login')}
      />
    );
  }
  return (
    <LoginScreen
      onSwitchToSignup={() => setMode('signup')}
      onSwitchToForgot={() => setMode('forgot')}
      onSignedIn={refresh}
    />
  );
}
