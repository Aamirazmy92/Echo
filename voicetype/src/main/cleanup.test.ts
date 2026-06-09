import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '../shared/types';

const mocks = vi.hoisted(() => ({
  proxyCleanup: vi.fn(),
  isProUser: vi.fn(),
}));

vi.mock('./cloud', () => ({
  proxyCleanup: mocks.proxyCleanup,
}));

vi.mock('./entitlements', () => ({
  isProUser: mocks.isProUser,
}));

import { cleanupText } from './cleanup';

const settings: Settings = {
  toggleHotkey: ['Control', 'Space'],
  pushToTalkHotkey: ['Control'],
  cancelHotkey: ['Escape'],
  groqApiKey: '',
  aiCleanup: true,
  useCloudTranscription: false,
  selectedGlobalStyleId: null,
  language: 'auto',
  selectedLanguages: ['en'],
  autoDetectLanguage: true,
  microphoneId: '',
  microphoneLabel: '',
  launchAtStartup: false,
  showOverlay: true,
  showAppInDock: true,
  themeMode: 'light',
  overlayPosition: 'top-center',
  onboardingComplete: true,
};

describe('cleanupText routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps Pro cleanup local when Local mode is selected', async () => {
    mocks.isProUser.mockReturnValue(true);

    const result = await cleanupText('hello there', null, { ...settings, useCloudTranscription: false });

    expect(result).toBe('hello there');
    expect(mocks.proxyCleanup).not.toHaveBeenCalled();
  });

  it('uses the Pro cleanup proxy when Cloud mode is selected', async () => {
    mocks.isProUser.mockReturnValue(true);
    mocks.proxyCleanup.mockResolvedValue({
      choices: [{ message: { content: 'cleaned hello there' } }],
    });

    const result = await cleanupText('hello there', null, { ...settings, useCloudTranscription: true });

    expect(result).toBe('cleaned hello there');
    expect(mocks.proxyCleanup).toHaveBeenCalledOnce();
  });

  it('does not let non-Pro users unlock cloud cleanup with a personal key', async () => {
    mocks.isProUser.mockReturnValue(false);

    const result = await cleanupText('hello there', null, { ...settings, useCloudTranscription: true });

    expect(result).toBe('hello there');
    expect(mocks.proxyCleanup).not.toHaveBeenCalled();
  });
});
