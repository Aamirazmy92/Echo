/*
 * Toast dispatch + types.
 *
 * Single source of truth for queuing toast notifications. Anyone can call
 * `toast.success(...)` / `toast.error(...)` / `toast.info(...)` from
 * anywhere in the renderer; ToastHost subscribes once and renders the
 * stack bottom-right of the main window.
 *
 * Backwards-compat: the old `'show-toast'` CustomEvent that several
 * components (Dashboard, etc.) already dispatch is bridged into the new
 * system inside ToastHost so we don't have to rewrite every existing
 * call site in the same change.
 */

export type ToastType = 'success' | 'error' | 'info';

export interface ToastDispatch {
  id: number;
  type: ToastType;
  message: string;
  /** Override the default auto-dismiss duration (ms). */
  duration?: number;
}

const TOAST_EVENT = 'echo:toast';

let nextId = 1;

function dispatch(type: ToastType, message: string, duration?: number): number {
  const id = nextId;
  nextId += 1;
  const detail: ToastDispatch = { id, type, message, duration };
  window.dispatchEvent(new CustomEvent<ToastDispatch>(TOAST_EVENT, { detail }));
  return id;
}

export const toast = {
  success(message: string, duration?: number): number {
    return dispatch('success', message, duration);
  },
  error(message: string, duration?: number): number {
    return dispatch('error', message, duration);
  },
  info(message: string, duration?: number): number {
    return dispatch('info', message, duration);
  },
};

export const TOAST_EVENT_NAME = TOAST_EVENT;
