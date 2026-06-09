/** Hover-reveal row actions that stay visible while a row is active (edit/delete open). */
export function rowActionsClassName(active = false): string {
  return active ? 'echo-row-actions is-active' : 'echo-row-actions';
}
