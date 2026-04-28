import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

/**
 * Top-level error boundary.
 *
 * Why we replaced the old "red text on black" panel:
 *   1. Any uncaught render-time exception in Dashboard/Insights/Settings
 *      used to white-screen the window with no recovery path.
 *   2. The crash details never reached the main-process log, so a friend
 *      reporting "the app went red" gave us nothing to debug from.
 *
 * The new boundary forwards a sanitised summary to the main process via
 * `window.api.reportRendererError`, dismisses the splash if it's still
 * up (so the user isn't stuck behind it), and offers a single Reload
 * button. Reloading is enough for >95 % of render errors because state
 * lives in `electron-store` / SQLite, not React memory.
 */
class ErrorBoundary extends React.Component<{ children: any }, { hasError: boolean; error: any }> {
  constructor(props: any) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error: any) {
    return { hasError: true, error };
  }
  componentDidCatch(error: any, errorInfo: { componentStack?: string }) {
    // Make sure the splash gets out of the way so the recovery card is
    // actually visible if the crash happened during initial render.
    try {
      (window as { __dismissEchoSplash?: () => void }).__dismissEchoSplash?.();
    } catch {
      // Ignore — the splash might already be gone.
    }

    // Forward a compact crash summary to the main process. The IPC layer
    // re-validates and truncates, so even if `error` is something exotic
    // we won't blow up the log budget.
    try {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error
        ? `${error.stack || ''}${errorInfo?.componentStack ? `\n--- componentStack ---${errorInfo.componentStack}` : ''}`
        : (errorInfo?.componentStack || undefined);
      (window as any).api?.reportRendererError?.('error-boundary', message, stack);
    } catch {
      // The bridge is best-effort — we never want logging to itself crash
      // a recovery view.
    }
  }
  reload = () => {
    window.location.reload();
  };
  render() {
    if (this.state.hasError) {
      const detail = this.state.error?.stack
        ? String(this.state.error.stack)
        : String(this.state.error?.message ?? this.state.error ?? 'Unknown error');
      return (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100vh',
            padding: 24,
            background: 'hsl(220, 20%, 94%)',
            color: 'hsl(220, 14%, 14%)',
            fontFamily: '"Figtree", "Segoe UI", sans-serif',
          }}
        >
          <div
            style={{
              maxWidth: 560,
              width: '100%',
              padding: 28,
              borderRadius: 16,
              background: 'white',
              boxShadow: '0 4px 24px rgba(0, 0, 0, 0.08)',
              border: '1px solid rgba(0, 0, 0, 0.06)',
            }}
          >
            <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 6 }}>Something went wrong</div>
            <div style={{ fontSize: 13, color: 'hsl(220, 10%, 40%)', marginBottom: 18 }}>
              Echo hit an unexpected error and stopped rendering. The full crash details have been
              saved to <code style={{ background: 'hsl(220, 14%, 92%)', padding: '1px 5px', borderRadius: 4 }}>
                %APPDATA%/Echo/dictation.log
              </code> if you'd like to investigate. Reloading usually clears the issue.
            </div>
            <button
              type="button"
              onClick={this.reload}
              style={{
                appearance: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: '10px 16px',
                borderRadius: 10,
                fontSize: 13,
                fontWeight: 600,
                background: 'hsl(220, 14%, 14%)',
                color: 'white',
              }}
            >
              Reload Echo
            </button>
            <details style={{ marginTop: 20 }}>
              <summary style={{ cursor: 'pointer', fontSize: 12, color: 'hsl(220, 10%, 50%)' }}>
                Show technical details
              </summary>
              <pre
                style={{
                  marginTop: 10,
                  padding: 12,
                  borderRadius: 8,
                  background: 'hsl(220, 14%, 96%)',
                  fontSize: 11,
                  lineHeight: 1.5,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  maxHeight: 240,
                  overflow: 'auto',
                }}
              >
                {detail}
              </pre>
            </details>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const container = document.getElementById('root') as HTMLElement;
const root = createRoot(container);
root.render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);

// ── Splash lifecycle ──
// Keep the branded splash (rendered by index.html) visible long enough for
// the user to actually see it, then cross-fade into the app once React has
// loaded settings. A minimum display time prevents a jarring flash on fast
// launches; a safety timeout guarantees the splash never stays stuck.
const SPLASH_SHOWN_AT = Date.now();
const SPLASH_MIN_VISIBLE_MS = 700;   // polished, intentional feel
const SPLASH_MAX_VISIBLE_MS = 6000;  // absolute safety cap

let splashDismissed = false;

const removeSplashNode = () => {
  const splash = document.getElementById('splash');
  if (!splash) return;
  splash.classList.add('fade-out');
  const cleanup = () => splash.remove();
  splash.addEventListener('transitionend', cleanup, { once: true });
  // Fallback in case `transitionend` never fires (reduced-motion users get
  // an instant hide, but the node still needs to be detached).
  window.setTimeout(cleanup, 800);
};

const dismissSplash = () => {
  if (splashDismissed) return;
  splashDismissed = true;
  const elapsed = Date.now() - SPLASH_SHOWN_AT;
  const wait = Math.max(0, SPLASH_MIN_VISIBLE_MS - elapsed);
  window.setTimeout(removeSplashNode, wait);
};

// App.tsx calls this once initial settings have been loaded and the first
// interactive UI is about to paint.
(window as { __dismissEchoSplash?: () => void }).__dismissEchoSplash = dismissSplash;

// Safety: if the renderer stalls for any reason, don't trap the user behind
// the splash forever.
window.setTimeout(dismissSplash, SPLASH_MAX_VISIBLE_MS);
