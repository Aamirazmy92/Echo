import { useState, useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Mic, ArrowLeft, ArrowRight, Check, Pencil } from 'lucide-react';
import { GlobalStyleId, Settings } from '../../shared/types';
import { GLOBAL_STYLE_CONFIG } from '../../shared/styleConfig';
import {
  DEFAULT_PUSH_TO_TALK_HOTKEY,
  DEFAULT_TOGGLE_HOTKEY,
  formatHotkeyLabel,
  normalizeHotkeyAccelerator,
} from '../../shared/hotkey';
import { fadeTransition } from '../lib/motion';
import { useMicTest } from '../lib/useMicTest';

interface OnboardingProps {
  settings: Settings;
  devices: MediaDeviceInfo[];
  onComplete: (updates: Partial<Settings>) => void;
}

// Full-screen onboarding modelled on the bundled Echo Redesign.
// Five steps: Welcome → Shortcut → Microphone → Tone → Ready. Each step
// fills the pane, with a fine progress bar across the top and a Back /
// Continue rail across the bottom.
const STEPS = ['welcome', 'shortcut', 'microphone', 'tone', 'ready'] as const;

type StepId = (typeof STEPS)[number];

// The welcome and ready screens don't count as setup steps, so the
// "Step X of N" kicker only covers the middle configuration steps.
const SETUP_STEP_COUNT = STEPS.length - 2;

const ONBOARDING_TONE_IDS: GlobalStyleId[] = ['formal', 'casual', 'very_casual'];

const TONE_SUBTITLES: Partial<Record<GlobalStyleId, string>> = {
  formal: 'Polished',
  casual: 'Balanced',
  very_casual: 'Lowercase',
};

function HotkeyTokens({ label, subdued = false }: { label: string; subdued?: boolean }) {
  const tokens = label.split('+').map((t) => t.trim()).filter(Boolean);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      {tokens.map((token, i) => (
        <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <kbd className={`echo-kbd echo-kbd-lg ${subdued ? 'opacity-50' : ''}`}>{token}</kbd>
          {i < tokens.length - 1 && (
            <span style={{ color: 'var(--ink-muted)', fontSize: 12 }}>+</span>
          )}
        </span>
      ))}
    </span>
  );
}

export default function Onboarding({ settings, devices, onComplete }: OnboardingProps) {
  const [stepIndex, setStepIndex] = useState(0);
  const [selectedMic, setSelectedMic] = useState(settings.microphoneId ?? '');
  const [selectedMicLabel, setSelectedMicLabel] = useState(
    settings.microphoneLabel ?? 'Default microphone'
  );
  const [pushToTalkHotkey, setPushToTalkHotkey] = useState<string[]>(
    settings.pushToTalkHotkey ?? [DEFAULT_PUSH_TO_TALK_HOTKEY]
  );
  const [toggleHotkey, setToggleHotkey] = useState<string[]>(
    settings.toggleHotkey ?? [DEFAULT_TOGGLE_HOTKEY]
  );
  const [captureTarget, setCaptureTarget] = useState<{
    field: 'toggleHotkey' | 'pushToTalkHotkey';
    index: number;
  } | null>(null);
  const [tested, setTested] = useState(false);
  const [selectedTone, setSelectedTone] = useState<GlobalStyleId>(
    settings.selectedGlobalStyleId ?? 'casual'
  );

  const stepId: StepId = STEPS[stepIndex];
  const isLast = stepIndex === STEPS.length - 1;

  // Real microphone test — the hook tears the session down automatically
  // when we leave the microphone step.
  const micTest = useMicTest(stepId === 'microphone');
  const micTesting = micTest.isTestingDevice(selectedMic);
  const micLevel = micTesting ? Math.max(...micTest.bars, 0) : 0;

  useEffect(() => {
    if (micTesting && micLevel > 0.18 && !tested) setTested(true);
  }, [micTesting, micLevel, tested]);

  const completeOnboarding = useCallback(
    (updates: Partial<Settings>) => {
      if (captureTarget) {
        void window.api.resumeHotkey();
        setCaptureTarget(null);
      }
      onComplete(updates);
    },
    [captureTarget, onComplete]
  );

  const goNext = useCallback(() => {
    if (isLast) {
      completeOnboarding({
        onboardingComplete: true,
        microphoneId: selectedMic,
        microphoneLabel: selectedMicLabel,
        pushToTalkHotkey,
        toggleHotkey,
        selectedGlobalStyleId: selectedTone,
      });
    } else {
      setStepIndex((s) => s + 1);
    }
  }, [
    completeOnboarding,
    isLast,
    pushToTalkHotkey,
    selectedMic,
    selectedMicLabel,
    selectedTone,
    toggleHotkey,
  ]);

  const goPrev = useCallback(() => {
    if (captureTarget) {
      window.api.resumeHotkey();
      setCaptureTarget(null);
    }
    setStepIndex((s) => Math.max(0, s - 1));
  }, [captureTarget]);

  const handleCapture = async (
    target: 'toggleHotkey' | 'pushToTalkHotkey',
    index: number
  ) => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }

    if (captureTarget?.field === target && captureTarget.index === index) {
      await window.api.resumeHotkey();
      setCaptureTarget(null);
      return;
    }

    if (captureTarget) {
      await window.api.resumeHotkey();
    }

    await window.api.suspendHotkey();
    setCaptureTarget({ field: target, index });
  };

  // Cancel any in-flight hotkey capture if we leave the shortcut step.
  useEffect(() => {
    if (stepId !== 'shortcut' && captureTarget) {
      window.api.resumeHotkey();
      setCaptureTarget(null);
    }
  }, [stepId, captureTarget]);

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

      if (modifiers.length === 0) return;

      const mainKey = key.length === 1 ? key.toUpperCase() : key;
      const normalizedKey = normalizeHotkeyAccelerator(mainKey, '');
      const newHotkey = [...modifiers, normalizedKey].join(' + ');

      const currentHotkeys =
        captureTarget.field === 'pushToTalkHotkey' ? pushToTalkHotkey : toggleHotkey;
      const updated = [...currentHotkeys];
      updated[captureTarget.index] = newHotkey;

      if (captureTarget.field === 'pushToTalkHotkey') {
        setPushToTalkHotkey(updated);
      } else {
        setToggleHotkey(updated);
      }

      window.api.resumeHotkey();
      setCaptureTarget(null);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [captureTarget, pushToTalkHotkey, toggleHotkey]);

  const pttLabel = formatHotkeyLabel(pushToTalkHotkey[0] ?? DEFAULT_PUSH_TO_TALK_HOTKEY);

  return (
    <motion.div
      className="echo-onboarding"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
    >
      {/* Top bar — wordmark + progress dots + skip */}
      <div className="echo-onb-top">
        <div className="echo-wordmark" style={{ padding: 0, fontSize: 18 }}>
          <span className="dot" aria-hidden="true" />
          Echo
        </div>
        <div className="echo-onb-progress">
          {STEPS.map((_, i) => (
            <div
              key={i}
              className={`step ${i < stepIndex ? 'done' : i === stepIndex ? 'active' : ''}`}
            />
          ))}
        </div>
        <button
          type="button"
          className="echo-btn echo-btn-ghost"
          onClick={() => completeOnboarding({ onboardingComplete: true })}
        >
          Skip setup
        </button>
      </div>

      {/* Body */}
      <div className="echo-onb-body">
        <AnimatePresence mode="wait">
          <motion.div
            key={stepId}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={fadeTransition}
            className="echo-onb-card"
          >
            {stepId === 'welcome' && (
              <>
                <div className="echo-mic-illustration">
                  <div className="ring" />
                  <div className="ring r2" />
                  <div className="ring r3" />
                  <div className="echo-mic-orb-lg">
                    <Mic size={36} />
                  </div>
                </div>
                <div className="echo-h-section" style={{ marginBottom: 16 }}>
                  Welcome to Echo
                </div>
                <h1 className="echo-h-display">Talk. We'll handle the typing.</h1>
                <p className="echo-lede">
                  Echo lives in the background. Press a key, speak, release — your
                  words appear wherever your cursor is. Email, code, docs, chats.
                  Anywhere.
                </p>
                <div style={{ marginTop: 8 }}>
                  <button
                    type="button"
                    className="echo-btn echo-btn-primary"
                    style={{ padding: '12px 22px', fontSize: 14 }}
                    onClick={goNext}
                  >
                    Let's set you up <ArrowRight size={14} />
                  </button>
                </div>
                <div style={{ marginTop: 24, fontSize: 12.5, color: 'var(--ink-muted)' }}>
                  Takes about 90 seconds.
                </div>
              </>
            )}

            {stepId === 'shortcut' && (
              <div style={{ maxWidth: 600, width: '100%' }}>
                <div className="echo-h-section" style={{ marginBottom: 16, textAlign: 'center' }}>
                  Step {stepIndex} of {SETUP_STEP_COUNT} · Choose your shortcut
                </div>
                <h1 className="echo-h-display" style={{ textAlign: 'center' }}>
                  Pick a key to hold while you speak.
                </h1>
                <p
                  className="echo-lede"
                  style={{ textAlign: 'center', maxWidth: 540, margin: '14px auto 0' }}
                >
                  Press and hold to start, release to transcribe. We've found{' '}
                  <kbd className="echo-kbd echo-kbd-lg">Right Ctrl</kbd> works for most
                  people — but choose what feels natural.
                </p>

                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(2, 1fr)',
                    gap: 10,
                    marginTop: 22,
                    width: '100%',
                  }}
                >
                  <ShortcutOption
                    label="Push to talk"
                    description="Hold to dictate, release to stop."
                    hotkey={pushToTalkHotkey[0] ?? DEFAULT_PUSH_TO_TALK_HOTKEY}
                    capturing={captureTarget?.field === 'pushToTalkHotkey'}
                    onCapture={() => handleCapture('pushToTalkHotkey', 0)}
                  />
                  <ShortcutOption
                    label="Toggle dictation"
                    description="Press once to start, again to stop."
                    hotkey={toggleHotkey[0] ?? DEFAULT_TOGGLE_HOTKEY}
                    capturing={captureTarget?.field === 'toggleHotkey'}
                    onCapture={() => handleCapture('toggleHotkey', 0)}
                  />
                </div>

                <div
                  style={{
                    marginTop: 14,
                    fontSize: 12.5,
                    color: 'var(--ink-muted)',
                    textAlign: 'center',
                  }}
                >
                  You can change either of these any time in Settings.
                </div>
              </div>
            )}

            {stepId === 'microphone' && (
              <div style={{ maxWidth: 540, width: '100%' }}>
                <div className="echo-h-section" style={{ marginBottom: 16, textAlign: 'center' }}>
                  Step {stepIndex} of {SETUP_STEP_COUNT} · Choose your microphone
                </div>
                <h1 className="echo-h-display" style={{ textAlign: 'center' }}>
                  Which mic should Echo listen on?
                </h1>
                <p
                  className="echo-lede"
                  style={{ textAlign: 'center', margin: '14px auto 0', maxWidth: 460 }}
                >
                  Pick the microphone you want to use for dictation. You can change
                  this in Settings later.
                </p>

                <div
                  style={{
                    marginTop: 22,
                    maxHeight: 240,
                    overflowY: 'auto',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                  }}
                >
                  <MicOption
                    label="Default microphone"
                    active={selectedMic === ''}
                    onSelect={() => {
                      setSelectedMic('');
                      setSelectedMicLabel('Default microphone');
                    }}
                  />
                  {devices.map((device) => (
                    <MicOption
                      key={device.deviceId}
                      label={device.label || 'Unknown microphone'}
                      active={selectedMic === device.deviceId}
                      onSelect={() => {
                        setSelectedMic(device.deviceId);
                        setSelectedMicLabel(device.label || 'Unknown microphone');
                      }}
                    />
                  ))}
                </div>

                <button
                  type="button"
                  onClick={() => void micTest.toggleDeviceTest(selectedMic)}
                  style={{
                    margin: '22px auto 0',
                    width: 120,
                    height: 120,
                    borderRadius: '50%',
                    background: micTesting
                      ? 'radial-gradient(circle at 30% 25%, #E4886A, #C96442 65%)'
                      : 'var(--card-raw)',
                    border: micTesting ? 'none' : '1px dashed var(--line-strong)',
                    color: micTesting ? 'var(--ivory)' : 'var(--ink-soft)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 3,
                    cursor: 'pointer',
                    font: 'inherit',
                    boxShadow: micTesting
                      ? `0 16px 40px -8px rgba(201,100,66,${0.35 + micLevel * 0.4})`
                      : 'none',
                    transition: 'background 200ms ease, box-shadow 120ms ease',
                  }}
                  aria-label={micTesting ? 'Stop microphone test' : 'Test microphone'}
                  aria-pressed={micTesting}
                >
                  {micTesting ? (
                    micTest.bars.map((level, i) => (
                      <span
                        key={i}
                        style={{
                          width: 4,
                          height: 8 + Math.min(1, level) * 30,
                          borderRadius: 2,
                          background: 'var(--ivory)',
                          transition: 'height 80ms ease',
                        }}
                      />
                    ))
                  ) : (
                    <Mic size={32} />
                  )}
                </button>

                <div
                  style={{
                    marginTop: 10,
                    fontSize: 13,
                    color: micTest.error
                      ? 'var(--destructive, #b3422f)'
                      : tested
                        ? 'var(--moss)'
                        : 'var(--ink-muted)',
                    textAlign: 'center',
                    height: 20,
                  }}
                  role="status"
                >
                  {micTest.error
                    ? micTest.error
                    : micTesting
                      ? tested
                        ? '✓ Sounds great. Tap again to stop.'
                        : 'Listening… say something'
                      : tested
                        ? '✓ Mic check passed.'
                        : 'Tap the mic to test'}
                </div>
              </div>
            )}

            {stepId === 'tone' && (
              <div style={{ maxWidth: 760, width: '100%' }}>
                <div className="echo-h-section" style={{ marginBottom: 16, textAlign: 'center' }}>
                  Step {stepIndex} of {SETUP_STEP_COUNT} · Pick a tone
                </div>
                <h1 className="echo-h-display" style={{ textAlign: 'center' }}>
                  How should it sound when you talk?
                </h1>
                <p
                  className="echo-lede"
                  style={{ textAlign: 'center', margin: '14px auto 22px', maxWidth: 540 }}
                >
                  Echo polishes your raw speech into clean writing. You can change
                  this later — or let it match the app you're in.
                </p>

                <div
                  role="radiogroup"
                  aria-label="Writing tone"
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(3, 1fr)',
                    gap: 12,
                    width: '100%',
                  }}
                >
                  {ONBOARDING_TONE_IDS.map((toneId) => {
                    const tone = GLOBAL_STYLE_CONFIG[toneId];
                    const selected = selectedTone === toneId;
                    return (
                      <button
                        key={toneId}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        onClick={() => setSelectedTone(toneId)}
                        className={`echo-tone-card ${selected ? 'selected' : ''}`}
                        style={{ textAlign: 'left', cursor: 'pointer', font: 'inherit' }}
                      >
                        <div className="radio" aria-hidden="true" />
                        <div className="name">{tone.label}</div>
                        <div className="sub" style={{ marginBottom: 0 }}>
                          {TONE_SUBTITLES[toneId] ?? tone.subtitle}
                        </div>
                      </button>
                    );
                  })}
                </div>

                <div
                  style={{
                    marginTop: 14,
                    fontSize: 12.5,
                    color: 'var(--ink-muted)',
                    textAlign: 'center',
                  }}
                >
                  Six tones to choose from later, including <em>Coding</em> and{' '}
                  <em>Excited</em>.
                </div>
              </div>
            )}

            {stepId === 'ready' && (
              <>
                <div
                  style={{
                    width: 84,
                    height: 84,
                    borderRadius: '50%',
                    background: 'var(--accent-tint)',
                    color: 'var(--clay)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    marginBottom: 28,
                  }}
                >
                  <Check size={36} />
                </div>
                <div className="echo-h-section" style={{ marginBottom: 16 }}>
                  You're all set
                </div>
                <h1 className="echo-h-display" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', justifyContent: 'center' }}>
                  Try it now — hold{' '}
                  <HotkeyTokens label={pttLabel} />
                </h1>
                <p className="echo-lede">
                  Echo will sit quietly in the background. Open any app, place your
                  cursor, and press to speak. Welcome aboard.
                </p>
                <button
                  type="button"
                  className="echo-btn echo-btn-primary"
                  style={{ padding: '12px 24px', fontSize: 14, marginTop: 8 }}
                  onClick={goNext}
                >
                  Open Echo <ArrowRight size={14} />
                </button>
              </>
            )}
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Bottom bar — Back / counter / Continue */}
      <div className="echo-onb-bot">
        <button
          type="button"
          className="echo-btn echo-btn-ghost"
          onClick={goPrev}
          disabled={stepIndex === 0}
          style={{ opacity: stepIndex === 0 ? 0.3 : 1 }}
        >
          <ArrowLeft size={14} /> Back
        </button>
        <div style={{ fontSize: 12.5, color: 'var(--ink-muted)' }}>
          {stepIndex + 1} / {STEPS.length}
        </div>
        {!isLast ? (
          <button
            type="button"
            className="echo-btn echo-btn-dark"
            onClick={goNext}
            style={{ padding: '10px 18px' }}
          >
            Continue <ArrowRight size={14} />
          </button>
        ) : (
          <button
            type="button"
            className="echo-btn echo-btn-dark"
            onClick={goNext}
            style={{ padding: '10px 18px' }}
          >
            Get started <ArrowRight size={14} />
          </button>
        )}
      </div>
    </motion.div>
  );
}

function ShortcutOption({
  label,
  description,
  hotkey,
  capturing,
  onCapture,
}: {
  label: string;
  description: string;
  hotkey: string;
  capturing: boolean;
  onCapture: () => void;
}) {
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onCapture}
      className="echo-card"
      style={{
        padding: '16px 18px',
        textAlign: 'left',
        cursor: 'pointer',
        font: 'inherit',
        background: capturing ? 'var(--accent-tint)' : 'var(--card-raw)',
        borderColor: capturing ? 'var(--clay)' : 'var(--line-soft)',
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--ink)' }}>{label}</div>
      <div style={{ marginTop: 4, fontSize: 12, color: 'var(--ink-muted)' }}>
        {description}
      </div>
      <div
        style={{
          marginTop: 12,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <HotkeyTokens
          label={capturing ? 'Press keys…' : formatHotkeyLabel(hotkey)}
          subdued={capturing}
        />
        <Pencil
          size={13}
          style={{ color: capturing ? 'var(--clay)' : 'var(--ink-faint)' }}
        />
      </div>
    </button>
  );
}

function MicOption({
  label,
  active,
  onSelect,
}: {
  label: string;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '12px 14px',
        borderRadius: 10,
        border: '1px solid',
        borderColor: active ? 'var(--clay)' : 'var(--line-soft)',
        background: active ? 'var(--accent-tint)' : 'var(--card-raw)',
        cursor: 'pointer',
        font: 'inherit',
        textAlign: 'left',
      }}
    >
      <Mic
        size={16}
        style={{ color: active ? 'var(--clay)' : 'var(--ink-faint)' }}
      />
      <span
        style={{
          flex: 1,
          fontSize: 13.5,
          fontWeight: 500,
          color: active ? 'var(--ink)' : 'var(--ink-2)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {label}
      </span>
      {active ? <Check size={16} style={{ color: 'var(--clay)' }} /> : null}
    </button>
  );
}
