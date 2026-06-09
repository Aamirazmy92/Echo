import Store from 'electron-store';
import { Settings } from '../shared/types';
import { app } from 'electron';
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

function hydrateSettings(settings: Settings): Settings {
  const languageSelection = getEffectiveLanguageSelection(settings);

  return {
    ...settings,
    language: languageSelection.autoDetectLanguage ? 'auto' : getPrimarySelectedLanguage(languageSelection),
    selectedLanguages: languageSelection.selectedLanguages,
    autoDetectLanguage: languageSelection.autoDetectLanguage,
    groqApiKey: '',
  };
}

export function initStore() {
  store = new Store<Settings>({ defaults });
  const legacyStore = store as Store<Settings> & {
    get(key: string): unknown;
    delete(key: string): void;
  };

  if (store.get('groqApiKey')) {
    console.warn('[store] Clearing saved Groq API key; cloud access now requires Echo Pro.');
    store.set('groqApiKey', '');
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
    console.warn('Ignoring groqApiKey in saveSettings — personal Groq keys are no longer supported');
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
