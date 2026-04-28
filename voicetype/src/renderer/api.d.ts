// ---- Preload bridge types -------------------------------------------------
// Mirrors the shape exposed by `src/main/preload.ts` so the renderer no
// longer has to reach through `(window as any).api`. Signatures here should
// track what `contextBridge.exposeInMainWorld('api', ...)` publishes.
import type {
  AppState,
  AppTab,
  DictationEntry,
  DictionaryItem,
  DictionaryItemInput,
  Settings,
  Snippet,
  SnippetInput,
  SpeechMetrics,
} from '../shared/types';

type DashboardData = {
  stats: { totalWords: number; totalSessions: number; todayWords: number; avgSessionMs: number };
  history: DictationEntry[];
};

type ModelDownloadProgress = {
  percent: number;
  bytesReceived: number;
  bytesTotal: number;
};

export interface EchoApi {
  getInitialTheme: () => 'light' | 'dark';
  getSettings: () => Promise<Settings>;
  saveSettings: (patch: Partial<Settings>) => Promise<Settings>;
  suspendHotkey: () => Promise<void>;
  cancelRecordingStart: () => Promise<void>;
  cancelDictation: () => Promise<void>;
  resumeHotkey: () => Promise<Settings>;
  getDashboardData: (limit?: number, offset?: number) => Promise<DashboardData>;
  getHistory: (limit: number, offset: number) => Promise<DictationEntry[]>;
  exportHistory: (format: 'csv' | 'json') => Promise<string>;
  updateHistoryEntry: (id: number, text: string) => Promise<DictationEntry | null>;
  deleteHistoryEntry: (id: number) => Promise<void>;
  deleteHistoryEntries: (ids: number[]) => Promise<void>;
  clearHistory: () => Promise<void>;
  getDictionaryItems: () => Promise<DictionaryItem[]>;
  saveDictionaryItem: (item: DictionaryItemInput) => Promise<DictionaryItem>;
  deleteDictionaryItem: (id: number) => Promise<void>;
  getSnippets: () => Promise<Snippet[]>;
  saveSnippet: (snippet: SnippetInput) => Promise<Snippet>;
  deleteSnippet: (id: number) => Promise<void>;
  getStats: () => Promise<{ totalWords: number; totalSessions: number; todayWords: number; avgSessionMs: number }>;
  getCurrentApp: () => Promise<string>;
  openApiKeyPage: () => void;
  testGroqApiKey: (key: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  testSavedGroqApiKey: () => Promise<{ ok: true } | { ok: false; error: string }>;
  transcribeAudio: (
    buffer: ArrayBuffer,
    duration: number,
    speechMetrics?: SpeechMetrics
  ) => Promise<void>;
  sendAudioLevel: (levels: number[]) => void;
  onStartRecording: (cb: () => void) => () => void;
  onStopRecording: (cb: () => void) => () => void;
  onCancelDictation: (cb: () => void) => () => void;
  onTranscriptionResult: (cb: (entry: DictationEntry | null) => void) => () => void;
  onError: (cb: (msg: string) => void) => () => void;
  onNavigateTab: (cb: (tab: AppTab) => void) => () => void;
  onOverlayState: (cb: (state: AppState, extra?: unknown) => void) => () => void;
  onAudioLevel: (cb: (levels: number[]) => void) => () => void;
  overlayMouseEnter: () => void;
  overlayMouseLeave: () => void;
  overlayRenderReady?: () => void;
  getOverlayState: () => Promise<{ state: AppState; extraData?: unknown }>;
  windowMinimize: () => void;
  windowToggleMaximize: () => void;
  windowClose: () => void;
  reportRendererError: (scope: string, message: string, stack?: string) => void;
  onUpdateReady: (cb: () => void) => () => void;
  onModelDownloadProgress: (
    cb: (state: string, progress?: ModelDownloadProgress, error?: string) => void
  ) => () => void;
  hasGroqApiKey: () => Promise<boolean>;
  isSecureStorageAvailable: () => Promise<boolean>;
  setGroqApiKey: (key: string) => Promise<Settings>;
  clearGroqApiKey: () => Promise<Settings>;
}

declare global {
  interface Window {
    api: EchoApi;
  }
}

export {};
