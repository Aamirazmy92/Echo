import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Cloud, CloudOff, Loader2, RefreshCw, LogOut, Trash2, Pencil, Plus, Check, X } from 'lucide-react';
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
const MAX_PROFILE_IMAGE_BYTES = 8 * 1024 * 1024;
const PROFILE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not read that image.'));
    image.src = src;
  });
}

async function createProfilePictureDataUrl(file: File): Promise<string> {
  if (!PROFILE_IMAGE_TYPES.has(file.type)) {
    throw new Error('Choose a JPEG, PNG, or WebP image.');
  }

  if (file.size > MAX_PROFILE_IMAGE_BYTES) {
    throw new Error('Choose an image smaller than 8 MB.');
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await loadImage(objectUrl);
    const size = Math.min(image.naturalWidth, image.naturalHeight);
    const sourceX = (image.naturalWidth - size) / 2;
    const sourceY = (image.naturalHeight - size) / 2;
    const outputSize = 160;
    const canvas = document.createElement('canvas');
    canvas.width = outputSize;
    canvas.height = outputSize;
    const context = canvas.getContext('2d');

    if (!context) {
      throw new Error('Could not process that image.');
    }

    context.drawImage(image, sourceX, sourceY, size, size, 0, 0, outputSize, outputSize);
    return canvas.toDataURL('image/jpeg', 0.82);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export default function AccountView({
  cloudVisible = true,
  onUpgradeClick,
}: {
  cloudVisible?: boolean;
  /** Optional callback wired by the Settings shell to jump to the Plans tab. */
  onUpgradeClick?: () => void;
}) {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [sync, setSync] = useState<SyncStatusPayload | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [forcing, setForcing] = useState(false);
  const [signOutModalOpen, setSignOutModalOpen] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [hasChanges, setHasChanges] = useState(false);
  const [savingName, setSavingName] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const profileInputRef = useRef<HTMLInputElement | null>(null);
  const [savingPicture, setSavingPicture] = useState(false);
  const [pictureError, setPictureError] = useState<string | null>(null);

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

  useEffect(() => {
    if (session?.displayName) {
      const parts = session.displayName.trim().split(/\s+/);
      setFirstName(parts[0] || '');
      setLastName(parts.slice(1).join(' ') || '');
    } else if (session) {
      setFirstName(session.email.split('@')[0]);
      setLastName('');
    }
    setHasChanges(false);
  }, [session]);

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

  function handleDiscard() {
    if (session?.displayName) {
      const parts = session.displayName.trim().split(/\s+/);
      setFirstName(parts[0] || '');
      setLastName(parts.slice(1).join(' ') || '');
    } else if (session) {
      setFirstName(session.email.split('@')[0]);
      setLastName('');
    }
    setHasChanges(false);
    setNameError(null);
  }

  async function handleSave() {
    const trimmedFirst = firstName.trim();
    const trimmedLast = lastName.trim();
    if (!trimmedFirst) {
      setNameError('First name is required.');
      return;
    }
    // Only join when both are present — otherwise we'd save a string
    // starting with a space, and the next session→state sync would
    // split it as { first: last, last: '' } (last name jumps into the
    // first-name slot). With firstName guaranteed non-empty above,
    // dropping the last name when blank is safe.
    const displayName = trimmedLast ? `${trimmedFirst} ${trimmedLast}` : trimmedFirst;
    if (displayName === (session?.displayName ?? '')) {
      setHasChanges(false);
      return;
    }
    setSavingName(true);
    setNameError(null);
    try {
      const result = await window.api.authUpdateDisplayName(displayName);
      if (result.error) {
        setNameError(result.error);
        return;
      }
      setHasChanges(false);
    } catch (err: unknown) {
      setNameError(err instanceof Error ? err.message : 'Could not update name.');
    } finally {
      setSavingName(false);
    }
  }

  async function handleProfilePictureSelected(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    setSavingPicture(true);
    setPictureError(null);
    try {
      const profilePictureDataUrl = await createProfilePictureDataUrl(file);
      const result = await window.api.authUpdateProfilePicture(profilePictureDataUrl);
      if (result.error) {
        setPictureError(result.error);
        toast.error(result.error);
        return;
      }
      toast.success('Profile picture updated.');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Could not update profile picture.';
      setPictureError(message);
      toast.error(message);
    } finally {
      setSavingPicture(false);
    }
  }

  async function handleRemoveProfilePicture() {
    setSavingPicture(true);
    setPictureError(null);
    try {
      const result = await window.api.authUpdateProfilePicture(null);
      if (result.error) {
        setPictureError(result.error);
        toast.error(result.error);
        return;
      }
      toast.success('Profile picture removed.');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Could not remove profile picture.';
      setPictureError(message);
      toast.error(message);
    } finally {
      setSavingPicture(false);
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

  const displayName = (session.displayName || `${firstName} ${lastName}`.trim() || session.email.split('@')[0]).trim();
  const planLabel = cloudVisible ? 'Pro plan' : 'Basic plan';

  return (
    <div className="flex min-h-full flex-col gap-4">
      {/* Hero card — warm sand surface that hosts the avatar, identity
          summary, and the prominent Upgrade affordance. */}
      <section className="flex items-center justify-between gap-4 rounded-2xl bg-secondary px-5 py-4">
        <div className="flex min-w-0 items-center gap-4">
          <div className="relative">
            <button
              type="button"
              onClick={() => profileInputRef.current?.click()}
              disabled={savingPicture}
              className="relative flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[hsl(220,14%,14%)] text-base font-semibold text-white transition hover:opacity-90 disabled:opacity-60"
              aria-label="Change profile picture"
            >
              {session.profilePictureDataUrl ? (
                <img
                  src={session.profilePictureDataUrl}
                  alt=""
                  className="h-full w-full object-cover"
                  draggable={false}
                />
              ) : (
                initials || '?'
              )}
              {savingPicture ? (
                <span className="absolute inset-0 flex items-center justify-center bg-black/45">
                  <Loader2 className="h-4 w-4 animate-spin" />
                </span>
              ) : null}
            </button>
            {/* Pencil affordance — anchors a "change picture" cue onto the
                avatar without an extra button below. */}
            <span
              aria-hidden
              className="pointer-events-none absolute -bottom-0.5 -right-0.5 flex h-5 w-5 items-center justify-center rounded-full border-2 border-secondary bg-card text-foreground"
            >
              <Pencil size={9} />
            </span>
            {/* Remove-photo affordance — only rendered when a custom
                picture is set. Sibling to the avatar button (not inside
                it) so its own click doesn't double-fire the file picker. */}
            {session.profilePictureDataUrl && !savingPicture ? (
              <button
                type="button"
                onClick={() => void handleRemoveProfilePicture()}
                className="absolute -top-0.5 -right-0.5 flex h-5 w-5 items-center justify-center rounded-full border-2 border-secondary bg-card text-foreground shadow-[0_1px_2px_rgba(31,27,22,0.12)] transition-colors hover:bg-[hsl(var(--destructive))] hover:text-[hsl(var(--destructive-foreground))] hover:border-[hsl(var(--destructive))]"
                aria-label="Remove profile picture"
                title="Remove profile picture"
              >
                <X size={10} strokeWidth={2.5} />
              </button>
            ) : null}
          </div>
          <div className="min-w-0">
            <div className="truncate text-[18px] font-semibold text-foreground">{displayName}</div>
            <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[13px] text-muted-foreground">
              <span className="truncate">{session.email}</span>
              <span aria-hidden className="text-muted-foreground/60">·</span>
              <span className="inline-flex h-[22px] shrink-0 items-center rounded-md border border-border bg-card px-2 text-[11px] font-medium text-foreground">
                {planLabel}
              </span>
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => onUpgradeClick?.()}
          className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-card px-3.5 text-[13px] font-medium text-[hsl(var(--primary))] shadow-[0_1px_2px_rgba(31,27,22,0.06)] transition-colors hover:bg-popover"
        >
          <Plus size={14} strokeWidth={2.5} />
          Upgrade
        </button>
      </section>

      {/* Profile card — labeled form fields with proper FIRST/LAST grid
          and a verified-email row. */}
      <section className="rounded-2xl border border-border bg-card p-5 shadow-[0_1px_4px_rgba(31,27,22,0.05)]">
        <div className="mb-4">
          <h2 className="text-[16px] font-semibold text-foreground">Profile</h2>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            How Echo greets you and signs your shortcuts.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
              First name
            </span>
            <input
              type="text"
              value={firstName}
              onChange={(e) => {
                setFirstName(e.target.value);
                setHasChanges(true);
                if (nameError) setNameError(null);
              }}
              placeholder="First name"
              disabled={savingName}
              className="mt-1.5 h-10 w-full rounded-lg border border-border bg-card px-3 text-[14px] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-foreground disabled:opacity-60"
            />
          </label>
          <label className="block">
            <span className="block text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
              Last name
            </span>
            <input
              type="text"
              value={lastName}
              onChange={(e) => {
                setLastName(e.target.value);
                setHasChanges(true);
                if (nameError) setNameError(null);
              }}
              placeholder="Last name"
              disabled={savingName}
              className="mt-1.5 h-10 w-full rounded-lg border border-border bg-card px-3 text-[14px] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-foreground disabled:opacity-60"
            />
          </label>
        </div>

        <div className="mt-4">
          <label className="block">
            <span className="block text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
              Email
            </span>
            <div className="relative mt-1.5">
              <input
                type="email"
                value={session.email}
                readOnly
                className="h-10 w-full cursor-default rounded-lg border border-border bg-card px-3 pr-[90px] text-[14px] text-foreground outline-none"
              />
              <span className="absolute right-2 top-1/2 inline-flex -translate-y-1/2 items-center gap-1 rounded-full bg-[hsl(95_21%_45%/0.14)] px-2 py-0.5 text-[11px] font-medium text-[hsl(95_30%_28%)]">
                <Check size={11} strokeWidth={3} />
                Verified
              </span>
            </div>
          </label>
          <p className="mt-1.5 text-[12px] text-muted-foreground">
            Used for sign-in, receipts, and account recovery.
          </p>
        </div>

        {nameError ? (
          <p role="alert" className="mt-2 text-[12px] text-red-600">
            {nameError}
          </p>
        ) : null}
        {pictureError ? (
          <p role="alert" className="mt-2 text-[12px] text-red-600">
            {pictureError}
          </p>
        ) : null}

        <div className="mt-5 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={handleDiscard}
            disabled={!hasChanges || savingName}
            className="echo-btn echo-btn-outline disabled:cursor-not-allowed disabled:opacity-40"
          >
            Discard
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={!hasChanges || savingName || !firstName.trim()}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-4 text-[13px] font-medium text-primary-foreground shadow-[0_1px_2px_rgba(31,27,22,0.08)] transition-[transform,opacity,background-color] duration-100 hover:bg-[hsl(var(--clay-hsl))] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {savingName ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Save changes
          </button>
        </div>
      </section>

      <input
        ref={profileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={handleProfilePictureSelected}
      />

      {cloudVisible && <SyncCard status={sync} onForce={handleForceSync} forcing={forcing} />}

      {/* Bottom-left destructive actions — use the same .echo-btn-* CSS
          component classes as the confirm modal buttons so the panel
          and its modals read as one consistent system. Raw Tailwind
          `bg-foreground` / `bg-destructive` utilities lose to `.echo-btn`'s
          base colors due to stylesheet order, which is why they looked
          washed-out before. */}
      <div className="mt-auto flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={() => setSignOutModalOpen(true)}
          disabled={signingOut}
          className="echo-btn echo-btn-dark disabled:opacity-60"
        >
          <LogOut size={14} />
          {signingOut ? 'Signing out…' : 'Sign out'}
        </button>
        <button
          type="button"
          onClick={() => setDeleteModalOpen(true)}
          className="echo-btn echo-btn-danger"
        >
          <Trash2 size={14} />
          Delete account
        </button>
      </div>

      <ConfirmationModal
        open={signOutModalOpen}
        title="Are you sure you want to sign out?"
        description=""
        cancelLabel="Back to account"
        confirmLabel={signingOut ? 'Signing out…' : 'Sign out'}
        loading={signingOut}
        confirmButtonClassName="echo-btn-dark"
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
        confirmButtonClassName="echo-btn-danger"
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
    <section className="rounded-xl border border-border bg-popover p-3 shadow-[0_1px_4px_rgba(31,27,22,0.05)]">
      <h2 className="mb-2 text-[15px] font-semibold text-foreground">Cloud sync</h2>
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <span aria-hidden>{icon}</span>
          <span className="text-[13px] text-[hsl(220,14%,18%)]">{label}</span>
        </div>
        <button
          type="button"
          onClick={onForce}
          disabled={forcing}
          className="echo-btn echo-btn-outline disabled:opacity-60"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${forcing ? 'animate-spin' : ''}`} />
          Sync now
        </button>
      </div>
      {status?.lastError ? (
        <p className="mt-3 text-[13px] text-red-700">{status.lastError}</p>
      ) : null}
      {status && status.queueDepth > 0 && status.status !== 'syncing' ? (
        <p className="mt-3 text-[13px] text-[hsl(220,10%,46%)]">
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
