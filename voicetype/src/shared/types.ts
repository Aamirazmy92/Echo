export type AppState = 'idle' | 'recording' | 'processing' | 'success' | 'error'
export type ThemeMode = 'light' | 'dark'
export type AppTab = 'dashboard' | 'history' | 'snippets' | 'style' | 'insights' | 'settings'
export type StyleCategory = 'personal' | 'work' | 'email' | 'other'
export type GlobalStyleId = 'formal' | 'casual' | 'very_casual' | 'concise' | 'code' | 'excited'
export type StyleToneId = string
export type CategoryStyleSelections = Partial<Record<StyleCategory, StyleToneId>>
export type EnabledStyleCategories = Partial<Record<StyleCategory, boolean>>

export interface Settings {
  toggleHotkey: string[]        // press once to start, press again to stop
  pushToTalkHotkey: string[]    // hold to record, release to stop
  cancelHotkey: string[]        // dismiss recording/results and clear the overlay
  groqApiKey: string
  aiCleanup: boolean            // enable GPT cleanup
  useCloudTranscription: boolean // use Groq cloud (fast) vs local model (slow, offline)
  selectedGlobalStyleId: GlobalStyleId | null
  categoryStyleSelections?: CategoryStyleSelections // deprecated legacy migration input
  enabledStyleCategories?: EnabledStyleCategories // deprecated legacy migration input
  writingMode?: WritingMode     // legacy fallback for older installs
  language: string              // legacy fallback: 'auto' or BCP-47 code e.g. 'en'
  selectedLanguages?: string[]  // active language picks used by the multi-select UI
  autoDetectLanguage?: boolean  // allow Whisper to auto-detect instead of forcing one language
  microphoneId: string
  microphoneLabel: string
  launchAtStartup: boolean
  showOverlay: boolean
  showAppInDock: boolean
  themeMode: ThemeMode
  overlayPosition: 'top-center' | 'bottom-center'
  onboardingComplete: boolean
}

export type WritingMode = 'standard' | 'formal' | 'casual' | 'bullet' | 'code'

export interface SpeechMetrics {
  frameCount: number
  speechFrames: number
  longestSpeechRunFrames: number
  peakBand: number
  averageBand: number
  peakRms: number
  averageRms: number
}

export interface DictationEntry {
  id: number
  text: string
  rawText: string               // pre-cleanup transcript
  wordCount: number
  durationMs: number
  appName: string               // active window process name at time of dictation
  mode: string
  method: 'cloud' | 'local' | 'local (cloud-fallback)'
  createdAt: string             // ISO timestamp
  processingTimeMs?: number     // time taken for transcription + cleanup
}

export interface Snippet {
  id: number
  trigger: string               // phrase to detect e.g. "my email"
  expansion: string             // what to replace it with
  category: string              // folder/category e.g. "Email", "Code", "General"
  shared: boolean
  createdAt: string
}

export interface SnippetInput {
  id?: number
  trigger: string
  expansion: string
  category?: string
  shared: boolean
}

export interface DictionaryItem {
  id: number
  phrase: string                // preferred spelling/casing, e.g. "Echo"
  misspelling: string | null    // optional explicit replacement source
  correctMisspelling: boolean   // allow fuzzy correction of near-matches
  shared: boolean
  createdAt: string
}

export interface DictionaryItemInput {
  id?: number
  phrase: string
  misspelling?: string | null
  correctMisspelling: boolean
  shared: boolean
}

export interface IpcChannels {
  // renderer -> main
  'get-settings': () => Settings
  'save-settings': (settings: Partial<Settings>) => Settings
  'suspend-hotkey': () => void
  'resume-hotkey': () => Settings
  'get-history': (limit: number, offset: number) => DictationEntry[]
  'update-history-entry': (id: number, text: string) => DictationEntry | null
  'delete-history-entry': (id: number) => void
  'clear-history': () => void
  'get-dictionary-items': () => DictionaryItem[]
  'save-dictionary-item': (item: DictionaryItemInput) => DictionaryItem
  'delete-dictionary-item': (id: number) => void
  'get-snippets': () => Snippet[]
  'save-snippet': (snippet: SnippetInput) => Snippet
  'delete-snippet': (id: number) => void
  'get-stats': () => { totalWords: number; totalSessions: number; todayWords: number; avgSessionMs: number }
  'get-current-app': () => string
  'open-api-key-page': () => void

  // main -> renderer (events)
  'state-changed': (state: AppState) => void
  'transcription-result': (entry: DictationEntry | null) => void
  'error': (message: string) => void
  'navigate-tab': (tab: AppTab) => void

  // overlay renderer <- main
  'overlay-state': (state: AppState, audioLevel?: number) => void
  'overlay-wordcount': (count: number) => void
}
