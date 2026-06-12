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

import { buildCleanupPlan, cleanupText, finalizeCleanup } from './cleanup';

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

describe('buildCleanupPlan', () => {
  it('returns null when aiCleanup is disabled', () => {
    expect(buildCleanupPlan(null, { ...settings, aiCleanup: false })).toBeNull();
  });

  it('returns model, systemPrompt and temperature for the default tone', () => {
    const plan = buildCleanupPlan(null, settings);
    expect(plan).not.toBeNull();
    expect(plan!.model).toBe('llama-3.1-8b-instant');
    expect(plan!.systemPrompt).toContain('text rewriter for speech dictation');
    expect(typeof plan!.temperature).toBe('number');
  });
});

describe('finalizeCleanup', () => {
  it('keeps the cleaned text when it is sane', () => {
    expect(finalizeCleanup('hello world um', 'Hello world.', null)).toBe('Hello world.');
  });

  it('falls back to raw text when the model replied like an assistant', () => {
    expect(
      finalizeCleanup('please fix the bug', "I don't see any images attached to this conversation", null)
    ).toBe('please fix the bug');
  });

  it('falls back to raw text when cleaned text is empty', () => {
    expect(finalizeCleanup('keep me', '', null)).toBe('keep me');
  });
});
