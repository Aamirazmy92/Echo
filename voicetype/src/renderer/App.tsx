import { useState, useEffect, useRef, useCallback, Suspense, lazy, startTransition } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Minus,
  Square,
  X,
  Home,
  BookOpen,
  Pencil,
  Type,
  FileText,
  Settings as SettingsIcon,
  PanelLeft,
  Download,
  Loader2,
  RefreshCw,
  CreditCard,
  type LucideIcon,
} from 'lucide-react';
import ToastHost from './components/toast/ToastHost';
import { toast as toastDispatch, type ToastType } from './components/toast/useToast';
import { AppState, AppTab, SpeechMetrics, Settings as SettingsType } from '../shared/types';
import { MIC_TEST_ACTIVE_EVENT } from './lib/micTest';
import { enumerateAudioInputDevices } from './lib/audioDevices';
import DashboardView from './components/Dashboard';
import Onboarding from './components/Onboarding';
import MotionWarmup from './components/MotionWarmup';
import ModalOverlayRoot from './components/ModalOverlayRoot';
import NotepadView from './components/Notepad';
import type { AuthSession, BasicUsagePayload, EntitlementsPayload, UpdateStatusPayload } from './api';
import {
  MODAL_OVERLAY_FADE,
  MODAL_PANEL_INITIAL,
  MODAL_PANEL_OPEN,
  MODAL_PANEL_EXIT,
  MODAL_SPRING,
  MODAL_SPRING_EXIT,
} from './lib/modalMotion';

type IdleWindow = Window & typeof globalThis & {
  requestIdleCallback?: (callback: () => void) => number;
  cancelIdleCallback?: (handle: number) => void;
};

let settingsViewImportPromise: Promise<typeof import('./components/Settings')> | null = null;
let historyViewImportPromise: Promise<typeof import('./components/History')> | null = null;
let snippetsViewImportPromise: Promise<typeof import('./components/Snippets')> | null = null;
let styleViewImportPromise: Promise<typeof import('./components/Style')> | null = null;

function loadSettingsView() {
  if (!settingsViewImportPromise) {
    settingsViewImportPromise = import('./components/Settings');
  }

  return settingsViewImportPromise;
}

function loadHistoryView() {
  if (!historyViewImportPromise) {
    historyViewImportPromise = import('./components/History');
  }

  return historyViewImportPromise;
}

function loadSnippetsView() {
  if (!snippetsViewImportPromise) {
    snippetsViewImportPromise = import('./components/Snippets');
  }

  return snippetsViewImportPromise;
}

function loadStyleView() {
  if (!styleViewImportPromise) {
    styleViewImportPromise = import('./components/Style');
  }

  return styleViewImportPromise;
}

const SettingsView = lazy(loadSettingsView);
const HistoryView = lazy(loadHistoryView);
const SnippetsView = lazy(loadSnippetsView);
const StyleView = lazy(loadStyleView);

const SIDEBAR_COMPACT_WIDTH = 64;
const SIDEBAR_EXPANDED_WIDTH = 232;
const SIDEBAR_SPRING = {
  type: 'spring',
  stiffness: 420,
  damping: 42,
  mass: 0.9,
} as const;
const SIDEBAR_CONTENT_FADE = {
  duration: 0.18,
  ease: [0.22, 1, 0.36, 1],
} as const;

function SidebarIcon({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <Icon
      size={16}
      strokeWidth={2}
      className="text-current"
    />
  );
}

function MainPanelSkeleton() {
  return <div className="h-full w-full bg-popover" />;
}

function StartupUpdatePrompt({
  status,
  pending,
  onDismiss,
  onAction,
}: {
  status: UpdateStatusPayload;
  pending: boolean;
  onDismiss: () => void;
  onAction: (action: 'download' | 'install') => Promise<void>;
}) {
  const isDownloading = status.state === 'downloading';
  const isReady = status.state === 'ready';
  const progress = typeof status.progress === 'number' ? status.progress : 0;
  const title = isReady ? 'Update ready to install' : isDownloading ? 'Downloading update' : 'Update available';
  const body = isReady
    ? `Echo ${status.version ? `v${status.version}` : 'update'} has been downloaded. Restart Echo to finish installing it.`
    : isDownloading
      ? `Echo ${status.version ? `v${status.version}` : 'update'} is downloading. ${progress}% complete.`
      : `Echo ${status.version ? `v${status.version}` : 'a new version'} is available. Download it now to get the latest fixes.`;
  const action = isReady ? 'install' : 'download';
  const ActionIcon = isReady ? RefreshCw : Download;

  return (
    <ModalOverlayRoot
      className="fixed inset-0 z-[9998] flex items-center justify-center bg-[hsl(25_18%_12%/0.30)] px-6 backdrop-blur-[2px]"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={MODAL_OVERLAY_FADE}
    >
      <motion.div
        className="echo-standard-modal w-full rounded-2xl border border-border bg-popover shadow-[0_24px_70px_rgba(31,27,22,0.18)] transform-gpu"
        initial={MODAL_PANEL_INITIAL}
        animate={MODAL_PANEL_OPEN}
        exit={{ ...MODAL_PANEL_EXIT, transition: MODAL_SPRING_EXIT }}
        transition={MODAL_SPRING}
        style={{ willChange: 'opacity, transform' }}
      >
        <div className="flex items-start gap-4">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[hsl(var(--success-soft))] text-[hsl(var(--success))]">
            {isDownloading ? <Loader2 size={20} className="animate-spin" /> : <ActionIcon size={20} />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="echo-modal-title">{title}</div>
            <div className="echo-modal-description">{body}</div>
            {isDownloading ? (
              <div className="mt-4 h-2 overflow-hidden rounded-full bg-foreground/10">
                <div className="h-full rounded-full bg-[hsl(var(--success))] transition-[width]" style={{ width: `${Math.max(0, Math.min(100, progress))}%` }} />
              </div>
            ) : null}
          </div>
        </div>
        <div className="echo-modal-footer">
          <button
            type="button"
            onClick={onDismiss}
            className="echo-btn echo-btn-outline"
          >
            Later
          </button>
          <button
            type="button"
            onClick={() => void onAction(action)}
            disabled={pending || isDownloading}
            className="echo-btn echo-btn-dark disabled:cursor-default disabled:opacity-70"
          >
            {pending || isDownloading ? <Loader2 size={15} className="animate-spin" /> : <ActionIcon size={15} />}
            {isReady ? 'Restart now' : isDownloading ? 'Downloading' : 'Download update'}
          </button>
        </div>
      </motion.div>
    </ModalOverlayRoot>
  );
}

function getBasicUsageMessage(payload: BasicUsagePayload): string {
  if (payload.message) return payload.message;
  if (payload.remaining > 0) {
    return `Basic includes ${payload.cap.toLocaleString()} dictated words per week. You have ${payload.remaining.toLocaleString()} left this week. Upgrade to Pro for more.`;
  }
  return `You've used all ${payload.cap.toLocaleString()} Basic words for this week. Upgrade to Pro for more.`;
}

function BasicUsageLimitPrompt({
  payload,
  onDismiss,
  onUpgrade,
}: {
  payload: BasicUsagePayload;
  onDismiss: () => void;
  onUpgrade: () => void;
}) {
  return (
    <ModalOverlayRoot
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-[hsl(25_18%_12%/0.30)] px-6 backdrop-blur-[2px]"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={MODAL_OVERLAY_FADE}
    >
      <motion.div
        className="echo-standard-modal w-full rounded-2xl border border-border bg-popover shadow-[0_24px_70px_rgba(31,27,22,0.18)] transform-gpu"
        initial={MODAL_PANEL_INITIAL}
        animate={MODAL_PANEL_OPEN}
        exit={{ ...MODAL_PANEL_EXIT, transition: MODAL_SPRING_EXIT }}
        transition={MODAL_SPRING}
        style={{ willChange: 'opacity, transform' }}
      >
        <div className="flex items-start gap-4">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[hsl(var(--brand)/0.12)] text-[hsl(var(--brand))]">
            <CreditCard size={20} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="echo-modal-title">Upgrade to Pro for more</div>
            <div className="echo-modal-description">
              {getBasicUsageMessage(payload)}
            </div>
          </div>
        </div>
        <div className="echo-modal-footer">
          <button
            type="button"
            onClick={onDismiss}
            className="echo-btn echo-btn-outline"
          >
            Not now
          </button>
          <button
            type="button"
            onClick={onUpgrade}
            className="echo-btn echo-btn-dark"
          >
            Upgrade to Pro
          </button>
        </div>
      </motion.div>
    </ModalOverlayRoot>
  );
}

const OFFLINE_SAMPLE_RATE = 16000;
const APP_ERROR_RESET_MS = 4_000;
const RECORDER_STOP_TIMEOUT_MS = 4_000;
const PROCESSING_TIMEOUT_MS = 30_000;

function downsampleFloat32Buffer(
  input: Float32Array,
  inputSampleRate: number,
  outputSampleRate: number
): Float32Array {
  if (!input.length || inputSampleRate === outputSampleRate) {
    return input;
  }

  const ratio = inputSampleRate / outputSampleRate;
  const outputLength = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(outputLength);
  let inputOffset = 0;

  for (let index = 0; index < outputLength; index += 1) {
    const nextOffset = Math.round((index + 1) * ratio);
    let sum = 0;
    let count = 0;

    for (let cursor = inputOffset; cursor < nextOffset && cursor < input.length; cursor += 1) {
      sum += input[cursor];
      count += 1;
    }

    output[index] = count > 0 ? sum / count : input[Math.min(inputOffset, input.length - 1)] ?? 0;
    inputOffset = nextOffset;
  }

  return output;
}

function normalizeAudioForTranscription(input: Float32Array): Float32Array {
  if (!input.length) return input;

  // Pass 1: compute mean
  let sum = 0;
  for (let index = 0; index < input.length; index += 1) {
    sum += input[index];
  }
  const mean = sum / input.length;

  // Pass 2: center in-place and find peak
  let centeredPeak = 0;
  for (let index = 0; index < input.length; index += 1) {
    const value = input[index] - mean;
    input[index] = value;
    const magnitude = Math.abs(value);
    if (magnitude > centeredPeak) centeredPeak = magnitude;
  }

  if (centeredPeak < 0.0005) {
    return input;
  }

  const gain = Math.min(12, Math.max(1, 0.85 / centeredPeak));
  if (gain === 1) {
    return input;
  }

  // Pass 3: apply gain in-place
  for (let index = 0; index < input.length; index += 1) {
    input[index] = Math.max(-1, Math.min(1, input[index] * gain));
  }

  return input;
}

let decodeCtx: AudioContext | null = null;

async function decodeRecordedAudioToMono(
  audioBuffer: ArrayBuffer
): Promise<{ samples: Float32Array; sampleRate: number }> {
  if (!decodeCtx || decodeCtx.state === 'closed') {
    decodeCtx = new AudioContext();
  }

  const decoded = await decodeCtx.decodeAudioData(audioBuffer.slice(0));
  const channelCount = decoded.numberOfChannels;
  const frameCount = decoded.length;
  const mono = new Float32Array(frameCount);

  if (channelCount === 1) {
    mono.set(decoded.getChannelData(0));
  } else {
    for (let channel = 0; channel < channelCount; channel += 1) {
      const channelData = decoded.getChannelData(channel);
      for (let index = 0; index < frameCount; index += 1) {
        mono[index] += channelData[index] / channelCount;
      }
    }
  }

  return {
    samples: mono,
    sampleRate: decoded.sampleRate,
  };
}

export default function App() {
  const [activeTab, setActiveTab] = useState<AppTab>('dashboard');
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isSettingsViewMounted, setIsSettingsViewMounted] = useState(false);
  const [settingsInitialCategory, setSettingsInitialCategory] = useState<string | null>(null);
  const [basicUsageLimitPrompt, setBasicUsageLimitPrompt] = useState<BasicUsagePayload | null>(null);
  const [isSidebarCompact, setIsSidebarCompact] = useState(false);
  const [settings, setSettings] = useState<SettingsType | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [startupUpdateStatus, setStartupUpdateStatus] = useState<UpdateStatusPayload | null>(null);
  const [isStartupUpdateDismissed, setIsStartupUpdateDismissed] = useState(false);
  const [isStartupUpdateActionPending, setIsStartupUpdateActionPending] = useState(false);
  const [authSession, setAuthSession] = useState<AuthSession | null>(null);
  const [entitlements, setEntitlements] = useState<EntitlementsPayload | null>(null);
  const appStateRef = useRef<AppState>('idle');
  const settingsRef = useRef<SettingsType | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const streamDeviceIdRef = useRef('');
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioGraphWarmupRef = useRef<Promise<void> | null>(null);
  const audioPrewarmStartedRef = useRef(false);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const levelIntervalRef = useRef<number | null>(null);
  const lastAudioLevelSentAtRef = useRef(0);
  const lastAudioBandsRef = useRef<number[]>([]);
  const recordingStartRef = useRef(0);
  const recordingIntentRef = useRef(false);
  const discardPendingRecordingRef = useRef(false);
  const startAttemptRef = useRef(0);
  const processingTimeoutRef = useRef<number | null>(null);
  const recorderStopTimeoutRef = useRef<number | null>(null);

  const updateAppState = (state: AppState) => {
    appStateRef.current = state;
  };

  // Bridge to the new global toast dispatcher. Kept as a thin wrapper so
  // the dozens of existing `showToast(...)` call sites in this file don't
  // need to change shape. Anyone outside this component can call
  // `toast.success(...) / toast.error(...)` directly from `useToast.ts`.
  const showToast = (message: string, type: ToastType = 'success') => {
    toastDispatch[type](message);
  };

  const applySettingsSnapshot = useCallback((nextSettings: SettingsType) => {
    settingsRef.current = nextSettings;
    setSettings(nextSettings);
  }, []);

  const refreshAudioInputDevices = useCallback(async () => {
    try {
      const mics = await enumerateAudioInputDevices();
      setDevices(mics);
    } catch (err) {
      console.error('Failed to enumerate devices:', err);
    }
  }, []);

  const handleUpdateSettings = useCallback(async (partial: Partial<SettingsType>) => {
    const previous = settingsRef.current;
    if (previous) {
      applySettingsSnapshot({ ...previous, ...partial });
    }

    try {
      const saved = await window.api.saveSettings(partial);
      applySettingsSnapshot(saved);
      return saved as SettingsType;
    } catch (error) {
      if (previous) {
        applySettingsSnapshot(previous);
      }
      // Surface the failure as a toast so the optimistic-update rollback
      // doesn't look like a no-op to the user. Callers that want to
      // present a more specific message (e.g. hotkey commit) catch this
      // and toast their own error before the rethrow propagates.
      toastDispatch.error('Could not save settings. Try again.');
      throw error;
    }
  }, [applySettingsSnapshot]);

  const warmSettingsView = useCallback(() => {
    void loadSettingsView().then(() => {
      setIsSettingsViewMounted(true);
    });
  }, []);

  const openPlansSettings = useCallback(() => {
    setBasicUsageLimitPrompt(null);
    setSettingsInitialCategory('Plans');
    warmSettingsView();
    startTransition(() => setIsSettingsOpen(true));
  }, [warmSettingsView]);

  useEffect(() => {
    if (!window.api) {
      showToast('Electron API not loaded. Preload failed or running in browser.', 'info');
      return;
    }

    const unsubError = window.api.onError((msg: string) => {
      if (processingTimeoutRef.current !== null) {
        window.clearTimeout(processingTimeoutRef.current);
        processingTimeoutRef.current = null;
      }
      if (recorderStopTimeoutRef.current !== null) {
        window.clearTimeout(recorderStopTimeoutRef.current);
        recorderStopTimeoutRef.current = null;
      }
      showToast(msg, 'error');
      updateAppState('error');
      setTimeout(() => {
        updateAppState('idle');
      }, APP_ERROR_RESET_MS);
    });

    const unsubBasicUsageLimit = window.api.onBasicUsageLimitReached((payload: BasicUsagePayload) => {
      if (processingTimeoutRef.current !== null) {
        window.clearTimeout(processingTimeoutRef.current);
        processingTimeoutRef.current = null;
      }
      if (recorderStopTimeoutRef.current !== null) {
        window.clearTimeout(recorderStopTimeoutRef.current);
        recorderStopTimeoutRef.current = null;
      }
      setBasicUsageLimitPrompt(payload);
      updateAppState('error');
      setTimeout(() => {
        updateAppState('idle');
      }, APP_ERROR_RESET_MS);
    });

    const clearProcessingTimeout = () => {
      if (processingTimeoutRef.current !== null) {
        window.clearTimeout(processingTimeoutRef.current);
        processingTimeoutRef.current = null;
      }
    };

    const clearRecorderStopTimeout = () => {
      if (recorderStopTimeoutRef.current !== null) {
        window.clearTimeout(recorderStopTimeoutRef.current);
        recorderStopTimeoutRef.current = null;
      }
    };

    const resetAudioLevelVisualization = () => {
      if (levelIntervalRef.current !== null) {
        window.clearInterval(levelIntervalRef.current);
        levelIntervalRef.current = null;
      }
      lastAudioLevelSentAtRef.current = 0;
      lastAudioBandsRef.current = [0];
      window.api.sendAudioLevel([0]);
    };

    const enterTransientErrorState = (message: string, resetMs = APP_ERROR_RESET_MS) => {
      showToast(message, 'error');
      updateAppState('error');
      window.setTimeout(() => {
        if (appStateRef.current === 'error') {
          updateAppState('idle');
        }
      }, resetMs);
    };

    const beginProcessingTimeout = () => {
      clearProcessingTimeout();
      processingTimeoutRef.current = window.setTimeout(() => {
        processingTimeoutRef.current = null;
        recordingIntentRef.current = false;
        void window.api.cancelRecordingStart?.();
        enterTransientErrorState('Transcription took too long. Please try again.');
      }, PROCESSING_TIMEOUT_MS);
    };

    const cancelCurrentDictation = (notifyMain = true) => {
      recordingIntentRef.current = false;
      discardPendingRecordingRef.current = true;
      startAttemptRef.current += 1;
      clearProcessingTimeout();
      clearRecorderStopTimeout();
      resetAudioLevelVisualization();

      if (recorderRef.current && recorderRef.current.state === 'recording') {
        try {
          recorderRef.current.requestData();
        } catch { }
        recorderRef.current.stop();
        recorderRef.current = null;
      }

      updateAppState('idle');

      if (notifyMain) {
        void window.api.cancelDictation?.();
      }
    };

    const teardownAudioGraph = async () => {
      try {
        sourceNodeRef.current?.disconnect();
      } catch { }

      try {
        analyserRef.current?.disconnect();
      } catch { }

      sourceNodeRef.current = null;
      analyserRef.current = null;

      if (audioContextRef.current) {
        await audioContextRef.current.close().catch(() => { });
        audioContextRef.current = null;
      }
    };

    const ensureAudioGraph = async (desiredDeviceId: string) => {
      if (streamRef.current && streamDeviceIdRef.current !== desiredDeviceId) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        streamDeviceIdRef.current = '';
        await teardownAudioGraph();
      }

      if (!streamRef.current) {
        const getStream = async () => {
          if (desiredDeviceId) {
            try {
              return await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: desiredDeviceId } } });
            } catch {
              return navigator.mediaDevices.getUserMedia({ audio: true });
            }
          }

          return navigator.mediaDevices.getUserMedia({ audio: true });
        };

        streamRef.current = await getStream();
        streamDeviceIdRef.current = desiredDeviceId;
      }

      if (!audioContextRef.current || !sourceNodeRef.current || !analyserRef.current) {
        const audioContext = new AudioContext();
        const source = audioContext.createMediaStreamSource(streamRef.current);
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.45;

        source.connect(analyser);

        audioContextRef.current = audioContext;
        sourceNodeRef.current = source;
        analyserRef.current = analyser;
      }

      if (audioContextRef.current.state === 'suspended') {
        await audioContextRef.current.resume().catch(() => { });
      }
    };

    const shouldPrewarmAudioGraph = async () => {
      const permissionsApi = (navigator as Navigator & {
        permissions?: {
          query?: (descriptor: PermissionDescriptor) => Promise<{ state: PermissionState }>;
        };
      }).permissions;

      if (permissionsApi?.query) {
        try {
          const permission = await permissionsApi.query({ name: 'microphone' as PermissionName });
          return permission.state === 'granted';
        } catch {
          // Fall back to device labels below.
        }
      }

      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        return devices.some((device) => device.kind === 'audioinput' && !!device.label);
      } catch {
        return false;
      }
    };

    const prewarmAudioGraph = async () => {
      if (audioPrewarmStartedRef.current) return;

      const canPrewarm = await shouldPrewarmAudioGraph();
      if (!canPrewarm) return;

      audioPrewarmStartedRef.current = true;

      try {
        const desiredDeviceId = settingsRef.current?.microphoneId ?? '';
        const warmupPromise = ensureAudioGraph(desiredDeviceId).finally(() => {
          if (audioGraphWarmupRef.current === warmupPromise) {
            audioGraphWarmupRef.current = null;
          }
        });
        audioGraphWarmupRef.current = warmupPromise;
        await warmupPromise;
      } catch (error) {
        audioPrewarmStartedRef.current = false;
        console.warn('Audio prewarm failed:', error);
      }
    };

    // Release mic + audio graph after a period of inactivity to avoid
    // holding the microphone indicator lit and draining battery. Every
    // recording activity resets the timer; next dictation will transparently
    // re-warm the graph.
    const IDLE_TEARDOWN_MS = 10 * 60 * 1000;
    let idleTeardownTimeoutId: number | null = null;
    const scheduleIdleTeardown = () => {
      if (idleTeardownTimeoutId !== null) {
        window.clearTimeout(idleTeardownTimeoutId);
      }
      idleTeardownTimeoutId = window.setTimeout(() => {
        idleTeardownTimeoutId = null;
        if (appStateRef.current === 'recording' || appStateRef.current === 'processing') {
          scheduleIdleTeardown();
          return;
        }
        try {
          streamRef.current?.getTracks().forEach((track) => track.stop());
          streamRef.current = null;
          streamDeviceIdRef.current = '';
          audioPrewarmStartedRef.current = false;
          void teardownAudioGraph();
        } catch (error) {
          console.warn('Idle audio graph teardown failed:', error);
        }
      }, IDLE_TEARDOWN_MS);
    };
    const handleActivityForIdleTimer = () => scheduleIdleTeardown();

    const onStart = async () => {
      if (appStateRef.current === 'recording') return;
      handleActivityForIdleTimer();
      clearProcessingTimeout();
      clearRecorderStopTimeout();
      recordingIntentRef.current = true;
      const startAttempt = ++startAttemptRef.current;

      try {
        const usage = await window.api.basicUsageGet();
        if (usage.exhausted && usage.tier !== 'pro') {
          recordingIntentRef.current = false;
          void window.api.cancelRecordingStart?.();
          setBasicUsageLimitPrompt(usage);
          updateAppState('idle');
          return;
        }
      } catch (error) {
        console.warn('Could not check Basic usage before recording:', error);
      }

      if (!recordingIntentRef.current || startAttempt !== startAttemptRef.current) {
        updateAppState('idle');
        return;
      }

      updateAppState('recording');

      try {
        const desiredDeviceId = settingsRef.current?.microphoneId ?? '';

        if (audioGraphWarmupRef.current) {
          await audioGraphWarmupRef.current;
        }
        await ensureAudioGraph(desiredDeviceId);

        if (!recordingIntentRef.current || startAttempt !== startAttemptRef.current) {
          updateAppState('idle');
          return;
        }

        const analyser = analyserRef.current!;
        recordingStartRef.current = Date.now();
        const stream = streamRef.current!;
        const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : 'audio/webm';
        const recorder = new MediaRecorder(stream, { mimeType });
        const chunks: BlobPart[] = [];
        discardPendingRecordingRef.current = false;

        const freqData = new Uint8Array(analyser.frequencyBinCount);
        const timeData = new Uint8Array(analyser.fftSize);
        const speechMetrics: SpeechMetrics = {
          frameCount: 0,
          speechFrames: 0,
          longestSpeechRunFrames: 0,
          peakBand: 0,
          averageBand: 0,
          peakRms: 0,
          averageRms: 0,
        };
        let totalBand = 0;
        let totalRms = 0;
        let currentSpeechRunFrames = 0;

        levelIntervalRef.current = window.setInterval(() => {
          if (audioContextRef.current?.state === 'suspended') {
            audioContextRef.current.resume().catch(() => { });
          }

          analyser.getByteFrequencyData(freqData);
          analyser.getByteTimeDomainData(timeData);

          const bands = Array(9).fill(0);
          const totalBins = analyser.frequencyBinCount;
          const voiceBins = Math.min(totalBins, 64);
          const binsPerBand = Math.max(1, Math.floor(voiceBins / 9));
          let maxSig = 0;
          let rmsTotal = 0;

          for (let i = 0; i < 9; i += 1) {
            let sum = 0;
            const start = i * binsPerBand;
            const end = Math.min(start + binsPerBand, voiceBins);
            for (let j = start; j < end; j += 1) {
              sum += freqData[j];
            }

            const avg = sum / (end - start);
            const floor = 16 + i * 0.8;
            const val = Math.max(0, avg - floor);
            const normalized = Math.min(1, val / 100);
            bands[i] = Math.pow(normalized, 1.2) * 1.6;
            if (bands[i] > maxSig) maxSig = bands[i];
          }

          for (let i = 0; i < timeData.length; i += 1) {
            const sample = (timeData[i] - 128) / 128;
            rmsTotal += sample * sample;
          }

          const rms = Math.sqrt(rmsTotal / timeData.length);
          const speechLike = maxSig >= 0.18 || rms >= 0.035;

          speechMetrics.frameCount += 1;
          totalBand += maxSig;
          totalRms += rms;
          speechMetrics.peakBand = Math.max(speechMetrics.peakBand, maxSig);
          speechMetrics.peakRms = Math.max(speechMetrics.peakRms, rms);

          if (speechLike) {
            speechMetrics.speechFrames += 1;
            currentSpeechRunFrames += 1;
            speechMetrics.longestSpeechRunFrames = Math.max(
              speechMetrics.longestSpeechRunFrames,
              currentSpeechRunFrames
            );
          } else {
            currentSpeechRunFrames = 0;
          }

          if (maxSig < 0.12) bands.fill(0);

          const now = performance.now();
          const previousBands = lastAudioBandsRef.current;
          const maxBandDelta = bands.reduce((delta, value, index) => {
            const previous = previousBands[index] ?? 0;
            return Math.max(delta, Math.abs(previous - value));
          }, 0);

          if (now - lastAudioLevelSentAtRef.current >= 33 || maxBandDelta >= 0.08) {
            window.api.sendAudioLevel(bands);
            lastAudioLevelSentAtRef.current = now;
            lastAudioBandsRef.current = bands.slice();
          }
        }, 33);

        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) {
            chunks.push(event.data);
          }
        };

        recorder.onstop = async () => {
          clearRecorderStopTimeout();
          if (discardPendingRecordingRef.current) {
            discardPendingRecordingRef.current = false;
            clearProcessingTimeout();
            void window.api.cancelRecordingStart?.();
            updateAppState('idle');
            return;
          }
          speechMetrics.averageBand = speechMetrics.frameCount > 0 ? totalBand / speechMetrics.frameCount : 0;
          speechMetrics.averageRms = speechMetrics.frameCount > 0 ? totalRms / speechMetrics.frameCount : 0;

          try {
            const recordedBuffer = await new Blob(chunks, { type: mimeType }).arrayBuffer();
            const decoded = await decodeRecordedAudioToMono(recordedBuffer);
            const downsampled = downsampleFloat32Buffer(
              decoded.samples,
              decoded.sampleRate,
              OFFLINE_SAMPLE_RATE
            );
            normalizeAudioForTranscription(downsampled);
            const audioBytes = new Uint8Array(downsampled.buffer, downsampled.byteOffset, downsampled.byteLength);
            const audioBuffer = new ArrayBuffer(audioBytes.byteLength);
            new Uint8Array(audioBuffer).set(audioBytes);
            const durationMs = Math.max(0, Date.now() - recordingStartRef.current);

            void window.api.transcribeAudio(audioBuffer, durationMs, speechMetrics).catch((error: unknown) => {
              console.error('Transcription IPC error:', error);
              clearProcessingTimeout();
              void window.api.cancelRecordingStart?.();
              enterTransientErrorState('Transcription failed. Please try again.');
            });
          } catch (error) {
            console.error('Audio decode error:', error);
            clearProcessingTimeout();
            void window.api.cancelRecordingStart?.();
            enterTransientErrorState('Failed to decode recorded audio.', 3000);
          }
        };

        // 250ms timeslice balances memory/CPU pressure for long dictations
        // with quick delivery of the first chunk on hotkey release.
        recorder.start(250);
        recorderRef.current = recorder;

        if (!recordingIntentRef.current || startAttempt !== startAttemptRef.current) {
          recorder.onstop = null;
          try {
            recorder.requestData();
          } catch { }
          recorder.stop();
          recorderRef.current = null;
          updateAppState('idle');
        }
      } catch (err) {
        console.error('Mic Access Error:', err);
        recordingIntentRef.current = false;
        clearProcessingTimeout();
        clearRecorderStopTimeout();
        void window.api.cancelRecordingStart?.();
        enterTransientErrorState('Microphone access failed.', 3000);
      }
    };

    const onStop = () => {
      handleActivityForIdleTimer();
      recordingIntentRef.current = false;
      startAttemptRef.current += 1;

      resetAudioLevelVisualization();

      if (recorderRef.current && recorderRef.current.state === 'recording') {
        try {
          recorderRef.current.requestData();
        } catch { }
        recorderRef.current.stop();
        recorderRef.current = null;
        clearRecorderStopTimeout();
        recorderStopTimeoutRef.current = window.setTimeout(() => {
          recorderStopTimeoutRef.current = null;
          clearProcessingTimeout();
          void window.api.cancelRecordingStart?.();
          enterTransientErrorState('Recording did not finish cleanly. Please try again.', 3000);
        }, RECORDER_STOP_TIMEOUT_MS);
        beginProcessingTimeout();
        updateAppState('processing');
        return;
      }

      clearProcessingTimeout();
      clearRecorderStopTimeout();
      recorderRef.current = null;
      updateAppState('idle');
      void window.api.cancelRecordingStart?.();
    };

    const handleManualStart = () => onStart();
    const handleManualStop = () => onStop();
    const handleCancelDictation = () => cancelCurrentDictation(false);

    // Note: the legacy `show-toast` CustomEvent is bridged into the new
    // `echo:toast` channel inside `ToastHost.tsx` itself. We deliberately
    // do NOT listen for it here — having a second bridge caused every
    // `show-toast` dispatch (e.g. Dashboard's "Entry updated") to be
    // enqueued twice.
    window.addEventListener('manual-start-recording', handleManualStart);
    window.addEventListener('manual-stop-recording', handleManualStop);

    const unsubStart = window.api.onStartRecording(onStart);
    const unsubStop = window.api.onStopRecording(onStop);
    const unsubCancel = window.api.onCancelDictation(handleCancelDictation);
    const unsubResult = window.api.onTranscriptionResult(() => {
      clearProcessingTimeout();
      clearRecorderStopTimeout();
      updateAppState('idle');
    });
    const unsubNavigate = window.api.onNavigateTab((tab: AppTab) => {
      if (tab === 'settings') {
        setSettingsInitialCategory(null);
        startTransition(() => setIsSettingsOpen(true));
      } else {
        setActiveTab(tab);
        setIsSettingsOpen(false);
      }
      window.focus();
    });

    const audioPrewarmTimeoutId = window.setTimeout(() => {
      void prewarmAudioGraph();
    }, 8000);

    let micTestSuspendedPrewarm = false;

    const onMicTestActive = (event: Event) => {
      const active = (event as CustomEvent<{ active: boolean }>).detail?.active;
      if (active) {
        if (appStateRef.current === 'recording' || appStateRef.current === 'processing') {
          return;
        }
        micTestSuspendedPrewarm = true;
        resetAudioLevelVisualization();
        streamRef.current?.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        streamDeviceIdRef.current = '';
        audioGraphWarmupRef.current = null;
        audioPrewarmStartedRef.current = false;
        void teardownAudioGraph();
        return;
      }

      if (!micTestSuspendedPrewarm) return;
      micTestSuspendedPrewarm = false;
      audioPrewarmStartedRef.current = false;
      void prewarmAudioGraph();
      scheduleIdleTeardown();
    };

    window.addEventListener(MIC_TEST_ACTIVE_EVENT, onMicTestActive);

    // `scheduleIdleTeardown` / `handleActivityForIdleTimer` are declared
    // earlier in this effect (above `onStart`) so the hotkey handlers can
    // reference them via closure.
    scheduleIdleTeardown();

    return () => {
      unsubError();
      unsubBasicUsageLimit();
      unsubStart();
      unsubStop();
      unsubCancel();
      unsubResult();
      unsubNavigate();
      window.removeEventListener('manual-start-recording', handleManualStart);
      window.removeEventListener('manual-stop-recording', handleManualStop);
      window.removeEventListener(MIC_TEST_ACTIVE_EVENT, onMicTestActive);
      if (levelIntervalRef.current !== null) {
        window.clearInterval(levelIntervalRef.current);
        levelIntervalRef.current = null;
      }
      clearProcessingTimeout();
      clearRecorderStopTimeout();
      recorderRef.current = null;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      streamDeviceIdRef.current = '';
      window.clearTimeout(audioPrewarmTimeoutId);
      if (idleTeardownTimeoutId !== null) {
        window.clearTimeout(idleTeardownTimeoutId);
        idleTeardownTimeoutId = null;
      }
      void teardownAudioGraph();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    void window.api.updateGetStatus().then((status) => {
      if (!cancelled) setStartupUpdateStatus(status);
    }).catch((error) => {
      console.error('Failed to load startup update status:', error);
    });

    const unsubscribe = window.api.onUpdateStatus((status) => {
      setStartupUpdateStatus(status);
      if (status.state !== 'available' && status.state !== 'ready') {
        setIsStartupUpdateActionPending(false);
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const handleStartupUpdateAction = useCallback(async (action: 'download' | 'install') => {
    setIsStartupUpdateActionPending(true);
    try {
      if (action === 'download') {
        await window.api.updateDownload();
      } else {
        await window.api.updateInstall();
      }
      if (action === 'download') {
        setIsStartupUpdateDismissed(true);
      }
    } catch (error) {
      console.error('Startup update action failed:', error);
      toastDispatch.error('Could not start the update. Try again from Settings.');
      setIsStartupUpdateActionPending(false);
    }
  }, []);

  useEffect(() => {
    const loadInitialData = async () => {
      const s = await window.api.getSettings() as SettingsType;
      applySettingsSnapshot(s);
      // Hand off from the branded splash to the app on the next frame so the
      // first real paint of the UI is already in place when the splash fades.
      requestAnimationFrame(() => {
        (window as { __dismissEchoSplash?: () => void }).__dismissEchoSplash?.();
      });
    };

    void loadInitialData();
  }, [applySettingsSnapshot]);

  useEffect(() => {
    let cancelled = false;

    void window.api
      .authGetSession()
      .then((session) => {
        if (!cancelled) setAuthSession(session);
      })
      .catch(() => undefined);

    void window.api
      .entitlementsGet()
      .then((next) => {
        if (!cancelled) setEntitlements(next);
      })
      .catch(() => undefined);

    const offAuth = window.api.onAuthState((session) => setAuthSession(session));
    const offEntitlements = window.api.onEntitlementsChanged((next) => setEntitlements(next));

    return () => {
      cancelled = true;
      offAuth();
      offEntitlements();
    };
  }, []);

  useEffect(() => {
    const handleDeviceChange = () => {
      void refreshAudioInputDevices();
      void window.api.refreshTrayMenu().catch(() => undefined);
    };

    void refreshAudioInputDevices();
    navigator.mediaDevices.addEventListener('devicechange', handleDeviceChange);
    return () => navigator.mediaDevices.removeEventListener('devicechange', handleDeviceChange);
  }, [refreshAudioInputDevices]);

  const handleTabClick = useCallback((tab: AppTab) => {
    if (tab === 'settings') {
      setSettingsInitialCategory(null);
      warmSettingsView();
      void refreshAudioInputDevices();
      startTransition(() => setIsSettingsOpen(prev => !prev));
    } else {
      if (tab === 'history') void loadHistoryView();
      if (tab === 'snippets') void loadSnippetsView();
      if (tab === 'style') void loadStyleView();
      setActiveTab(tab);
      setIsSettingsOpen(false);
    }
  }, [refreshAudioInputDevices, warmSettingsView]);

  const openSettings = useCallback((category: string | null = null) => {
    setSettingsInitialCategory(category);
    warmSettingsView();
    void refreshAudioInputDevices();
    startTransition(() => setIsSettingsOpen(true));
  }, [refreshAudioInputDevices, warmSettingsView]);

  useEffect(() => {
    // Warm the Settings chunk on idle so opening Settings later doesn't
    // combine lazy-import work with the modal animation.
    const idleWindow = window as IdleWindow;
    const ric = idleWindow.requestIdleCallback;
    if (ric) {
      const id = ric(() => warmSettingsView());
      return () => {
        idleWindow.cancelIdleCallback?.(id);
      };
    }
    const timeoutId = window.setTimeout(() => warmSettingsView(), 250);
    return () => window.clearTimeout(timeoutId);
  }, [warmSettingsView]);

  const navItems: Array<{ id: AppTab; label: string; icon: LucideIcon }> = [
    { id: 'dashboard', label: 'Home', icon: Home },
    { id: 'history', label: 'Dictionary', icon: BookOpen },
    { id: 'snippets', label: 'Shortcuts', icon: Pencil },
    { id: 'style', label: 'Style', icon: Type },
    { id: 'notepad', label: 'Notepad', icon: FileText },
  ];
  const sidebarDisplayName = (() => {
    if (!authSession) return 'Echo User';
    const candidate = (authSession.displayName || authSession.email.split('@')[0] || '').trim();
    return candidate || 'Echo User';
  })();
  const sidebarInitial = sidebarDisplayName.charAt(0).toUpperCase() || 'E';
  const sidebarPlanLabel = (() => {
    if (entitlements?.tier === 'pro') return 'Pro plan';
    if (entitlements?.tier === 'free') return 'Basic plan';
    return 'Basic plan';
  })();
  const shouldShowStartupUpdatePrompt = !!(
    startupUpdateStatus &&
    !isStartupUpdateDismissed &&
    ['available', 'downloading', 'ready'].includes(startupUpdateStatus.state)
  );

  return (
    <div className="h-screen overflow-hidden text-foreground" style={{ background: 'hsl(var(--app-bg))' }}>
      {/* Pre-warms framer-motion at boot so the first modal open animates
          smoothly instead of skipping its spring on cold JIT. */}
      <MotionWarmup />

      {/* Titlebar drag region — only covers the area above the main panel so it
          doesn't intercept hover/click on the sidebar toggle */}
      <motion.div
        className="titlebar absolute top-0 right-0 z-50 flex h-10 items-center justify-end pr-2"
        initial={false}
        animate={{ left: isSidebarCompact ? SIDEBAR_COMPACT_WIDTH : SIDEBAR_EXPANDED_WIDTH }}
        transition={SIDEBAR_SPRING}
        style={{ willChange: 'left' }}
      >
        <div className="no-drag flex items-center">
          <button
            type="button"
            onClick={() => window.api.windowMinimize()}
            aria-label="Minimize window"
            className="flex h-10 w-11 items-center justify-center rounded-lg text-foreground/58 transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
          >
            <Minus size={17} />
          </button>
          <button
            type="button"
            onClick={() => window.api.windowToggleMaximize()}
            aria-label="Maximize window"
            className="flex h-10 w-11 items-center justify-center rounded-lg text-foreground/58 transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
          >
            <Square size={15} />
          </button>
          <button
            type="button"
            onClick={() => window.api.windowClose()}
            aria-label="Close window"
            className="flex h-10 w-11 items-center justify-center rounded-lg text-foreground/58 transition-colors hover:bg-destructive/10 hover:text-destructive"
          >
            <X size={17} />
          </button>
        </div>
      </motion.div>

      <div className="relative z-[1] flex h-full gap-0 px-2 pb-2">
        {/* ── Sidebar ── */}
        <motion.div
          className="relative shrink-0 overflow-hidden"
          initial={false}
          animate={{ width: isSidebarCompact ? SIDEBAR_COMPACT_WIDTH : SIDEBAR_EXPANDED_WIDTH }}
          transition={SIDEBAR_SPRING}
          style={{ willChange: 'width' }}
        >
          <aside className="relative z-10 flex h-full w-full flex-col px-2.5 pb-2.5 pt-2">
            {/* Toggle row */}
            <div className="no-drag relative z-[60] mb-2">
              <button
                type="button"
                onClick={() => setIsSidebarCompact((current) => !current)}
                aria-label={isSidebarCompact ? 'Expand sidebar' : 'Collapse sidebar'}
                title={isSidebarCompact ? 'Expand sidebar' : 'Collapse sidebar'}
                className="flex h-10 w-10 items-center justify-center rounded-xl text-foreground/70 transition-[background-color,color,transform] duration-150 hover:bg-white hover:text-foreground active:scale-[0.96] focus:outline-none focus-visible:outline-none"
              >
                <motion.span
                  className="flex"
                  initial={false}
                  animate={{ rotate: isSidebarCompact ? 180 : 0 }}
                  transition={SIDEBAR_CONTENT_FADE}
                >
                  <PanelLeft size={18} strokeWidth={2} />
                </motion.span>
              </button>
            </div>

            <div className="mb-3 flex h-12 items-center">
              <motion.span
                className="echo-wordmark"
                initial={false}
                animate={{
                  maxWidth: isSidebarCompact ? 0 : 160,
                  opacity: isSidebarCompact ? 0 : 1,
                  x: isSidebarCompact ? -8 : 0,
                }}
                transition={SIDEBAR_CONTENT_FADE}
                style={{ willChange: 'max-width, opacity, transform', overflow: 'hidden' }}
              >
                <span className="dot" aria-hidden="true" />
                Echo
              </motion.span>
            </div>

            {/* Navigation */}
            <nav className="flex-1 space-y-1">
              {navItems.map((item) => {
                const isActive = activeTab === item.id && !isSettingsOpen;
                return (
                  <button
                    type="button"
                    key={item.id}
                    onClick={() => handleTabClick(item.id)}
                    aria-label={item.label}
                    title={isSidebarCompact ? item.label : undefined}
                    className={`echo-nav-item ${isActive ? 'active' : ''}`}
                    style={{ overflow: 'hidden' }}
                  >
                    <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                      <SidebarIcon icon={item.icon} />
                    </span>
                    <motion.span
                      className="block overflow-hidden whitespace-nowrap"
                      initial={false}
                      animate={{
                        maxWidth: isSidebarCompact ? 0 : 150,
                        opacity: isSidebarCompact ? 0 : 1,
                        x: isSidebarCompact ? -6 : 0,
                      }}
                      transition={SIDEBAR_CONTENT_FADE}
                      style={{ willChange: 'max-width, opacity, transform' }}
                    >
                      {item.label}
                    </motion.span>
                  </button>
                );
              })}
            </nav>

            {/* Account/settings — pinned to bottom, matches the bundle's
                user-chip cream pill when expanded; collapses to a single
                avatar+cog tap target when the sidebar is compact. */}
            <div className="mt-3 w-full shrink-0">
              {!isSidebarCompact ? (
                <motion.div
                  key="sidebar-account-summary"
                  className="echo-user-chip"
                  style={{ width: '100%' }}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={SIDEBAR_CONTENT_FADE}
                >
                  <div className="name">{sidebarDisplayName}</div>
                  <div className="row">
                    <span className="avatar">
                      {authSession?.profilePictureDataUrl ? (
                        <img
                          src={authSession.profilePictureDataUrl}
                          alt=""
                          draggable={false}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        sidebarInitial
                      )}
                    </span>
                    <button
                      type="button"
                      className="plan-pill"
                      onMouseEnter={warmSettingsView}
                      onFocus={warmSettingsView}
                      onClick={() => openPlansSettings()}
                      aria-label="Manage your plan"
                      title="Manage your plan"
                    >
                      {sidebarPlanLabel}
                    </button>
                    <button
                      type="button"
                      className="theme-toggle"
                      onMouseEnter={warmSettingsView}
                      onFocus={warmSettingsView}
                      onClick={() => openSettings()}
                      aria-label="Open settings"
                      title="Open settings"
                    >
                      <SettingsIcon size={15} strokeWidth={1.9} />
                    </button>
                  </div>
                </motion.div>
              ) : (
                <button
                  type="button"
                  onMouseEnter={warmSettingsView}
                  onFocus={warmSettingsView}
                  onClick={() => openSettings()}
                  aria-label="Open settings"
                  title={`${sidebarDisplayName} · ${sidebarPlanLabel}`}
                  className="flex h-10 w-10 items-center justify-center rounded-xl"
                  style={{ color: 'var(--ink-soft)' }}
                >
                  <SettingsIcon size={18} strokeWidth={2} />
                </button>
              )}
            </div>

          </aside>
        </motion.div>

        {/* ── Main Panel ── */}
        <div className="flex min-w-0 flex-1 flex-col pt-10 pr-0">
        <main className="relative z-10 flex min-w-0 flex-1 flex-col overflow-hidden rounded-[24px] border border-border bg-popover shadow-[0_18px_60px_-44px_rgba(15,23,42,0.42)]">
          <div className="relative min-h-0 flex-1 overflow-hidden">
            <div className="absolute inset-0">
              {activeTab === 'dashboard' && <DashboardView settings={settings} />}
              <Suspense fallback={<MainPanelSkeleton />}>
                {activeTab === 'history' && <HistoryView />}
                {activeTab === 'snippets' && <SnippetsView />}
                {activeTab === 'style' && <StyleView />}
                {activeTab === 'notepad' && <NotepadView />}
              </Suspense>
            </div>
          </div>
        </main>
        </div>

        {/* Settings modal */}
        <Suspense fallback={null}>
          {isSettingsViewMounted && (
            <SettingsView
              key="settings-view"
              isOpen={isSettingsOpen}
              initialCategory={settingsInitialCategory}
              onClose={() => {
                setIsSettingsOpen(false);
                setSettingsInitialCategory(null);
              }}
              settings={settings}
              devices={devices}
              onRefreshDevices={refreshAudioInputDevices}
              onUpdateSettings={handleUpdateSettings}
            />
          )}
        </Suspense>

        {/* Onboarding */}
        <AnimatePresence initial={false}>
          {settings && !settings.onboardingComplete && (
            <Onboarding
              key="onboarding"
              settings={settings}
              devices={devices}
              onComplete={(updates) => handleUpdateSettings(updates)}
            />
          )}
        </AnimatePresence>

        {/* Toast host — stack of bottom-right notifications. Listens for
            both the new `echo:toast` channel and the legacy `show-toast`
            CustomEvent that several components still dispatch. */}
        <ToastHost />
      </div>

      <AnimatePresence initial={false}>
        {shouldShowStartupUpdatePrompt && startupUpdateStatus ? (
          <StartupUpdatePrompt
            key="startup-update-prompt"
            status={startupUpdateStatus}
            pending={isStartupUpdateActionPending}
            onDismiss={() => setIsStartupUpdateDismissed(true)}
            onAction={handleStartupUpdateAction}
          />
        ) : null}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {basicUsageLimitPrompt ? (
          <BasicUsageLimitPrompt
            key="basic-usage-prompt"
            payload={basicUsageLimitPrompt}
            onDismiss={() => setBasicUsageLimitPrompt(null)}
            onUpgrade={openPlansSettings}
          />
        ) : null}
      </AnimatePresence>

    </div>
  );
}
