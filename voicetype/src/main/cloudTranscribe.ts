import { resolveCloudLanguage } from '../shared/languages';

const CLOUD_TRANSCRIPTION_MODEL = 'whisper-large-v3';
const GROQ_TRANSCRIPTIONS_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
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

export async function transcribeWithCloud(
  audioBuffer: ArrayBuffer,
  apiKey: string,
  language: string
): Promise<{ text: string; detectedLanguage?: string }> {
  let waveform: Float32Array;
  if (audioBuffer instanceof ArrayBuffer) {
    waveform = new Float32Array(audioBuffer);
  } else if (ArrayBuffer.isView(audioBuffer)) {
    const view = audioBuffer as unknown as Uint8Array;
    const raw = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
    waveform = new Float32Array(raw);
  } else {
    return { text: '' };
  }

  if (!waveform.length) return { text: '' };

  const wavBuffer = encodeWav(waveform, 16000);
  const langCode = resolveCloudLanguage(language);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CLOUD_TIMEOUT_MS);
  const wavArrayBuffer = wavBuffer.buffer.slice(wavBuffer.byteOffset, wavBuffer.byteOffset + wavBuffer.byteLength) as ArrayBuffer;
  const form = new FormData();
  form.append('file', new Blob([wavArrayBuffer], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', CLOUD_TRANSCRIPTION_MODEL);
  form.append('response_format', 'verbose_json');
  if (langCode !== 'auto') form.append('language', langCode);
  form.append('prompt', 'Transcribe the speech exactly as spoken. Keep the original language and script. Do not translate.');
  form.append('temperature', '0');

  let transcription: { text?: unknown; language?: unknown };
  try {
    const response = await fetch(GROQ_TRANSCRIPTIONS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey.replace(/\s+/g, '')}`,
      },
      body: form,
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(errorText || `Groq transcription failed with HTTP ${response.status}`);
    }

    transcription = await response.json();
  } finally {
    clearTimeout(timeout);
  }

  return {
    text: String(transcription.text ?? '').replace(/\s+/g, ' ').trim(),
    detectedLanguage: typeof transcription.language === 'string'
      ? transcription.language.trim()
      : undefined,
  };
}
