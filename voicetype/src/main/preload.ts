import { contextBridge, ipcRenderer } from 'electron';
import { AppState, AppTab, DictionaryItemInput, DictationEntry, Settings, SnippetInput, SpeechMetrics } from '../shared/types';

const initialTheme = 'light';

window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.dataset.theme = initialTheme;
});

contextBridge.exposeInMainWorld('api', {
  getInitialTheme: () => initialTheme,
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (s: Partial<Settings>) => ipcRenderer.invoke('save-settings', s),
  suspendHotkey: () => ipcRenderer.invoke('suspend-hotkey'),
  cancelRecordingStart: () => ipcRenderer.invoke('cancel-recording-start'),
  cancelDictation: () => ipcRenderer.invoke('cancel-dictation'),
  resumeHotkey: () => ipcRenderer.invoke('resume-hotkey'),
  getDashboardData: (limit = 50, offset = 0) => ipcRenderer.invoke('get-dashboard-data', limit, offset),
  getHistory: (limit: number, offset: number) => ipcRenderer.invoke('get-history', limit, offset),
  exportHistory: (format: 'csv' | 'json') => ipcRenderer.invoke('export-history', format),
  updateHistoryEntry: (id: number, text: string) => ipcRenderer.invoke('update-history-entry', id, text),
  deleteHistoryEntry: (id: number) => ipcRenderer.invoke('delete-history-entry', id),
  deleteHistoryEntries: (ids: number[]) => ipcRenderer.invoke('delete-history-entries', ids),
  clearHistory: () => ipcRenderer.invoke('clear-history'),
  getDictionaryItems: () => ipcRenderer.invoke('get-dictionary-items'),
  saveDictionaryItem: (item: DictionaryItemInput) => ipcRenderer.invoke('save-dictionary-item', item),
  deleteDictionaryItem: (id: number) => ipcRenderer.invoke('delete-dictionary-item', id),
  getSnippets: () => ipcRenderer.invoke('get-snippets'),
  saveSnippet: (s: SnippetInput) => ipcRenderer.invoke('save-snippet', s),
  deleteSnippet: (id: number) => ipcRenderer.invoke('delete-snippet', id),
  getStats: () => ipcRenderer.invoke('get-stats'),
  getCurrentApp: () => ipcRenderer.invoke('get-current-app'),
  openApiKeyPage: () => ipcRenderer.send('open-api-key-page'),
  testGroqApiKey: (key: string) => ipcRenderer.invoke('test-groq-api-key', key),
  testSavedGroqApiKey: () => ipcRenderer.invoke('test-saved-groq-api-key'),

  transcribeAudio: (buffer: ArrayBuffer, duration: number, speechMetrics?: SpeechMetrics) =>
    ipcRenderer.invoke('transcribe-audio', buffer, duration, speechMetrics),
  sendAudioLevel: (levels: number[]) => ipcRenderer.send('audio-level', levels),

  onStartRecording: (cb: () => void) => {
    const fn = () => cb();
    ipcRenderer.on('start-recording', fn);
    return () => ipcRenderer.removeListener('start-recording', fn);
  },
  onStopRecording: (cb: () => void) => {
    const fn = () => cb();
    ipcRenderer.on('stop-recording', fn);
    return () => ipcRenderer.removeListener('stop-recording', fn);
  },
  onCancelDictation: (cb: () => void) => {
    const fn = () => cb();
    ipcRenderer.on('cancel-dictation', fn);
    return () => ipcRenderer.removeListener('cancel-dictation', fn);
  },
  onTranscriptionResult: (cb: (entry: DictationEntry | null) => void) => {
    const fn = (_: unknown, entry: DictationEntry | null) => cb(entry);
    ipcRenderer.on('transcription-result', fn);
    return () => ipcRenderer.removeListener('transcription-result', fn);
  },
  onError: (cb: (msg: string) => void) => {
    const fn = (_: unknown, msg: string) => cb(msg);
    ipcRenderer.on('error', fn);
    return () => ipcRenderer.removeListener('error', fn);
  },
  onNavigateTab: (cb: (tab: AppTab) => void) => {
    const fn = (_: unknown, tab: AppTab) => cb(tab);
    ipcRenderer.on('navigate-tab', fn);
    return () => ipcRenderer.removeListener('navigate-tab', fn);
  },

  // overlay specific
  onOverlayState: (cb: (state: AppState, extra?: unknown) => void) => {
    const fn = (_: unknown, state: AppState, extra: unknown) => cb(state, extra);
    ipcRenderer.on('overlay-state', fn);
    return () => ipcRenderer.removeListener('overlay-state', fn);
  },
  onAudioLevel: (cb: (levels: number[]) => void) => {
    const fn = (_: unknown, levels: number[]) => cb(levels);
    ipcRenderer.on('audio-level', fn);
    return () => ipcRenderer.removeListener('audio-level', fn);
  },
  overlayMouseEnter: () => ipcRenderer.send('overlay-mouse-enter'),
  overlayMouseLeave: () => ipcRenderer.send('overlay-mouse-leave'),
  overlayRenderReady: () => ipcRenderer.send('overlay-render-ready'),
  getOverlayState: () => ipcRenderer.invoke('get-overlay-state'),

  windowMinimize: () => ipcRenderer.send('window-minimize'),
  windowToggleMaximize: () => ipcRenderer.send('window-toggle-maximize'),
  windowClose: () => ipcRenderer.send('window-close'),

  reportRendererError: (scope: string, message: string, stack?: string) =>
    ipcRenderer.send('report-renderer-error', { scope, message, stack }),

  onUpdateReady: (cb: () => void) => {
    const fn = () => cb();
    ipcRenderer.on('update-ready', fn);
    return () => ipcRenderer.removeListener('update-ready', fn);
  },

  onModelDownloadProgress: (cb: (state: string, progress?: { percent: number; bytesReceived: number; bytesTotal: number }, error?: string) => void) => {
    const fn = (_: unknown, data: { state: string; progress?: { percent: number; bytesReceived: number; bytesTotal: number }; error?: string }) => cb(data.state, data.progress, data.error);
    ipcRenderer.on('model-download-progress', fn);
    return () => ipcRenderer.removeListener('model-download-progress', fn);
  },
  hasGroqApiKey: () => ipcRenderer.invoke('has-groq-api-key'),
  isSecureStorageAvailable: () => ipcRenderer.invoke('is-secure-storage-available'),
  setGroqApiKey: (key: string) => ipcRenderer.invoke('set-groq-api-key', key),
  clearGroqApiKey: () => ipcRenderer.invoke('clear-groq-api-key'),
});
