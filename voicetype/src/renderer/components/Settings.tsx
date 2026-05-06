import { memo, useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { Settings as SettingsType } from '../../shared/types';
import { getEffectiveLanguageSelection, LANGUAGE_OPTIONS } from '../../shared/languages';
import {
  DEFAULT_CANCEL_HOTKEY,
  DEFAULT_PUSH_TO_TALK_HOTKEY,
  DEFAULT_TOGGLE_HOTKEY,
  formatHotkeyLabel,
  normalizeHotkeyAccelerator,
  normalizeHotkeyList,
} from '../../shared/hotkey';
import {
  Check,
  Download,
  Search,
  Settings as SettingsIcon,
  Monitor,
  Globe2,
  Loader2,
  RefreshCw,
  X,
  Pencil,
  Eye,
  EyeOff,
  Mic,
  Wifi,
  UserCircle2,
} from 'lucide-react';
import AccountView from './Account';
import { toast } from './toast/useToast';
import type { UpdateStatusPayload } from '../api';
import {
  MODAL_BACKDROP_EXIT,
  MODAL_BACKDROP_INITIAL,
  MODAL_BACKDROP_OPEN,
  MODAL_BACKDROP_TRANSITION,
  MODAL_PANEL_INITIAL,
  MODAL_PANEL_OPEN,
  MODAL_PANEL_EXIT,
  MODAL_OPEN_TRANSITION,
  MODAL_CLOSE_TRANSITION,
} from '../lib/modalMotion';

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta']);
const SUPPORTED_MOUSE_BUTTONS: Record<number, { accelerator: string; label: string }> = {
  1: { accelerator: 'MouseMiddle', label: 'Middle Mouse' },
  3: { accelerator: 'Mouse4', label: 'Mouse 4' },
  4: { accelerator: 'Mouse5', label: 'Mouse 5' },
};
type HotkeyTarget = 'toggleHotkey' | 'pushToTalkHotkey' | 'cancelHotkey';
type ActiveHotkeyCapture = {
  field: HotkeyTarget;
  index: number;
};
type SelectOption = {
  value: string;
  label: string;
  nativeLabel?: string;
  flag?: string;
  description?: string;
};

const languageOptions: SelectOption[] = LANGUAGE_OPTIONS.map((option) => ({
  value: option.id,
  label: option.label,
  nativeLabel: option.nativeLabel,
  flag: option.flag,
  description: option.description,
}));
const nonAutoLanguageOptions = languageOptions.filter((option) => option.value !== 'auto');
const searchableLanguageOptions = nonAutoLanguageOptions.map((option) => ({
  ...option,
  searchText: `${option.label} ${option.nativeLabel ?? ''} ${option.description ?? ''}`.toLowerCase(),
}));

function summarizeSelectedLanguages(selectedValues: string[], autoDetectEnabled: boolean) {
  const labels = selectedValues
    .map((value) => languageOptions.find((option) => option.value === value)?.label ?? value)
    .filter(Boolean);

  if (!labels.length) {
    return autoDetectEnabled ? 'Auto-detect all languages' : 'English';
  }

  const joinedLabels = labels.length <= 3
    ? labels.join(', ')
    : `${labels.slice(0, 2).join(', ')} +${labels.length - 2} more`;

  return autoDetectEnabled ? 'Auto-detect all languages' : joinedLabels;
}

function SettingsModalShell({
  open,
  onClose,
  children,
  panelClassName = '',
  zIndex = 180,
  onBackdropClick,
  closeOnEscape = true,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  panelClassName?: string;
  zIndex?: number;
  onBackdropClick?: () => void;
  closeOnEscape?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (!closeOnEscape) return;
      if (document.querySelector('[data-confirmation-modal="true"]')) return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open, onClose, closeOnEscape]);

  const modalContent = (
    <AnimatePresence initial={false}>
      {open ? (
        <motion.div
          key="settings-modal"
          className="fixed inset-0 flex items-center justify-center"
          style={{ zIndex }}
          aria-hidden={false}
          initial={{ opacity: 1 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 1 }}
          onClick={() => (onBackdropClick ?? onClose)()}
        >
          <motion.div
            className="absolute inset-0 bg-black/15"
            initial={MODAL_BACKDROP_INITIAL}
            animate={MODAL_BACKDROP_OPEN}
            exit={MODAL_BACKDROP_EXIT}
            transition={MODAL_BACKDROP_TRANSITION}
          />
          <motion.div
            className={`settings-modal-panel relative overflow-hidden rounded-2xl border border-border bg-background shadow-[0_30px_80px_-20px_rgba(15,23,42,0.35)] transform-gpu ${panelClassName}`}
            initial={MODAL_PANEL_INITIAL}
            animate={MODAL_PANEL_OPEN}
            exit={{ ...MODAL_PANEL_EXIT, transition: MODAL_CLOSE_TRANSITION }}
            transition={MODAL_OPEN_TRANSITION}
            style={{ willChange: 'opacity, transform' }}
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
          >
            {children}
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );

  return createPortal(modalContent, document.body);
}

// Segmented control used for Mode (Local/Cloud) and Overlay position
// (Top/Bottom). Pure CSS transform, no framer layout animation.
function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string; disabled?: boolean }>;
  onChange: (next: T) => void;
}) {
  const activeIndex = Math.max(0, options.findIndex((o) => o.value === value));
  const n = Math.max(1, options.length);
  // Use an inline-grid of N equal columns so every button gets the same
  // slot width regardless of label length. A flex layout sizes each button
  // to its content ("Top" vs "Bottom"), which makes the active label look
  // off-centre inside the pill even though the pill itself is correctly
  // positioned at equal intervals.
  return (
    <div
      className="relative inline-grid items-center rounded-xl border border-border bg-muted/60 p-1"
      style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}
    >
      <div
        className="segmented-thumb pointer-events-none absolute left-1 top-1 bottom-1 rounded-lg bg-background shadow-[0_1px_2px_rgba(15,23,42,0.08),0_8px_18px_-14px_rgba(15,23,42,0.25)]"
        style={{
          width: `calc((100% - 8px) / ${n})`,
          transform: `translateX(${activeIndex * 100}%)`,
        }}
      />
      {options.map((option) => {
        const isActive = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            disabled={option.disabled && !isActive}
            onClick={() => onChange(option.value)}
            className={`segmented-label relative z-10 rounded-lg px-4 py-1.5 text-[13px] font-medium ${
              isActive
                ? 'text-foreground'
                : option.disabled
                  ? 'cursor-not-allowed text-muted-foreground/40'
                  : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

const LANGUAGE_FLAG_CODES: Record<string, string> = {
  en: 'us',
  es: 'es',
  fr: 'fr',
  de: 'de',
  it: 'it',
  pt: 'pt',
  nl: 'nl',
  pl: 'pl',
  tr: 'tr',
  ru: 'ru',
  uk: 'ua',
  cs: 'cz',
  ro: 'ro',
  hu: 'hu',
  sv: 'se',
  no: 'no',
  da: 'dk',
  fi: 'fi',
  el: 'gr',
  bg: 'bg',
  hr: 'hr',
  sk: 'sk',
  sl: 'si',
  et: 'ee',
  lv: 'lv',
  lt: 'lt',
  ja: 'jp',
  ko: 'kr',
  zh: 'cn',
  'zh-CN': 'cn',
  'zh-TW': 'tw',
  yue: 'hk',
  hi: 'in',
  bn: 'bd',
  ta: 'in',
  te: 'in',
  mr: 'in',
  gu: 'in',
  pa: 'in',
  ur: 'pk',
  ar: 'sa',
  he: 'il',
  fa: 'ir',
  id: 'id',
  ms: 'my',
  th: 'th',
  vi: 'vn',
  ca: 'es',
  la: 'va',
  mi: 'nz',
  ml: 'in',
  cy: 'gb-wls',
  sr: 'rs',
  az: 'az',
  kn: 'in',
  mk: 'mk',
  br: 'fr',
  eu: 'es',
  is: 'is',
  hy: 'am',
  ne: 'np',
  mn: 'mn',
  bs: 'ba',
  kk: 'kz',
  sq: 'al',
  sw: 'ke',
  gl: 'es',
  si: 'lk',
  km: 'kh',
  sn: 'zw',
  yo: 'ng',
  so: 'so',
  af: 'za',
  oc: 'fr',
  ka: 'ge',
  be: 'by',
  tg: 'tj',
  sd: 'pk',
  am: 'et',
  yi: 'il',
  lo: 'la',
  uz: 'uz',
  fo: 'fo',
  ht: 'ht',
  ps: 'af',
  tk: 'tm',
  nn: 'no',
  mt: 'mt',
  sa: 'in',
  lb: 'lu',
  my: 'mm',
  bo: 'cn',
  tl: 'ph',
  mg: 'mg',
  as: 'in',
  tt: 'ru',
  haw: 'us',
  ln: 'cd',
  ha: 'ng',
  ba: 'ru',
  jw: 'id',
  su: 'id',
};

const FLAG_SIZE_CLASS = 'h-[18px] w-[26px] rounded-[5px] border border-black/10 shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.15)]';

function getFlagUrl(countryCode: string): string | null {
  const normalized = countryCode.toLowerCase();
  // flagcdn.com supports standard 2-letter codes and gb-wls for Wales
  if (normalized === 'gb-wls') {
    return 'https://flagcdn.com/w40/gb-wls.png';
  }
  if (!/^[a-z]{2}$/.test(normalized)) {
    return null;
  }
  return `https://flagcdn.com/w40/${normalized}.png`;
}

function normalizeMainKey(key: string) {
  if (key === ' ') return 'Space';
  if (key === 'Escape') return 'Esc';
  if (key.startsWith('Arrow')) return key.replace('Arrow', '');
  if (key === 'Backspace') return 'Backspace';
  if (key.length === 1) return key.toUpperCase();

  const aliases: Record<string, string> = {
    Enter: 'Enter',
    Tab: 'Tab',
    Delete: 'Delete',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    Insert: 'Insert',
    Spacebar: 'Space',
  };

  return aliases[key] ?? key;
}

// Map event.code to a sided modifier token
const SIDED_MODIFIER_MAP: Record<string, { part: string; label: string }> = {
  ControlLeft: { part: 'LCtrl', label: 'Left Ctrl' },
  ControlRight: { part: 'RCtrl', label: 'Right Ctrl' },
  AltLeft: { part: 'LAlt', label: 'Left Alt' },
  AltRight: { part: 'RAlt', label: 'Right Alt' },
  ShiftLeft: { part: 'LShift', label: 'Left Shift' },
  ShiftRight: { part: 'RShift', label: 'Right Shift' },
  MetaLeft: { part: 'LSuper', label: 'Left Win' },
  MetaRight: { part: 'RSuper', label: 'Right Win' },
};

function buildModifierOnlyHotkey(event: KeyboardEvent) {
  const sided = SIDED_MODIFIER_MAP[event.code];
  if (!sided) return null;
  return {
    valid: true as const,
    accelerator: sided.part,
    label: sided.label,
  };
}

function buildComboHotkeyFromEvent(event: KeyboardEvent, target: HotkeyTarget) {
  if (event.key === 'Escape' && target !== 'cancelHotkey') {
    return { cancelled: true as const };
  }

  // Skip if only a modifier was pressed (handled by keyup)
  if (MODIFIER_KEYS.has(event.key)) {
    return { pending: true as const };
  }

  const parts: string[] = [];
  const labels: string[] = [];

  if (event.ctrlKey || event.metaKey) {
    parts.push('CommandOrControl');
    labels.push('Ctrl');
  }
  if (event.altKey) {
    parts.push('Alt');
    labels.push('Alt');
  }
  if (event.shiftKey) {
    parts.push('Shift');
    labels.push('Shift');
  }

  const mainKey = normalizeMainKey(event.key);
  if (!mainKey) {
    return { valid: false as const, reason: 'Could not recognize the key. Try a different one.' };
  }

  if (target !== 'cancelHotkey' && parts.length === 0) {
    return { valid: false as const, reason: 'Please include at least one modifier key (Ctrl, Shift, Alt, Meta).' };
  }

  parts.push(mainKey);
  labels.push(mainKey);

  return {
    valid: true as const,
    accelerator: parts.join('+'),
    label: labels.join(' + '),
  };
}

function buildMouseHotkeyFromEvent(event: MouseEvent) {
  const mouseButton = SUPPORTED_MOUSE_BUTTONS[event.button];
  if (!mouseButton) {
    return { valid: false as const, reason: 'Use Middle Mouse, Mouse 4, or Mouse 5.' };
  }

  const parts: string[] = [];
  const labels: string[] = [];

  if (event.ctrlKey || event.metaKey) {
    parts.push('CommandOrControl');
    labels.push('Ctrl');
  }
  if (event.altKey) {
    parts.push('Alt');
    labels.push('Alt');
  }
  if (event.shiftKey) {
    parts.push('Shift');
    labels.push('Shift');
  }

  parts.push(mouseButton.accelerator);
  labels.push(mouseButton.label);

  return {
    valid: true as const,
    accelerator: parts.join('+'),
    label: labels.join(' + '),
  };
}

function FlagIcon({
  language,
  label,
  className = '',
}: {
  language?: string;
  label?: string;
  className?: string;
}) {
  if (language === 'auto') {
    return (
      <span
        aria-hidden="true"
        title={label}
        className={`inline-flex items-center justify-center rounded-md border border-border bg-muted text-muted-foreground ${FLAG_SIZE_CLASS} ${className}`}
      >
        <Globe2 size={14} strokeWidth={1.8} />
      </span>
    );
  }

  const countryCode = language ? LANGUAGE_FLAG_CODES[language] : undefined;
  const flagUrl = countryCode ? getFlagUrl(countryCode) : undefined;

  if (!flagUrl) {
    return (
      <span
        aria-hidden="true"
        title={label}
        className={`inline-flex items-center justify-center rounded-md border border-border bg-muted px-1.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-muted-foreground ${FLAG_SIZE_CLASS} ${className}`}
      >
        {!language ? '...' : language.slice(0, 2)}
      </span>
    );
  }

  return (
    <img
      aria-hidden="true"
      alt=""
      title={label}
      src={flagUrl}
      className={`inline-block object-cover ${className || FLAG_SIZE_CLASS}`}
      loading="lazy"
      decoding="async"
    />
  );
}

export default memo(function SettingsView({
  isOpen,
  onClose,
  settings,
  devices,
  onUpdateSettings,
}: {
  isOpen: boolean;
  onClose: () => void;
  settings: SettingsType | null;
  devices: MediaDeviceInfo[];
  onUpdateSettings: (partial: Partial<SettingsType>) => Promise<unknown>;
}) {
  const [activeCategory, setActiveCategory] = useState('General');
  const [settingsQuery, setSettingsQuery] = useState('');
  const [captureTarget, setCaptureTarget] = useState<ActiveHotkeyCapture | null>(null);
  const [hotkeyMessages, setHotkeyMessages] = useState<Partial<Record<HotkeyTarget, string>>>({});
  const [isShortcutsModalOpen, setIsShortcutsModalOpen] = useState(false);
  const [isLanguageModalOpen, setIsLanguageModalOpen] = useState(false);
  const [isMicrophoneModalOpen, setIsMicrophoneModalOpen] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatusPayload | null>(null);
  const [updateActionPending, setUpdateActionPending] = useState(false);
  const [appVersion, setAppVersion] = useState('');
  const hasChildModalOpenRef = useRef(false);
  const deferredSettingsQuery = useDeferredValue(settingsQuery);
  const appVisibilityLabel = navigator.platform.toLowerCase().includes('mac')
    ? 'Show app in dock'
    : 'Show app in taskbar';

  const getDefaultHotkeys = (target: HotkeyTarget) => {
    switch (target) {
      case 'toggleHotkey':
        return [DEFAULT_TOGGLE_HOTKEY];
      case 'cancelHotkey':
        return [DEFAULT_CANCEL_HOTKEY];
      default:
        return [DEFAULT_PUSH_TO_TALK_HOTKEY];
    }
  };

  const getHotkeysForTarget = (target: HotkeyTarget, currentSettings = settings) =>
    normalizeHotkeyList(currentSettings?.[target] ?? getDefaultHotkeys(target), getDefaultHotkeys(target)[0]);

  useEffect(() => {
    if (isOpen) return;

    if (captureTarget) {
      void window.api.resumeHotkey();
      setCaptureTarget(null);
    }
    setIsShortcutsModalOpen(false);
    setIsLanguageModalOpen(false);
    setIsMicrophoneModalOpen(false);
    setSettingsQuery('');
    setActiveCategory('General');
  }, [captureTarget, isOpen]);

  useEffect(() => {
    return () => {
      if (captureTarget) {
        void window.api.resumeHotkey();
      }
    };
  }, [captureTarget]);

  useEffect(() => {
    if (!isOpen) return;

    if (!isShortcutsModalOpen && captureTarget) {
      void window.api.resumeHotkey();
      setCaptureTarget(null);
    }
  }, [captureTarget, isOpen, isShortcutsModalOpen]);

  useEffect(() => {
    if (!isOpen || !captureTarget) return;
    const activeCapture = captureTarget;

    let modifierDownCode: string | null = null;

    async function commitHotkey(accelerator: string, label: string) {
      const targetField = activeCapture.field;
      const requestedHotkey = normalizeHotkeyAccelerator(accelerator);
      const currentHotkeys = getHotkeysForTarget(targetField);
      const nextHotkeys = [...currentHotkeys];
      const isAdding = activeCapture.index >= nextHotkeys.length;

      if (isAdding) {
        nextHotkeys.push(requestedHotkey);
      } else {
        nextHotkeys[activeCapture.index] = requestedHotkey;
      }

      try {
        await onUpdateSettings({ [targetField]: nextHotkeys });
      } catch (err) {
        console.error('Failed to save hotkey:', err);
        setCaptureTarget(null);
        toast.error(`Could not save "${label}". Try again.`);
        return;
      }
      const savedSettings = await window.api.getSettings();
      const savedValue = getHotkeysForTarget(targetField, savedSettings);
      setCaptureTarget(null);

      if (!savedValue.includes(requestedHotkey)) {
        // OS-level registration rejected the combo (e.g. another app owns
        // it, or the OS reserves it). Surface as a toast so the user sees
        // it even if they've already moved focus, and keep the inline
        // message for context inside the form.
        const message = `"${label}" is unavailable. Try a different shortcut.`;
        setHotkeyMessages((current) => ({
          ...current,
          [targetField]: `Shortcut unavailable. Saved shortcuts: ${savedValue.map((value: string) => formatHotkeyLabel(value)).join(', ')}.`,
        }));
        toast.error(message);
      } else {
        setHotkeyMessages((current) => ({
          ...current,
          [targetField]: `${isAdding ? 'Added' : 'Updated'} ${label}.`,
        }));
        toast.success(`"${label}" ${isAdding ? 'added successfully' : 'updated'}`);
      }
    }

    const onKeyDown = async (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();

      if (event.key === 'Escape' && activeCapture.field !== 'cancelHotkey') {
        setCaptureTarget(null);
        window.api.resumeHotkey();
        return;
      }

      if (MODIFIER_KEYS.has(event.key)) {
        modifierDownCode = event.code;
        return;
      }

      modifierDownCode = null;
      const result = buildComboHotkeyFromEvent(event, activeCapture.field);
      if ('pending' in result) return;
      if (!result.valid) {
        const reason = result.reason ?? 'Invalid shortcut. Try a different key combination.';
        setHotkeyMessages((current) => ({ ...current, [activeCapture.field]: reason }));
        toast.error(reason);
        return;
      }
      await commitHotkey(result.accelerator, result.label);
    };

    const onKeyUp = async (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();

      if (modifierDownCode && event.code === modifierDownCode) {
        const result = buildModifierOnlyHotkey(event);
        modifierDownCode = null;
        if (result) {
          await commitHotkey(result.accelerator, result.label);
        }
      }
    };

    const onMouseDown = async (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();

      // Ignore ordinary left clicks while a capture session is open.
      if (event.button === 0) {
        return;
      }

      const result = buildMouseHotkeyFromEvent(event);
      if (!result.valid) {
        const reason = result.reason ?? 'Invalid mouse button.';
        setHotkeyMessages((current) => ({ ...current, [activeCapture.field]: reason }));
        toast.error(reason);
        return;
      }

      await commitHotkey(result.accelerator, result.label);
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('mousedown', onMouseDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('mousedown', onMouseDown, true);
    };
  }, [captureTarget, isOpen, onUpdateSettings, settings]);

  const handleAppInDockToggle = (checked: boolean) => {
    onUpdateSettings({ showAppInDock: checked });
  };

  useEffect(() => {
    let cancelled = false;

    void window.api.getAppVersion().then((version) => {
      if (!cancelled) {
        setAppVersion(version);
      }
    }).catch(() => {
      if (!cancelled) {
        setAppVersion('');
      }
    });

    void window.api.updateGetStatus().then((status) => {
      if (!cancelled) {
        setUpdateStatus(status);
      }
    }).catch((error) => {
      console.error('Failed to load update status:', error);
    });

    const unsubscribe = window.api.onUpdateStatus((status) => {
      setUpdateStatus(status);
      setUpdateActionPending(false);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const handleUpdateAction = async (action: 'check' | 'download' | 'install') => {
    setUpdateActionPending(true);
    try {
      if (action === 'check') {
        await window.api.updateCheck();
      } else if (action === 'download') {
        await window.api.updateDownload();
      } else {
        await window.api.updateInstall();
      }
    } catch (error) {
      console.error('Update action failed:', error);
      toast.error('Could not start the update action. Try again.');
      setUpdateActionPending(false);
    }
  };

  const toggleHotkeys = useMemo(
    () => getHotkeysForTarget('toggleHotkey'),
    [settings?.toggleHotkey]
  );
  const pushToTalkHotkeys = useMemo(
    () => getHotkeysForTarget('pushToTalkHotkey'),
    [settings?.pushToTalkHotkey]
  );
  const cancelHotkeys = useMemo(
    () => getHotkeysForTarget('cancelHotkey'),
    [settings?.cancelHotkey]
  );

  const toggleHotkeyCapture = async (target: HotkeyTarget, index: number) => {
    setHotkeyMessages((current) => ({ ...current, [target]: '' }));
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }

    if (captureTarget?.field === target && captureTarget.index === index) {
      window.api.resumeHotkey();
      setCaptureTarget(null);
      return;
    }

    if (captureTarget) {
      window.api.resumeHotkey();
    }

    window.api.suspendHotkey();
    setCaptureTarget({ field: target, index });
  };

  const removeHotkey = async (target: HotkeyTarget, index: number) => {
    const currentHotkeys = getHotkeysForTarget(target);
    if (currentHotkeys.length <= 1) return;

    if (captureTarget?.field === target && captureTarget.index === index) {
      window.api.resumeHotkey();
      setCaptureTarget(null);
    }

    const nextHotkeys = currentHotkeys.filter((_, hotkeyIndex) => hotkeyIndex !== index);
    await onUpdateSettings({ [target]: nextHotkeys });
    setHotkeyMessages((current) => ({
      ...current,
      [target]: 'Removed shortcut.',
    }));
  };

  const closeShortcutsModal = async () => {
    if (captureTarget) {
      await window.api.resumeHotkey();
      setCaptureTarget(null);
    }
    setIsShortcutsModalOpen(false);
  };

  const closeMicrophoneModal = () => {
    setIsMicrophoneModalOpen(false);
  };

  const closeLanguageModal = () => {
    setIsLanguageModalOpen(false);
  };

  const hasChildModalOpen = isShortcutsModalOpen || isLanguageModalOpen || isMicrophoneModalOpen;

  useEffect(() => {
    hasChildModalOpenRef.current = hasChildModalOpen;
  }, [hasChildModalOpen]);

  useEffect(() => {
    if (!isOpen) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape'
        && !captureTarget
        && !hasChildModalOpenRef.current
        && !document.querySelector('[data-confirmation-modal="true"]')
      ) {
        onClose();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose, captureTarget]);

  const resetShortcutDefaults = async () => {
    if (captureTarget) {
      await window.api.resumeHotkey();
      setCaptureTarget(null);
    }

    await onUpdateSettings({
      pushToTalkHotkey: [DEFAULT_PUSH_TO_TALK_HOTKEY],
      toggleHotkey: [DEFAULT_TOGGLE_HOTKEY],
      cancelHotkey: [DEFAULT_CANCEL_HOTKEY],
    });

    setHotkeyMessages({
      pushToTalkHotkey: `Reset to ${formatHotkeyLabel(DEFAULT_PUSH_TO_TALK_HOTKEY)}.`,
      toggleHotkey: `Reset to ${formatHotkeyLabel(DEFAULT_TOGGLE_HOTKEY)}.`,
      cancelHotkey: `Reset to ${formatHotkeyLabel(DEFAULT_CANCEL_HOTKEY)}.`,
    });
  };

  const microphoneOptions: SelectOption[] = useMemo(
    () => [
      { value: 'default', label: 'System Default', description: 'Use your current Windows input device.' },
      ...devices
        .filter((device) => device.deviceId !== 'default')
        .map((device) => ({
        value: device.deviceId,
        label: device.label || `Microphone ${device.deviceId.slice(0, 5)}...`,
      })),
    ],
    [devices]
  );
  const selectedMicrophone = useMemo(
    () => {
      const selectedValue = settings?.microphoneId || 'default';
      const matchedOption = microphoneOptions.find((option) => option.value === selectedValue);
      if (matchedOption) {
        return matchedOption;
      }

      if (settings?.microphoneId) {
        return {
          value: settings.microphoneId,
          label: settings.microphoneLabel || 'Selected microphone',
          description: 'Currently unavailable. Reconnect it or switch devices.',
        };
      }

      return microphoneOptions[0];
    },
    [microphoneOptions, settings?.microphoneId, settings?.microphoneLabel]
  );
  const languageSelection = useMemo(
    () => getEffectiveLanguageSelection(settings ?? {}),
    [settings?.language, settings?.selectedLanguages, settings?.autoDetectLanguage]
  );
  const selectedLanguageSummary = useMemo(
    () => summarizeSelectedLanguages(languageSelection.selectedLanguages, languageSelection.autoDetectLanguage),
    [languageSelection]
  );

  if (!settings) return null;

  const hasGroqKey = settings.groqApiKey.length > 0;
  const showCloudKeyWarning = settings.useCloudTranscription && !hasGroqKey;

  const sidebarItems: Array<{ id: string; icon: ReactNode; label: string }> = [
    { id: 'General', icon: <SettingsIcon size={16} />, label: 'General' },
    { id: 'System', icon: <Monitor size={16} />, label: 'System' },
    { id: 'Account', icon: <UserCircle2 size={16} />, label: 'Account' },
  ];

  const normalizedSettingsQuery = deferredSettingsQuery.trim().toLowerCase();
  const hasSettingsSearch = normalizedSettingsQuery.length > 0;
  const matchesSettingsSearch = (...values: Array<string | undefined>) =>
    !hasSettingsSearch
    || values.some((value) => value?.toLowerCase().includes(normalizedSettingsQuery));

  const showGeneralShortcuts = matchesSettingsSearch(
    'general',
    'shortcuts',
    'shortcut',
    'hotkeys',
    'hotkey',
    'push to talk',
    'toggle hotkey',
    'cancel hotkey'
  );
  const showGeneralMicrophone = matchesSettingsSearch(
    'general',
    'microphone',
    'input device',
    selectedMicrophone.label,
    selectedMicrophone.description
  );
  const showGeneralLanguages = matchesSettingsSearch(
    'general',
    'language',
    'languages',
    'auto detect',
    selectedLanguageSummary
  );
  // Transcription mode and the related Groq API key live in the System
  // tab — they're configuration of *how the app talks to the cloud*
  // rather than per-session preferences like microphone or shortcuts.
  const showSystemMode = matchesSettingsSearch(
    'system',
    'transcription mode',
    'local',
    'cloud',
    'cleanup'
  );
  const showSystemCloudKey = matchesSettingsSearch(
    'system',
    'cloud api key',
    'api key',
    'groq',
    'cloud transcription',
    'cloud cleanup'
  );
  const hasGeneralMatches = showGeneralShortcuts || showGeneralMicrophone || showGeneralLanguages;

  const showSystemLaunch = matchesSettingsSearch(
    'system',
    'launch app at login',
    'startup',
    'launch on startup'
  );
  const showSystemOverlay = matchesSettingsSearch(
    'system',
    'show echo pill',
    'overlay',
    'pill'
  );
  const showSystemVisibility = matchesSettingsSearch(
    'system',
    appVisibilityLabel,
    'show app',
    'dock',
    'taskbar'
  );
  const showSystemPosition = matchesSettingsSearch(
    'system',
    'overlay position',
    'top',
    'bottom'
  );
  const hasSystemMatches =
    showSystemLaunch || showSystemOverlay || showSystemVisibility || showSystemPosition || showSystemMode || showSystemCloudKey;

  // Account content is fetched live (session, sync status). It doesn't
  // map onto any of the indexed labels, so a simple keyword check
  // matches the Account section. Unlike General/System we don't
  // hide internal rows here — the panel either shows or it doesn't.
  const hasAccountMatches = matchesSettingsSearch('account', 'sign out', 'sync', 'delete account', 'profile', 'email');

  const filteredSidebarItems = sidebarItems.filter((item) => {
    if (!hasSettingsSearch) return true;
    if (item.id === 'General') return hasGeneralMatches;
    if (item.id === 'System') return hasSystemMatches;
    if (item.id === 'Account') return hasAccountMatches;
    return item.label.toLowerCase().includes(normalizedSettingsQuery);
  });

  const categoryMeta: Record<string, { title: string }> = {
    General: { title: 'General' },
    System: { title: 'System' },
    Account: { title: 'Account' },
  };

  const activeMeta = categoryMeta[activeCategory] ?? { title: 'Settings' };

  useEffect(() => {
    if (!filteredSidebarItems.length) return;
    if (!filteredSidebarItems.some((item) => item.id === activeCategory)) {
      setActiveCategory(filteredSidebarItems[0].id);
    }
  }, [activeCategory, filteredSidebarItems]);

  return (
    <SettingsModalShell
      open={isOpen}
      onClose={onClose}
      zIndex={100}
      closeOnEscape={!hasChildModalOpen && !captureTarget}
      panelClassName="flex h-[min(680px,calc(100vh-48px))] w-[min(980px,calc(100vw-48px))]"
    >
        {/* Sidebar */}
        <aside className="flex w-[220px] shrink-0 flex-col border-r border-border bg-muted/55 px-3 pt-6 pb-4">
          <div className="mb-2 px-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Settings
          </div>
          <div className="mb-3 px-2">
            <label className="relative block">
              <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                value={settingsQuery}
                onChange={(event) => setSettingsQuery(event.target.value)}
                placeholder="Search settings"
                className="h-9 w-full rounded-xl border border-border bg-background/85 pl-9 pr-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring/20"
              />
            </label>
          </div>
          <div className="flex-1">
            <nav className="space-y-1.5">
              {filteredSidebarItems.map((item) => (
                <button
                  key={item.id}
                  onClick={() => setActiveCategory(item.id)}
                  className={`nav-item ${activeCategory === item.id ? 'is-active' : ''}`}
                >
                  <span className="text-foreground">{item.icon}</span>
                  {item.label}
                </button>
              ))}
            </nav>
            {filteredSidebarItems.length === 0 && (
              <div className="px-3 pt-3 text-xs leading-relaxed text-muted-foreground">
                No settings match that search.
              </div>
            )}
          </div>
          <SidebarUpdateControl
            appVersion={appVersion}
            status={updateStatus}
            pending={updateActionPending}
            onAction={handleUpdateAction}
          />
        </aside>

        {/* Content Area */}
        <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* Header */}
          <div className="flex items-start justify-between gap-4 px-8 pt-8 pb-2">
            <h1 className="page-title">{activeMeta.title}</h1>
            <button
              onClick={onClose}
              aria-label="Close settings"
              className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <X size={18} />
            </button>
          </div>

          <div className="h-full overflow-y-auto px-8 pt-6 pb-6">
            <div className="mx-auto max-w-[620px]">
              {filteredSidebarItems.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border bg-background/70 px-5 py-10 text-center">
                  <div className="text-base font-semibold text-foreground">No matching settings</div>
                  <div className="mt-1.5 text-sm text-muted-foreground">
                    Try a different term like "microphone", "overlay", or "startup".
                  </div>
                </div>
              ) : activeCategory === 'General' && hasGeneralMatches ? (
                <div className="space-y-5">
                  {(showGeneralShortcuts || showGeneralMicrophone || showGeneralLanguages) && (
                    <div className="overflow-hidden rounded-xl border border-border bg-background">
                      {showGeneralShortcuts && (
                        <div className="flex items-center justify-between px-5 py-4">
                          <div>
                            <div className="text-base font-semibold text-foreground">Shortcuts</div>
                            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
                              <span>Hold</span>
                              <span className="settings-hotkey-chip inline-flex min-h-[28px] items-center justify-center px-3 py-1 text-[12px] font-semibold uppercase tracking-[0.08em] text-[#1E3A5F]">
                                {formatHotkeyLabel(settings.pushToTalkHotkey?.[0] ?? DEFAULT_PUSH_TO_TALK_HOTKEY)}
                              </span>
                              <span>and speak.</span>
                            </div>
                          </div>
                          <button onMouseDown={(event) => event.preventDefault()} onClick={() => setIsShortcutsModalOpen(true)} className="settings-action-button h-8 rounded-md px-7 text-sm font-medium text-foreground transition-colors">Change</button>
                        </div>
                      )}

                      {showGeneralShortcuts && (showGeneralMicrophone || showGeneralLanguages) && <div className="mx-5 h-px bg-foreground/5" />}

                      {showGeneralMicrophone && (
                        <div className="px-5 py-4">
                          <div className="flex items-center justify-between">
                            <div>
                              <div className="text-base font-semibold text-foreground">Microphone</div>
                              <div className="mt-0.5 max-w-[260px] truncate text-sm text-muted-foreground">{selectedMicrophone.label}</div>
                            </div>
                            <button onMouseDown={(event) => event.preventDefault()} onClick={() => setIsMicrophoneModalOpen(true)} className="settings-action-button h-8 rounded-md px-7 text-sm font-medium text-foreground transition-colors">Change</button>
                          </div>
                          <div className="mt-3">
                            <MicTestButton selectedMic={settings.microphoneId} />
                          </div>
                        </div>
                      )}

                      {showGeneralMicrophone && showGeneralLanguages && <div className="mx-5 h-px bg-foreground/5" />}

                      {showGeneralLanguages && (
                        <div className="flex items-center justify-between px-5 py-4">
                          <div>
                            <div className="text-base font-semibold text-foreground">Languages</div>
                            <div className="mt-0.5 text-sm text-muted-foreground">{selectedLanguageSummary}</div>
                          </div>
                          <button onMouseDown={(event) => event.preventDefault()} onClick={() => setIsLanguageModalOpen(true)} className="settings-action-button h-8 rounded-md px-7 text-sm font-medium text-foreground transition-colors">Change</button>
                        </div>
                      )}
                    </div>
                  )}

                </div>
              ) : activeCategory === 'Account' && hasAccountMatches ? (
                <AccountView />
              ) : activeCategory === 'System' && hasSystemMatches ? (
                <div className="space-y-6">
                  <section>
                    <h2 className="mb-3 text-base font-semibold text-foreground">App settings</h2>
                    <div className="overflow-hidden rounded-xl border border-border bg-background">
                      {showSystemLaunch && (
                        <RowV2 label="Launch app at login">
                          <AnimatedSwitch checked={settings.launchAtStartup} onChange={(checked) => onUpdateSettings({ launchAtStartup: checked })} />
                        </RowV2>
                      )}
                      {showSystemLaunch && (showSystemOverlay || showSystemVisibility || showSystemPosition) && <div className="mx-5 h-px bg-foreground/5" />}
                      {showSystemOverlay && (
                        <RowV2 label="Show Echo pill">
                          <AnimatedSwitch checked={settings.showOverlay} onChange={(checked) => onUpdateSettings({ showOverlay: checked })} />
                        </RowV2>
                      )}
                      {showSystemOverlay && (showSystemVisibility || showSystemPosition) && <div className="mx-5 h-px bg-foreground/5" />}
                      {showSystemVisibility && (
                        <RowV2 label={appVisibilityLabel}>
                          <AnimatedSwitch checked={settings.showAppInDock ?? true} onChange={handleAppInDockToggle} />
                        </RowV2>
                      )}
                      {showSystemVisibility && showSystemPosition && <div className="mx-5 h-px bg-foreground/5" />}
                      {showSystemPosition && (
                        <RowV2 label="Overlay position" description="Adjust where the overlay appears on screen.">
                          <SegmentedControl<'top-center' | 'bottom-center'>
                            value={settings.overlayPosition === 'bottom-center' ? 'bottom-center' : 'top-center'}
                            onChange={(next) => onUpdateSettings({ overlayPosition: next })}
                            options={[
                              { value: 'top-center', label: 'Top' },
                              { value: 'bottom-center', label: 'Bottom' },
                            ]}
                          />
                        </RowV2>
                      )}
                    </div>
                  </section>

                  {(showSystemMode || showSystemCloudKey) && (
                    <section>
                      <h2 className="mb-3 text-base font-semibold text-foreground">Transcription</h2>
                      <div className="rounded-xl border border-border bg-background">
                        {showSystemMode && (
                          <RowV2
                            label="Transcription mode"
                            description="Local stays on-device. Cloud uses Groq for transcription and cleanup."
                          >
                            <ModeToggle
                              value={settings.useCloudTranscription ? 'cloud' : 'local'}
                              cloudEnabled={hasGroqKey}
                              onChange={(value) => onUpdateSettings({ useCloudTranscription: value === 'cloud' })}
                            />
                          </RowV2>
                        )}

                        {showSystemMode && showCloudKeyWarning && (
                          <div className="px-5 pb-3">
                            <div className="rounded-lg border border-border bg-destructive/5 px-3 py-2 text-sm font-medium text-foreground">
                              Cloud mode is selected, but no Groq API key is saved.
                            </div>
                          </div>
                        )}

                        {showSystemMode && showSystemCloudKey && <div className="mx-5 h-px bg-foreground/5" />}

                        {showSystemCloudKey && (
                          <div className="px-5 py-4">
                            <div className="flex items-start justify-between gap-4">
                              <div className="min-w-0">
                                <div className="text-base font-semibold text-foreground">Cloud API key (Groq)</div>
                                <div className="mt-0.5 text-sm text-muted-foreground">Required for Cloud transcription and cloud cleanup.</div>
                              </div>
                              <button type="button" onClick={() => window.api.openApiKeyPage()} className="settings-action-button h-8 shrink-0 rounded-md px-5 text-sm font-medium text-foreground transition-colors">Get key</button>
                            </div>
                            <div className="mt-3">
                              <ApiKeyInput
                                value={settings.groqApiKey ?? ''}
                                onSave={async (key) => {
                                  // Clearing the key never needs validation.
                                  if (!key) {
                                    try {
                                      await window.api.clearGroqApiKey();
                                      toast.success('API key removed');
                                      if (onUpdateSettings) void onUpdateSettings({});
                                    } catch (err) {
                                      console.error('Failed to clear API key:', err);
                                      toast.error('Could not remove API key. Try again.');
                                    }
                                    return;
                                  }

                                  // Verify against Groq BEFORE persisting so
                                  // a typo'd / non-Groq key never gets saved
                                  // and silently confirmed. The main-process
                                  // `set-groq-api-key` IPC has no built-in
                                  // verification — we have to gate it here.
                                  try {
                                    const result = await window.api.testGroqApiKey(key);
                                    if (!result?.ok) {
                                      const reason = (result?.error as string | undefined)?.trim();
                                      toast.error(reason
                                        ? `API key was rejected: ${reason}`
                                        : 'That key was rejected by Groq. Check the value and try again.');
                                      return;
                                    }
                                    await window.api.setGroqApiKey(key);
                                    toast.success('API key saved');
                                    if (onUpdateSettings) void onUpdateSettings({});
                                  } catch (err) {
                                    console.error('Failed to save API key:', err);
                                    const reason = (err as { message?: string })?.message?.trim();
                                    toast.error(reason || 'Could not save API key. Check the value and try again.');
                                  }
                                }}
                              />
                            </div>
                          </div>
                        )}
                      </div>
                    </section>
                  )}
                </div>
              ) : null}
            </div>
          </div>
        </div>

        {/* Sub-modals: always mounted so their first open has zero cold-start. */}
        <ShortcutsModal
          open={isShortcutsModalOpen}
          pushToTalkHotkeys={pushToTalkHotkeys}
          toggleHotkeys={toggleHotkeys}
          cancelHotkeys={cancelHotkeys}
          captureTarget={captureTarget}
          hotkeyMessages={hotkeyMessages}
          onClose={closeShortcutsModal}
          onCapture={toggleHotkeyCapture}
          onRemove={removeHotkey}
          onReset={resetShortcutDefaults}
        />
        <LanguageModal
          open={isLanguageModalOpen}
          options={languageOptions}
          selectedValues={languageSelection.selectedLanguages}
          autoDetectEnabled={languageSelection.autoDetectLanguage}
          onClose={closeLanguageModal}
          onSave={async (selectedValues, autoDetectLanguage) => {
            await onUpdateSettings({ selectedLanguages: selectedValues, autoDetectLanguage });
            closeLanguageModal();
          }}
        />
        <MicrophoneModal
          open={isMicrophoneModalOpen}
          options={microphoneOptions}
          selectedValue={settings.microphoneId || 'default'}
          onClose={closeMicrophoneModal}
          onSave={async (id: string) => {
            const resolvedId = id === 'default' ? '' : id;
            const label = resolvedId
              ? devices.find((device) => device.deviceId === resolvedId)?.label || settings.microphoneLabel || 'Selected microphone'
              : 'System Default';
            await onUpdateSettings({ microphoneId: resolvedId, microphoneLabel: label });
            closeMicrophoneModal();
          }}
        />
    </SettingsModalShell>
  );
});

function SidebarUpdateControl({
  appVersion,
  status,
  pending,
  onAction,
}: {
  appVersion: string;
  status: UpdateStatusPayload | null;
  pending: boolean;
  onAction: (action: 'check' | 'download' | 'install') => Promise<void>;
}) {
  const state = status?.state ?? 'checking';
  const isChecking = state === 'checking';
  const isDownloading = state === 'downloading';
  const isBusy = pending || isChecking || isDownloading;
  const progress = typeof status?.progress === 'number' ? status.progress : 0;

  let action: 'check' | 'download' | 'install' = 'check';
  let actionLabel = 'Check for updates';
  let Icon = RefreshCw;

  if (state === 'unsupported') {
    actionLabel = 'Updates unavailable';
  } else if (state === 'idle') {
    actionLabel = 'Check again';
  } else if (state === 'checking') {
    actionLabel = 'Checking';
    Icon = Loader2;
  } else if (state === 'available') {
    action = 'download';
    actionLabel = 'Download update';
    Icon = Download;
  } else if (state === 'downloading') {
    actionLabel = `Downloading ${progress}%`;
    Icon = Loader2;
  } else if (state === 'ready') {
    action = 'install';
    actionLabel = 'Restart to install';
  }

  const disabled = state === 'unsupported' || isBusy;

  return (
    <div className="mt-4 border-t border-foreground/[0.04] px-3 pt-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-medium text-foreground">
            Echo{appVersion ? ` v${appVersion}` : ''}
          </div>
        </div>
        <button
          type="button"
          onClick={() => void onAction(action)}
          disabled={disabled}
          aria-label={actionLabel}
          title={actionLabel}
          className="settings-action-button inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-foreground transition-colors disabled:cursor-default disabled:opacity-45"
        >
          <Icon size={15} className={isChecking || isDownloading ? 'animate-spin' : undefined} />
        </button>
      </div>
    </div>
  );
}

function RowV2({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-3.5">
      <div className="min-w-0">
        <div className="text-base font-semibold text-foreground">{label}</div>
        {description ? (
          <div className="mt-0.5 text-sm text-muted-foreground">{description}</div>
        ) : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function AnimatedSwitch({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative h-[22px] w-[40px] shrink-0 cursor-pointer rounded-full transition-colors duration-150 ${
        checked ? 'bg-primary' : 'bg-foreground/15'
      }`}
    >
      <span
        aria-hidden="true"
        className="absolute top-[2px] left-[2px] h-[18px] w-[18px] rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.15)] transition-transform duration-150 ease-out will-change-transform"
        style={{ transform: checked ? 'translateX(18px)' : 'translateX(0px)' }}
      />
    </button>
  );
}

function ModeToggle({
  cloudEnabled,
  value,
  onChange,
}: {
  cloudEnabled: boolean;
  value: 'local' | 'cloud';
  onChange: (value: 'local' | 'cloud') => void;
}) {
  return (
    <SegmentedControl<'local' | 'cloud'>
      value={value}
      onChange={onChange}
      options={[
        { value: 'local', label: 'Local' },
        { value: 'cloud', label: 'Cloud', disabled: !cloudEnabled },
      ]}
    />
  );
}

function ApiKeyInput({
  value,
  onSave,
}: {
  value: string;
  onSave: (key: string) => Promise<void> | void;
}) {
  // `value` is the hydrated settings field — when a key is saved the main
  // process masks it as "••••••••". We NEVER seed that mask into the input,
  // because typing or pasting next to it would corrupt the saved key. The
  // masked state is communicated with the placeholder / "Saved" badge only.
  const hasSavedKey = Boolean((value ?? '').trim());
  const [draft, setDraft] = useState('');
  const [show, setShow] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<'success' | 'error' | null>(null);
  const trimmedDraft = draft.trim();
  const isDirty = trimmedDraft.length > 0;

  // When an outer update flips the saved-key state (e.g. after clearing),
  // make sure the draft doesn't stick around.
  useEffect(() => {
    if (!hasSavedKey) setDraft((d) => d);
  }, [hasSavedKey]);

  const handleSave = async () => {
    if (!trimmedDraft) return;
    setSaving(true);
    try {
      await onSave(trimmedDraft);
      setDraft('');
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    setSaving(true);
    try {
      await onSave('');
      setDraft('');
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    if (isDirty && !trimmedDraft) {
      setTestResult('error');
      setTimeout(() => setTestResult(null), 3000);
      return;
    }

    setTesting(true);
    setTestResult(null);
    try {
      const result = isDirty
        ? await window.api.testGroqApiKey(trimmedDraft)
        : hasSavedKey
          ? await window.api.testSavedGroqApiKey()
          : { ok: false as const, error: 'No saved API key.' };
      setTestResult(result.ok ? 'success' : 'error');
    } catch {
      setTestResult('error');
    }
    setTesting(false);
    setTimeout(() => setTestResult(null), 3000);
  };

  const placeholder = hasSavedKey ? 'Paste a new key to replace the saved one' : 'gsk_...';

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <input
            type={show ? 'text' : 'password'}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={placeholder}
            className="h-9 w-full rounded-lg border border-border bg-background/60 pl-3 pr-9 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring/20"
          />
          <button
            type="button"
            onClick={() => setShow(!show)}
            className="settings-button-no-press absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            {show ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
        <button
          type="button"
          disabled={!isDirty || saving}
          onClick={handleSave}
          className="h-9 w-[72px] shrink-0 rounded-md bg-primary text-sm font-medium text-primary-foreground transition-all hover:opacity-90 disabled:opacity-40"
        >
          {saving ? '...' : saved ? <Check size={16} className="mx-auto" /> : 'Save'}
        </button>
        <button
          type="button"
          disabled={testing || (!isDirty && !hasSavedKey)}
          onClick={handleTest}
          className={`relative group/btn flex h-9 w-9 shrink-0 items-center justify-center rounded-md transition-all disabled:opacity-40 ${
            testResult === 'success'
              ? 'bg-emerald-500 text-white'
              : testResult === 'error'
                ? 'bg-red-500 text-white'
                : 'bg-white/80 text-foreground hover:bg-white'
          }`}
        >
          {testResult === 'success' ? (
            <Check size={16} />
          ) : testResult === 'error' ? (
            <X size={16} />
          ) : (
            <Wifi size={14} />
          )}
          <div className="pointer-events-none absolute bottom-full mb-2 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-lg bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white opacity-0 shadow-lg transition-opacity group-hover/btn:opacity-100">
            Test API key
            <div className="absolute top-full left-1/2 -translate-x-1/2 -mt-px">
              <div className="border-4 border-transparent border-t-neutral-900"></div>
            </div>
          </div>
        </button>
      </div>
      {hasSavedKey && (
        <div className="flex items-center justify-between gap-2 px-1 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5 text-emerald-600 dark:text-emerald-500">
            <Check size={12} />
            API key saved
          </span>
          <button
            type="button"
            onClick={handleClear}
            disabled={saving}
            className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-40"
          >
            Remove saved key
          </button>
        </div>
      )}
    </div>
  );
}

function ShortcutsModal({
  open,
  pushToTalkHotkeys,
  toggleHotkeys,
  cancelHotkeys,
  captureTarget,
  hotkeyMessages,
  onClose,
  onCapture,
  onRemove,
  onReset,
}: {
  open: boolean;
  pushToTalkHotkeys: string[];
  toggleHotkeys: string[];
  cancelHotkeys: string[];
  captureTarget: ActiveHotkeyCapture | null;
  hotkeyMessages: Partial<Record<HotkeyTarget, string>>;
  onClose: () => void;
  onCapture: (target: HotkeyTarget, index: number) => void;
  onRemove: (target: HotkeyTarget, index: number) => void;
  onReset: () => void;
}) {
  // Only close on Escape when no key-capture is in progress, otherwise the
  // user's Escape would be consumed by the modal instead of cancelling the
  // capture.
  const handleClose = () => {
    if (captureTarget) return;
    onClose();
  };

  return (
    <SettingsModalShell
      open={open}
      onClose={handleClose}
      panelClassName="w-full max-w-[620px] max-h-[calc(100vh-48px)] overflow-y-auto"
    >
      <div className="p-6">
        <div className="mb-5 flex items-start justify-between">
          <div>
            <h2 className="text-[15px] font-semibold text-foreground">Shortcuts</h2>
            <p className="mt-0.5 text-[13px] text-muted-foreground">Choose your preferred shortcuts for Echo.</p>
          </div>
          <button onClick={handleClose} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"><X size={16} /></button>
        </div>

        <div className="space-y-3">
          <ShortcutCard title="Push to talk" description="Hold to dictate, release to stop." target="pushToTalkHotkey" hotkeys={pushToTalkHotkeys} captureTarget={captureTarget} message={hotkeyMessages.pushToTalkHotkey} onCapture={onCapture} onRemove={onRemove} />
          <ShortcutCard title="Toggle dictation" description="Press once to start, again to stop." target="toggleHotkey" hotkeys={toggleHotkeys} captureTarget={captureTarget} message={hotkeyMessages.toggleHotkey} onCapture={onCapture} onRemove={onRemove} />
          <ShortcutCard title="Cancel" description="Dismiss dictation" target="cancelHotkey" hotkeys={cancelHotkeys} captureTarget={captureTarget} message={hotkeyMessages.cancelHotkey} onCapture={onCapture} onRemove={onRemove} allowMultiple={false} />
        </div>

        <div className="mt-5">
          <button onClick={onReset} className="btn-secondary">
            Reset to default
          </button>
        </div>
      </div>
    </SettingsModalShell>
  );
}

const LanguageOptionButton = memo(function LanguageOptionButton({
  option,
  isSelected,
  onToggle,
  disabled = false,
}: {
  option: SelectOption;
  isSelected: boolean;
  onToggle: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onToggle(option.value)}
      className={`flex h-9 items-center gap-2 rounded-md border border-black/[0.06] px-2.5 text-left text-sm transition-colors ${
        disabled
          ? 'cursor-not-allowed opacity-40'
          : isSelected
          ? 'border-primary/30 bg-primary/5 font-semibold text-foreground'
          : 'text-foreground/80 hover:bg-accent/40'
      }`}
    >
      <FlagIcon language={option.value} label={option.label} className="h-3.5 w-5 rounded-[2px] border-0 shadow-none" />
      <span className="truncate">{option.label}</span>
    </button>
  );
});

function LanguageModal({
  open,
  options,
  selectedValues,
  autoDetectEnabled,
  onClose,
  onSave,
}: {
  open: boolean;
  options: SelectOption[];
  selectedValues: string[];
  autoDetectEnabled: boolean;
  onClose: () => void;
  onSave: (selectedValues: string[], autoDetectEnabled: boolean) => Promise<void>;
}) {
  const [query, setQuery] = useState('');
  const [draftValues, setDraftValues] = useState(() => selectedValues.length ? selectedValues : ['en']);
  const [draftAutoDetectEnabled, setDraftAutoDetectEnabled] = useState(autoDetectEnabled);
  const [saving, setSaving] = useState(false);
  const deferredQuery = useDeferredValue(query);

  // Keep the internal draft in sync with parent state each time the modal
  // is opened, so a close-without-save followed by reopen shows the saved
  // values (not the abandoned draft).
  useEffect(() => {
    if (!open) return;
    setDraftValues(selectedValues.length ? selectedValues : ['en']);
    setDraftAutoDetectEnabled(autoDetectEnabled);
    setQuery('');
  }, [open, selectedValues, autoDetectEnabled]);

  const filteredOptions = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    if (!q) return searchableLanguageOptions;
    return searchableLanguageOptions.filter((o) => o.searchText.includes(q));
  }, [deferredQuery]);

  const selectedOptions = useMemo(
    () => draftValues
      .map((v) => options.find((o) => o.value === v))
      .filter((o): o is SelectOption => Boolean(o)),
    [draftValues, options]
  );

  const handleToggleLanguage = (value: string) => {
    if (draftAutoDetectEnabled) return;
    setDraftValues((cur) =>
      cur.includes(value)
        ? cur.length === 1 ? cur : cur.filter((v) => v !== value)
        : [...cur, value]
    );
  };

  return (
    <SettingsModalShell
      open={open}
      onClose={onClose}
      panelClassName="flex h-[min(580px,calc(100vh-88px))] w-[min(780px,calc(100vw-40px))] flex-col"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-6 py-4">
        <div>
          <h2 className="text-[15px] font-semibold text-foreground">Preferred language</h2>
          <p className="mt-0.5 text-[13px] text-muted-foreground">Pick the languages Echo should expect.</p>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-medium text-muted-foreground">Auto-detect</span>
            <AnimatedSwitch checked={draftAutoDetectEnabled} onChange={setDraftAutoDetectEnabled} />
          </div>
          <button onClick={onClose} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"><X size={16} /></button>
        </div>
      </div>

      {/* Content */}
      <div className="flex min-h-0 flex-1 gap-5 px-6 pb-5 pt-4">
        {/* Left: search + grid */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="mb-3 flex h-9 items-center gap-2 rounded-lg border border-border bg-muted/30 px-3">
            <Search size={14} className="shrink-0 text-muted-foreground" />
            <input
              autoFocus
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search for any language"
              className="flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {filteredOptions.length ? (
              <div className="grid grid-cols-3 gap-1.5">
                {filteredOptions.map((option) => (
                  <LanguageOptionButton
                    key={option.value}
                    option={option}
                    isSelected={draftValues.includes(option.value)}
                    onToggle={handleToggleLanguage}
                    disabled={draftAutoDetectEnabled}
                  />
                ))}
              </div>
            ) : (
              <div className="flex h-full items-center justify-center text-[13px] text-muted-foreground">
                No languages match that search.
              </div>
            )}
          </div>
        </div>

        {/* Right: selected */}
        <div className="flex w-[180px] shrink-0 flex-col">
          <div className="mb-2 section-title">Selected</div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {draftAutoDetectEnabled ? (
              <p className="text-[12px] italic text-muted-foreground">Auto-detecting any language</p>
            ) : selectedOptions.length ? (
              <div className="space-y-1.5">
                {selectedOptions.map((option) => (
                  <div key={option.value} className="flex items-center gap-2 rounded-lg bg-muted/40 px-2.5 py-1.5 text-[13px] text-foreground">
                    <FlagIcon language={option.value} label={option.label} className="h-3.5 w-5 rounded-[2px] border-0 shadow-none" />
                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
                    {draftValues.length > 1 && (
                      <button
                        type="button"
                        onClick={() => handleToggleLanguage(option.value)}
                        className="shrink-0 rounded-md p-0.5 text-muted-foreground hover:text-foreground"
                      >
                        <X size={12} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[12px] italic text-muted-foreground">No languages selected</p>
            )}
          </div>
          <div className="mt-3 flex flex-col gap-2">
            <button type="button" onClick={onClose} className="btn-secondary w-full">Cancel</button>
            <button
              type="button"
              disabled={saving}
              onClick={async () => { setSaving(true); try { await onSave(draftValues, draftAutoDetectEnabled); } finally { setSaving(false); } }}
              className="btn-primary w-full"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </SettingsModalShell>
  );
}

function MicrophoneModal({
  open,
  options,
  selectedValue,
  onClose,
  onSave,
}: {
  open: boolean;
  options: SelectOption[];
  selectedValue: string;
  onClose: () => void;
  onSave: (id: string) => Promise<void>;
}) {
  return (
    <SettingsModalShell
      open={open}
      onClose={onClose}
      panelClassName="flex w-full max-w-[560px] max-h-[calc(100vh-40px)] flex-col"
    >
      <div className="flex items-start justify-between border-b border-border px-5 py-4">
        <div>
          <h2 className="text-[15px] font-semibold text-foreground">Microphone</h2>
          <p className="mt-0.5 text-[13px] text-muted-foreground">Choose the input device for dictation.</p>
        </div>
        <button onClick={onClose} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"><X size={16} /></button>
      </div>

      <div className="flex-1 space-y-1 overflow-y-auto p-3">
        {options.map((option) => {
          const isSelected = option.value === selectedValue;
          return (
            <button
              type="button"
              key={option.value}
              onClick={() => onSave(option.value)}
              className={`flex w-full items-center justify-between rounded-md px-3.5 py-3 text-left transition-colors ${
                isSelected ? 'border border-foreground/15 bg-foreground/5' : 'border border-transparent hover:bg-accent/50'
              }`}
            >
              <div className="min-w-0 flex-1 pr-3">
                <div className={`text-[14px] ${isSelected ? 'font-semibold text-foreground' : 'font-medium text-foreground/75'}`}>{option.label}</div>
                {option.description && <div className="mt-0.5 text-[12px] text-muted-foreground">{option.description}</div>}
              </div>
              {isSelected && <Check size={16} className="shrink-0 text-foreground" />}
            </button>
          );
        })}
      </div>
    </SettingsModalShell>
  );
}

function ShortcutCard({
  target,
  title,
  description,
  hotkeys,
  captureTarget,
  message,
  onCapture,
  onRemove,
  allowMultiple = true,
}: {
  target: HotkeyTarget;
  title: string;
  description: string;
  hotkeys: string[];
  captureTarget: ActiveHotkeyCapture | null;
  message?: string;
  onCapture: (target: HotkeyTarget, index: number) => void;
  onRemove: (target: HotkeyTarget, index: number) => void;
  allowMultiple?: boolean;
}) {
  const isAppending = captureTarget?.field === target && captureTarget.index === hotkeys.length;
  const displayedHotkeys = isAppending ? [...hotkeys, ''] : hotkeys;

  return (
    <section className="rounded-xl border border-border bg-background px-5 py-4">
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_220px] md:items-start">
        <div className="min-w-0">
          <div className="text-base font-semibold text-foreground">{title}</div>
          <div className="mt-0.5 text-sm text-muted-foreground">{description}</div>
          {message && <div className="mt-1.5 text-[14px] font-medium text-muted-foreground">{message}</div>}
          {!isAppending && allowMultiple && (
            <button
              type="button"
              onMouseDown={(e: React.MouseEvent) => e.preventDefault()}
              onClick={() => onCapture(target, hotkeys.length)}
              className="mt-3 h-8 rounded-md bg-white px-5 text-sm font-medium text-foreground shadow-[0_1px_2px_rgba(15,23,42,0.06)] transition-colors hover:bg-white/90"
            >
              Add another
            </button>
          )}
        </div>

        <div className="space-y-2 md:justify-self-end">
          {displayedHotkeys.map((hotkey, index) => {
            const isCapturing = captureTarget?.field === target && captureTarget.index === index;
            const canRemove = hotkeys.length > 1 && index < hotkeys.length;

            return (
              <div key={`${target}-${hotkey || 'pending'}-${index}`} className="flex items-stretch gap-1.5">
                <button
                  type="button"
                  onMouseDown={(e: React.MouseEvent) => e.preventDefault()}
                  onClick={() => onCapture(target, index)}
                  className={`w-full min-w-[220px] rounded-md border px-3 py-2 text-left transition-all ${
                    isCapturing ? 'border-foreground/20 bg-foreground/5' : 'border-border hover:border-foreground/15'
                  }`}
                >
                  <div className="flex min-h-[22px] items-center justify-between gap-2">
                    <HotkeyTokens label={isCapturing ? 'Press keys...' : formatHotkeyLabel(hotkey)} subdued={isCapturing} />
                    <Pencil size={12} className={`shrink-0 ${isCapturing ? 'text-foreground' : 'text-muted-foreground'}`} />
                  </div>
                </button>
                {canRemove && (
                  <button type="button" onMouseDown={(e: React.MouseEvent) => e.preventDefault()} onClick={() => onRemove(target, index)} aria-label="Remove shortcut"
                    className="self-center rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <X size={13} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function MicTestButton({ selectedMic }: { selectedMic: string }) {
  const [testing, setTesting] = useState(false);
  const [bars, setBars] = useState<number[]>([0, 0, 0, 0, 0, 0, 0]);
  const [error, setError] = useState('');
  const animFrameRef = useRef<number>(0);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const smoothedBarsRef = useRef<number[]>([0, 0, 0, 0, 0, 0, 0]);
  const BAR_COUNT = 7;

  const stopTesting = () => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = 0;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    analyserRef.current = null;
    setTesting(false);
    setBars([0, 0, 0, 0, 0, 0, 0]);
    smoothedBarsRef.current = [0, 0, 0, 0, 0, 0, 0];
  };

  const startTesting = async () => {
    setError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: selectedMic ? { deviceId: { exact: selectedMic } } : true,
      });
      streamRef.current = stream;
      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.2;
      source.connect(analyser);
      analyserRef.current = analyser;
      setTesting(true);

      const freqData = new Uint8Array(analyser.frequencyBinCount);
      const timeData = new Uint8Array(analyser.fftSize);
      smoothedBarsRef.current = [0, 0, 0, 0, 0, 0, 0];

      const binSize = audioContext.sampleRate / analyser.fftSize;
      const voiceStartBin = Math.floor(60 / binSize);
      const voiceEndBin = Math.floor(8000 / binSize);

      const tick = () => {
        analyser.getByteFrequencyData(freqData);
        analyser.getByteTimeDomainData(timeData);

        let rmsSum = 0;
        for (let i = 0; i < timeData.length; i++) {
          const v = (timeData[i] - 128) / 128;
          rmsSum += v * v;
        }
        const rms = Math.sqrt(rmsSum / timeData.length);
        const volume = Math.min(1, rms * 8);

        let totalFreq = 0;
        let freqCount = 0;
        for (let i = voiceStartBin; i < voiceEndBin && i < freqData.length; i++) {
          totalFreq += freqData[i];
          freqCount++;
        }
        const avgFreq = freqCount > 0 ? totalFreq / freqCount : 0;
        const freqLevel = Math.min(1, avgFreq / 100);

        const overallLevel = Math.max(volume, freqLevel);

        const newBars: number[] = [];
        for (let i = 0; i < BAR_COUNT; i++) {
          const variation = 0.9 + Math.random() * 0.2;
          const raw = Math.min(1, overallLevel * variation);
          const prev = smoothedBarsRef.current[i];
          const next = raw > prev
            ? prev + (raw - prev) * 0.75
            : prev + (raw - prev) * 0.2;
          smoothedBarsRef.current[i] = Math.max(0, next);
          newBars.push(smoothedBarsRef.current[i]);
        }

        setBars([...newBars]);
        animFrameRef.current = requestAnimationFrame(tick);
      };
      tick();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Microphone access denied');
      stopTesting();
    }
  };

  useEffect(() => {
    return () => stopTesting();
  }, []);

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={testing ? stopTesting : startTesting}
        className={`flex h-8 items-center gap-1.5 rounded-md px-5 text-sm font-medium transition-all ${
          testing ? 'bg-destructive/10 text-destructive' : 'bg-white/80 text-foreground hover:bg-white'
        }`}
      >
        <Mic size={13} />
        {testing ? 'Stop test' : 'Test mic'}
      </button>

      {testing && (
        <div className="flex-1">
          <div className="flex h-12 items-end justify-center gap-[3px] rounded-lg bg-white px-4 py-2.5">
            {bars.map((value, i) => {
              const height = Math.max(3, value * 34);
              const hue = value > 0.7 ? 'from-red-500 to-orange-400' : value > 0.4 ? 'from-yellow-500 to-green-400' : 'from-green-500 to-green-400';
              return (
                <div key={i} className={`w-[6px] rounded-full bg-gradient-to-t ${hue}`} style={{ height: `${height}px`, opacity: 0.25 + value * 0.75 }} />
              );
            })}
          </div>
          <p className="mt-1 text-center text-[14px] text-muted-foreground">Listening...</p>
        </div>
      )}

      {error && <p className="text-[14px] font-medium text-destructive">{error}</p>}
    </div>
  );
}

function HotkeyTokens({ label, subdued = false }: { label: string; subdued?: boolean }) {
  const parts = label.split(' + ').filter(Boolean);

  if (!parts.length) {
    return <span className={`text-sm font-medium ${subdued ? 'text-muted-foreground' : 'text-foreground'}`}>{label}</span>;
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {parts.map((part, index) => (
        <span
          key={`${part}-${index}`}
          className={`settings-hotkey-chip inline-flex min-h-[34px] min-w-[56px] items-center justify-center px-4 py-1.5 text-[13px] font-semibold ${
            subdued
              ? 'opacity-70 text-muted-foreground'
              : 'text-foreground'
          }`}
        >
          {part}
        </span>
      ))}
    </div>
  );
}
