import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PUSH_TO_TALK_HOTKEY,
  DEFAULT_TOGGLE_HOTKEY,
  formatHotkeyLabel,
  normalizeHotkeyAccelerator,
  normalizeHotkeyList,
  normalizeShortcutSettings,
} from './hotkey';

describe('hotkey helpers', () => {
  it('normalizes common modifier aliases into Electron accelerators', () => {
    expect(normalizeHotkeyAccelerator('Ctrl + shift + a')).toBe('CommandOrControl+Shift+A');
    expect(normalizeHotkeyAccelerator('Win + Spacebar')).toBe('Super+Space');
    expect(normalizeHotkeyAccelerator('Middle Mouse')).toBe('MouseMiddle');
  });

  it('deduplicates hotkey lists and falls back when empty', () => {
    expect(normalizeHotkeyList(['Ctrl+A', 'Control + a', ''])).toEqual(['CommandOrControl+A']);
    expect(normalizeHotkeyList([], DEFAULT_TOGGLE_HOTKEY)).toEqual([DEFAULT_TOGGLE_HOTKEY]);
  });

  it('normalizes shortcut settings independently', () => {
    expect(normalizeShortcutSettings({ toggleHotkey: 'Ctrl+B', pushToTalkHotkey: null })).toMatchObject({
      toggleHotkey: ['CommandOrControl+B'],
      pushToTalkHotkey: [DEFAULT_PUSH_TO_TALK_HOTKEY],
    });
  });

  it('formats user-facing labels', () => {
    expect(formatHotkeyLabel(['CommandOrControl+Shift+Space', 'Mouse4'])).toBe('Ctrl + Shift + Space or Mouse 4');
  });
});
