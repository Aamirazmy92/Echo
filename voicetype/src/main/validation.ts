import type { DictionaryItemInput, Settings, SnippetInput, SpeechMetrics } from '../shared/types';
import {
  DEFAULT_CANCEL_HOTKEY,
  DEFAULT_PUSH_TO_TALK_HOTKEY,
  DEFAULT_TOGGLE_HOTKEY,
  normalizeHotkeyList,
} from '../shared/hotkey';
import { normalizeSelectedLanguages } from '../shared/languages';
import { sanitizeSelectedGlobalStyleId } from '../shared/styleConfig';

const MAX_PAGE_LIMIT = 10_000;
const MAX_PAGE_OFFSET = 10_000;
const MAX_TEXT_LENGTH = 20_000;
const MAX_API_KEY_LENGTH = 512;
const MAX_AUDIO_BYTES = 32 * 1024 * 1024;
const MAX_AUDIO_DURATION_MS = 15 * 60 * 1000;
const MAX_AUDIO_LEVEL_COUNT = 32;
const MAX_LANGUAGE_CODE_LENGTH = 32;
const MAX_MICROPHONE_ID_LENGTH = 256;
const MAX_MICROPHONE_LABEL_LENGTH = 256;
const MAX_SNIPPET_TRIGGER_LENGTH = 120;
const MAX_SNIPPET_EXPANSION_LENGTH = 20_000;
const MAX_CATEGORY_LENGTH = 80;
const MAX_DICTIONARY_PHRASE_LENGTH = 160;
const MAX_DICTIONARY_MISSPELLING_LENGTH = 160;

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const numericValue = asFiniteNumber(value);
  if (numericValue === null) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.trunc(numericValue)));
}

function assertString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Invalid ${field}.`);
  }

  return value;
}

function sanitizeTrimmedString(
  value: unknown,
  field: string,
  maxLength: number,
  {
    allowEmpty = false,
    collapseWhitespace = false,
  }: { allowEmpty?: boolean; collapseWhitespace?: boolean } = {}
): string {
  const rawValue = assertString(value, field);
  const normalized = collapseWhitespace
    ? rawValue.replace(/\s+/g, ' ').trim()
    : rawValue.trim();

  if (!allowEmpty && !normalized) {
    throw new Error(`Invalid ${field}.`);
  }

  return normalized.slice(0, maxLength);
}

function sanitizeOptionalTrimmedString(
  value: unknown,
  field: string,
  maxLength: number,
  options?: { collapseWhitespace?: boolean }
): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  const normalized = sanitizeTrimmedString(value, field, maxLength, {
    allowEmpty: true,
    collapseWhitespace: options?.collapseWhitespace,
  });

  return normalized || null;
}

function sanitizeBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`Invalid ${field}.`);
  }

  return value;
}

function sanitizeHotkeyInput(value: unknown, fallback: string): string[] {
  if (typeof value === 'string') {
    return normalizeHotkeyList(value, fallback);
  }

  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return normalizeHotkeyList(value, fallback);
  }

  throw new Error('Invalid hotkey setting.');
}

function sanitizeLanguageListInput(value: unknown): string[] {
  if (typeof value === 'string' || value === null || value === undefined) {
    return normalizeSelectedLanguages(value);
  }

  if (Array.isArray(value)) {
    return normalizeSelectedLanguages(
      value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim().slice(0, MAX_LANGUAGE_CODE_LENGTH))
    );
  }

  throw new Error('Invalid selectedLanguages.');
}

export function sanitizePagination(
  limit: unknown,
  offset: unknown,
  defaultLimit = 50
): { limit: number; offset: number } {
  return {
    limit: clampInteger(limit, 1, MAX_PAGE_LIMIT, defaultLimit),
    offset: clampInteger(offset, 0, MAX_PAGE_OFFSET, 0),
  };
}

export function sanitizeEntryId(value: unknown): number {
  const numericValue = asFiniteNumber(value);
  if (numericValue === null || !Number.isInteger(numericValue) || numericValue < 1) {
    throw new Error('Invalid id.');
  }

  return Math.min(Number.MAX_SAFE_INTEGER, numericValue);
}

const MAX_BULK_DELETE_COUNT = 500;

export function sanitizeEntryIds(value: unknown): number[] {
  if (!Array.isArray(value)) {
    throw new Error('Expected an array of ids.');
  }

  if (value.length === 0 || value.length > MAX_BULK_DELETE_COUNT) {
    throw new Error(`Expected 1–${MAX_BULK_DELETE_COUNT} ids.`);
  }

  return value.map((id, index) => {
    const numericValue = asFiniteNumber(id);
    if (numericValue === null || !Number.isInteger(numericValue) || numericValue < 1) {
      throw new Error(`Invalid id at index ${index}.`);
    }
    return Math.min(Number.MAX_SAFE_INTEGER, numericValue);
  });
}

export function sanitizeHistoryText(value: unknown): string {
  return sanitizeTrimmedString(value, 'history text', MAX_TEXT_LENGTH);
}

export function sanitizeExportFormat(value: unknown): 'csv' | 'json' {
  if (value === 'csv' || value === 'json') {
    return value;
  }

  throw new Error('Invalid export format.');
}

export function sanitizeGroqApiKey(value: unknown): string {
  return sanitizeTrimmedString(value, 'API key', MAX_API_KEY_LENGTH);
}

export function sanitizeArrayBufferPayload(value: unknown): ArrayBuffer {
  if (value instanceof ArrayBuffer) {
    if (value.byteLength > MAX_AUDIO_BYTES) {
      throw new Error('Audio payload is too large.');
    }
    return value;
  }

  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    if (view.byteLength > MAX_AUDIO_BYTES) {
      throw new Error('Audio payload is too large.');
    }
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
  }

  throw new Error('Invalid audio payload.');
}

export function sanitizeDurationMs(value: unknown): number {
  return clampInteger(value, 0, MAX_AUDIO_DURATION_MS, 0);
}

export function sanitizeSpeechMetrics(value: unknown): SpeechMetrics | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isPlainObject(value)) {
    throw new Error('Invalid speech metrics.');
  }

  return {
    frameCount: clampInteger(value.frameCount, 0, 1_000_000, 0),
    speechFrames: clampInteger(value.speechFrames, 0, 1_000_000, 0),
    longestSpeechRunFrames: clampInteger(value.longestSpeechRunFrames, 0, 1_000_000, 0),
    peakBand: Math.min(1, Math.max(0, asFiniteNumber(value.peakBand) ?? 0)),
    averageBand: Math.min(1, Math.max(0, asFiniteNumber(value.averageBand) ?? 0)),
    peakRms: Math.min(1, Math.max(0, asFiniteNumber(value.peakRms) ?? 0)),
    averageRms: Math.min(1, Math.max(0, asFiniteNumber(value.averageRms) ?? 0)),
  };
}

export function sanitizeAudioLevels(levels: unknown): number[] {
  if (!Array.isArray(levels)) {
    return [0];
  }

  const sanitized = levels
    .slice(0, MAX_AUDIO_LEVEL_COUNT)
    .map((level) => {
      const numericLevel = asFiniteNumber(level);
      return numericLevel === null ? 0 : Math.min(1, Math.max(0, numericLevel));
    });

  return sanitized.length ? sanitized : [0];
}

export function sanitizeSettingsUpdate(overrides: unknown): Partial<Settings> {
  if (!isPlainObject(overrides)) {
    throw new Error('Invalid settings payload.');
  }

  const sanitized: Partial<Settings> = {};

  if (overrides.toggleHotkey !== undefined) {
    sanitized.toggleHotkey = sanitizeHotkeyInput(overrides.toggleHotkey, DEFAULT_TOGGLE_HOTKEY);
  }

  if (overrides.pushToTalkHotkey !== undefined) {
    sanitized.pushToTalkHotkey = sanitizeHotkeyInput(overrides.pushToTalkHotkey, DEFAULT_PUSH_TO_TALK_HOTKEY);
  }

  if (overrides.cancelHotkey !== undefined) {
    sanitized.cancelHotkey = sanitizeHotkeyInput(overrides.cancelHotkey, DEFAULT_CANCEL_HOTKEY);
  }

  if (overrides.aiCleanup !== undefined) {
    sanitized.aiCleanup = sanitizeBoolean(overrides.aiCleanup, 'aiCleanup');
  }

  if (overrides.useCloudTranscription !== undefined) {
    sanitized.useCloudTranscription = sanitizeBoolean(overrides.useCloudTranscription, 'useCloudTranscription');
  }

  if (overrides.selectedGlobalStyleId !== undefined) {
    sanitized.selectedGlobalStyleId = sanitizeSelectedGlobalStyleId(
      sanitizeOptionalTrimmedString(overrides.selectedGlobalStyleId, 'selectedGlobalStyleId', 64)
    );
  }

  if (overrides.writingMode !== undefined) {
    const writingMode = sanitizeTrimmedString(overrides.writingMode, 'writingMode', 32);
    if (['standard', 'formal', 'casual', 'bullet', 'code'].includes(writingMode)) {
      sanitized.writingMode = writingMode as Settings['writingMode'];
    }
  }

  if (overrides.language !== undefined) {
    sanitized.language = sanitizeTrimmedString(overrides.language, 'language', MAX_LANGUAGE_CODE_LENGTH);
  }

  if (overrides.selectedLanguages !== undefined) {
    sanitized.selectedLanguages = sanitizeLanguageListInput(overrides.selectedLanguages);
  }

  if (overrides.autoDetectLanguage !== undefined) {
    sanitized.autoDetectLanguage = sanitizeBoolean(overrides.autoDetectLanguage, 'autoDetectLanguage');
  }

  if (overrides.microphoneId !== undefined) {
    sanitized.microphoneId = sanitizeTrimmedString(
      overrides.microphoneId,
      'microphoneId',
      MAX_MICROPHONE_ID_LENGTH,
      { allowEmpty: true }
    );
  }

  if (overrides.microphoneLabel !== undefined) {
    sanitized.microphoneLabel = sanitizeTrimmedString(
      overrides.microphoneLabel,
      'microphoneLabel',
      MAX_MICROPHONE_LABEL_LENGTH,
      { allowEmpty: true }
    );
  }

  if (overrides.launchAtStartup !== undefined) {
    sanitized.launchAtStartup = sanitizeBoolean(overrides.launchAtStartup, 'launchAtStartup');
  }

  if (overrides.showOverlay !== undefined) {
    sanitized.showOverlay = sanitizeBoolean(overrides.showOverlay, 'showOverlay');
  }

  if (overrides.showAppInDock !== undefined) {
    sanitized.showAppInDock = sanitizeBoolean(overrides.showAppInDock, 'showAppInDock');
  }

  if (overrides.themeMode !== undefined) {
    sanitized.themeMode = 'light';
  }

  if (overrides.overlayPosition !== undefined) {
    const overlayPosition = sanitizeTrimmedString(overrides.overlayPosition, 'overlayPosition', 32);
    if (overlayPosition === 'top-center' || overlayPosition === 'bottom-center') {
      sanitized.overlayPosition = overlayPosition;
    }
  }

  if (overrides.onboardingComplete !== undefined) {
    sanitized.onboardingComplete = sanitizeBoolean(overrides.onboardingComplete, 'onboardingComplete');
  }

  return sanitized;
}

export function sanitizeDictionaryItemInputPayload(value: unknown): DictionaryItemInput {
  if (!isPlainObject(value)) {
    throw new Error('Invalid dictionary item.');
  }

  const correctMisspelling = sanitizeBoolean(value.correctMisspelling, 'correctMisspelling');

  return {
    ...(value.id !== undefined ? { id: sanitizeEntryId(value.id) } : {}),
    phrase: sanitizeTrimmedString(value.phrase, 'phrase', MAX_DICTIONARY_PHRASE_LENGTH, { collapseWhitespace: true }),
    misspelling: correctMisspelling
      ? sanitizeOptionalTrimmedString(value.misspelling, 'misspelling', MAX_DICTIONARY_MISSPELLING_LENGTH, { collapseWhitespace: true })
      : null,
    correctMisspelling,
    shared: sanitizeBoolean(value.shared, 'shared'),
  };
}

export function sanitizeSnippetInputPayload(value: unknown): SnippetInput {
  if (!isPlainObject(value)) {
    throw new Error('Invalid snippet.');
  }

  return {
    ...(value.id !== undefined ? { id: sanitizeEntryId(value.id) } : {}),
    trigger: sanitizeTrimmedString(value.trigger, 'trigger', MAX_SNIPPET_TRIGGER_LENGTH, { collapseWhitespace: true }),
    expansion: sanitizeTrimmedString(value.expansion, 'expansion', MAX_SNIPPET_EXPANSION_LENGTH),
    category: sanitizeOptionalTrimmedString(value.category, 'category', MAX_CATEGORY_LENGTH, { collapseWhitespace: true }) ?? '',
    shared: sanitizeBoolean(value.shared, 'shared'),
  };
}
