/**
 * Browsers (including Chromium/Electron) often keep the “wrong” cursor and
 * :hover state after a fullscreen overlay is removed while the pointer
 * stays still — the element underneath never receives a new pointer entry.
 * Tracking the last client position and dispatching a micro synthetic
 * hover/move at that point forces cursor + hover to match what’s under the
 * pointer again.
 */
let lastClientX = 0;
let lastClientY = 0;
let hasPointerSample = false;

if (typeof window !== 'undefined') {
  const track = (e: MouseEvent) => {
    lastClientX = e.clientX;
    lastClientY = e.clientY;
    hasPointerSample = true;
  };
  window.addEventListener('mousemove', track, { passive: true, capture: true });
  window.addEventListener('pointermove', track, { passive: true, capture: true });
}

export function refreshPointerTargetUnderCursor(): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (!hasPointerSample) return;

      const x = lastClientX;
      const y = lastClientY;
      const el = document.elementFromPoint(x, y);
      if (!el || el === document.documentElement) return;

      const init: MouseEventInit = {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        view: window,
      };

      el.dispatchEvent(new MouseEvent('mouseover', init));
      el.dispatchEvent(new MouseEvent('mousemove', init));
    });
  });
}
