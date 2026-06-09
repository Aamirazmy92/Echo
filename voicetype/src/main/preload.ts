import { contextBridge, ipcRenderer } from 'electron';
import { AppState, AppTab, DictionaryItemInput, DictationEntry, Note, NoteInput, Settings, SnippetInput, SpeechMetrics } from '../shared/types';

type UpdateStatusPayload = {
  state: 'unsupported' | 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error';
  version: string | null;
  progress: number | null;
  error: string | null;
  lastCheckedAt: string | null;
};

const initialTheme = 'light';

window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.dataset.theme = initialTheme;
});

contextBridge.exposeInMainWorld('api', {
  getInitialTheme: () => initialTheme,
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  refreshTrayMenu: () => ipcRenderer.invoke('refresh-tray-menu'),
  saveSettings: (s: Partial<Settings>) => ipcRenderer.invoke('save-settings', s),
  suspendHotkey: () => ipcRenderer.invoke('suspend-hotkey'),
  cancelRecordingStart: () => ipcRenderer.invoke('cancel-recording-start'),
  cancelDictation: () => ipcRenderer.invoke('cancel-dictation'),
  resumeHotkey: () => ipcRenderer.invoke('resume-hotkey'),
  getDashboardData: (limit = 50, offset = 0) => ipcRenderer.invoke('get-dashboard-data', limit, offset),
  basicUsageGet: () => ipcRenderer.invoke('basic-usage-get'),
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
  getNotes: () => ipcRenderer.invoke('get-notes'),
  saveNote: (note: NoteInput) => ipcRenderer.invoke('save-note', note),
  deleteNote: (id: number) => ipcRenderer.invoke('delete-note', id),
  toggleNotePin: (id: number, pinned: boolean) => ipcRenderer.invoke('toggle-note-pin', id, pinned),
  openStickyNoteWindow: (noteId?: number, options?: { x?: number; y?: number }) =>
    ipcRenderer.invoke('open-sticky-note-window', noteId, options),
  createNewStickyNoteWindow: (
    note?: number | { noteId?: number; title: string; body: string },
    options?: { x?: number; y?: number },
  ) => ipcRenderer.invoke('create-new-sticky-note-window', note, options),
  attachNoteToStickyWindow: (
    note: { noteId?: number; title: string; body: string },
    point: { x: number; y: number },
  ) => ipcRenderer.invoke('attach-note-to-sticky-window', note, point),
  getStats: () => ipcRenderer.invoke('get-stats'),
  getCurrentApp: () => ipcRenderer.invoke('get-current-app'),

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
  onBasicUsageLimitReached: (cb: (payload: unknown) => void) => {
    const fn = (_: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on('basic-usage-limit-reached', fn);
    return () => ipcRenderer.removeListener('basic-usage-limit-reached', fn);
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
  closeCurrentWindow: () => ipcRenderer.send('close-current-window'),
  forceCloseCurrentWindow: () => ipcRenderer.send('force-close-current-window'),
  toggleCurrentWindowMaximize: () => ipcRenderer.send('toggle-current-window-maximize'),
  expandCurrentWindowForWriting: () => ipcRenderer.send('expand-current-window-for-writing'),
  onNotesUpdated: (cb: () => void) => {
    const fn = () => cb();
    ipcRenderer.on('notes-updated', fn);
    return () => ipcRenderer.removeListener('notes-updated', fn);
  },
  onOpenNoteInSticky: (cb: (note: Note) => void) => {
    const fn = (_: unknown, note: Note) => cb(note);
    ipcRenderer.on('open-note-in-sticky', fn);
    return () => ipcRenderer.removeListener('open-note-in-sticky', fn);
  },
  onNewBlankTabInSticky: (cb: () => void) => {
    const fn = () => cb();
    ipcRenderer.on('new-blank-tab-in-sticky', fn);
    return () => ipcRenderer.removeListener('new-blank-tab-in-sticky', fn);
  },
  onAttachNoteInSticky: (
    cb: (note: { noteId?: number; title: string; body: string; keepAsNewTab?: boolean }) => void,
  ) => {
    const fn = (
      _: unknown,
      note: { noteId?: number; title: string; body: string; keepAsNewTab?: boolean },
    ) => cb(note);
    ipcRenderer.on('attach-note-in-sticky', fn);
    return () => ipcRenderer.removeListener('attach-note-in-sticky', fn);
  },
  writeClipboardText: (text: string) => ipcRenderer.invoke('clipboard-write-text', text),
  openExternalUrl: (url: string) => ipcRenderer.invoke('open-external-url', url),

  reportRendererError: (scope: string, message: string, stack?: string) =>
    ipcRenderer.send('report-renderer-error', { scope, message, stack }),

  updateGetStatus: () => ipcRenderer.invoke('update-get-status'),
  updateCheck: () => ipcRenderer.invoke('update-check'),
  updateDownload: () => ipcRenderer.invoke('update-download'),
  updateInstall: () => ipcRenderer.invoke('update-install'),
  onUpdateStatus: (cb: (status: UpdateStatusPayload) => void) => {
    const fn = (_: unknown, status: UpdateStatusPayload) => cb(status);
    ipcRenderer.on('update-status', fn);
    return () => ipcRenderer.removeListener('update-status', fn);
  },

  onModelDownloadProgress: (cb: (state: string, progress?: { percent: number; bytesReceived: number; bytesTotal: number }, error?: string) => void) => {
    const fn = (_: unknown, data: { state: string; progress?: { percent: number; bytesReceived: number; bytesTotal: number }; error?: string }) => cb(data.state, data.progress, data.error);
    ipcRenderer.on('model-download-progress', fn);
    return () => ipcRenderer.removeListener('model-download-progress', fn);
  },

  // ─────────── Auth (Supabase-backed) ───────────
  authConfigStatus: () => ipcRenderer.invoke('auth-config-status'),
  authGetSession: () => ipcRenderer.invoke('auth-get-session'),
  authSignIn: (email: string, password: string) => ipcRenderer.invoke('auth-sign-in', email, password),
  authSignUp: (email: string, password: string, displayName?: string) =>
    ipcRenderer.invoke('auth-sign-up', email, password, displayName),
  authSignOut: () => ipcRenderer.invoke('auth-sign-out'),
  authResetPassword: (email: string) => ipcRenderer.invoke('auth-reset-password', email),
  authGoogleSignIn: () => ipcRenderer.invoke('auth-google-sign-in'),
  authDeleteAccount: () => ipcRenderer.invoke('auth-delete-account'),
  authUpdateDisplayName: (name: string) => ipcRenderer.invoke('auth-update-display-name', name),
  authUpdateProfilePicture: (profilePictureDataUrl: string | null) =>
    ipcRenderer.invoke('auth-update-profile-picture', profilePictureDataUrl),
  onAuthState: (cb: (session: unknown | null) => void) => {
    const fn = (_: unknown, session: unknown | null) => cb(session);
    ipcRenderer.on('auth-state', fn);
    return () => ipcRenderer.removeListener('auth-state', fn);
  },

  // ─────────── Cloud sync ───────────
  syncGetStatus: () => ipcRenderer.invoke('sync-get-status'),
  syncForce: () => ipcRenderer.invoke('sync-force'),
  onSyncStatus: (cb: (payload: unknown) => void) => {
    const fn = (_: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on('sync-status', fn);
    return () => ipcRenderer.removeListener('sync-status', fn);
  },

  // ─────────── Billing / entitlements ───────────
  billingConfigStatus: () => ipcRenderer.invoke('billing-config-status'),
  entitlementsGet: () => ipcRenderer.invoke('entitlements-get'),
  entitlementsRefresh: () => ipcRenderer.invoke('entitlements-refresh'),
  billingStartCheckout: (plan: 'pro_monthly' | 'pro_yearly') =>
    ipcRenderer.invoke('billing-start-checkout', plan),
  billingOpenPortal: () => ipcRenderer.invoke('billing-open-portal'),
  onEntitlementsChanged: (cb: (ent: unknown) => void) => {
    const fn = (_: unknown, ent: unknown) => cb(ent);
    ipcRenderer.on('entitlements-changed', fn);
    return () => ipcRenderer.removeListener('entitlements-changed', fn);
  },
  onBillingDeepLink: (cb: (url: string) => void) => {
    const fn = (_: unknown, url: string) => cb(url);
    ipcRenderer.on('billing-deep-link', fn);
    return () => ipcRenderer.removeListener('billing-deep-link', fn);
  },
});
