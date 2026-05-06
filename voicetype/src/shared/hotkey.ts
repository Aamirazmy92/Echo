export const DEFAULT_PUSH_TO_TALK_HOTKEY = 'CommandOrControl+Space';
export const DEFAULT_TOGGLE_HOTKEY = 'CommandOrControl+Shift+Space';
export const DEFAULT_CANCEL_HOTKEY = 'Escape';
export const DEFAULT_HOTKEY = DEFAULT_PUSH_TO_TALK_HOTKEY;
export type HotkeySettingInput = string | string[] | null | undefined;

// Sided modifier tokens that should be passed through as-is
const SIDED_MODIFIERS = new Set([
  'LCtrl', 'RCtrl', 'LAlt', 'RAlt', 'LShift', 'RShift', 'LSuper', 'RSuper',
]);
const MOUSE_BUTTONS = new Set(['MouseMiddle', 'Mouse4', 'Mouse5']);

function normalizeMainKey(key: string) {
  if (!key) return '';
  if (key === ' ') return 'Space';
  if (SIDED_MODIFIERS.has(key)) return key;

  const aliases: Record<string, string> = {
    Ctrl: 'CommandOrControl',
    ctrl: 'CommandOrControl',
    Control: 'CommandOrControl',
    control: 'CommandOrControl',
    Command: 'CommandOrControl',
    command: 'CommandOrControl',
    Meta: 'Super',
    meta: 'Super',
    Win: 'Super',
    win: 'Super',
    Alt: 'Alt',
    alt: 'Alt',
    Shift: 'Shift',
    shift: 'Shift',
    Spacebar: 'Space',
    spacebar: 'Space',
    'Middle Mouse': 'MouseMiddle',
    MouseMiddle: 'MouseMiddle',
    'Mouse 3': 'MouseMiddle',
    Mouse3: 'MouseMiddle',
    'Mouse 4': 'Mouse4',
    Mouse4: 'Mouse4',
    'Mouse 5': 'Mouse5',
    Mouse5: 'Mouse5',
  };

  const aliased = aliases[key] ?? key;
  if (MOUSE_BUTTONS.has(aliased)) {
    return aliased;
  }
  if (aliased.length === 1) {
    return aliased.toUpperCase();
  }

  return aliased;
}

export function normalizeHotkeyAccelerator(
  hotkey?: string | null,
  fallback = DEFAULT_PUSH_TO_TALK_HOTKEY
) {
  if (!hotkey?.trim()) return fallback;

  // If the hotkey is a single sided modifier token, pass it through directly
  const trimmed = hotkey.trim();
  if (SIDED_MODIFIERS.has(trimmed)) return trimmed;

  let hasCommandOrControl = false;
  let hasAlt = false;
  let hasShift = false;
  let hasSuper = false;
  let mainKey = '';

  for (const rawPart of hotkey.split('+')) {
    const part = normalizeMainKey(rawPart.trim());
    if (!part) continue;

    switch (part) {
      case 'CommandOrControl':
        hasCommandOrControl = true;
        break;
      case 'Alt':
        hasAlt = true;
        break;
      case 'Shift':
        hasShift = true;
        break;
      case 'Super':
        hasSuper = true;
        break;
      default:
        if (!mainKey) {
          mainKey = part;
        }
        break;
    }
  }

  const parts: string[] = [];
  if (hasCommandOrControl) parts.push('CommandOrControl');
  if (hasAlt) parts.push('Alt');
  if (hasShift) parts.push('Shift');
  if (hasSuper) parts.push('Super');
  if (mainKey) parts.push(mainKey);

  if (!parts.length) return fallback;

  return parts.join('+');
}

export function normalizeHotkeyList(
  hotkeys?: HotkeySettingInput,
  fallback = DEFAULT_PUSH_TO_TALK_HOTKEY
) {
  const rawValues = Array.isArray(hotkeys) ? hotkeys : [hotkeys];
  const normalized = rawValues
    .map((value) => normalizeHotkeyAccelerator(value, ''))
    .filter(Boolean);
  const unique = Array.from(new Set(normalized));

  return unique.length ? unique : [normalizeHotkeyAccelerator(undefined, fallback)];
}

export function normalizeShortcutSettings<T extends { toggleHotkey?: HotkeySettingInput; pushToTalkHotkey?: HotkeySettingInput; cancelHotkey?: HotkeySettingInput }>(
  settings: T
) {
  return {
    ...settings,
    toggleHotkey: normalizeHotkeyList(settings.toggleHotkey, DEFAULT_TOGGLE_HOTKEY),
    pushToTalkHotkey: normalizeHotkeyList(settings.pushToTalkHotkey, DEFAULT_PUSH_TO_TALK_HOTKEY),
    cancelHotkey: normalizeHotkeyList(settings.cancelHotkey, DEFAULT_CANCEL_HOTKEY),
  };
}

function formatSingleHotkeyLabel(hotkey?: string | null) {
  return normalizeHotkeyAccelerator(hotkey)
    .replace(/CommandOrControl/g, 'Ctrl')
    .replace(/\bLCtrl\b/g, 'Left Ctrl')
    .replace(/\bRCtrl\b/g, 'Right Ctrl')
    .replace(/\bLAlt\b/g, 'Left Alt')
    .replace(/\bRAlt\b/g, 'Right Alt')
    .replace(/\bLShift\b/g, 'Left Shift')
    .replace(/\bRShift\b/g, 'Right Shift')
    .replace(/\bLSuper\b/g, 'Left Win')
    .replace(/\bRSuper\b/g, 'Right Win')
    .replace(/\bSuper\b/g, 'Win')
    .replace(/\bMouseMiddle\b/g, 'Middle Mouse')
    .replace(/\bMouse4\b/g, 'Mouse 4')
    .replace(/\bMouse5\b/g, 'Mouse 5')
    .replace(/\+/g, ' + ');
}

export function formatHotkeyLabel(hotkey?: HotkeySettingInput | null) {
  return normalizeHotkeyList(hotkey).map((value) => formatSingleHotkeyLabel(value)).join(' or ');
}
