import type { ReactNode } from 'react';
import { Minus, Square, X } from 'lucide-react';
import echoLogoUrl from '../assets/echo-logo.png';

/*
 * Shared chrome for every auth screen — centred card on a soft
 * gradient backdrop with the Echo wordmark + a subtitle.
 *
 * This file deliberately uses inline tailwind classes (no shadcn
 * components) because the auth screens render BEFORE the lazy-loaded
 * dashboard. Pulling in dialog/Button/etc. here would defeat that
 * lazy split and slow first paint after sign-in.
 *
 * Frameless-window plumbing:
 *   The Echo BrowserWindow is `frame: false`, so without an in-app
 *   titlebar the user can't move, minimise, maximise, or close the
 *   window from the sign-in screen. We render the same drag region
 *   + min/max/close trio as App.tsx, scoped to AuthShell, so the
 *   auth screens behave like a normal Windows app.
 *
 *   The `titlebar` and `no-drag` classes are defined in `index.css`
 *   and toggle Electron's `-webkit-app-region` between `drag` and
 *   `no-drag` — there is no JS plumbing required for the drag region
 *   itself.
 */
export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div
      className="relative flex h-screen w-screen items-center justify-center px-6"
      style={{
        background:
          'radial-gradient(circle at 30% 0%, hsl(220, 30%, 97%), hsl(220, 18%, 92%) 60%)',
      }}
    >
      <TitleBar />
      <div className="w-full max-w-[400px]">
        <div className="mb-6 text-center">
          <div className="mb-3 flex justify-center">
            <img
              src={echoLogoUrl}
              alt="Echo"
              draggable={false}
              className="h-14 w-14 select-none object-contain"
            />
          </div>
          <div className="mb-1 text-2xl font-semibold tracking-tight text-[hsl(220,14%,14%)]">
            Echo
          </div>
          <div className="text-sm text-[hsl(220,10%,42%)]">{subtitle}</div>
        </div>

        <div
          className="rounded-2xl border border-black/5 bg-white p-7 shadow-[0_4px_24px_rgba(0,0,0,0.06)]"
        >
          <h1 className="mb-5 text-base font-semibold text-[hsl(220,14%,14%)]">{title}</h1>
          {children}
        </div>

        {footer ? (
          <div className="mt-5 text-center text-xs text-[hsl(220,10%,46%)]">{footer}</div>
        ) : null}
      </div>
    </div>
  );
}

export const inputClasses =
  'w-full rounded-lg border border-[hsl(220,14%,86%)] bg-white px-3 py-2 text-sm text-[hsl(220,14%,14%)] outline-none placeholder:text-[hsl(220,10%,60%)] focus:border-black focus:ring-2 focus:ring-black/10 disabled:opacity-60';

export const primaryButtonClasses =
  'flex h-10 w-full items-center justify-center rounded-lg bg-[hsl(220,14%,14%)] px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-[hsl(220,14%,8%)] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60';

export const secondaryButtonClasses =
  'flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-[hsl(220,14%,86%)] bg-white px-4 text-sm font-medium text-[hsl(220,14%,14%)] transition hover:bg-[hsl(220,20%,97%)] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60';

export const linkButtonClasses =
  'text-[hsl(220,14%,14%)] underline-offset-4 hover:underline focus:outline-none focus:underline';

/**
 * Frameless-window titlebar for the auth screens.
 *
 * Spans the full top of the window so anywhere outside the buttons is
 * draggable (the `titlebar` class enables `-webkit-app-region: drag`).
 * Buttons opt out via `no-drag` so clicks register normally.
 */
function TitleBar() {
  return (
    <div className="titlebar absolute top-0 left-0 right-0 z-50 flex h-10 items-center justify-end pr-2">
      <div className="no-drag flex items-center">
        <button
          type="button"
          onClick={() => window.api.windowMinimize()}
          aria-label="Minimize window"
          className="flex h-10 w-11 items-center justify-center rounded-md text-[hsl(220,14%,40%)] transition-colors hover:bg-black/5 hover:text-[hsl(220,14%,14%)]"
        >
          <Minus size={17} />
        </button>
        <button
          type="button"
          onClick={() => window.api.windowToggleMaximize()}
          aria-label="Maximize window"
          className="flex h-10 w-11 items-center justify-center rounded-md text-[hsl(220,14%,40%)] transition-colors hover:bg-black/5 hover:text-[hsl(220,14%,14%)]"
        >
          <Square size={15} />
        </button>
        <button
          type="button"
          onClick={() => window.api.windowClose()}
          aria-label="Close window"
          className="flex h-10 w-11 items-center justify-center rounded-md text-[hsl(220,14%,40%)] transition-colors hover:bg-red-500/10 hover:text-red-600"
        >
          <X size={17} />
        </button>
      </div>
    </div>
  );
}
