import Store from 'electron-store';
import { Settings } from '../shared/types';
import { app, safeStorage } from 'electron';
import {
  migrateLegacyStyleSelection,
  sanitizeSelectedGlobalStyleId,
} from '../shared/styleConfig';
import {
  DEFAULT_CANCEL_HOTKEY,
  DEFAULT_PUSH_TO_TALK_HOTKEY,
  DEFAULT_TOGGLE_HOTKEY,
  normalizeHotkeyAccelerator,
  normalizeHotkeyList,
} from '../shared/hotkey';
import {
  getEffectiveLanguageSelection,
  getPrimarySelectedLanguage,
} from '../shared/languages';

const defaults: Settings = {
  toggleHotkey: [DEFAULT_TOGGLE_HOTKEY],
  pushToTalkHotkey: [DEFAULT_PUSH_TO_TALK_HOTKEY],
  cancelHotkey: [DEFAULT_CANCEL_HOTKEY],
  groqApiKey: '',
  aiCleanup: true,
  useCloudTranscription: true,
  selectedGlobalStyleId: null,
  writingMode: 'standard',
  language: 'en',
  selectedLanguages: ['en'],
  autoDetectLanguage: false,
  microphoneId: '',
  microphoneLabel: 'Default microphone',
  launchAtStartup: false,
  showOverlay: true,
  showAppInDock: true,
  themeMode: 'light',
  overlayPosition: 'bottom-center',
  onboardingComplete: false,
};

let store: Store<Settings>;
const ENCRYPTED_SECRET_PREFIX = 'safe:';

function encryptSecret(secret: string): string {
  if (!secret) return '';
  if (!safeStorage.isEncryptionAvailable()) {
    // Refuse to persist a secret in plaintext. The caller (setGroqApiKey) is
    // expected to check isSecureStorageAvailable() before reaching here, but
    // this is a defense-in-depth guard so we never silently leak the key
    // into ~/AppData/Roaming/Echo/config.json in clear text.
    throw new Error(
      'Secure storage is unavailable on this system. Echo cannot persist the Groq API key safely.'
    );
  }
  return `${ENCRYPTED_SECRET_PREFIX}${safeStorage.encryptString(secret).toString('base64')}`;
}

export function isSecureStorageAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function decryptSecret(secret: string): string {
  if (!secret) return '';
  if (!secret.startsWith(ENCRYPTED_SECRET_PREFIX)) return secret;
  if (!safeStorage.isEncryptionAvailable()) return '';

  try {
    const encrypted = Buffer.from(secret.slice(ENCRYPTED_SECRET_PREFIX.length), 'base64');
    return safeStorage.decryptString(encrypted);
  } catch {
    return '';
  }
}

// UI masks a saved key as a string of bullets. If that mask ever reaches
// setGroqApiKey (e.g. the user clicks Save without editing, or pastes next
// to the mask), we must reject it so we don't overwrite the real encrypted
// key with a string of bullet characters that Groq will then reject.
const MASK_PLACEHOLDER_REGEX = /^[\u2022\s]*$/;
function looksLikeMaskPlaceholder(value: string): boolean {
  return MASK_PLACEHOLDER_REGEX.test(value);
}

function hydrateSettings(settings: Settings): Settings {
  const languageSelection = getEffectiveLanguageSelection(settings);

  return {
    ...settings,
    language: languageSelection.autoDetectLanguage ? 'auto' : getPrimarySelectedLanguage(languageSelection),
    selectedLanguages: languageSelection.selectedLanguages,
    autoDetectLanguage: languageSelection.autoDetectLanguage,
    groqApiKey: decryptSecret(settings.groqApiKey) ? '••••••••' : '',
  };
}

function persistGroqApiKeyIfNeeded(): void {
  const storedKey = store.get('groqApiKey');
  if (typeof storedKey !== 'string' || !storedKey) return;
  if (storedKey.startsWith(ENCRYPTED_SECRET_PREFIX)) return;

  const encryptedKey = encryptSecret(storedKey);
  if (encryptedKey !== storedKey) {
    store.set('groqApiKey', encryptedKey);
  }
}

export function initStore() {
  store = new Store<Settings>({ defaults });
  const legacyStore = store as Store<Settings> & {
    get(key: string): unknown;
    delete(key: string): void;
  };

  // One-time repair: if an earlier build saved a bullet-mask as the key,
  // drop it so the user is prompted to enter a real key instead of being
  // stuck in an undecryptable / Groq-rejecting state.
  try {
    const rawStoredKey = store.get('groqApiKey');
    if (typeof rawStoredKey === 'string' && rawStoredKey.startsWith(ENCRYPTED_SECRET_PREFIX)) {
      const decrypted = decryptSecret(rawStoredKey);
      if (decrypted && looksLikeMaskPlaceholder(decrypted)) {
        console.warn('[store] Discarding previously-saved API key that was a UI mask placeholder.');
        store.set('groqApiKey', '');
      }
    }
  } catch {
    // ignore — decryption errors are handled at read time
  }

  const legacyHotkey = legacyStore.get('hotkey') as string | undefined;
  if (legacyHotkey && !store.get('pushToTalkHotkey')) {
    store.set('pushToTalkHotkey', [normalizeHotkeyAccelerator(legacyHotkey, DEFAULT_PUSH_TO_TALK_HOTKEY)]);
  }

  const normalizedToggleHotkey = normalizeHotkeyList(legacyStore.get('toggleHotkey'), DEFAULT_TOGGLE_HOTKEY);
  if (JSON.stringify(normalizedToggleHotkey) !== JSON.stringify(store.get('toggleHotkey'))) {
    store.set('toggleHotkey', normalizedToggleHotkey);
  }

  const normalizedPushToTalkHotkey = normalizeHotkeyList(legacyStore.get('pushToTalkHotkey'), DEFAULT_PUSH_TO_TALK_HOTKEY);
  if (JSON.stringify(normalizedPushToTalkHotkey) !== JSON.stringify(store.get('pushToTalkHotkey'))) {
    store.set('pushToTalkHotkey', normalizedPushToTalkHotkey);
  }

  const normalizedCancelHotkey = normalizeHotkeyList(legacyStore.get('cancelHotkey'), DEFAULT_CANCEL_HOTKEY);
  if (JSON.stringify(normalizedCancelHotkey) !== JSON.stringify(store.get('cancelHotkey'))) {
    store.set('cancelHotkey', normalizedCancelHotkey);
  }

  const storedSelectedGlobalStyleId = legacyStore.get('selectedGlobalStyleId') as string | null | undefined;
  if (storedSelectedGlobalStyleId === undefined) {
    const migratedStyleId = migrateLegacyStyleSelection(
      legacyStore.get('categoryStyleSelections'),
      legacyStore.get('enabledStyleCategories')
    );
    store.set('selectedGlobalStyleId', migratedStyleId);
  } else {
    store.set('selectedGlobalStyleId', sanitizeSelectedGlobalStyleId(storedSelectedGlobalStyleId));
  }

  legacyStore.delete('categoryStyleSelections');
  legacyStore.delete('enabledStyleCategories');
  persistGroqApiKeyIfNeeded();

  const languageSelection = getEffectiveLanguageSelection({
    language: legacyStore.get('language'),
    selectedLanguages: legacyStore.get('selectedLanguages'),
    autoDetectLanguage: legacyStore.get('autoDetectLanguage'),
  });
  store.set('selectedLanguages', languageSelection.selectedLanguages);
  store.set('autoDetectLanguage', languageSelection.autoDetectLanguage);
  store.set('language', languageSelection.autoDetectLanguage ? 'auto' : getPrimarySelectedLanguage(languageSelection));

  if (store.get('themeMode') !== 'light') {
    store.set('themeMode', 'light');
  }
  if (store.get('showOverlay') === undefined) {
    store.set('showOverlay', true);
  }
  if (app.dock) {
    if (store.get('showAppInDock') === false) {
      app.dock.hide();
    } else {
      app.dock.show();
    }
  }
  if (store.get('launchAtStartup')) {
    app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] });
  }
}

export function getSettings(): Settings {
  return hydrateSettings(store.store);
}

export function hasGroqApiKey(): boolean {
  const storedKey = store.get('groqApiKey');
  if (!storedKey || typeof storedKey !== 'string') return false;
  return !!decryptSecret(storedKey);
}

export function getGroqApiKeyPlain(): string {
  const storedKey = store.get('groqApiKey');
  if (!storedKey || typeof storedKey !== 'string') return '';
  return decryptSecret(storedKey);
}

export function setGroqApiKey(key: string): void {
  const trimmed = key.trim();

  // Strip any bullet mask characters that a careless paste may have left
  // glued to the real key — e.g. "••••••••gsk_abc...". Without this the
  // saved value is corrupted and Groq rejects it forever after, which is
  // exactly the "my key keeps resetting" symptom users report.
  const cleaned = trimmed.replace(/[\u2022]+/g, '');

  if (!cleaned || looksLikeMaskPlaceholder(trimmed)) {
    throw new Error(
      'Refusing to save an empty or masked API key. Clear the field and paste a real key.'
    );
  }

  store.set('groqApiKey', encryptSecret(cleaned));
}

export function clearGroqApiKey(): void {
  store.set('groqApiKey', '');
}

export function saveSettings(partial: Partial<Settings>) {
  const normalizedPartial: Partial<Settings> = { ...partial };
  const currentSettings = getSettings();

  if (partial.toggleHotkey !== undefined) {
    normalizedPartial.toggleHotkey = normalizeHotkeyList(partial.toggleHotkey, DEFAULT_TOGGLE_HOTKEY);
  }

  if (partial.pushToTalkHotkey !== undefined) {
    normalizedPartial.pushToTalkHotkey = normalizeHotkeyList(partial.pushToTalkHotkey, DEFAULT_PUSH_TO_TALK_HOTKEY);
  }

  if (partial.cancelHotkey !== undefined) {
    normalizedPartial.cancelHotkey = normalizeHotkeyList(partial.cancelHotkey, DEFAULT_CANCEL_HOTKEY);
  }

  if (partial.selectedGlobalStyleId !== undefined) {
    normalizedPartial.selectedGlobalStyleId = sanitizeSelectedGlobalStyleId(partial.selectedGlobalStyleId);
  }

  if (partial.groqApiKey !== undefined) {
    console.warn('Ignoring groqApiKey in saveSettings — use setGroqApiKey/clearGroqApiKey instead');
    delete normalizedPartial.groqApiKey;
  }

  if (
    partial.language !== undefined ||
    partial.selectedLanguages !== undefined ||
    partial.autoDetectLanguage !== undefined
  ) {
    const languageSelection = getEffectiveLanguageSelection({
      language: partial.language ?? currentSettings.language,
      selectedLanguages: partial.selectedLanguages ?? currentSettings.selectedLanguages,
      autoDetectLanguage: partial.autoDetectLanguage ?? currentSettings.autoDetectLanguage,
    });
    normalizedPartial.selectedLanguages = languageSelection.selectedLanguages;
    normalizedPartial.autoDetectLanguage = languageSelection.autoDetectLanguage;
    normalizedPartial.language = languageSelection.autoDetectLanguage ? 'auto' : getPrimarySelectedLanguage(languageSelection);
  }

  delete normalizedPartial.categoryStyleSelections;
  delete normalizedPartial.enabledStyleCategories;

  store.set(normalizedPartial);

  if (partial.launchAtStartup !== undefined) {
    app.setLoginItemSettings({
      openAtLogin: partial.launchAtStartup,
      args: partial.launchAtStartup ? ['--hidden'] : [],
    });
  }

  if (partial.showAppInDock !== undefined) {
    if (app.dock) {
      if (partial.showAppInDock) {
        app.dock.show();
      } else {
        app.dock.hide();
      }
    }
  }
}
