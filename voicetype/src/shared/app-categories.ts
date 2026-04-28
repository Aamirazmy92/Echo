// Curated mapping from active-window executable names to a friendly app
// label and a coarse category bucket. Used by the Insights page to group
// per-app dictation usage into "AI", "Documents", "Email", etc. The mapping
// is intentionally small and easy to extend — extend it as new apps appear.

export type AppCategory =
  | 'AI Prompts'
  | 'Documents'
  | 'Emails'
  | 'Work Messages'
  | 'Personal Messages'
  | 'Other Tasks';

// Canonical render order — used by the Insights page so every category gets
// a row even when its dictation count is zero. Sort UI applies on top.
export const ALL_CATEGORIES: AppCategory[] = [
  'AI Prompts',
  'Documents',
  'Emails',
  'Work Messages',
  'Personal Messages',
  'Other Tasks',
];

export type AppCategoryInfo = {
  category: AppCategory;
  label: string;
};

// Keys are *normalized* executable names: lowercased, with `.exe`/`.app`
// stripped and spaces removed (see `normalizeAppName` below).
const TABLE: Record<string, AppCategoryInfo> = {
  // ── AI Prompts ────────────────────────────────────────────────────────
  cursor: { category: 'AI Prompts', label: 'Cursor' },
  windsurf: { category: 'AI Prompts', label: 'Windsurf' },
  continue: { category: 'AI Prompts', label: 'Continue' },
  chatgpt: { category: 'AI Prompts', label: 'ChatGPT' },
  claude: { category: 'AI Prompts', label: 'Claude' },
  copilot: { category: 'AI Prompts', label: 'Copilot' },
  perplexity: { category: 'AI Prompts', label: 'Perplexity' },
  raycast: { category: 'AI Prompts', label: 'Raycast' },

  // ── Documents (Office, PDF readers, note-taking apps) ─────────────────
  winword: { category: 'Documents', label: 'Word' },
  word: { category: 'Documents', label: 'Word' },
  powerpnt: { category: 'Documents', label: 'PowerPoint' },
  powerpoint: { category: 'Documents', label: 'PowerPoint' },
  excel: { category: 'Documents', label: 'Excel' },
  pages: { category: 'Documents', label: 'Pages' },
  keynote: { category: 'Documents', label: 'Keynote' },
  numbers: { category: 'Documents', label: 'Numbers' },
  libreoffice: { category: 'Documents', label: 'LibreOffice' },
  soffice: { category: 'Documents', label: 'LibreOffice' },
  acrobat: { category: 'Documents', label: 'Acrobat' },
  acrord32: { category: 'Documents', label: 'Acrobat Reader' },
  notion: { category: 'Documents', label: 'Notion' },
  obsidian: { category: 'Documents', label: 'Obsidian' },
  logseq: { category: 'Documents', label: 'Logseq' },
  bear: { category: 'Documents', label: 'Bear' },
  notes: { category: 'Documents', label: 'Notes' },
  onenote: { category: 'Documents', label: 'OneNote' },
  evernote: { category: 'Documents', label: 'Evernote' },
  craft: { category: 'Documents', label: 'Craft' },
  roam: { category: 'Documents', label: 'Roam' },
  reflect: { category: 'Documents', label: 'Reflect' },

  // ── Emails ────────────────────────────────────────────────────────────
  outlook: { category: 'Emails', label: 'Outlook' },
  thunderbird: { category: 'Emails', label: 'Thunderbird' },
  mailspring: { category: 'Emails', label: 'Mailspring' },
  spark: { category: 'Emails', label: 'Spark' },
  mail: { category: 'Emails', label: 'Mail' },
  airmail: { category: 'Emails', label: 'Airmail' },

  // ── Work Messages (team chat, work-oriented messaging) ────────────────
  slack: { category: 'Work Messages', label: 'Slack' },
  teams: { category: 'Work Messages', label: 'Teams' },
  msteams: { category: 'Work Messages', label: 'Teams' },
  discord: { category: 'Work Messages', label: 'Discord' },

  // ── Personal Messages (1:1 / consumer chat apps) ──────────────────────
  whatsapp: { category: 'Personal Messages', label: 'WhatsApp' },
  telegram: { category: 'Personal Messages', label: 'Telegram' },
  signal: { category: 'Personal Messages', label: 'Signal' },
  skype: { category: 'Personal Messages', label: 'Skype' },
  messenger: { category: 'Personal Messages', label: 'Messenger' },
  imessage: { category: 'Personal Messages', label: 'Messages' },
  messages: { category: 'Personal Messages', label: 'Messages' },

  // ── Other Tasks (code editors, terminals, browsers, design, etc.) ────
  // Code editors
  code: { category: 'Other Tasks', label: 'VS Code' },
  'code-insiders': { category: 'Other Tasks', label: 'VS Code Insiders' },
  codium: { category: 'Other Tasks', label: 'VSCodium' },
  sublime_text: { category: 'Other Tasks', label: 'Sublime Text' },
  sublimetext: { category: 'Other Tasks', label: 'Sublime Text' },
  atom: { category: 'Other Tasks', label: 'Atom' },
  vim: { category: 'Other Tasks', label: 'Vim' },
  nvim: { category: 'Other Tasks', label: 'Neovim' },
  notepad: { category: 'Other Tasks', label: 'Notepad' },
  'notepad++': { category: 'Other Tasks', label: 'Notepad++' },
  notepadpp: { category: 'Other Tasks', label: 'Notepad++' },
  idea64: { category: 'Other Tasks', label: 'IntelliJ IDEA' },
  idea: { category: 'Other Tasks', label: 'IntelliJ IDEA' },
  pycharm64: { category: 'Other Tasks', label: 'PyCharm' },
  pycharm: { category: 'Other Tasks', label: 'PyCharm' },
  webstorm64: { category: 'Other Tasks', label: 'WebStorm' },
  webstorm: { category: 'Other Tasks', label: 'WebStorm' },
  goland64: { category: 'Other Tasks', label: 'GoLand' },
  rider64: { category: 'Other Tasks', label: 'Rider' },
  xcode: { category: 'Other Tasks', label: 'Xcode' },
  devenv: { category: 'Other Tasks', label: 'Visual Studio' },
  android_studio: { category: 'Other Tasks', label: 'Android Studio' },
  studio64: { category: 'Other Tasks', label: 'Android Studio' },
  zed: { category: 'Other Tasks', label: 'Zed' },
  // Terminals
  powershell: { category: 'Other Tasks', label: 'PowerShell' },
  pwsh: { category: 'Other Tasks', label: 'PowerShell' },
  cmd: { category: 'Other Tasks', label: 'Command Prompt' },
  conhost: { category: 'Other Tasks', label: 'Console Host' },
  windowsterminal: { category: 'Other Tasks', label: 'Windows Terminal' },
  wt: { category: 'Other Tasks', label: 'Windows Terminal' },
  iterm2: { category: 'Other Tasks', label: 'iTerm' },
  iterm: { category: 'Other Tasks', label: 'iTerm' },
  terminal: { category: 'Other Tasks', label: 'Terminal' },
  alacritty: { category: 'Other Tasks', label: 'Alacritty' },
  hyper: { category: 'Other Tasks', label: 'Hyper' },
  warp: { category: 'Other Tasks', label: 'Warp' },
  bash: { category: 'Other Tasks', label: 'Bash' },
  zsh: { category: 'Other Tasks', label: 'Zsh' },
  // Browsers
  chrome: { category: 'Other Tasks', label: 'Chrome' },
  msedge: { category: 'Other Tasks', label: 'Edge' },
  edge: { category: 'Other Tasks', label: 'Edge' },
  firefox: { category: 'Other Tasks', label: 'Firefox' },
  safari: { category: 'Other Tasks', label: 'Safari' },
  brave: { category: 'Other Tasks', label: 'Brave' },
  arc: { category: 'Other Tasks', label: 'Arc' },
  opera: { category: 'Other Tasks', label: 'Opera' },
  vivaldi: { category: 'Other Tasks', label: 'Vivaldi' },
  // Design
  figma: { category: 'Other Tasks', label: 'Figma' },
  sketch: { category: 'Other Tasks', label: 'Sketch' },
  photoshop: { category: 'Other Tasks', label: 'Photoshop' },
  illustrator: { category: 'Other Tasks', label: 'Illustrator' },
  affinitydesigner: { category: 'Other Tasks', label: 'Affinity Designer' },
  affinityphoto: { category: 'Other Tasks', label: 'Affinity Photo' },
  // Productivity
  linear: { category: 'Other Tasks', label: 'Linear' },
  asana: { category: 'Other Tasks', label: 'Asana' },
  trello: { category: 'Other Tasks', label: 'Trello' },
  jira: { category: 'Other Tasks', label: 'Jira' },
  monday: { category: 'Other Tasks', label: 'Monday' },
  todoist: { category: 'Other Tasks', label: 'Todoist' },
  things3: { category: 'Other Tasks', label: 'Things' },
  things: { category: 'Other Tasks', label: 'Things' },
  clickup: { category: 'Other Tasks', label: 'ClickUp' },
  // Media
  zoom: { category: 'Other Tasks', label: 'Zoom' },
  spotify: { category: 'Other Tasks', label: 'Spotify' },
  obs64: { category: 'Other Tasks', label: 'OBS' },
  obs: { category: 'Other Tasks', label: 'OBS' },
  vlc: { category: 'Other Tasks', label: 'VLC' },
  applemusic: { category: 'Other Tasks', label: 'Apple Music' },
};

export function normalizeAppName(rawName: string): string {
  return rawName
    .toLowerCase()
    .replace(/\.(exe|app)$/i, '')
    .replace(/\s+/g, '');
}

export function classifyApp(rawName: string): AppCategoryInfo {
  const normalized = normalizeAppName(rawName);
  // Exact match first.
  const exact = TABLE[normalized];
  if (exact) return exact;
  // Fall back to a substring scan so common variants like
  // "chrome_proxy.exe" / "WhatsApp Beta" still land in their bucket.
  for (const [key, info] of Object.entries(TABLE)) {
    if (key.length < 3) continue;
    if (normalized.includes(key)) return info;
  }
  // Unknown app — surface the original name so the user can still see what
  // it was.
  return { category: 'Other Tasks', label: rawName };
}
