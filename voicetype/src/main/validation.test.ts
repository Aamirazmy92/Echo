import { describe, expect, it } from 'vitest';
import {
  sanitizeArrayBufferPayload,
  sanitizeAudioLevels,
  sanitizeDurationMs,
  sanitizeEntryIds,
  sanitizeExportFormat,
  sanitizePagination,
  sanitizeSettingsUpdate,
  sanitizeSnippetInputPayload,
} from './validation';

describe('IPC validation helpers', () => {
  it('clamps pagination inputs', () => {
    expect(sanitizePagination(999_999, -20)).toEqual({ limit: 10_000, offset: 0 });
    expect(sanitizePagination('bad', 'bad', 25)).toEqual({ limit: 25, offset: 0 });
  });

  it('rejects invalid ids and oversized bulk deletes', () => {
    expect(() => sanitizeEntryIds([1, 2, 0])).toThrow('Invalid id at index 2.');
    expect(() => sanitizeEntryIds(Array.from({ length: 600 }, (_, index) => index + 1))).toThrow('Expected 1–500 ids.');
  });

  it('sanitizes audio payload metadata', () => {
    const buffer = new ArrayBuffer(8);
    expect(sanitizeArrayBufferPayload(buffer)).toBe(buffer);
    expect(sanitizeDurationMs(999_999_999)).toBe(15 * 60 * 1000);
    expect(sanitizeAudioLevels([0.2, Number.NaN, 2, -2])).toEqual([0.2, 0, 1, 0]);
  });

  it('validates export format', () => {
    expect(sanitizeExportFormat('csv')).toBe('csv');
    expect(() => sanitizeExportFormat('xml')).toThrow('Invalid export format.');
  });

  it('sanitizes partial settings updates', () => {
    expect(sanitizeSettingsUpdate({ useCloudTranscription: true, themeMode: 'dark' })).toEqual({
      useCloudTranscription: true,
      themeMode: 'light',
    });
    expect(() => sanitizeSettingsUpdate(null)).toThrow('Invalid settings payload.');
  });

  it('normalizes snippet payloads', () => {
    expect(sanitizeSnippetInputPayload({ trigger: '  sig  ', expansion: ' Hello ', category: ' Work ', shared: false })).toMatchObject({
      trigger: 'sig',
      expansion: 'Hello',
      category: 'Work',
    });
  });
});
