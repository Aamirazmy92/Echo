import { Tray, Menu, app, BrowserWindow, nativeImage, type MenuItemConstructorOptions } from 'electron';
import fs from 'fs';
import path from 'path';
import { AppState, type AppTab } from '../shared/types';
import { getEffectiveLanguageSelection, LANGUAGE_OPTIONS } from '../shared/languages';
import { getSettings, saveSettings } from './store';

let tray: Tray | null = null;
let trayWindow: BrowserWindow | null = null;
let cachedMicrophones: Array<{ id: string; label: string }> = [];

function resolveAssetPath(filename: string): string {
  // Look in multiple candidate locations so both dev (unpacked repo) and
  // packaged (inside `resources/`) layouts work without special casing.
  const candidates = [
    path.join(__dirname, '..', '..', 'assets', filename),
    path.join(app.getAppPath(), 'assets', filename),
    typeof process.resourcesPath === 'string'
      ? path.join(process.resourcesPath, 'assets', filename)
      : '',
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // Ignore — asar may throw on existsSync for paths inside asar during
      // some Electron versions; we'll fall through to the default.
    }
  }

  return candidates[0] ?? filename;
}

function loadTrayImage(filename: string) {
  const resolved = resolveAssetPath(filename);
  const image = nativeImage.createFromPath(resolved);
  return image.isEmpty() ? nativeImage.createEmpty() : image;
}

export function createTray(mainWindow: BrowserWindow): Tray {
  trayWindow = mainWindow;
  tray = new Tray(loadTrayImage('tray-idle.png'));
  tray.setContextMenu(buildMinimalTrayMenu());
  mainWindow.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      void refreshTrayMenu();
    }, 2500);
  });

  tray.on('double-click', () => {
    if (mainWindow.isVisible()) mainWindow.focus();
    else mainWindow.show();
  });

  return tray;
}

function buildMinimalTrayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Echo v1.0', enabled: false },
    { type: 'separator' },
    { label: 'Open Dashboard', click: () => showTab('dashboard') },
    { label: 'Open Style', click: () => showTab('style') },
    { label: 'Open Settings', click: () => showTab('settings') },
    { type: 'separator' },
    { label: 'Quit Echo', click: () => app.quit() },
  ]);
}

export function updateTrayState(state: AppState) {
  if (!tray) return;
  const icons: Partial<Record<AppState, string>> = {
    idle: 'tray-idle.png',
    recording: 'tray-recording.png',
    processing: 'tray-processing.png',
    error: 'tray-error.png',
    success: 'tray-idle.png',
  };
  tray.setImage(loadTrayImage(icons[state] || 'tray-idle.png'));
  tray.setToolTip(`Echo — ${state.charAt(0).toUpperCase() + state.slice(1)}`);
}

export async function refreshTrayMenu() {
  if (!trayWindow || trayWindow.isDestroyed()) return;
  cachedMicrophones = await getAudioInputDevices(trayWindow);
  await updateTrayMenu();
}

async function getAudioInputDevices(mainWindow: BrowserWindow): Promise<Array<{ id: string; label: string }>> {
  if (mainWindow.webContents.isLoading()) {
    return cachedMicrophones;
  }

  try {
    const devices = await mainWindow.webContents.executeJavaScript(`
      navigator.mediaDevices.enumerateDevices()
        .then((devices) =>
          devices
            .filter((device) => device.kind === 'audioinput')
            .map((device, index) => ({
              id: device.deviceId,
              label: device.label || 'Microphone ' + (index + 1)
            }))
        )
        .catch(() => [])
    `, true);

    return Array.isArray(devices) ? devices : cachedMicrophones;
  } catch {
    return cachedMicrophones;
  }
}

function showTab(tab: AppTab) {
  if (!trayWindow || trayWindow.isDestroyed()) return;
  trayWindow.show();
  trayWindow.focus();
  trayWindow.webContents.send('navigate-tab', tab);
}

async function updateTrayMenu() {
  if (!tray) return;

  const settings = getSettings();
  const { selectedLanguages, autoDetectLanguage } = getEffectiveLanguageSelection(settings);

  const microphoneItems: MenuItemConstructorOptions[] = [
    {
      label: 'Default microphone',
      type: 'radio',
      checked: !settings.microphoneId,
      click: () => {
        saveSettings({ microphoneId: '', microphoneLabel: 'Default microphone' });
        void refreshTrayMenu();
      },
    },
    ...cachedMicrophones.map((device) => ({
      label: device.label,
      type: 'radio' as const,
      checked: settings.microphoneId === device.id,
      click: () => {
        saveSettings({ microphoneId: device.id, microphoneLabel: device.label });
        void refreshTrayMenu();
      },
    })),
  ];

  const languageItems: MenuItemConstructorOptions[] = [
    {
      label: 'Auto-detect spoken language',
      type: 'checkbox',
      checked: autoDetectLanguage,
      click: () => {
        saveSettings({ autoDetectLanguage: !autoDetectLanguage });
        void refreshTrayMenu();
      },
    },
    { type: 'separator' },
    ...LANGUAGE_OPTIONS
      .filter((language) => language.id !== 'auto')
      .map((language) => {
        const isSelected = selectedLanguages.includes(language.id);
        const isOnlySelectedLanguage = isSelected && selectedLanguages.length === 1;

        return {
          label: language.label,
          type: 'checkbox' as const,
          checked: isSelected,
          enabled: !autoDetectLanguage && !isOnlySelectedLanguage,
          click: () => {
            const nextSelectedLanguages = isSelected
              ? selectedLanguages.filter((value) => value !== language.id)
              : [...selectedLanguages, language.id];

            saveSettings({ selectedLanguages: nextSelectedLanguages });
            void refreshTrayMenu();
          },
        };
      }),
  ];

  const ctxMenu = Menu.buildFromTemplate([
    { label: 'Echo v1.0', enabled: false },
    { type: 'separator' },
    { label: 'Microphone', submenu: microphoneItems },
    { label: 'Languages', submenu: languageItems },
    { type: 'separator' },
    { label: 'Open Dashboard', click: () => showTab('dashboard') },
    { label: 'Open Style', click: () => showTab('style') },
    { label: 'Open Settings', click: () => showTab('settings') },
    { type: 'separator' },
    { label: 'Quit Echo', click: () => app.quit() },
  ]);

  tray.setContextMenu(ctxMenu);
}
