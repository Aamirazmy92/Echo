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
  CreditCard,
  Download,
  Search,
  Settings as SettingsIcon,
  Monitor,
  Globe2,
  Loader2,
  RefreshCw,
  X,
  Pencil,
  Mic,
  UserCircle2,
} from 'lucide-react';
import AccountView from './Account';
import { refreshPointerTargetUnderCursor } from '../lib/pointerSync';
import ModalOverlayRoot from './ModalOverlayRoot';
import PlansBilling from './PlansBilling';
import { toast } from './toast/useToast';
import { useMicTest } from '../lib/useMicTest';
import type { EntitlementsPayload, UpdateStatusPayload } from '../api';
import {
  MODAL_OVERLAY_FADE,
  MODAL_PANEL_INITIAL,
  MODAL_PANEL_OPEN,
  MODAL_PANEL_EXIT,
  MODAL_SPRING,
  MODAL_SPRING_EXIT,
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
    <AnimatePresence initial={false} onExitComplete={refreshPointerTargetUnderCursor}>
      {open ? (
        <ModalOverlayRoot
          key="settings-modal"
          className="fixed inset-0 flex items-center justify-center bg-[hsl(25_18%_12%/0.30)] px-6"
          style={{ zIndex }}
          aria-hidden={false}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={MODAL_OVERLAY_FADE}
          onClick={() => (onBackdropClick ?? onClose)()}
        >
          <motion.div
            className={`settings-modal-panel relative overflow-hidden rounded-2xl border border-border bg-popover shadow-[0_30px_80px_-20px_rgba(31,27,22,0.30)] transform-gpu ${panelClassName}`}
            initial={MODAL_PANEL_INITIAL}
            animate={MODAL_PANEL_OPEN}
            exit={{ ...MODAL_PANEL_EXIT, transition: MODAL_SPRING_EXIT }}
            transition={MODAL_SPRING}
            style={{ willChange: 'opacity, transform' }}
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
          >
            {children}
          </motion.div>
        </ModalOverlayRoot>
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
      className="relative inline-grid items-center rounded-xl bg-secondary p-1"
      style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}
    >
      <div
        className="segmented-thumb pointer-events-none absolute left-1 top-1 bottom-1 rounded-lg bg-card shadow-[0_1px_2px_rgba(31,27,22,0.08),0_4px_10px_-6px_rgba(31,27,22,0.18)]"
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
            className={`segmented-label relative z-10 rounded-lg px-4 py-1.5 text-[13px] ${
              isActive
                ? 'font-semibold text-foreground'
                : option.disabled
                  ? 'cursor-not-allowed font-medium text-muted-foreground/40'
                  : 'font-medium text-muted-foreground hover:text-foreground'
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
  initialCategory,
  onClose,
  settings,
  devices,
  onRefreshDevices,
  onUpdateSettings,
}: {
  isOpen: boolean;
  initialCategory?: string | null;
  onClose: () => void;
  settings: SettingsType | null;
  devices: MediaDeviceInfo[];
  onRefreshDevices: () => Promise<void>;
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
  const [entitlements, setEntitlements] = useState<EntitlementsPayload | null>(null);
  const hasChildModalOpenRef = useRef(false);
  const deferredSettingsQuery = useDeferredValue(settingsQuery);
  const appVisibilityLabel = navigator.platform.toLowerCase().includes('mac')
    ? 'Show app in dock'
    : 'Show app in taskbar';

  useEffect(() => {
    if (!isMicrophoneModalOpen) return;
    void onRefreshDevices();
  }, [isMicrophoneModalOpen, onRefreshDevices]);

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
    if (!isOpen || !initialCategory) return;
    setActiveCategory(initialCategory);
  }, [initialCategory, isOpen]);

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

  useEffect(() => {
    let cancelled = false;

    void window.api.entitlementsGet().then((current) => {
      if (!cancelled) {
        setEntitlements(current);
      }
    }).catch((error) => {
      console.error('Failed to load entitlements:', error);
    });

    const unsubscribe = window.api.onEntitlementsChanged((next) => {
      setEntitlements(next);
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
      ...devices.map((device) => ({
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

  const hasProCloud = entitlements?.tier === 'pro' && !entitlements.fairUseExceeded;
  const cloudEnabled = hasProCloud;
  const cloudModeValue = hasProCloud && settings.useCloudTranscription ? 'cloud' : 'local';

  type SidebarItem = { id: string; icon: ReactNode; label: string };
  type SidebarSection = { title: string; items: SidebarItem[] };

  const sidebarSections: SidebarSection[] = [
    {
      title: 'Settings',
      items: [
        { id: 'General', icon: <SettingsIcon size={16} />, label: 'General' },
        { id: 'System', icon: <Monitor size={16} />, label: 'System' },
      ],
    },
    {
      title: 'Account',
      items: [
        { id: 'Account', icon: <UserCircle2 size={16} />, label: 'Account' },
        { id: 'Plans', icon: <CreditCard size={16} />, label: 'Plans & Billing' },
      ],
    },
  ];

  const normalizedSettingsQuery = deferredSettingsQuery.trim().toLowerCase();
  const hasSettingsSearch = normalizedSettingsQuery.length > 0;
  const matchesSettingsSearch = (...values: Array<string | null | undefined>) =>
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
  // Transcription mode lives in the System tab because it configures how
  // the app talks to Echo cloud rather than per-session microphone choices.
  const showSystemMode = matchesSettingsSearch(
    'system',
    'transcription mode',
    'local',
    'cloud',
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
    showSystemLaunch || showSystemOverlay || showSystemVisibility || showSystemPosition || showSystemMode;
  const showSystemUpdates = matchesSettingsSearch(
    'system',
    'updates',
    'update',
    'check for updates',
    'download update',
    'install update',
    updateStatus?.version,
    updateStatus?.state
  );

  // Account content is fetched live (session, sync status). It doesn't
  // map onto any of the indexed labels, so a simple keyword check
  // matches the Account section. Unlike General/System we don't
  // hide internal rows here — the panel either shows or it doesn't.
  const hasAccountMatches = matchesSettingsSearch('account', 'sign out', 'sync', 'delete account', 'profile', 'email');

  // Plans & Billing is the dedicated subscription/upgrade page. Match a
  // generous keyword set so users can find it via search regardless of
  // whether they say "billing", "subscription", "pro", etc.
  const hasPlansMatches = matchesSettingsSearch(
    'plans',
    'plan',
    'billing',
    'subscription',
    'subscribe',
    'pro',
    'upgrade',
    'invoice',
    'payment',
    'cancel'
  );

  const filteredSidebarSections = sidebarSections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => {
        if (!hasSettingsSearch) return true;
        if (item.id === 'General') return hasGeneralMatches;
        if (item.id === 'System') return hasSystemMatches || showSystemUpdates;
        if (item.id === 'Plans') return hasPlansMatches;
        if (item.id === 'Account') return hasAccountMatches;
        return item.label.toLowerCase().includes(normalizedSettingsQuery);
      }),
    }))
    .filter((section) => section.items.length > 0);

  const categoryMeta: Record<string, { title: string }> = {
    General: { title: 'General' },
    System: { title: 'System' },
    Plans: { title: 'Plans & Billing' },
    Account: { title: 'Account' },
  };

  const activeMeta = categoryMeta[activeCategory] ?? { title: 'Settings' };

  const primaryLanguageValue = languageSelection.selectedLanguages[0] ?? 'en';
  const primaryLanguageLabel =
    languageOptions.find((option) => option.value === primaryLanguageValue)?.label ?? 'English';
  const languageDescription = languageSelection.autoDetectLanguage
    ? `Auto-detect across all languages. ${primaryLanguageLabel} is your primary.`
    : `${selectedLanguageSummary}. ${primaryLanguageLabel} is your primary.`;

  const generalOptionRows = [
    showGeneralShortcuts
      ? {
          key: 'shortcuts',
          content: (
            <div className="flex items-center justify-between gap-4 px-5 py-4">
              <div className="min-w-0">
                <div className="text-[15px] font-semibold text-foreground">Push-to-talk shortcut</div>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted-foreground">
                  <span>Hold</span>
                  <span className="settings-hotkey-chip inline-flex min-h-[24px] items-center justify-center px-2 py-0.5 text-[13px] font-medium text-foreground/75">
                    {formatHotkeyLabel(settings.pushToTalkHotkey?.[0] ?? DEFAULT_PUSH_TO_TALK_HOTKEY)}
                  </span>
                  <span>and speak. Release to transcribe.</span>
                </div>
              </div>
              <button onMouseDown={(event) => event.preventDefault()} onClick={() => setIsShortcutsModalOpen(true)} className="echo-btn settings-option-btn shrink-0">Change</button>
            </div>
          ),
        }
      : null,
    showGeneralMicrophone
      ? {
          key: 'microphone',
          content: (
            <div className="flex items-center justify-between gap-4 px-5 py-4">
              <div className="min-w-0">
                <div className="text-[15px] font-semibold text-foreground">Microphone</div>
                <div className="mt-0.5 truncate text-[13px] text-muted-foreground">
                  {selectedMicrophone.label}. <span style={{ color: 'var(--moss)' }}>Calibrated.</span>
                </div>
              </div>
              <button onMouseDown={(event) => event.preventDefault()} onClick={() => setIsMicrophoneModalOpen(true)} className="echo-btn settings-option-btn shrink-0">Change</button>
            </div>
          ),
        }
      : null,
    showGeneralLanguages
      ? {
          key: 'languages',
          content: (
            <div className="flex items-center justify-between gap-4 px-5 py-4">
              <div className="min-w-0">
                <div className="text-[15px] font-semibold text-foreground">Languages</div>
                <div className="mt-0.5 text-[13px] text-muted-foreground">{languageDescription}</div>
              </div>
              <button onMouseDown={(event) => event.preventDefault()} onClick={() => setIsLanguageModalOpen(true)} className="echo-btn settings-option-btn shrink-0">Change</button>
            </div>
          ),
        }
      : null,
  ].filter(Boolean) as Array<{ key: string; content: ReactNode }>;

  const systemOptionRows = [
    showSystemLaunch
      ? {
          key: 'launch',
          content: (
            <RowV2 label="Launch app at login">
              <AnimatedSwitch checked={settings.launchAtStartup} onChange={(checked) => onUpdateSettings({ launchAtStartup: checked })} />
            </RowV2>
          ),
        }
      : null,
    showSystemOverlay
      ? {
          key: 'overlay',
          content: (
            <RowV2 label="Show Echo pill">
              <AnimatedSwitch checked={settings.showOverlay} onChange={(checked) => onUpdateSettings({ showOverlay: checked })} />
            </RowV2>
          ),
        }
      : null,
    showSystemVisibility
      ? {
          key: 'visibility',
          content: (
            <RowV2 label={appVisibilityLabel}>
              <AnimatedSwitch checked={settings.showAppInDock ?? true} onChange={handleAppInDockToggle} />
            </RowV2>
          ),
        }
      : null,
    showSystemPosition
      ? {
          key: 'position',
          content: (
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
          ),
        }
      : null,
    showSystemMode
      ? {
          key: 'mode',
          content: (
            <RowV2
              label="Transcription mode"
              description={hasProCloud
                ? 'Cloud uses Echo Pro. Local stays on-device.'
                : 'Local stays on-device. Cloud is included with Echo Pro.'}
            >
              <ModeToggle
                value={cloudModeValue}
                cloudEnabled={cloudEnabled}
                onChange={(value) => onUpdateSettings({ useCloudTranscription: value === 'cloud' })}
              />
            </RowV2>
          ),
        }
      : null,
  ].filter(Boolean) as Array<{ key: string; content: ReactNode }>;

  useEffect(() => {
    const allFilteredItems = filteredSidebarSections.flatMap((s) => s.items);
    if (!allFilteredItems.length) return;
    if (!allFilteredItems.some((item) => item.id === activeCategory)) {
      setActiveCategory(allFilteredItems[0].id);
    }
  }, [activeCategory, filteredSidebarSections]);

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
          <div className="mb-3 px-2">
            <label className="relative block">
              <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                value={settingsQuery}
                onChange={(event) => setSettingsQuery(event.target.value)}
                placeholder="Search settings"
                className="h-9 w-full rounded-xl border border-border bg-popover/85 pl-9 pr-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-foreground"
              />
            </label>
          </div>
          <div className="flex-1 overflow-y-auto">
            {filteredSidebarSections.map((section, sectionIndex) => (
              <div key={section.title} className={sectionIndex > 0 ? 'mt-5' : ''}>
                <div className="mb-2 px-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  {section.title}
                </div>
                <nav className="space-y-1">
                  {section.items.map((item) => (
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
              </div>
            ))}
            {filteredSidebarSections.length === 0 && (
              <div className="px-3 pt-3 text-xs leading-relaxed text-muted-foreground">
                No settings match that search.
              </div>
            )}
          </div>
          <SidebarUpdatePanel
            appVersion={appVersion}
            status={updateStatus}
            pending={updateActionPending}
            onAction={handleUpdateAction}
          />
        </aside>

        {/* Content Area */}
        <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-popover">
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
            <div className="mx-auto min-h-full max-w-[620px]">
              {filteredSidebarSections.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border bg-popover/70 px-5 py-10 text-center">
                  <div className="text-[15px] font-semibold text-foreground">No matching settings</div>
                  <div className="mt-1.5 text-[13px] text-muted-foreground">
                    Try a different term like "microphone", "overlay", or "startup".
                  </div>
                </div>
              ) : activeCategory === 'General' && hasGeneralMatches ? (
                <SettingsOptionsCard rows={generalOptionRows} />
              ) : activeCategory === 'Account' && hasAccountMatches ? (
                <div className="flex min-h-full flex-col">
                  <AccountView
                    cloudVisible={entitlements?.tier === 'pro'}
                    onUpgradeClick={() => setActiveCategory('Plans')}
                  />
                </div>
              ) : activeCategory === 'Plans' && hasPlansMatches ? (
                <PlansBilling />
              ) : activeCategory === 'System' && (hasSystemMatches || showSystemUpdates) ? (
                <SettingsOptionsCard rows={systemOptionRows} />
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

function SidebarUpdatePanel({
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
  let title = appVersion ? `Echo v${appVersion}` : 'Echo';
  let description = 'Manage updates.';
  let Icon = RefreshCw;

  if (state === 'unsupported') {
    actionLabel = 'Updates unavailable';
    description = 'Updates unavailable.';
  } else if (state === 'idle') {
    actionLabel = 'Check again';
    description = 'Up to date.';
  } else if (state === 'checking') {
    actionLabel = 'Checking';
    description = 'Checking for updates.';
    Icon = Loader2;
  } else if (state === 'available') {
    action = 'download';
    actionLabel = 'Download update';
    title = 'Update available';
    description = status?.version ? `Echo v${status.version} is ready.` : 'New version ready.';
    Icon = Download;
  } else if (state === 'downloading') {
    actionLabel = `${progress}%`;
    title = 'Downloading update';
    description = `${progress}% complete.`;
    Icon = Loader2;
  } else if (state === 'ready') {
    action = 'install';
    actionLabel = 'Restart';
    title = 'Update ready to install';
    description = status?.version ? `Echo v${status.version} downloaded.` : 'Update downloaded.';
  }

  const disabled = state === 'unsupported' || isBusy;

  return (
    <section className="mt-4 border-t border-foreground/[0.04] px-2 pt-3">
      <div className="rounded-xl bg-card/80 p-3">
        <div className="flex items-start gap-2.5">
          <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${state === 'available' || state === 'downloading' || state === 'ready' ? 'bg-[hsl(var(--success-soft))] text-[hsl(var(--success))]' : 'bg-muted text-muted-foreground'}`}>
            <Icon size={16} className={isChecking || isDownloading ? 'animate-spin' : undefined} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-semibold text-foreground">{title}</div>
            <div className="mt-0.5 line-clamp-2 text-[13px] leading-4 text-muted-foreground">
              {state === 'error' && status?.error ? status.error : description}
            </div>
          </div>
        </div>
        {isDownloading ? (
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-foreground/10">
            <div className="h-full rounded-full bg-emerald-700 transition-[width]" style={{ width: `${Math.max(0, Math.min(100, progress))}%` }} />
          </div>
        ) : null}
        <button
          type="button"
          onClick={() => void onAction(action)}
          disabled={disabled}
          className="settings-action-button mt-3 inline-flex h-8 w-full items-center justify-center gap-2 rounded-lg px-5 text-[12px] font-semibold text-foreground transition-colors disabled:cursor-default disabled:opacity-45"
        >
          <Icon size={14} className={isChecking || isDownloading ? 'animate-spin' : undefined} />
          {pending ? 'Starting' : actionLabel}
        </button>
      </div>
    </section>
  );
}

function SettingsOptionsCard({ rows }: { rows: Array<{ key: string; content: ReactNode }> }) {
  if (!rows.length) return null;

  return (
    <div className="settings-modal-card">
      {rows.map((row, index) => (
        <div key={row.key}>
          {index > 0 ? <div className="mx-5 h-px bg-border" /> : null}
          {row.content}
        </div>
      ))}
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
        <div className="text-[15px] font-semibold text-foreground">{label}</div>
        {description ? (
          <div className="mt-0.5 text-[13px] text-muted-foreground">{description}</div>
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
        className="absolute top-[2px] left-[2px] h-[18px] w-[18px] rounded-full bg-popover shadow-[0_1px_2px_rgba(31,27,22,0.18)] transition-transform duration-150 ease-out will-change-transform"
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
      panelClassName="w-full max-w-[480px] max-h-[calc(100vh-48px)] overflow-y-auto"
    >
      <div className="p-6">
        <div className="echo-modal-header mb-0 flex items-start justify-between pr-0">
          <div>
            <h2 className="echo-modal-title">Shortcuts</h2>
            <p className="echo-modal-description">Choose your preferred shortcuts for Echo.</p>
          </div>
          <button onClick={handleClose} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"><X size={16} /></button>
        </div>

        <div className="echo-modal-body mt-5">
          <ShortcutCard title="Push to talk" description="Hold to dictate, release to stop." target="pushToTalkHotkey" hotkeys={pushToTalkHotkeys} captureTarget={captureTarget} message={hotkeyMessages.pushToTalkHotkey} onCapture={onCapture} onRemove={onRemove} />
          <ShortcutCard title="Toggle dictation" description="Press once to start, again to stop." target="toggleHotkey" hotkeys={toggleHotkeys} captureTarget={captureTarget} message={hotkeyMessages.toggleHotkey} onCapture={onCapture} onRemove={onRemove} />
          <ShortcutCard title="Cancel" description="Dismiss dictation" target="cancelHotkey" hotkeys={cancelHotkeys} captureTarget={captureTarget} message={hotkeyMessages.cancelHotkey} onCapture={onCapture} onRemove={onRemove} allowMultiple={false} />
        </div>

        <div className="echo-modal-footer justify-start">
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
      className={`settings-modal-field flex h-9 items-center gap-2 rounded-md px-2.5 text-left text-sm transition-colors ${
        disabled
          ? 'cursor-not-allowed opacity-40'
          : isSelected
          ? 'border-primary/30 bg-secondary font-semibold text-foreground'
          : 'text-foreground/80'
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
      <div className="echo-modal-shell-header">
        <div>
          <h2 className="echo-modal-title">Preferred language</h2>
          <p className="echo-modal-description">Pick the languages Echo should expect.</p>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-medium text-muted-foreground">Auto-detect</span>
            <AnimatedSwitch checked={draftAutoDetectEnabled} onChange={setDraftAutoDetectEnabled} />
          </div>
          <button onClick={onClose} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"><X size={16} /></button>
        </div>
      </div>

      {/* Content */}
      <div className="flex min-h-0 flex-1 gap-5 px-6 pb-5 pt-4">
        {/* Left: search + grid */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="settings-modal-field mb-3 flex h-9 items-center gap-2 rounded-lg px-3">
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
              <p className="text-[13px] italic text-muted-foreground">Auto-detecting any language</p>
            ) : selectedOptions.length ? (
              <div className="space-y-1.5">
                {selectedOptions.map((option) => (
                  <div key={option.value} className="settings-modal-field flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] text-foreground">
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
              <p className="text-[13px] italic text-muted-foreground">No languages selected</p>
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

function MicLevelBars({ bars, className = '' }: { bars: number[]; className?: string }) {
  return (
    <div className={`settings-modal-field flex h-10 items-end justify-center gap-[3px] rounded-lg px-3 py-2 ${className}`}>
      {bars.map((value, index) => {
        const height = Math.max(4, value * 28);
        const hue = value > 0.7 ? 'from-red-500 to-orange-400' : value > 0.4 ? 'from-yellow-500 to-green-400' : 'from-green-500 to-green-400';
        return (
          <div
            key={index}
            className={`w-[5px] rounded-full bg-gradient-to-t ${hue}`}
            style={{ height: `${height}px`, opacity: 0.25 + value * 0.75 }}
          />
        );
      })}
    </div>
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
  const { bars, error, toggleDeviceTest, isTestingDevice, testingDeviceKey } = useMicTest(open);

  return (
    <SettingsModalShell
      open={open}
      onClose={onClose}
      panelClassName="flex w-full max-w-[480px] max-h-[calc(100vh-40px)] flex-col"
    >
      <div className="echo-modal-shell-header">
        <div>
          <h2 className="echo-modal-title">Microphone</h2>
          <p className="echo-modal-description">Choose the input device for dictation.</p>
        </div>
        <button onClick={onClose} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"><X size={16} /></button>
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto p-4">
        {options.map((option) => {
          const isSelected = option.value === selectedValue;
          const isTesting = isTestingDevice(option.value);

          return (
            <div key={option.value} className="space-y-1.5">
              <div
                className={`settings-modal-field flex items-stretch gap-2 rounded-md p-1.5 transition-colors ${
                  isSelected ? 'border-primary/30 bg-secondary' : ''
                } ${isTesting ? 'ring-1 ring-primary/15' : ''}`}
              >
                <button
                  type="button"
                  onClick={() => onSave(option.value)}
                  className="flex min-w-0 flex-1 items-center justify-between rounded-md px-2 py-1.5 text-left"
                >
                  <div className="min-w-0 pr-3">
                    <div className={`text-[15px] ${isSelected ? 'font-semibold text-foreground' : 'font-medium text-foreground/80'}`}>
                      {option.label}
                    </div>
                    {option.description ? (
                      <div className="mt-0.5 text-[13px] text-muted-foreground">{option.description}</div>
                    ) : null}
                  </div>
                  {isSelected ? <Check size={16} className="shrink-0 text-foreground" /> : null}
                </button>
                <button
                  type="button"
                  title={isTesting ? 'Stop microphone test' : `Test ${option.label}`}
                  aria-label={isTesting ? 'Stop microphone test' : `Test ${option.label}`}
                  aria-pressed={isTesting}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={(event) => {
                    event.stopPropagation();
                    void toggleDeviceTest(option.value);
                  }}
                  className={`echo-btn settings-option-btn inline-flex h-10 w-10 shrink-0 items-center justify-center px-0 ${
                    isTesting ? 'text-destructive ring-1 ring-destructive/20' : ''
                  }`}
                >
                  <Mic size={15} />
                </button>
              </div>

              {isTesting ? (
                <div className="px-1.5">
                  <MicLevelBars bars={bars} />
                  <p className="mt-1 text-[12px] text-muted-foreground">Speak to test this microphone…</p>
                </div>
              ) : null}
            </div>
          );
        })}

        {error && testingDeviceKey ? (
          <p className="px-1.5 text-[13px] font-medium text-destructive">{error}</p>
        ) : null}
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
    <section className="settings-modal-card px-5 py-4">
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_220px] md:items-start">
        <div className="min-w-0">
          <div className="text-[15px] font-semibold text-foreground">{title}</div>
          <div className="mt-0.5 text-[13px] text-muted-foreground">{description}</div>
          {message && <div className="mt-1.5 text-[13px] font-medium text-muted-foreground">{message}</div>}
          {!isAppending && allowMultiple && (
            <button
              type="button"
              onMouseDown={(e: React.MouseEvent) => e.preventDefault()}
              onClick={() => onCapture(target, hotkeys.length)}
              className="echo-btn settings-option-btn mt-3"
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
                  className={`settings-modal-field w-full min-w-[220px] rounded-md px-3 py-2 text-left transition-all ${
                    isCapturing ? 'border-primary/30 bg-secondary ring-1 ring-primary/15' : ''
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

function HotkeyTokens({ label, subdued = false }: { label: string; subdued?: boolean }) {
  const parts = label.split(' + ').filter(Boolean);

  if (!parts.length) {
    return <span className={`text-sm font-medium ${subdued ? 'text-muted-foreground' : 'text-foreground'}`}>{label}</span>;
  }

  return (
    <div className="flex flex-wrap gap-1">
      {parts.map((part, index) => (
        <span
          key={`${part}-${index}`}
          className={`settings-hotkey-chip inline-flex min-h-[28px] min-w-0 items-center justify-center px-2 py-0.5 text-[14px] font-normal ${
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
