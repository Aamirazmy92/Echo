import { useEffect, useState, type FormEvent } from 'react';
import {
  AuthShell,
  inputClasses,
  linkButtonClasses,
  primaryButtonClasses,
  secondaryButtonClasses,
} from './authShell';

interface Props {
  onSwitchToLogin: () => void;
  onSignedIn: () => void;
}

export default function SignupScreen({ onSwitchToLogin, onSignedIn }: Props) {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsConfirmation, setNeedsConfirmation] = useState(false);
  const [googleSubmitting, setGoogleSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!email.trim() || !password) {
      setError('Email and password are required.');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const result = await window.api.authSignUp(email, password, displayName);
      if (result.error) {
        setError(result.error);
        return;
      }
      if (result.needsConfirmation) {
        setNeedsConfirmation(true);
      } else {
        onSignedIn();
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not create account. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleGoogle() {
    setError(null);
    setGoogleSubmitting(true);
    try {
      const result = await window.api.authGoogleSignIn();
      if (result.error) setError(result.error);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not start Google sign-in.');
    } finally {
      setGoogleSubmitting(false);
    }
  }

  useEffect(() => {
    if (!needsConfirmation) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setNeedsConfirmation(false);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [needsConfirmation]);

  if (needsConfirmation) {
    return (
      <AuthShell
        title="Check your inbox"
        subtitle="One more step before you can dictate"
        footer={
          <>
            Already confirmed?{' '}
            <button type="button" className={linkButtonClasses} onClick={onSwitchToLogin}>
              Sign in
            </button>
          </>
        }
      >
        <p className="text-sm text-[hsl(220,10%,32%)]">
          We've sent a confirmation link to <strong>{email}</strong>. Click it to activate your
          account, then come back here to sign in. The link expires in 24 hours.
        </p>
        <button
          type="button"
          className={`${secondaryButtonClasses} mt-5`}
          onClick={() => setNeedsConfirmation(false)}
        >
          Back to sign up
        </button>
      </AuthShell>
    );
  }

  const disabled = submitting || googleSubmitting;

  return (
    <AuthShell
      title="Create your account"
      subtitle="History, dictionary and snippets sync across every device you sign in on"
      footer={
        <>
          Already have an account?{' '}
          <button type="button" className={linkButtonClasses} onClick={onSwitchToLogin}>
            Sign in
          </button>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-[hsl(220,10%,30%)]">Display name</span>
          <input
            type="text"
            autoComplete="nickname"
            autoFocus
            className={inputClasses}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            disabled={disabled}
            placeholder="What should we call you?"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-[hsl(220,10%,30%)]">Email</span>
          <input
            type="email"
            autoComplete="email"
            className={inputClasses}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={disabled}
            placeholder="you@example.com"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-[hsl(220,10%,30%)]">Password</span>
          <input
            type="password"
            autoComplete="new-password"
            className={inputClasses}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={disabled}
            placeholder="At least 8 characters"
          />
        </label>

        {error ? (
          <div
            role="alert"
            className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800"
          >
            {error}
          </div>
        ) : null}

        <div className="mt-1 flex flex-col gap-3">
          <button type="submit" className={primaryButtonClasses} disabled={disabled}>
            {submitting ? 'Creating account…' : 'Create account'}
          </button>

          <div className="flex items-center gap-3 text-xs text-[hsl(220,10%,55%)]">
            <span className="h-px flex-1 bg-[hsl(220,14%,90%)]" />
            <span>or</span>
            <span className="h-px flex-1 bg-[hsl(220,14%,90%)]" />
          </div>

          <button
            type="button"
            className={secondaryButtonClasses}
            onClick={handleGoogle}
            disabled={disabled}
          >
            <GoogleGlyph />
            {googleSubmitting ? 'Opening browser…' : 'Continue with Google'}
          </button>
        </div>
      </form>
    </AuthShell>
  );
}

function GoogleGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden>
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.49h4.84a4.13 4.13 0 0 1-1.79 2.71v2.26h2.9c1.7-1.56 2.69-3.87 2.69-6.62z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26a5.4 5.4 0 0 1-3.06.86 5.4 5.4 0 0 1-5.07-3.71H.96v2.33A9 9 0 0 0 9 18z"
      />
      <path fill="#FBBC05" d="M3.93 10.71A5.4 5.4 0 0 1 3.64 9c0-.6.1-1.18.29-1.71V4.96H.96A9 9 0 0 0 0 9c0 1.45.35 2.82.96 4.04l2.97-2.33z" />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.51.45 3.45 1.35l2.58-2.58A8.97 8.97 0 0 0 9 0 9 9 0 0 0 .96 4.96l2.97 2.33A5.4 5.4 0 0 1 9 3.58z"
      />
    </svg>
  );
}
