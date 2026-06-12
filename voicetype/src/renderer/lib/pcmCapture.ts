// Pure building blocks for the AudioWorklet PCM capture path. Kept free
// of Web Audio types so they unit-test under Node.

export function concatFloat32(chunks: readonly Float32Array[]): Float32Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Rolling buffer of the most recent PCM. While armed (graph warm, not
 * recording) the worklet keeps pushing here; on recording start the last
 * few hundred ms are prepended so hotkey-handling latency never clips
 * the first word.
 */
export class PreRollBuffer {
  private chunks: Float32Array[] = [];
  private total = 0;

  constructor(private readonly maxSamples: number) {}

  push(chunk: Float32Array): void {
    if (!chunk.length) return;
    this.chunks.push(chunk);
    this.total += chunk.length;
    while (this.chunks.length > 1 && this.total - this.chunks[0].length >= this.maxSamples) {
      this.total -= this.chunks[0].length;
      this.chunks.shift();
    }
  }

  /** Newest `maxSamples` samples, oldest first. */
  snapshot(maxSamples: number): Float32Array {
    const all = concatFloat32(this.chunks);
    if (all.length <= maxSamples) return all;
    return all.slice(all.length - maxSamples);
  }

  clear(): void {
    this.chunks = [];
    this.total = 0;
  }
}
