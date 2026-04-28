import {
  CategoryStyleSelections,
  EnabledStyleCategories,
  GlobalStyleId,
  Settings,
  StyleCategory,
} from './types';

export type GlobalStyleConfig = {
  id: GlobalStyleId;
  label: string;
  subtitle: string;
  description: string;
  inputExample: string;
  preview: string;
  prompt: string;
  model: string;
  temperature: number;
  accentClass: string;
  selectedSurfaceClass: string;
  selectedPillClass: string;
  bubbleClass: string;
  badgeLabel: string;
};

export const GLOBAL_STYLE_ORDER: GlobalStyleId[] = [
  'formal',
  'casual',
  'very_casual',
  'concise',
  'code',
  'excited',
];

export const STYLE_CATEGORY_ORDER: StyleCategory[] = ['personal', 'work', 'email', 'other'];

export const DEFAULT_CATEGORY_STYLE_SELECTIONS: Record<StyleCategory, string> = {
  personal: 'casual',
  work: 'formal',
  email: 'formal',
  other: 'casual',
};

export const GLOBAL_STYLE_CONFIG: Record<GlobalStyleId, GlobalStyleConfig> = {
  formal: {
    id: 'formal',
    label: 'Formal',
    subtitle: 'Polished and composed',
    description: 'Clear sentence case, strong punctuation, and professional phrasing for any text field.',
    inputExample: 'hey sarah i looked at the draft and did the updates you asked for tell me if you need anything else',
    preview: 'Hello Sarah, I reviewed the draft and made the requested updates. Please let me know if you would like any further revisions.',
    prompt:
      "Rewrite this dictation in a polished, composed tone suitable for any app or text field. Use sentence case, clear punctuation, concise wording, and preserve the speaker's meaning exactly.",
    model: 'llama-3.3-70b-versatile',
    temperature: 0.2,
    accentClass: 'border-2 border-[#C7AFA6] shadow-[0_0_0_3px_rgba(199, 175, 166, 0.4)]',
    selectedSurfaceClass: 'bg-[#F3E8DF]',
    selectedPillClass: 'bg-[#F3E8DF] text-black',
    bubbleClass: 'bg-[#F3E8DF] text-black',
    badgeLabel: 'A',
  },
  casual: {
    id: 'casual',
    label: 'Casual',
    subtitle: 'Natural and balanced',
    description: 'Friendly, everyday writing with light cleanup and relaxed punctuation.',
    inputExample: 'good morning sarah i have successfully reviewed the draft and implemented the requested modifications please inform me if additional adjustments are necessary',
    preview: "Hey Sarah, I reviewed the draft and made the updates you asked for. Let me know if you want me to tweak anything else.",
    prompt:
      'Rewrite this dictation in a natural, everyday tone. Use sentence case, keep contractions where they sound natural, remove filler words, and keep punctuation relaxed but clear.',
    model: 'llama-3.1-8b-instant',
    temperature: 0.32,
    accentClass: 'border-2 border-[#C7AFA6] shadow-[0_0_0_3px_rgba(243, 232, 223, 0.36)]',
    selectedSurfaceClass: 'bg-[#F3E8DF]',
    selectedPillClass: 'bg-[#F3E8DF] text-black',
    bubbleClass: 'bg-[#F3E8DF] text-black',
    badgeLabel: 'Hi',
  },
  very_casual: {
    id: 'very_casual',
    label: 'Very casual',
    subtitle: 'Lowercase and loose',
    description: 'Text-message energy with minimal structure, lowercase phrasing, and almost no punctuation.',
    inputExample: 'sarah i reviewed the draft and made the updates you asked for let me know if you want anything else changed',
    preview: 'hey sarah i reviewed the draft and made the updates you asked for let me know if you want anything else changed',
    prompt:
      'Rewrite this dictation like a very casual text message. Use lowercase, avoid punctuation unless omitting it would make the meaning unclear, keep the tone warm and informal, remove filler words, and preserve the original meaning.',
    model: 'llama-3.1-8b-instant',
    temperature: 0.55,
    accentClass: 'border-2 border-[#452829] shadow-[0_0_0_3px_rgba(69, 40, 41, 0.42)]',
    selectedSurfaceClass: 'bg-[#F3E8DF]',
    selectedPillClass: 'bg-[#F3E8DF] text-black',
    bubbleClass: 'bg-[#F3E8DF] text-black',
    badgeLabel: 'txt',
  },
  concise: {
    id: 'concise',
    label: 'Concise',
    subtitle: 'Short and direct',
    description: 'Tightens phrasing, removes repetition, and keeps only the essential message.',
    inputExample: 'hi sarah um so i was looking at the draft that you sent over yesterday and i went ahead and made all the updates that you asked for so just let me know if you want any changes',
    preview: 'Hi Sarah, I revised the draft. Let me know if you want any changes.',
    prompt:
      'Rewrite this dictation to be concise and direct. Preserve the meaning, shorten where possible, remove filler and repetition, and keep the result easy to paste anywhere.',
    model: 'llama-3.1-8b-instant',
    temperature: 0.15,
    accentClass: 'border-2 border-[#C7AFA6] shadow-[0_0_0_3px_rgba(199, 175, 166, 0.36)]',
    selectedSurfaceClass: 'bg-[#F3E8DF]',
    selectedPillClass: 'bg-[#F3E8DF] text-black',
    bubbleClass: 'bg-[#F3E8DF] text-black',
    badgeLabel: 'TL;DR',
  },
  code: {
    id: 'code',
    label: 'Coding',
    subtitle: 'Technical and prompt-ready',
    description: 'Keeps code terms, commands, filenames, and API wording intact while turning dictation into a clean engineering prompt.',
    inputExample: 'build a react settings page with type script and tail wind add a collapsible side bar optimistic save states keyboard shortcuts and a clean empty state',
    preview: 'Build a React settings page with TypeScript and Tailwind. Add a collapsible sidebar, optimistic save states, keyboard shortcuts, and a clean empty state.',
    prompt:
      'Rewrite this dictation for coding and technical work. Preserve the exact technical meaning, including identifiers, filenames, paths, commands, flags, package names, APIs, frameworks, versions, and error messages. Fix phrasing and punctuation so it reads clearly as an engineering note or AI coding prompt. When the dictation is asking to build, edit, debug, or refactor software, phrase it as a direct, well-structured instruction. Do not rewrite code into generic prose, do not remove useful technical formatting, and do not invent requirements.',
    model: 'llama-3.3-70b-versatile',
    temperature: 0.12,
    accentClass: 'border-2 border-[#452829] shadow-[0_0_0_3px_rgba(69, 40, 41, 0.34)]',
    selectedSurfaceClass: 'bg-[#F3E8DF]',
    selectedPillClass: 'bg-[#F3E8DF] text-black',
    bubbleClass: 'bg-[#F3E8DF] text-black',
    badgeLabel: '</>',
  },
  excited: {
    id: 'excited',
    label: 'Excited',
    subtitle: 'Bright and energetic',
    description: 'Adds upbeat momentum without turning the message into over-the-top marketing copy.',
    inputExample: "great news i reviewed the draft and made the updates you asked for it's looking strong and i'm excited for you to see it",
    preview: "Great news! I reviewed the draft and made the updates you asked for. It's looking strong, and I'm excited for you to see it!",
    prompt:
      'Rewrite this dictation with energetic, upbeat tone. Keep it readable, use sentence case, add expressive wording where it feels natural, and use exclamation marks sparingly but intentionally.',
    model: 'llama-3.1-8b-instant',
    temperature: 0.45,
    accentClass: 'border-2 border-[#C7AFA6] shadow-[0_0_0_3px_rgba(199, 175, 166, 0.4)]',
    selectedSurfaceClass: 'bg-[#F3E8DF]',
    selectedPillClass: 'bg-[#F3E8DF] text-black',
    bubbleClass: 'bg-[#F3E8DF] text-black',
    badgeLabel: '!',
  },
};

export function sanitizeCategoryStyleSelections(
  selections?: Partial<Record<StyleCategory, string>> | null
): CategoryStyleSelections {
  const safeSelections: CategoryStyleSelections = {};

  for (const category of STYLE_CATEGORY_ORDER) {
    const requestedTone = selections?.[category];
    if (!requestedTone) continue;

    if (Object.prototype.hasOwnProperty.call(GLOBAL_STYLE_CONFIG, requestedTone)) {
      safeSelections[category] = requestedTone;
    }
  }

  return safeSelections;
}

export function sanitizeEnabledStyleCategories(
  enabledCategories?: Partial<Record<StyleCategory, boolean>> | null
): EnabledStyleCategories {
  const safeEnabledCategories: EnabledStyleCategories = {};

  for (const category of STYLE_CATEGORY_ORDER) {
    if (enabledCategories?.[category]) {
      safeEnabledCategories[category] = true;
    }
  }

  return safeEnabledCategories;
}

export function sanitizeSelectedGlobalStyleId(styleId?: string | null): GlobalStyleId | null {
  if (!styleId) return null;
  return Object.prototype.hasOwnProperty.call(GLOBAL_STYLE_CONFIG, styleId)
    ? (styleId as GlobalStyleId)
    : null;
}

export function migrateLegacyStyleSelection(
  legacySelections?: CategoryStyleSelections | null,
  legacyEnabledCategories?: EnabledStyleCategories | null
): GlobalStyleId | null {
  const safeSelections = sanitizeCategoryStyleSelections(legacySelections);
  const safeEnabledCategories = sanitizeEnabledStyleCategories(legacyEnabledCategories);
  const migrationOrder: StyleCategory[] = ['other', 'work', 'email', 'personal'];

  for (const category of migrationOrder) {
    if (!safeEnabledCategories[category]) continue;

    const legacyToneId = safeSelections[category] ?? DEFAULT_CATEGORY_STYLE_SELECTIONS[category];
    const migratedStyleId = sanitizeSelectedGlobalStyleId(legacyToneId);
    if (migratedStyleId) {
      return migratedStyleId;
    }
  }

  return null;
}

export function getGlobalStyleConfig(styleId: GlobalStyleId): GlobalStyleConfig {
  return GLOBAL_STYLE_CONFIG[styleId];
}

export function getResolvedGlobalStyleKey(styleId: GlobalStyleId | null): string {
  return styleId ? `global.${styleId}` : 'global.off';
}

export function resolveGlobalStyle(
  settings: Pick<Settings, 'selectedGlobalStyleId'>
): { toneId: GlobalStyleId | null; key: string } {
  const toneId = sanitizeSelectedGlobalStyleId(settings.selectedGlobalStyleId);

  return {
    toneId,
    key: getResolvedGlobalStyleKey(toneId),
  };
}
