// ---- Preload bridge types -------------------------------------------------
// Mirrors the shape exposed by `src/main/preload.ts` so the renderer no
// longer has to reach through `window.api`. Signatures here should
// track what `contextBridge.exposeInMainWorld('api', ...)` publishes.
import type {
  AppState,
  AppTab,
  DictationEntry,
  DictionaryItem,
  DictionaryItemInput,
  Note,
  NoteInput,
  Settings,
  Snippet,
  SnippetInput,
  SpeechMetrics,
} from '../shared/types';

type DashboardData = {
  stats: { totalWords: number; totalSessions: number; todayWords: number; avgSessionMs: number };
  history: DictationEntry[];
};

export type BasicUsagePayload = {
  tier: 'anonymous' | 'free' | 'pro';
  used: number;
  cap: number;
  remaining: number;
  exhausted: boolean;
  message?: string;
};

type ModelDownloadProgress = {
  percent: number;
  bytesReceived: number;
  bytesTotal: number;
};

export interface UpdateStatusPayload {
  state: 'unsupported' | 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error';
  version: string | null;
  progress: number | null;
  error: string | null;
  lastCheckedAt: string | null;
}

export interface EchoApi {
  getInitialTheme: () => 'light' | 'dark';
  getAppVersion: () => Promise<string>;
  getSettings: () => Promise<Settings>;
  refreshTrayMenu: () => Promise<void>;
  saveSettings: (patch: Partial<Settings>) => Promise<Settings>;
  suspendHotkey: () => Promise<void>;
  cancelRecordingStart: () => Promise<void>;
  cancelDictation: () => Promise<void>;
  resumeHotkey: () => Promise<Settings>;
  getDashboardData: (limit?: number, offset?: number) => Promise<DashboardData>;
  basicUsageGet: () => Promise<BasicUsagePayload>;
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
  getNotes: () => Promise<Note[]>;
  saveNote: (note: NoteInput) => Promise<Note>;
  deleteNote: (id: number) => Promise<void>;
  toggleNotePin: (id: number, pinned: boolean) => Promise<Note>;
  openStickyNoteWindow: (noteId?: number, options?: { x?: number; y?: number }) => Promise<void>;
  createNewStickyNoteWindow: (
    note?: number | { noteId?: number; title: string; body: string },
    options?: { x?: number; y?: number },
  ) => Promise<void>;
  attachNoteToStickyWindow: (
    note: { noteId?: number; title: string; body: string },
    point: { x: number; y: number }
  ) => Promise<boolean>;
  getStats: () => Promise<{ totalWords: number; totalSessions: number; todayWords: number; avgSessionMs: number }>;
  getCurrentApp: () => Promise<string>;
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
  onBasicUsageLimitReached: (cb: (payload: BasicUsagePayload) => void) => () => void;
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
  closeCurrentWindow: () => void;
  forceCloseCurrentWindow: () => void;
  toggleCurrentWindowMaximize: () => void;
  expandCurrentWindowForWriting: () => void;
  onNotesUpdated: (cb: () => void) => () => void;
  onOpenNoteInSticky: (cb: (note: Note) => void) => () => void;
  onNewBlankTabInSticky: (cb: () => void) => () => void;
  onAttachNoteInSticky: (cb: (note: { noteId?: number; title: string; body: string; keepAsNewTab?: boolean }) => void) => () => void;
  writeClipboardText: (text: string) => Promise<void>;
  openExternalUrl: (url: string) => Promise<void>;
  reportRendererError: (scope: string, message: string, stack?: string) => void;

  // ── Auto-update ──
  updateGetStatus: () => Promise<UpdateStatusPayload>;
  updateCheck: () => Promise<void>;
  updateDownload: () => Promise<void>;
  updateInstall: () => Promise<void>;
  onUpdateStatus: (cb: (status: UpdateStatusPayload) => void) => () => void;

  onModelDownloadProgress: (
    cb: (state: string, progress?: ModelDownloadProgress, error?: string) => void
  ) => () => void;

  // ── Auth (Supabase) ──
  authConfigStatus: () => Promise<{ configured: boolean }>;
  authGetSession: () => Promise<AuthSession | null>;
  authSignIn: (email: string, password: string) => Promise<{ error?: string }>;
  authSignUp: (
    email: string,
    password: string,
    displayName?: string
  ) => Promise<{ error?: string; needsConfirmation?: boolean }>;
  authSignOut: () => Promise<{ error?: string }>;
  authResetPassword: (email: string) => Promise<{ error?: string }>;
  authGoogleSignIn: () => Promise<{ error?: string }>;
  authDeleteAccount: () => Promise<{ error?: string }>;
  authUpdateDisplayName: (name: string) => Promise<{ error?: string }>;
  authUpdateProfilePicture: (profilePictureDataUrl: string | null) => Promise<{ error?: string }>;
  onAuthState: (cb: (session: AuthSession | null) => void) => () => void;

  // ── Cloud sync ──
  syncGetStatus: () => Promise<SyncStatusPayload>;
  syncForce: () => Promise<void>;
  onSyncStatus: (cb: (payload: SyncStatusPayload) => void) => () => void;

  // ── Billing / entitlements ──
  billingConfigStatus: () => Promise<{ configured: boolean }>;
  entitlementsGet: () => Promise<EntitlementsPayload>;
  entitlementsRefresh: () => Promise<EntitlementsPayload>;
  billingStartCheckout: (
    plan: 'pro_monthly' | 'pro_yearly'
  ) => Promise<{ ok: true } | { ok: false; code: string; error: string }>;
  billingOpenPortal: () => Promise<
    { ok: true } | { ok: false; code: string; error: string }
  >;
  onEntitlementsChanged: (cb: (ent: EntitlementsPayload) => void) => () => void;
  onBillingDeepLink: (cb: (url: string) => void) => () => void;
}

export interface EntitlementsPayload {
  tier: 'anonymous' | 'free' | 'pro';
  status: string;
  plan: 'pro_monthly' | 'pro_yearly' | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  trialEnd: string | null;
  fairUseExceeded: boolean;
  fairUseRemainingSeconds: number;
  fairUseUsedSeconds: number;
  fairUseCapSeconds: number;
  fetchedAt: number;
  loading: boolean;
  error: string | null;
}

export interface AuthSession {
  userId: string;
  email: string;
  displayName: string | null;
  profilePictureDataUrl: string | null;
  expiresAt: number | null;
}

export interface SyncStatusPayload {
  status: 'idle' | 'syncing' | 'offline' | 'error' | 'signed-out';
  queueDepth: number;
  lastError: string | null;
  lastSyncedAt: string | null;
}

declare global {
  interface Window {
    api: EchoApi;
  }
}

export {};
