import { useState, useEffect, useRef, useCallback, Suspense, lazy, startTransition } from 'react';
import { motion } from 'framer-motion';
import {
  Minus,
  Square,
  X,
  Home,
  BookOpen,
  Scissors,
  Type,
  BarChart3,
  Settings as SettingsIcon,
  AudioLines,
  PanelLeft,
  type LucideIcon,
} from 'lucide-react';
import Toast, { type ToastType } from './components/Toast';
import { AppState, AppTab, SpeechMetrics, Settings as SettingsType } from '../shared/types';
import {
  DEFAULT_PUSH_TO_TALK_HOTKEY,
  DEFAULT_TOGGLE_HOTKEY,
  formatHotkeyLabel,
} from '../shared/hotkey';
import DashboardView from './components/Dashboard';
import Onboarding from './components/Onboarding';

let settingsViewImportPromise: Promise<typeof import('./components/Settings')> | null = null;
let historyViewImportPromise: Promise<typeof import('./components/History')> | null = null;
let snippetsViewImportPromise: Promise<typeof import('./components/Snippets')> | null = null;
let styleViewImportPromise: Promise<typeof import('./components/Style')> | null = null;
let insightsViewImportPromise: Promise<typeof import('./components/Insights')> | null = null;

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

function loadInsightsView() {
  if (!insightsViewImportPromise) {
    insightsViewImportPromise = import('./components/Insights');
  }

  return insightsViewImportPromise;
}

const SettingsView = lazy(loadSettingsView);
const HistoryView = lazy(loadHistoryView);
const SnippetsView = lazy(loadSnippetsView);
const StyleView = lazy(loadStyleView);
const InsightsView = lazy(loadInsightsView);

function SidebarIcon({ icon: Icon, active }: { icon: LucideIcon; active: boolean }) {
  return (
    <span className="flex h-7 w-7 items-center justify-center">
      <Icon
        size={20}
        strokeWidth={2}
        className="text-black"
      />
    </span>
  );
}

function MainPanelSkeleton() {
  return <div className="h-full w-full bg-background" />;
}

const OFFLINE_SAMPLE_RATE = 16000;
const APP_ERROR_RESET_MS = 4_000;
const RECORDER_STOP_TIMEOUT_MS = 4_000;
const PROCESSING_TIMEOUT_MS = 30_000;

function mergeFloat32Chunks(chunks: Float32Array[]): Float32Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Float32Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  return merged;
}

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
  const [toast, setToast] = useState<{ message: string; type: ToastType } | null>(null);
  const [appState, setAppState] = useState<AppState>('idle');
  const [activeTab, setActiveTab] = useState<AppTab>('dashboard');
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isSettingsViewMounted, setIsSettingsViewMounted] = useState(false);
  const [isSidebarCompact, setIsSidebarCompact] = useState(false);
  const [settings, setSettings] = useState<SettingsType | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [shortcutLabels, setShortcutLabels] = useState({
    toggle: formatHotkeyLabel(DEFAULT_TOGGLE_HOTKEY),
    pushToTalk: formatHotkeyLabel(DEFAULT_PUSH_TO_TALK_HOTKEY),
  });
  const appStateRef = useRef<AppState>('idle');
  const settingsRef = useRef<SettingsType | null>(null);
  const devicesLoadedRef = useRef(false);
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
  const [isMaximized, setIsMaximized] = useState(false);

  const updateAppState = (state: AppState) => {
    appStateRef.current = state;
    setAppState(state);
  };

  const showToast = (message: string, type: ToastType = 'success') => {
    setToast({ message, type });
  };

  const applySettingsSnapshot = useCallback((nextSettings: SettingsType) => {
    settingsRef.current = nextSettings;
    setSettings(nextSettings);
    setShortcutLabels({
      toggle: formatHotkeyLabel(nextSettings.toggleHotkey ?? [DEFAULT_TOGGLE_HOTKEY]),
      pushToTalk: formatHotkeyLabel(nextSettings.pushToTalkHotkey ?? [DEFAULT_PUSH_TO_TALK_HOTKEY]),
    });
  }, []);

  const ensureDevicesLoaded = useCallback(async () => {
    if (devicesLoadedRef.current) return;

    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const mics = all.filter((device) => device.kind === 'audioinput');
      devicesLoadedRef.current = true;
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
      const saved = await (window as any).api.saveSettings(partial);
      applySettingsSnapshot(saved);
      return saved as SettingsType;
    } catch (error) {
      if (previous) {
        applySettingsSnapshot(previous);
      }
      throw error;
    }
  }, [applySettingsSnapshot]);

  const warmSettingsView = useCallback(() => {
    void loadSettingsView().then(() => {
      setIsSettingsViewMounted(true);
    });
  }, []);

  useEffect(() => {
    if (!(window as any).api) {
      showToast('Electron API not loaded. Preload failed or running in browser.', 'info');
      return;
    }

    const unsubError = (window as any).api.onError((msg: string) => {
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
      (window as any).api.sendAudioLevel([0]);
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
        void (window as any).api.cancelRecordingStart?.();
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
        void (window as any).api.cancelDictation?.();
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
            (window as any).api.sendAudioLevel(bands);
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
            void (window as any).api.cancelRecordingStart?.();
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
            const audioBuffer = downsampled.buffer;
            const durationMs = Math.max(0, Date.now() - recordingStartRef.current);

            void (window as any).api.transcribeAudio(audioBuffer, durationMs, speechMetrics).catch((error: unknown) => {
              console.error('Transcription IPC error:', error);
              clearProcessingTimeout();
              void (window as any).api.cancelRecordingStart?.();
              enterTransientErrorState('Transcription failed. Please try again.');
            });
          } catch (error) {
            console.error('Audio decode error:', error);
            clearProcessingTimeout();
            void (window as any).api.cancelRecordingStart?.();
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
        void (window as any).api.cancelRecordingStart?.();
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
          void (window as any).api.cancelRecordingStart?.();
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
      void (window as any).api.cancelRecordingStart?.();
    };

    const handleManualStart = () => onStart();
    const handleManualStop = () => onStop();
    const handleCancelDictation = () => cancelCurrentDictation(false);
    const handleShowToast = (e: any) => {
      showToast(e.detail.message, e.detail.type);
    };

    window.addEventListener('manual-start-recording', handleManualStart);
    window.addEventListener('manual-stop-recording', handleManualStop);
    window.addEventListener('show-toast', handleShowToast);

    const unsubStart = (window as any).api.onStartRecording(onStart);
    const unsubStop = (window as any).api.onStopRecording(onStop);
    const unsubCancel = (window as any).api.onCancelDictation(handleCancelDictation);
    const unsubResult = (window as any).api.onTranscriptionResult(() => {
      clearProcessingTimeout();
      clearRecorderStopTimeout();
      updateAppState('idle');
    });
    const unsubNavigate = (window as any).api.onNavigateTab((tab: AppTab) => {
      if (tab === 'settings') {
        startTransition(() => setIsSettingsOpen(true));
      } else {
        setActiveTab(tab);
        setIsSettingsOpen(false);
      }
      window.focus();
    });

    // Auto-update breadcrumb. The main process only fires `update-ready`
    // once a downloaded update is staged for install on next quit, so we
    // surface it as an info toast and rely on the existing tray "Quit
    // Echo" entry to apply it.
    const unsubUpdateReady = (window as any).api.onUpdateReady?.(() => {
      showToast('Update downloaded — restart Echo to install.', 'info');
    });

    const audioPrewarmTimeoutId = window.setTimeout(() => {
      void prewarmAudioGraph();
    }, 8000);

    // `scheduleIdleTeardown` / `handleActivityForIdleTimer` are declared
    // earlier in this effect (above `onStart`) so the hotkey handlers can
    // reference them via closure.
    scheduleIdleTeardown();

    return () => {
      unsubError();
      unsubStart();
      unsubStop();
      unsubCancel();
      unsubResult();
      unsubNavigate();
      unsubUpdateReady?.();
      window.removeEventListener('manual-start-recording', handleManualStart);
      window.removeEventListener('manual-stop-recording', handleManualStop);
      window.removeEventListener('show-toast', handleShowToast);
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
    const loadInitialData = async () => {
      const s = await (window as any).api.getSettings() as SettingsType;
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
    const handleDeviceChange = () => {
      devicesLoadedRef.current = false;
      void ensureDevicesLoaded();
    };

    navigator.mediaDevices.addEventListener('devicechange', handleDeviceChange);
    return () => navigator.mediaDevices.removeEventListener('devicechange', handleDeviceChange);
  }, [ensureDevicesLoaded]);

  const handleTabClick = useCallback((tab: AppTab) => {
    if (tab === 'settings') {
      warmSettingsView();
      void ensureDevicesLoaded();
      startTransition(() => setIsSettingsOpen(prev => !prev));
    } else {
      if (tab === 'history') void loadHistoryView();
      if (tab === 'snippets') void loadSnippetsView();
      if (tab === 'style') void loadStyleView();
      if (tab === 'insights') void loadInsightsView();
      setActiveTab(tab);
      setIsSettingsOpen(false);
    }
  }, [ensureDevicesLoaded, warmSettingsView]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      warmSettingsView();
    }, 5000);

    return () => window.clearTimeout(timeoutId);
  }, [warmSettingsView]);

  const navItems: Array<{ id: AppTab; label: string; icon: LucideIcon }> = [
    { id: 'dashboard', label: 'Home', icon: Home },
    { id: 'history', label: 'Dictionary', icon: BookOpen },
    { id: 'snippets', label: 'Snippets', icon: Scissors },
    { id: 'style', label: 'Style', icon: Type },
    { id: 'insights', label: 'Insights', icon: BarChart3 },
  ];

  return (
    <div className="h-screen overflow-hidden text-foreground" style={{ background: 'hsl(var(--app-bg))' }}>

      {/* Titlebar drag region — only covers the area above the main panel so it
          doesn't intercept hover/click on the sidebar toggle */}
      <div
        className="titlebar absolute top-0 right-0 z-50 flex h-10 items-center justify-end pr-2"
        style={{ left: isSidebarCompact ? 52 : 220 }}
      >
        <div className="no-drag flex items-center">
          <button
            type="button"
            onClick={() => (window as any).api.windowMinimize()}
            aria-label="Minimize window"
            className="flex h-10 w-11 items-center justify-center rounded-md text-foreground/65 transition-colors hover:bg-black/5 hover:text-foreground"
          >
            <Minus size={17} />
          </button>
          <button
            type="button"
            onClick={() => (window as any).api.windowToggleMaximize()}
            aria-label="Maximize window"
            className="flex h-10 w-11 items-center justify-center rounded-md text-foreground/65 transition-colors hover:bg-black/5 hover:text-foreground"
          >
            <Square size={15} />
          </button>
          <button
            type="button"
            onClick={() => (window as any).api.windowClose()}
            aria-label="Close window"
            className="flex h-10 w-11 items-center justify-center rounded-md text-foreground/65 transition-colors hover:bg-destructive/10 hover:text-destructive"
          >
            <X size={17} />
          </button>
        </div>
      </div>

      <div className="relative z-[1] flex h-full gap-0 px-1.5 pb-1.5">
        {/* ── Sidebar ── */}
        <motion.div
          className="relative shrink-0 overflow-hidden"
          animate={{ width: isSidebarCompact ? 52 : 220 }}
          transition={{ type: 'spring', stiffness: 520, damping: 42, mass: 0.9 }}
        >
          <aside className="relative z-10 flex h-full w-full flex-col px-2 pb-2 pt-2">
            {/* Toggle row */}
            <div className="no-drag relative z-[60] mb-2">
              <button
                type="button"
                onClick={() => setIsSidebarCompact((current) => !current)}
                aria-label={isSidebarCompact ? 'Expand sidebar' : 'Collapse sidebar'}
                title={isSidebarCompact ? 'Expand sidebar' : 'Collapse sidebar'}
                className="flex h-9 w-9 items-center justify-center rounded-md text-foreground transition-[background-color,transform] duration-150 hover:bg-black/[0.04] active:scale-[0.96] focus:outline-none focus-visible:outline-none focus-visible:ring-0"
              >
                <PanelLeft size={18} strokeWidth={2} />
              </button>
            </div>

            {/* Brand row */}
            <div className="mb-4 flex h-9 items-center">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center text-foreground">
                <AudioLines size={20} strokeWidth={2.2} />
              </span>
              <motion.span
                className="ml-1 whitespace-nowrap text-[24px] font-semibold leading-none tracking-tight text-foreground"
                style={{ fontFamily: '"Figtree", "Aptos", "Segoe UI Variable Text", "Segoe UI", sans-serif' }}
                animate={{ opacity: isSidebarCompact ? 0 : 1, width: isSidebarCompact ? 0 : 'auto' }}
                transition={{ type: 'spring', stiffness: 520, damping: 44, mass: 0.8 }}
              >
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
                    className={`flex h-9 ${isSidebarCompact ? 'w-9' : 'w-full'} items-center overflow-hidden rounded-md text-left text-[14.5px] font-semibold text-foreground transition-colors duration-150 hover:bg-black/[0.04] ${isActive ? 'bg-black/[0.05]' : ''}`}
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center">
                      <SidebarIcon icon={item.icon} active={isActive} />
                    </span>
                    <motion.span
                      className="ml-0.5 whitespace-nowrap"
                      animate={{ opacity: isSidebarCompact ? 0 : 1, width: isSidebarCompact ? 0 : 'auto' }}
                      transition={{ type: 'spring', stiffness: 520, damping: 44, mass: 0.8 }}
                    >
                      {item.label}
                    </motion.span>
                  </button>
                );
              })}
            </nav>

            {/* Subtle separator between primary nav and the Settings entry. */}
            <div className="mx-3 my-2 h-px bg-black/[0.035]" />

            {/* Settings — pinned to bottom */}
            <div>
              <button
                type="button"
                onMouseEnter={warmSettingsView}
                onFocus={warmSettingsView}
                onClick={() => {
                  warmSettingsView();
                  void ensureDevicesLoaded();
                  startTransition(() => setIsSettingsOpen(true));
                }}
                aria-label="Settings"
                title={isSidebarCompact ? 'Settings' : undefined}
                className={`flex h-9 ${isSidebarCompact ? 'w-9' : 'w-full'} items-center overflow-hidden rounded-md text-left text-[14.5px] font-semibold text-foreground transition-colors duration-150 hover:bg-black/[0.04] focus:outline-none focus-visible:outline-none focus-visible:ring-0`}
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center">
                  <SidebarIcon icon={SettingsIcon} active={false} />
                </span>
                <motion.span
                  className="ml-1 whitespace-nowrap"
                  animate={{ opacity: isSidebarCompact ? 0 : 1, width: isSidebarCompact ? 0 : 'auto' }}
                  transition={{ type: 'spring', stiffness: 520, damping: 44, mass: 0.8 }}
                >
                  Settings
                </motion.span>
              </button>
            </div>

          </aside>
        </motion.div>

        {/* ── Main Panel ── */}
        <div className="flex min-w-0 flex-1 flex-col pt-10 pr-1.5 pb-1.5">
        <main className="relative z-10 flex min-w-0 flex-1 flex-col overflow-hidden rounded-[28px] border border-black/[0.09] bg-background">
          <div className="relative min-h-0 flex-1 overflow-hidden">
            <div className="absolute inset-0">
              {activeTab === 'dashboard' && <DashboardView settings={settings} onUpdateSettings={handleUpdateSettings} />}
              <Suspense fallback={<MainPanelSkeleton />}>
                {activeTab === 'history' && <HistoryView />}
                {activeTab === 'snippets' && <SnippetsView />}
                {activeTab === 'style' && <StyleView />}
                {activeTab === 'insights' && <InsightsView />}
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
              onClose={() => setIsSettingsOpen(false)}
              settings={settings}
              devices={devices}
              onUpdateSettings={handleUpdateSettings}
            />
          )}
        </Suspense>

        {/* Onboarding */}
        {settings && !settings.onboardingComplete && (
          <Onboarding
            settings={settings}
            devices={devices}
            onComplete={(updates) => handleUpdateSettings(updates)}
          />
        )}

        {/* Toast */}
        {toast && (
          <Toast
            message={toast.message}
            type={toast.type}
            onClose={() => setToast(null)}
          />
        )}
      </div>

      {/* CSS transition prewarm — forces the compositor to JIT-compile the
          opacity/transform path for .dialog-panel before the user ever opens
          a modal, eliminating cold-start lag on first app launch. */}
      <div aria-hidden="true" className="pointer-events-none fixed" style={{ top: -9999, left: -9999 }}>
        <div className="dialog-panel dialog-panel-default" style={{ opacity: 0, width: 1, height: 1 }} />
        <div className="dialog-panel dialog-panel-pop" style={{ opacity: 0, width: 1, height: 1 }} />
      </div>
    </div>
  );
}
