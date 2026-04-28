import { useState, useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Mic, Keyboard, Sparkles, ChevronRight, Check, Pencil, X } from 'lucide-react';
import { Settings } from '../../shared/types';
import { DEFAULT_PUSH_TO_TALK_HOTKEY, DEFAULT_TOGGLE_HOTKEY, formatHotkeyLabel, normalizeHotkeyList, normalizeHotkeyAccelerator } from '../../shared/hotkey';
import { fadeTransition, panelTransition } from '../lib/motion';

interface OnboardingProps {
  settings: Settings;
  devices: MediaDeviceInfo[];
  onComplete: (updates: Partial<Settings>) => void;
}

const STEPS = [
  {
    id: 'welcome',
    title: 'Welcome to Echo',
    description: 'Echo lets you dictate text into any application on your computer using your voice.',
  },
  {
    id: 'microphone',
    title: 'Choose your microphone',
    description: 'Select the microphone you want to use for dictation.',
  },
  {
    id: 'hotkey',
    title: 'Set your hotkey',
    description: 'Echo uses a hotkey to start and stop dictation. Choose your preferred mode below.',
  },
  {
    id: 'ready',
    title: 'You\'re all set!',
    description: 'Hold your hotkey to start dictating. Release to stop. The transcribed text will appear in whatever app you\'re using.',
  },
];

function HotkeyTokens({ label, subdued = false }: { label: string; subdued?: boolean }) {
  const tokens = label.split(' + ');
  return (
    <div className="flex items-center gap-1">
      {tokens.map((token, i) => (
        <span
          key={i}
          className={`theme-kbd flex items-center px-2 py-1 text-[13px] font-semibold ${subdued ? 'opacity-50' : ''}`}
        >
          {token}
        </span>
      ))}
    </div>
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
}: {
  target: 'toggleHotkey' | 'pushToTalkHotkey';
  title: string;
  description: string;
  hotkeys: string[];
  captureTarget: { field: string; index: number } | null;
  message?: string;
  onCapture: (target: 'toggleHotkey' | 'pushToTalkHotkey', index: number) => void;
  onRemove: (target: 'toggleHotkey' | 'pushToTalkHotkey', index: number) => void;
}) {
  const isAppending = captureTarget?.field === target && captureTarget.index === hotkeys.length;
  const displayedHotkeys = isAppending ? [...hotkeys, ''] : hotkeys;

  return (
    <section className="theme-card-soft rounded-[16px] px-6 py-5">
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_246px] md:items-start">
        <div className="min-w-0">
          <div className="text-[14px] font-semibold text-[color:var(--text-primary)]">{title}</div>
          <div className="mt-1 max-w-[330px] text-[13px] text-[color:var(--text-muted)]">{description}</div>
          {message ? (
            <div className="mt-2 text-[12px] font-medium text-[color:var(--text-muted)]">{message}</div>
          ) : null}
        </div>

        <div className="space-y-2.5 md:justify-self-end">
          {displayedHotkeys.map((hotkey, index) => {
            const isCapturing = captureTarget?.field === target && captureTarget.index === index;
            const canRemove = hotkeys.length > 1 && index < hotkeys.length;

            return (
              <div key={`${target}-${hotkey || 'pending'}-${index}`} className="flex items-stretch gap-2">
                <button
                  type="button"
                  onMouseDown={(event: React.MouseEvent) => event.preventDefault()}
                  onClick={() => onCapture(target, index)}
                  className={`w-full min-w-[246px] rounded-md border px-3 py-2 text-left transition-all ${
                    isCapturing
                      ? 'theme-selected-surface border-[color:var(--border-strong)] bg-[rgba(121,192,255,0.08)]'
                      : 'border-[color:var(--border-soft)] bg-[rgba(24,35,56,0.96)] hover:border-[rgba(121,192,255,0.28)] hover:bg-[rgba(121,192,255,0.08)]'
                  }`}
                >
                  <div className="flex min-h-[24px] items-center justify-between gap-3">
                    <HotkeyTokens label={isCapturing ? 'Press keys...' : formatHotkeyLabel(hotkey)} subdued={isCapturing} />
                    <Pencil size={14} className={`${isCapturing ? 'text-[color:var(--accent)]' : 'text-[color:var(--text-faint)]'} shrink-0`} />
                  </div>
                </button>

                {canRemove ? (
                  <button
                    type="button"
                    onMouseDown={(event: React.MouseEvent) => event.preventDefault()}
                    onClick={() => onRemove(target, index)}
                    className="theme-icon-button self-center rounded-full p-1.5"
                    aria-label="Remove shortcut"
                  >
                    <X size={14} />
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

export default function Onboarding({ settings, devices, onComplete }: OnboardingProps) {
  const [step, setStep] = useState(0);
  const [selectedMic, setSelectedMic] = useState(settings.microphoneId ?? '');
  const [selectedMicLabel, setSelectedMicLabel] = useState(settings.microphoneLabel ?? 'Default microphone');
  const [pushToTalkHotkey, setPushToTalkHotkey] = useState<string[]>(settings.pushToTalkHotkey ?? [DEFAULT_PUSH_TO_TALK_HOTKEY]);
  const [toggleHotkey, setToggleHotkey] = useState<string[]>(settings.toggleHotkey ?? [DEFAULT_TOGGLE_HOTKEY]);
  const [captureTarget, setCaptureTarget] = useState<{ field: 'toggleHotkey' | 'pushToTalkHotkey'; index: number } | null>(null);
  const [hotkeyMessage, setHotkeyMessage] = useState('');

  const current = STEPS[step];
  const isLast = step === STEPS.length - 1;

  const handleNext = useCallback(() => {
    if (isLast) {
      if (captureTarget) {
        (window as any).api.resumeHotkey();
        setCaptureTarget(null);
      }
      onComplete({
        onboardingComplete: true,
        microphoneId: selectedMic,
        microphoneLabel: selectedMicLabel,
        pushToTalkHotkey: pushToTalkHotkey,
        toggleHotkey: toggleHotkey,
      });
    } else {
      setStep(s => s + 1);
    }
  }, [isLast, selectedMic, selectedMicLabel, pushToTalkHotkey, toggleHotkey, onComplete, captureTarget]);

  const handleMicSelect = (deviceId: string, label: string) => {
    setSelectedMic(deviceId);
    setSelectedMicLabel(label);
  };

  const handleCapture = async (target: 'toggleHotkey' | 'pushToTalkHotkey', index: number) => {
    setHotkeyMessage('');
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }

    if (captureTarget?.field === target && captureTarget.index === index) {
      await (window as any).api.resumeHotkey();
      setCaptureTarget(null);
      setHotkeyMessage('Hotkey capture cancelled.');
      return;
    }

    if (captureTarget) {
      await (window as any).api.resumeHotkey();
    }

    await (window as any).api.suspendHotkey();
    setCaptureTarget({ field: target, index });
  };

  const handleRemove = async (target: 'toggleHotkey' | 'pushToTalkHotkey', index: number) => {
    const currentHotkeys = target === 'pushToTalkHotkey' ? pushToTalkHotkey : toggleHotkey;
    if (currentHotkeys.length <= 1) return;

    if (captureTarget?.field === target && captureTarget.index === index) {
      await (window as any).api.resumeHotkey();
      setCaptureTarget(null);
    }

    const nextHotkeys = currentHotkeys.filter((_, hotkeyIndex) => hotkeyIndex !== index);
    if (target === 'pushToTalkHotkey') {
      setPushToTalkHotkey(nextHotkeys);
    } else {
      setToggleHotkey(nextHotkeys);
    }
    setHotkeyMessage('Removed shortcut.');
  };

  const handleReset = async () => {
    if (captureTarget) {
      await (window as any).api.resumeHotkey();
      setCaptureTarget(null);
    }
    setPushToTalkHotkey([DEFAULT_PUSH_TO_TALK_HOTKEY]);
    setToggleHotkey([DEFAULT_TOGGLE_HOTKEY]);
    setHotkeyMessage(`Reset to default.`);
  };

  useEffect(() => {
    if (step !== 2) {
      if (captureTarget) {
        (window as any).api.resumeHotkey();
        setCaptureTarget(null);
      }
    }
  }, [step, captureTarget]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!captureTarget) return;

      event.preventDefault();

      const modifiers: string[] = [];
      if (event.ctrlKey) modifiers.push('Ctrl');
      if (event.shiftKey) modifiers.push('Shift');
      if (event.altKey) modifiers.push('Alt');
      if (event.metaKey) modifiers.push('Meta');

      const key = event.key;
      if (key === 'Control' || key === 'Shift' || key === 'Alt' || key === 'Meta') {
        return;
      }

      if (modifiers.length === 0) {
        setHotkeyMessage('Please include at least one modifier key (Ctrl, Shift, Alt, Meta).');
        return;
      }

      const mainKey = key.length === 1 ? key.toUpperCase() : key;
      const normalizedKey = normalizeHotkeyAccelerator(mainKey, '');
      const newHotkey = [...modifiers, normalizedKey].join(' + ');

      const currentHotkeys = captureTarget.field === 'pushToTalkHotkey' ? pushToTalkHotkey : toggleHotkey;
      const updatedHotkeys = [...currentHotkeys];
      updatedHotkeys[captureTarget.index] = newHotkey;

      if (captureTarget.field === 'pushToTalkHotkey') {
        setPushToTalkHotkey(updatedHotkeys);
      } else {
        setToggleHotkey(updatedHotkeys);
      }

      (window as any).api.resumeHotkey();
      setCaptureTarget(null);
      setHotkeyMessage('Hotkey saved.');
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [captureTarget, pushToTalkHotkey, toggleHotkey]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={fadeTransition}
      className="fixed inset-0 z-[200] flex items-center justify-center bg-[rgba(6,11,21,0.72)]"
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 10 }}
        transition={panelTransition}
        className="theme-card relative flex w-full max-w-[460px] flex-col overflow-hidden rounded-[28px] shadow-2xl"
      >
        {/* Progress bar */}
        <div className="h-1 bg-[color:var(--border-soft)]">
          <motion.div
            className="h-full bg-[color:var(--accent)]"
            initial={{ width: '0%' }}
            animate={{ width: `${((step + 1) / STEPS.length) * 100}%` }}
            transition={panelTransition}
          />
        </div>

        <div className="p-8">
          {/* Step indicator */}
          <div className="mb-6 flex items-center gap-2">
            {STEPS.map((s, i) => (
              <div
                key={s.id}
                className={`h-1.5 rounded-full transition-all duration-300 ${
                  i <= step ? 'w-6 bg-[color:var(--accent)]' : 'w-1.5 bg-[color:var(--border-soft)]'
                }`}
              />
            ))}
            <span className="ml-auto text-[12px] font-medium text-[color:var(--text-faint)]">
              {step + 1} / {STEPS.length}
            </span>
          </div>

          <AnimatePresence mode="wait">
            <motion.div
              key={current.id}
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={fadeTransition}
            >
              <h2 className="text-[24px] font-bold tracking-tight text-[color:var(--text-primary)]">
                {current.title}
              </h2>
              <p className="mt-2 text-[14px] leading-relaxed text-[color:var(--text-secondary)]">
                {current.description}
              </p>

              {/* Step content */}
              {current.id === 'welcome' && (
                <div className="mt-8 flex items-center gap-4">
                  <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[color:var(--accent-surface)]">
                    <Mic size={28} className="text-[color:var(--accent)]" />
                  </div>
                  <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[color:var(--accent-surface)]">
                    <Keyboard size={28} className="text-[color:var(--accent)]" />
                  </div>
                  <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[color:var(--accent-surface)]">
                    <Sparkles size={28} className="text-[color:var(--accent)]" />
                  </div>
                </div>
              )}

              {current.id === 'microphone' && (
                <div className="mt-6 max-h-[200px] space-y-2 overflow-y-auto">
                  <button
                    type="button"
                    onClick={() => handleMicSelect('', 'Default microphone')}
                    className={`flex w-full items-center gap-3 rounded-md border px-4 py-3 text-left transition-all ${
                      selectedMic === ''
                        ? 'border-[color:var(--border-strong)] bg-[color:var(--accent-surface)]'
                        : 'border-[color:var(--border-soft)] bg-[color:var(--surface-1)] hover:bg-[color:var(--surface-2)]'
                    }`}
                  >
                    <Mic size={16} className={selectedMic === '' ? 'text-[color:var(--accent)]' : 'text-[color:var(--text-faint)]'} />
                    <span className={`flex-1 text-[13px] font-medium ${selectedMic === '' ? 'text-[color:var(--text-primary)]' : 'text-[color:var(--text-secondary)]'}`}>
                      Default microphone
                    </span>
                    {selectedMic === '' && <Check size={16} className="text-[color:var(--accent)]" />}
                  </button>
                  {devices.map((d) => (
                    <button
                      type="button"
                      key={d.deviceId}
                      onClick={() => handleMicSelect(d.deviceId, d.label || 'Unknown device')}
                      className={`flex w-full items-center gap-3 rounded-md border px-4 py-3 text-left transition-all ${
                        selectedMic === d.deviceId
                          ? 'border-[color:var(--border-strong)] bg-[color:var(--accent-surface)]'
                          : 'border-[color:var(--border-soft)] bg-[color:var(--surface-1)] hover:bg-[color:var(--surface-2)]'
                      }`}
                    >
                      <Mic size={16} className={selectedMic === d.deviceId ? 'text-[color:var(--accent)]' : 'text-[color:var(--text-faint)]'} />
                      <span className={`flex-1 truncate text-[13px] font-medium ${selectedMic === d.deviceId ? 'text-[color:var(--text-primary)]' : 'text-[color:var(--text-secondary)]'}`}>
                        {d.label || 'Unknown device'}
                      </span>
                      {selectedMic === d.deviceId && <Check size={16} className="text-[color:var(--accent)]" />}
                    </button>
                  ))}
                </div>
              )}

              {current.id === 'hotkey' && (
                <div className="mt-6 space-y-4">
                  <ShortcutCard
                    title="Push to talk"
                    description="Hold to dictate, then release to stop."
                    target="pushToTalkHotkey"
                    hotkeys={pushToTalkHotkey}
                    captureTarget={captureTarget}
                    message={hotkeyMessage}
                    onCapture={handleCapture}
                    onRemove={handleRemove}
                  />

                  <ShortcutCard
                    title="Toggle dictation"
                    description="Press once to start dictation and again to stop."
                    target="toggleHotkey"
                    hotkeys={toggleHotkey}
                    captureTarget={captureTarget}
                    message={hotkeyMessage}
                    onCapture={handleCapture}
                    onRemove={handleRemove}
                  />

                  <div className="mt-4 text-center">
                    <button
                      type="button"
                      onClick={handleReset}
                      className="theme-button-secondary px-4 text-[13px]"
                    >
                      Reset to default
                    </button>
                  </div>
                </div>
              )}

              {current.id === 'ready' && (
                <div className="mt-6 flex items-center gap-3 rounded-xl border border-[color:var(--border-strong)] bg-[color:var(--accent-surface)] p-4">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[color:var(--accent)] text-[color:var(--accent-text)]">
                    <Check size={20} />
                  </div>
                  <div>
                    <div className="text-[13px] font-semibold text-[color:var(--text-primary)]">Setup complete</div>
                    <div className="text-[12px] text-[color:var(--text-muted)]">You can change these settings anytime.</div>
                  </div>
                </div>
              )}
            </motion.div>
          </AnimatePresence>

          {/* Actions */}
          <div className="mt-8 flex items-center justify-between">
            {step > 0 ? (
              <button
                type="button"
                onClick={() => {
                  if (captureTarget) {
                    (window as any).api.resumeHotkey();
                  }
                  setCaptureTarget(null);
                  setStep(step - 1);
                }}
                className="theme-button-secondary px-5 text-[13px] font-medium"
              >
                Back
              </button>
            ) : (
              <div />
            )}
            <button
              type="button"
              onClick={handleNext}
              className="theme-button-primary flex items-center gap-2 px-6 text-[13px] font-semibold"
            >
              {isLast ? 'Get started' : 'Continue'}
              {!isLast && <ChevronRight size={16} />}
            </button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}
