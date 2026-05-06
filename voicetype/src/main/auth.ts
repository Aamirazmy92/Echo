import { app, BrowserWindow, safeStorage, shell } from 'electron';
import fs from 'fs';
import path from 'path';
import { createClient, SupabaseClient, Session, AuthChangeEvent } from '@supabase/supabase-js';
import { logError, logInfo, logWarn } from './logger';

/*
 * Auth module — wraps the Supabase client for the main process.
 *
 * Responsibilities:
 *   1. Hold the singleton Supabase client.
 *   2. Persist / restore the session to a JSON file in app userData so
 *      we don't force the user to re-login on every launch.
 *   3. Expose typed, Promise-based methods that the IPC layer can hand
 *      to the renderer (signIn, signUp, signOut, signInWithGoogle, etc.).
 *   4. Handle the OAuth deep-link callback when the user finishes the
 *      Google flow in the system browser (echo://auth-callback?code=...).
 *   5. Notify subscribers (the sync engine, the renderer) when the
 *      auth state changes so they can pull or wipe local caches.
 *
 * The Supabase URL + anon key come from `.env` and are baked into the
 * main bundle by Vite (VITE_* prefix). Anon keys are safe to ship —
 * RLS on the database is what enforces per-user access.
 */

const viteEnv = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ?? {};
const SUPABASE_URL = viteEnv.VITE_SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = viteEnv.VITE_SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY ?? '';
const SUPABASE_REDIRECT_URL =
  viteEnv.VITE_SUPABASE_REDIRECT_URL ??
  process.env.VITE_SUPABASE_REDIRECT_URL ??
  'echo://auth-callback';

let supabase: SupabaseClient | null = null;
let currentSession: Session | null = null;
const sessionListeners = new Set<(session: Session | null) => void>();
const NETWORK_AUTH_ERROR = 'Network error. Check your internet connection and try again.';

function isNetworkError(error: unknown): boolean {
  if (!error) return false;
  const cause = error instanceof Error
    ? (error as Error & { cause?: unknown }).cause as { code?: string; message?: string } | undefined
    : undefined;
  const text = [
    error instanceof Error ? error.name : '',
    error instanceof Error ? error.message : String(error),
    cause?.code ?? '',
    cause?.message ?? '',
  ].join(' ');
  return /fetch failed|network|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|socket disconnected|TLS connection/i.test(text);
}

function authErrorMessage(error: unknown): string {
  if (isNetworkError(error)) return NETWORK_AUTH_ERROR;
  return error instanceof Error ? error.message : String(error);
}

function sessionFilePath(): string {
  return path.join(app.getPath('userData'), 'auth-session.json');
}

// On disk, the session payload is wrapped in this envelope so we can tell
// encrypted blobs apart from any plaintext JSON left behind by older
// builds. The blob itself is `safeStorage.encryptString(json)` base64'd.
//
// `safeStorage` uses DPAPI on Windows (scoped to the current user) and
// Keychain on macOS, so the access/refresh tokens can no longer be
// lifted by another process running as the same OS user from a flat
// JSON file — they need an active impersonation of the user's session
// to decrypt.
const ENCRYPTED_SESSION_VERSION = 1;
type EncryptedSessionEnvelope = {
  v: number;
  enc: string; // base64-encoded ciphertext from safeStorage.encryptString
};

function isEncryptedEnvelope(value: unknown): value is EncryptedSessionEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as EncryptedSessionEnvelope).enc === 'string' &&
    (value as EncryptedSessionEnvelope).v === ENCRYPTED_SESSION_VERSION
  );
}

function persistSession(session: Session | null): void {
  try {
    const file = sessionFilePath();
    if (!session) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      return;
    }

    if (!safeStorage.isEncryptionAvailable()) {
      // Refuse to persist tokens in plaintext. Losing session continuity
      // (the user has to sign in again next launch) is strictly better
      // than leaving access/refresh tokens readable by any process
      // running as the same OS user.
      if (fs.existsSync(file)) fs.unlinkSync(file);
      logWarn('auth', 'safeStorage unavailable — session not persisted to disk this launch');
      return;
    }

    const ciphertext = safeStorage.encryptString(JSON.stringify(session)).toString('base64');
    const envelope: EncryptedSessionEnvelope = { v: ENCRYPTED_SESSION_VERSION, enc: ciphertext };
    fs.writeFileSync(file, JSON.stringify(envelope), { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    logWarn('auth', 'failed to persist session', err);
  }
}

function restoreSession(): Session | null {
  try {
    const file = sessionFilePath();
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf8');

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // File is corrupt — wipe it so we don't keep failing on every launch.
      try { fs.unlinkSync(file); } catch { /* best effort */ }
      return null;
    }

    if (isEncryptedEnvelope(parsed)) {
      if (!safeStorage.isEncryptionAvailable()) {
        // Encrypted on disk but the OS keyring isn't available right now
        // (e.g. headless Linux session). Drop to anonymous and let the
        // user sign in again rather than blowing up.
        return null;
      }
      try {
        const buf = Buffer.from(parsed.enc, 'base64');
        const json = safeStorage.decryptString(buf);
        return JSON.parse(json) as Session;
      } catch (err) {
        // Decryption can fail if the user's OS profile / keyring rotated
        // between launches. Treat as no session and remove the bad file.
        logWarn('auth', 'failed to decrypt persisted session, clearing it', err);
        try { fs.unlinkSync(file); } catch { /* best effort */ }
        return null;
      }
    }

    // Migration path: legacy plaintext session JSON from builds before
    // safeStorage encryption landed. Read it once, then immediately
    // overwrite with an encrypted envelope so it never sits on disk in
    // the clear after this launch. If safeStorage is unavailable, wipe
    // the file outright — a forced re-login is the safe default.
    if (parsed && typeof parsed === 'object' && (parsed as Session).access_token) {
      const session = parsed as Session;
      logInfo('auth', 'migrating legacy plaintext session to encrypted envelope');
      persistSession(session);
      return session;
    }

    return null;
  } catch (err) {
    logWarn('auth', 'failed to restore session', err);
    return null;
  }
}

export function isAuthConfigured(): boolean {
  return !!SUPABASE_URL && !!SUPABASE_ANON_KEY;
}

export function getSupabase(): SupabaseClient | null {
  return supabase;
}

export function getCurrentSession(): Session | null {
  return currentSession;
}

export function getCurrentUserId(): string | null {
  return currentSession?.user?.id ?? null;
}

export function onAuthStateChange(listener: (session: Session | null) => void): () => void {
  sessionListeners.add(listener);
  return () => sessionListeners.delete(listener);
}

function notifyListeners(session: Session | null) {
  for (const listener of sessionListeners) {
    try {
      listener(session);
    } catch (err) {
      logError('auth', 'listener threw', err);
    }
  }
}

export async function initAuth(): Promise<void> {
  if (!isAuthConfigured()) {
    logWarn('auth', 'Supabase env vars missing — running without cloud sync');
    return;
  }

  supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      // We persist the session ourselves to a file in userData. Disabling
      // Supabase's internal storage prevents it from trying to use
      // localStorage (which doesn't exist in the main process) and from
      // racing our own read/write of auth-session.json.
      persistSession: false,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  });

  // Try to restore the previous session. If it's still valid, Supabase
  // will silently refresh the access token; if it's expired beyond the
  // refresh window, setSession returns an error and we just stay signed
  // out.
  const stored = restoreSession();
  if (stored?.refresh_token) {
    try {
      const { data, error } = await supabase.auth.setSession({
        access_token: stored.access_token,
        refresh_token: stored.refresh_token,
      });
      if (error) {
        logWarn('auth', 'could not restore session', error);
        persistSession(null);
      } else if (data.session) {
        currentSession = data.session;
        persistSession(data.session);
      }
    } catch (err) {
      logWarn('auth', 'could not reach Supabase while restoring session', err);
      if (isNetworkError(err)) {
        currentSession = stored;
        notifyListeners(currentSession);
      } else {
        persistSession(null);
      }
    }
  }

  supabase.auth.onAuthStateChange((_event: AuthChangeEvent, session: Session | null) => {
    // No info-log here — every token refresh fires this and the Account
    // panel already shows the live state. Errors/warnings still log.
    currentSession = session;
    persistSession(session);
    notifyListeners(session);
  });
}

export async function signInWithPassword(email: string, password: string): Promise<{ error?: string }> {
  if (!supabase) return { error: 'Cloud sync not configured.' };
  try {
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    return error ? { error: authErrorMessage(error) } : {};
  } catch (err) {
    logWarn('auth', 'sign in request failed', err);
    return { error: authErrorMessage(err) };
  }
}

export async function signUpWithPassword(
  email: string,
  password: string,
  displayName?: string
): Promise<{ error?: string; needsConfirmation?: boolean }> {
  if (!supabase) return { error: 'Cloud sync not configured.' };
  try {
    const { data, error } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: {
        data: { display_name: displayName?.trim() || undefined },
        emailRedirectTo: SUPABASE_REDIRECT_URL,
      },
    });
    if (error) return { error: authErrorMessage(error) };
    // If Supabase's "Confirm email" setting is on, signUp returns a user
    // with no session and the renderer should show a "Check your inbox"
    // state instead of dumping them into the app.
    return { needsConfirmation: !data.session };
  } catch (err) {
    logWarn('auth', 'sign up request failed', err);
    return { error: authErrorMessage(err) };
  }
}

export async function signOut(): Promise<{ error?: string }> {
  if (!supabase) return {};
  try {
    const { error } = await supabase.auth.signOut();
    if (error) return { error: authErrorMessage(error) };
    currentSession = null;
    persistSession(null);
    return {};
  } catch (err) {
    logWarn('auth', 'sign out request failed', err);
    return { error: authErrorMessage(err) };
  }
}

/**
 * Update the signed-in user's display name.
 *
 * Two writes happen:
 *   1. `auth.updateUser({ data: { display_name } })` — updates the
 *      `auth.users.raw_user_meta_data` JSON. This is what
 *      `serialiseSession()` reads, so the rename is visible the moment
 *      the next session refresh arrives.
 *   2. `update public.profiles set display_name = ...` — keeps the
 *      profiles row in sync for any future feature that joins on it
 *      (mentions, sharing, etc.). RLS on the table already restricts
 *      the update to the authenticated user's own row.
 *
 * The two writes are best-effort independent: a profile-row failure
 * doesn't roll back the metadata write, since the metadata is the
 * source of truth for the rendered name.
 */
export async function updateDisplayName(name: string): Promise<{ error?: string }> {
  if (!supabase) return { error: 'Cloud sync not configured.' };
  if (!currentSession) return { error: 'Not signed in.' };

  const trimmed = name.trim();
  if (!trimmed) return { error: 'Display name cannot be empty.' };
  if (trimmed.length > 60) return { error: 'Display name must be 60 characters or fewer.' };

  let data;
  try {
    const result = await supabase.auth.updateUser({ data: { display_name: trimmed } });
    data = result.data;
    if (result.error) {
      logError('auth', 'updateUser display_name failed', result.error);
      return { error: authErrorMessage(result.error) };
    }
  } catch (err) {
    logWarn('auth', 'update display name request failed', err);
    return { error: authErrorMessage(err) };
  }
  if (data?.user) {
    // updateUser doesn't return the full session, only the user.
    // Patch our cached session so serialiseSession() reflects the new
    // name immediately without waiting for the next token refresh.
    currentSession = { ...currentSession, user: data.user } as Session;
    persistSession(currentSession);
    notifyListeners(currentSession);
  }

  try {
    const { error: profileError } = await supabase
      .from('profiles')
      .update({ display_name: trimmed })
      .eq('id', currentSession.user.id);
    if (profileError) {
      logWarn('auth', 'profiles update failed (non-fatal)', profileError);
    }
  } catch (err) {
    logWarn('auth', 'profiles update request failed (non-fatal)', err);
  }

  return {};
}

/**
 * Permanently delete the signed-in user's account and all their data.
 *
 * Calls the `delete_my_account()` Postgres RPC defined in schema.sql,
 * which runs as SECURITY DEFINER to remove the row from `auth.users`.
 * The on-delete-cascade FKs on every data table then wipe history,
 * snippets, dictionary, custom_styles, settings, and the profile.
 *
 * After the RPC succeeds we sign out locally so the renderer drops
 * back to the login screen and the sync engine clears local cached
 * data (existing sign-out flow handles that part).
 */
export async function deleteAccount(): Promise<{ error?: string }> {
  if (!supabase) return { error: 'Cloud sync not configured.' };
  if (!currentSession) return { error: 'Not signed in.' };
  try {
    const { error } = await supabase.rpc('delete_my_account');
    if (error) {
      logError('auth', 'delete_my_account RPC failed', error);
      return { error: authErrorMessage(error) };
    }
  } catch (err) {
    logWarn('auth', 'delete account request failed', err);
    return { error: authErrorMessage(err) };
  }
  // Best-effort sign-out. The auth.users row is gone so the next API
  // call would fail anyway, but signing out cleanly tears down the
  // local session file + triggers the local-data wipe.
  await supabase.auth.signOut().catch(() => undefined);
  currentSession = null;
  persistSession(null);
  // Explicitly notify in case Supabase's own onAuthStateChange didn't
  // fire (it usually does, but the deleted-auth.users edge case has
  // bitten us before). Listeners are idempotent.
  notifyListeners(null);
  return {};
}

export async function sendPasswordReset(email: string): Promise<{ error?: string }> {
  if (!supabase) return { error: 'Cloud sync not configured.' };
  try {
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: SUPABASE_REDIRECT_URL,
    });
    return error ? { error: authErrorMessage(error) } : {};
  } catch (err) {
    logWarn('auth', 'password reset request failed', err);
    return { error: authErrorMessage(err) };
  }
}

/**
 * Kick off a Google OAuth sign-in. We open the auth URL in the user's
 * default browser (Supabase shows the Google consent screen, then
 * redirects to our `echo://auth-callback?code=...` deep link). The
 * single-instance handler in main/index.ts catches the deep link and
 * forwards the code to `completeOAuthCallback` below.
 */
export async function startGoogleSignIn(): Promise<{ error?: string }> {
  if (!supabase) return { error: 'Cloud sync not configured.' };
  let url: string | undefined;
  try {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: SUPABASE_REDIRECT_URL,
        // Skip the browser-side redirect — we'll open the URL ourselves.
        skipBrowserRedirect: true,
      },
    });
    if (error || !data?.url) {
      return { error: error ? authErrorMessage(error) : 'Could not start Google sign-in.' };
    }
    url = data.url;
  } catch (err) {
    logWarn('auth', 'google sign in request failed', err);
    return { error: authErrorMessage(err) };
  }
  if (!url) return { error: 'Could not start Google sign-in.' };
  await shell.openExternal(url);
  return {};
}

/**
 * Called by the main-process deep-link handler when Echo receives an
 * `echo://auth-callback?code=...` URL. Exchanges the code for a session
 * and brings the main window back to focus.
 */
export async function completeOAuthCallback(callbackUrl: string): Promise<void> {
  if (!supabase) return;
  try {
    const url = new URL(callbackUrl);

    // Supabase can hand us the OAuth result in two shapes:
    //
    //   1. PKCE flow:     echo://auth-callback?code=xxxx
    //      → exchange the code for a session.
    //   2. Implicit flow: echo://auth-callback#access_token=...&refresh_token=...
    //      → the tokens are already in the URL fragment; set the session
    //        directly. This is what `signInWithOAuth({ provider: 'google' })`
    //        produces by default in v2.x of @supabase/supabase-js.
    //
    // We support both because the choice depends on Supabase's project
    // settings (and could change between versions). Trying PKCE first
    // means the migration to PKCE later is a no-op.

    const code = url.searchParams.get('code');
    if (code) {
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (error) {
        logError('auth', 'exchangeCodeForSession failed', authErrorMessage(error));
        return;
      }
    } else {
      // Hash fragments aren't parsed by URL.searchParams, so do it by hand.
      // Strip the leading '#' and feed it to URLSearchParams.
      const hash = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
      const params = new URLSearchParams(hash);
      const accessToken = params.get('access_token');
      const refreshToken = params.get('refresh_token');
      if (!accessToken || !refreshToken) {
        logWarn('auth', `OAuth callback missing tokens: ${callbackUrl}`);
        return;
      }
      const { error } = await supabase.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken,
      });
      if (error) {
        logError('auth', 'setSession from implicit flow failed', authErrorMessage(error));
        return;
      }
    }

    // Bring Echo back to the front since the user finished the flow in
    // their browser. Without this they'd have to alt-tab.
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  } catch (err) {
    logError('auth', 'completeOAuthCallback threw', err);
  }
}

export interface SerialisedSession {
  userId: string;
  email: string;
  displayName: string | null;
  expiresAt: number | null;
}

export function serialiseSession(): SerialisedSession | null {
  if (!currentSession?.user) return null;
  return {
    userId: currentSession.user.id,
    email: currentSession.user.email ?? '',
    displayName:
      (currentSession.user.user_metadata?.display_name as string | undefined) ??
      currentSession.user.email?.split('@')[0] ??
      null,
    expiresAt: currentSession.expires_at ?? null,
  };
}
