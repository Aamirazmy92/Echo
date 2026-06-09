import { resolveCloudLanguage } from '../shared/languages';
import { proxyTranscribe } from './cloud';

const CLOUD_TIMEOUT_MS = 15_000;

function encodeWav(samples: Float32Array, sampleRate: number): Buffer {
  const numSamples = samples.length;
  const bytesPerSample = 2;
  const dataSize = numSamples * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * bytesPerSample, 28);
  buffer.writeUInt16LE(bytesPerSample, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(sample < 0 ? sample * 0x8000 : sample * 0x7fff, offset);
    offset += 2;
  }

  return buffer;
}

function audioBufferToWaveform(audioBuffer: ArrayBuffer): Float32Array | null {
  if (audioBuffer instanceof ArrayBuffer) {
    return new Float32Array(audioBuffer);
  }
  if (ArrayBuffer.isView(audioBuffer)) {
    const view = audioBuffer as unknown as Uint8Array;
    const raw = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
    return new Float32Array(raw);
  }
  return null;
}

/**
 * Cloud transcription via the Echo Pro proxy (Supabase Edge Function).
 * No Groq key needed on the client — the server holds it. Used when the
 * signed-in user has an active Pro entitlement.
 */
export async function transcribeWithCloudProxy(
  audioBuffer: ArrayBuffer,
  language: string,
): Promise<{ text: string; detectedLanguage?: string }> {
  const waveform = audioBufferToWaveform(audioBuffer);
  if (!waveform || !waveform.length) return { text: '' };

  const wavBuffer = encodeWav(waveform, 16000);
  const langCode = resolveCloudLanguage(language);
  const durationMs = Math.round((waveform.length / 16000) * 1000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CLOUD_TIMEOUT_MS);

  try {
    const result = await proxyTranscribe({
      wavBuffer,
      language: langCode,
      durationMs,
      signal: controller.signal,
    });
    return {
      text: String(result.text ?? '').replace(/\s+/g, ' ').trim(),
      detectedLanguage: typeof result.language === 'string' ? result.language.trim() : undefined,
    };
  } finally {
    clearTimeout(timeout);
  }
}
