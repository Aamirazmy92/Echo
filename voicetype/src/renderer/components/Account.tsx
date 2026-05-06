import { useEffect, useRef, useState } from 'react';
import { Cloud, CloudOff, Loader2, RefreshCw, LogOut, ShieldAlert, Trash2, Pencil, Check, X } from 'lucide-react';
import type { AuthSession, SyncStatusPayload } from '../api';
import ConfirmationModal from './ConfirmationModal';
import { toast } from './toast/useToast';

/*
 * <AccountView> — sidebar destination when the user picks "Account" in
 * the nav. Shows their profile (email + display name), the current
 * sync status (synced / syncing / offline / error + queue depth + last
 * sync time), and gives them a single-button sign-out.
 *
 * The data comes from two sources:
 *   * `authGetSession()` — populated once on mount, and refreshed
 *     whenever main pushes an `auth-state` event (so signing out from
 *     another window also updates this view).
 *   * `syncGetStatus()` — pulled on mount; live updates arrive via the
 *     `sync-status` event so we never have to poll.
 */
export default function AccountView() {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [sync, setSync] = useState<SyncStatusPayload | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [forcing, setForcing] = useState(false);
  // Both destructive actions (sign out, delete account) gate behind a
  // simple confirm modal. We track open state + in-flight state per
  // action so the buttons can show spinners and the modal stays
  // mounted until the RPC settles.
  const [signOutModalOpen, setSignOutModalOpen] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Inline display-name editor. `editingName === null` means “not
  // editing”; otherwise it holds the in-progress draft text.
  const [editingName, setEditingName] = useState<string | null>(null);
  const [savingName, setSavingName] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [s, st] = await Promise.all([window.api.authGetSession(), window.api.syncGetStatus()]);
      if (cancelled) return;
      setSession(s);
      setSync(st);
    })();
    const offAuth = window.api.onAuthState((next) => setSession(next));
    const offSync = window.api.onSyncStatus((next) => setSync(next));
    return () => {
      cancelled = true;
      offAuth();
      offSync();
    };
  }, []);

  async function handleSignOut() {
    setSigningOut(true);
    try {
      const result = await window.api.authSignOut();
      if (result?.error) {
        toast.error(result.error);
        return;
      }
      // Auth-state listener flips the app back to the sign-in screen.
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Could not sign out. Please try again.');
    } finally {
      setSigningOut(false);
      setSignOutModalOpen(false);
    }
  }

  async function handleDeleteAccount() {
    setDeleting(true);
    try {
      const result = await window.api.authDeleteAccount();
      if (result.error) {
        toast.error(result.error);
        return;
      }
      // On success the backend will fire an auth-state(null) event,
      // AuthGate will re-render the login screen, and this component
      // unmounts before the next render — no further work needed.
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Could not delete account. Please try again.');
    } finally {
      setDeleting(false);
      setDeleteModalOpen(false);
    }
  }

  function startEditingName() {
    setNameError(null);
    setEditingName(session?.displayName ?? session?.email.split('@')[0] ?? '');
    // Focus + select on next tick so the input has mounted.
    requestAnimationFrame(() => {
      nameInputRef.current?.focus();
      nameInputRef.current?.select();
    });
  }

  function cancelEditingName() {
    setEditingName(null);
    setNameError(null);
  }

  async function saveDisplayName() {
    if (editingName === null) return;
    const trimmed = editingName.trim();
    if (!trimmed) {
      setNameError('Display name cannot be empty.');
      return;
    }
    // No-op when nothing changed — just close the editor.
    if (trimmed === (session?.displayName ?? '')) {
      setEditingName(null);
      setNameError(null);
      return;
    }
    setSavingName(true);
    setNameError(null);
    try {
      const result = await window.api.authUpdateDisplayName(trimmed);
      if (result.error) {
        setNameError(result.error);
        return;
      }
      // The auth-state listener will push the new session through, so
      // we don't need to optimistically update local state here.
      setEditingName(null);
    } catch (err: unknown) {
      setNameError(err instanceof Error ? err.message : 'Could not update display name.');
    } finally {
      setSavingName(false);
    }
  }

  async function handleForceSync() {
    setForcing(true);
    try {
      await window.api.syncForce();
    } finally {
      // brief delay so the spinner is perceptible even on instant cloud round-trips
      window.setTimeout(() => setForcing(false), 350);
    }
  }

  if (!session) {
    return (
      <div className="p-8 text-sm text-[hsl(220,10%,40%)]">Not signed in.</div>
    );
  }

  const initials = (session.displayName || session.email)
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    // No max-width / padding here so this component plugs into either
    // a full-page layout *or* the Settings modal's already-padded
    // content area without doubling up on margins.
    <div className="flex w-full flex-col gap-6">
      <header className="flex items-center gap-4">
        <div
          className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-[hsl(220,14%,14%)] text-base font-semibold text-white"
          aria-hidden
        >
          {initials || '?'}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {editingName === null ? (
            <div className="flex items-center gap-2">
              <span className="truncate text-base font-semibold text-[hsl(220,14%,14%)]">
                {session.displayName || session.email.split('@')[0]}
              </span>
              <button
                type="button"
                onClick={startEditingName}
                aria-label="Edit display name"
                className="flex h-7 w-7 items-center justify-center rounded-md text-[hsl(220,10%,46%)] transition hover:bg-black/5 hover:text-[hsl(220,14%,14%)]"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <input
                ref={nameInputRef}
                type="text"
                value={editingName}
                maxLength={60}
                onChange={(e) => {
                  setEditingName(e.target.value);
                  if (nameError) setNameError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void saveDisplayName();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    cancelEditingName();
                  }
                }}
                disabled={savingName}
                placeholder="Your name"
                className="h-8 min-w-0 flex-1 rounded-md border border-[hsl(220,14%,86%)] bg-white px-2.5 text-sm font-medium text-[hsl(220,14%,14%)] outline-none focus:border-black focus:ring-2 focus:ring-black/10 disabled:opacity-60"
              />
              <button
                type="button"
                onClick={() => void saveDisplayName()}
                disabled={savingName || !editingName.trim()}
                aria-label="Save display name"
                className="flex h-8 w-8 items-center justify-center rounded-md bg-[hsl(220,14%,14%)] text-white transition hover:bg-[hsl(220,14%,8%)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {savingName ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              </button>
              <button
                type="button"
                onClick={cancelEditingName}
                disabled={savingName}
                aria-label="Cancel"
                className="flex h-8 w-8 items-center justify-center rounded-md border border-[hsl(220,14%,86%)] bg-white text-[hsl(220,10%,46%)] transition hover:bg-[hsl(220,20%,97%)] hover:text-[hsl(220,14%,14%)] disabled:opacity-60"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          <span className="truncate text-xs text-[hsl(220,10%,46%)]">{session.email}</span>
          {nameError ? (
            <span role="alert" className="text-xs text-red-600">
              {nameError}
            </span>
          ) : null}
        </div>
      </header>

      <SyncCard status={sync} onForce={handleForceSync} forcing={forcing} />

      <section className="rounded-xl border border-black/5 bg-white p-5 shadow-[0_1px_4px_rgba(0,0,0,0.04)]">
        <h2 className="mb-1 text-sm font-semibold text-[hsl(220,14%,14%)]">Sign out</h2>
        <p className="mb-4 text-xs text-[hsl(220,10%,42%)]">
          Signing out clears your session on this device. Your synced history stays in the cloud
          and will reappear next time you sign in. Local-only data (API keys, microphone
          choice) will need to be re-entered.
        </p>
        <button
          type="button"
          onClick={() => setSignOutModalOpen(true)}
          disabled={signingOut}
          className="inline-flex h-9 items-center gap-2 rounded-lg bg-[hsl(220,14%,14%)] px-4 text-xs font-semibold text-white transition hover:bg-[hsl(220,14%,8%)] disabled:opacity-60"
        >
          <LogOut className="h-3.5 w-3.5" />
          {signingOut ? 'Signing out…' : 'Sign out'}
        </button>
      </section>

      <section className="rounded-xl border border-red-200 bg-red-50 p-5">
        <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-red-900">
          <ShieldAlert className="h-4 w-4" />
          Delete account
        </div>
        <p className="mb-4 text-xs text-red-900/80">
          Permanently deletes your account, cloud history, dictionary, snippets and styles
          across every device. This cannot be undone.
        </p>

        <button
          type="button"
          onClick={() => setDeleteModalOpen(true)}
          className="inline-flex h-9 items-center gap-2 rounded-lg border border-red-300 bg-white px-4 text-xs font-semibold text-red-700 transition hover:bg-red-100"
        >
          <Trash2 className="h-3.5 w-3.5" />
          Delete account
        </button>
      </section>

      <ConfirmationModal
        open={signOutModalOpen}
        title="Are you sure you want to sign out?"
        description=""
        cancelLabel="Back to account"
        confirmLabel={signingOut ? 'Signing out…' : 'Sign out'}
        loading={signingOut}
        confirmButtonClassName="bg-[hsl(220,14%,14%)] text-white hover:bg-[hsl(220,14%,8%)]"
        onConfirm={handleSignOut}
        onClose={() => {
          if (signingOut) return;
          setSignOutModalOpen(false);
        }}
      />

      <ConfirmationModal
        open={deleteModalOpen}
        title="Are you sure you want to delete your account?"
        description=""
        cancelLabel="Back to account"
        confirmLabel={deleting ? 'Deleting…' : 'Delete account'}
        loading={deleting}
        onConfirm={handleDeleteAccount}
        onClose={() => {
          if (deleting) return;
          setDeleteModalOpen(false);
        }}
      />
    </div>
  );
}

function SyncCard({
  status,
  onForce,
  forcing,
}: {
  status: SyncStatusPayload | null;
  onForce: () => void;
  forcing: boolean;
}) {
  const icon = (() => {
    if (!status) return <Loader2 className="h-4 w-4 animate-spin" />;
    switch (status.status) {
      case 'syncing':
        return <Loader2 className="h-4 w-4 animate-spin text-[hsl(220,14%,14%)]" />;
      case 'error':
        return <CloudOff className="h-4 w-4 text-red-600" />;
      case 'offline':
        return <CloudOff className="h-4 w-4 text-[hsl(220,10%,40%)]" />;
      case 'signed-out':
        return <CloudOff className="h-4 w-4 text-[hsl(220,10%,40%)]" />;
      default:
        return <Cloud className="h-4 w-4 text-emerald-600" />;
    }
  })();

  const label = (() => {
    if (!status) return 'Loading…';
    switch (status.status) {
      case 'syncing':
        return status.queueDepth > 0
          ? `Syncing ${status.queueDepth} change${status.queueDepth === 1 ? '' : 's'}…`
          : 'Syncing…';
      case 'error':
        return 'Sync failed';
      case 'offline':
        return 'Offline';
      case 'signed-out':
        return 'Sync paused';
      default:
        return status.lastSyncedAt ? `Up to date · ${formatRelativeTime(status.lastSyncedAt)}` : 'Up to date';
    }
  })();

  return (
    <section className="rounded-xl border border-black/5 bg-white p-5 shadow-[0_1px_4px_rgba(0,0,0,0.04)]">
      <h2 className="mb-3 text-sm font-semibold text-[hsl(220,14%,14%)]">Cloud sync</h2>
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <span aria-hidden>{icon}</span>
          <span className="text-sm text-[hsl(220,14%,18%)]">{label}</span>
        </div>
        <button
          type="button"
          onClick={onForce}
          disabled={forcing}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[hsl(220,14%,86%)] bg-white px-3 text-xs font-medium text-[hsl(220,14%,14%)] transition hover:bg-[hsl(220,20%,97%)] disabled:opacity-60"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${forcing ? 'animate-spin' : ''}`} />
          Sync now
        </button>
      </div>
      {status?.lastError ? (
        <p className="mt-3 text-xs text-red-700">{status.lastError}</p>
      ) : null}
      {status && status.queueDepth > 0 && status.status !== 'syncing' ? (
        <p className="mt-3 text-xs text-[hsl(220,10%,46%)]">
          {status.queueDepth} pending change{status.queueDepth === 1 ? '' : 's'} will upload when
          a connection is available.
        </p>
      ) : null}
    </section>
  );
}

function formatRelativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 30_000) return 'just now';
  if (ms < 60_000 * 2) return '1 minute ago';
  if (ms < 60_000 * 60) return `${Math.floor(ms / 60_000)} minutes ago`;
  if (ms < 60_000 * 60 * 2) return '1 hour ago';
  if (ms < 60_000 * 60 * 24) return `${Math.floor(ms / (60_000 * 60))} hours ago`;
  return new Date(iso).toLocaleDateString();
}
