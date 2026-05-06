import { useState, type FormEvent } from 'react';
import { AuthShell, inputClasses, linkButtonClasses, primaryButtonClasses } from './authShell';

interface Props {
  onBack: () => void;
}

export default function ForgotPasswordScreen({ onBack }: Props) {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!email.trim()) {
      setError('Please enter the email you used to sign up.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const result = await window.api.authResetPassword(email);
      if (result.error) {
        setError(result.error);
        return;
      }
      setSent(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not send reset email. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell
      title={sent ? 'Check your inbox' : 'Reset your password'}
      subtitle={sent ? 'We sent you a link.' : 'Enter your email and we\u2019ll send a reset link.'}
      footer={
        <button type="button" className={linkButtonClasses} onClick={onBack}>
          Back to sign in
        </button>
      }
    >
      {sent ? (
        <p className="text-sm text-[hsl(220,10%,32%)]">
          We've sent a password-reset link to <strong>{email}</strong>. Click it from the same
          device to set a new password and come back here to sign in.
        </p>
      ) : (
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-[hsl(220,10%,30%)]">Email</span>
            <input
              type="email"
              autoComplete="email"
              autoFocus
              className={inputClasses}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={submitting}
              placeholder="you@example.com"
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

          <button type="submit" className={primaryButtonClasses} disabled={submitting}>
            {submitting ? 'Sending…' : 'Send reset link'}
          </button>
        </form>
      )}
    </AuthShell>
  );
}
