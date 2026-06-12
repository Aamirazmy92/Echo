import { describe, expect, it } from 'vitest';
import { PreRollBuffer, concatFloat32 } from './pcmCapture';

function chunk(...values: number[]): Float32Array {
  return Float32Array.from(values);
}

describe('concatFloat32', () => {
  it('concatenates chunks in order', () => {
    const out = concatFloat32([chunk(1, 2), chunk(3), chunk(4, 5)]);
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5]);
  });

  it('returns an empty array for no chunks', () => {
    expect(concatFloat32([]).length).toBe(0);
  });
});

describe('PreRollBuffer', () => {
  it('keeps at most maxSamples (plus at most one partial chunk)', () => {
    const buffer = new PreRollBuffer(4);
    buffer.push(chunk(1, 2));
    buffer.push(chunk(3, 4));
    buffer.push(chunk(5, 6));
    // Evicts [1,2] — remaining [3,4,5,6] is exactly maxSamples.
    expect(Array.from(buffer.snapshot(4))).toEqual([3, 4, 5, 6]);
  });

  it('snapshot returns only the newest maxSamples when asked for fewer', () => {
    const buffer = new PreRollBuffer(8);
    buffer.push(chunk(1, 2, 3, 4));
    buffer.push(chunk(5, 6, 7, 8));
    expect(Array.from(buffer.snapshot(3))).toEqual([6, 7, 8]);
  });

  it('snapshot returns everything when asked for more than stored', () => {
    const buffer = new PreRollBuffer(8);
    buffer.push(chunk(1, 2));
    expect(Array.from(buffer.snapshot(100))).toEqual([1, 2]);
  });

  it('clear empties the buffer', () => {
    const buffer = new PreRollBuffer(8);
    buffer.push(chunk(1, 2));
    buffer.clear();
    expect(buffer.snapshot(8).length).toBe(0);
  });
});
