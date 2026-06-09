import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '../shared/types';

const mocks = vi.hoisted(() => ({
  transcribeWithLocalModel: vi.fn(),
  transcribeWithCloudProxy: vi.fn(),
  getEntitlementsSnapshot: vi.fn(),
  isProUser: vi.fn(),
  refreshEntitlements: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock('./localTranscribe', () => ({
  transcribeWithLocalModel: mocks.transcribeWithLocalModel,
}));

vi.mock('./cloudTranscribe', () => ({
  transcribeWithCloudProxy: mocks.transcribeWithCloudProxy,
}));

vi.mock('./entitlements', () => ({
  getEntitlementsSnapshot: mocks.getEntitlementsSnapshot,
  isProUser: mocks.isProUser,
  refreshEntitlements: mocks.refreshEntitlements,
}));

vi.mock('./logger', () => ({
  logInfo: mocks.logInfo,
  logWarn: mocks.logWarn,
}));

import { transcribeAudio } from './transcribe';

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

function speechBuffer(): ArrayBuffer {
  const samples = new Float32Array(16000);
  samples[0] = 0.2;
  return samples.buffer;
}

describe('transcribeAudio routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getEntitlementsSnapshot.mockReturnValue({
      tier: 'anonymous',
      status: 'anonymous',
      plan: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      trialEnd: null,
      fairUseExceeded: false,
      fairUseRemainingSeconds: 0,
      fairUseUsedSeconds: 0,
      fairUseCapSeconds: 0,
      fetchedAt: 0,
      loading: false,
      error: 'not loaded',
    });
  });

  it('keeps local dictation working when entitlement refresh fails', async () => {
    mocks.isProUser.mockReturnValue(false);
    mocks.refreshEntitlements.mockRejectedValue(new Error('refreshEntitlements is not defined'));
    mocks.transcribeWithLocalModel.mockResolvedValue('hello there');

    const result = await transcribeAudio(speechBuffer(), settings);

    expect(result).toEqual({ text: 'hello there', method: 'local', cloudError: undefined, detectedLanguage: undefined });
    expect(mocks.refreshEntitlements).toHaveBeenCalledOnce();
    expect(mocks.transcribeWithLocalModel).toHaveBeenCalledOnce();
    expect(mocks.logWarn).toHaveBeenCalledWith(
      'transcribe',
      'Entitlements refresh failed before routing, continuing with cached state',
      expect.any(Error),
    );
  });

  it('routes Pro users through the cloud proxy without a Groq key when Cloud mode is selected', async () => {
    mocks.isProUser.mockReturnValue(true);
    mocks.getEntitlementsSnapshot.mockReturnValue({
      tier: 'pro',
      status: 'active',
      plan: 'pro_monthly',
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      trialEnd: null,
      fairUseExceeded: false,
      fairUseRemainingSeconds: 1000,
      fairUseUsedSeconds: 0,
      fairUseCapSeconds: 1000,
      fetchedAt: Date.now(),
      loading: false,
      error: null,
    });
    mocks.transcribeWithCloudProxy.mockResolvedValue({ text: 'hello from pro', detectedLanguage: 'en' });

    const result = await transcribeAudio(speechBuffer(), { ...settings, useCloudTranscription: true });

    expect(result).toEqual({
      text: 'hello from pro',
      method: 'cloud',
      cloudError: undefined,
      detectedLanguage: 'en',
    });
    expect(mocks.refreshEntitlements).not.toHaveBeenCalled();
    expect(mocks.transcribeWithCloudProxy).toHaveBeenCalledOnce();
    expect(mocks.transcribeWithLocalModel).not.toHaveBeenCalled();
  });

  it('lets Pro users choose local transcription', async () => {
    mocks.isProUser.mockReturnValue(true);
    mocks.getEntitlementsSnapshot.mockReturnValue({
      tier: 'pro',
      status: 'active',
      plan: 'pro_monthly',
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      trialEnd: null,
      fairUseExceeded: false,
      fairUseRemainingSeconds: 1000,
      fairUseUsedSeconds: 0,
      fairUseCapSeconds: 1000,
      fetchedAt: Date.now(),
      loading: false,
      error: null,
    });
    mocks.transcribeWithLocalModel.mockResolvedValue('local pro choice');

    const result = await transcribeAudio(speechBuffer(), { ...settings, useCloudTranscription: false });

    expect(result).toEqual({
      text: 'local pro choice',
      method: 'local',
      cloudError: undefined,
      detectedLanguage: undefined,
    });
    expect(mocks.refreshEntitlements).not.toHaveBeenCalled();
    expect(mocks.transcribeWithCloudProxy).not.toHaveBeenCalled();
    expect(mocks.transcribeWithLocalModel).toHaveBeenCalledOnce();
  });

  it('does not let non-Pro users unlock cloud with a personal Groq key', async () => {
    mocks.isProUser.mockReturnValue(false);
    mocks.refreshEntitlements.mockResolvedValue({
      tier: 'free',
      status: 'free',
      plan: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      trialEnd: null,
      fairUseExceeded: false,
      fairUseRemainingSeconds: 0,
      fairUseUsedSeconds: 0,
      fairUseCapSeconds: 0,
      fetchedAt: Date.now(),
      loading: false,
      error: null,
    });
    mocks.getEntitlementsSnapshot.mockReturnValue({
      tier: 'free',
      status: 'free',
      plan: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      trialEnd: null,
      fairUseExceeded: false,
      fairUseRemainingSeconds: 0,
      fairUseUsedSeconds: 0,
      fairUseCapSeconds: 0,
      fetchedAt: Date.now(),
      loading: false,
      error: null,
    });
    mocks.transcribeWithLocalModel.mockResolvedValue('free local only');

    const result = await transcribeAudio(speechBuffer(), { ...settings, useCloudTranscription: true });

    expect(result).toEqual({
      text: 'free local only',
      method: 'local',
      cloudError: undefined,
      detectedLanguage: undefined,
    });
    expect(mocks.refreshEntitlements).toHaveBeenCalledOnce();
    expect(mocks.transcribeWithCloudProxy).not.toHaveBeenCalled();
    expect(mocks.transcribeWithLocalModel).toHaveBeenCalledOnce();
  });
});
