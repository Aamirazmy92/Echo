import { describe, expect, it } from 'vitest';
import { getStartOfWeek, getWeekStartIso } from './usageWindow';

describe('getStartOfWeek', () => {
  it('returns the preceding Monday at local midnight', () => {
    // Thursday 2026-06-11 15:30 local
    const start = getStartOfWeek(new Date(2026, 5, 11, 15, 30));
    expect(start.getDay()).toBe(1); // Monday
    expect(start.getDate()).toBe(8);
    expect(start.getHours()).toBe(0);
    expect(start.getMinutes()).toBe(0);
  });

  it('returns the same day at midnight when called on a Monday', () => {
    const start = getStartOfWeek(new Date(2026, 5, 8, 9, 0));
    expect(start.getDate()).toBe(8);
    expect(start.getHours()).toBe(0);
  });

  it('treats Sunday as the last day of the week', () => {
    const start = getStartOfWeek(new Date(2026, 5, 14, 23, 59));
    expect(start.getDay()).toBe(1);
    expect(start.getDate()).toBe(8);
  });
});

describe('getWeekStartIso', () => {
  it('returns an ISO string comparable to entry created_at values', () => {
    const iso = getWeekStartIso(new Date(2026, 5, 11, 15, 30));
    expect(iso).toBe(getStartOfWeek(new Date(2026, 5, 11, 15, 30)).toISOString());
    // ISO strings compare lexicographically in the same way as instants.
    expect(iso < new Date(2026, 5, 11, 16, 0).toISOString()).toBe(true);
  });
});
