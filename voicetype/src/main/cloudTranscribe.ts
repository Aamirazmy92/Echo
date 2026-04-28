import OpenAI, { toFile } from 'openai';
import { resolveCloudLanguage } from '../shared/languages';

let cachedClient: OpenAI | null = null;
let cachedApiKey: string = '';
const CLOUD_TRANSCRIPTION_MODEL = 'whisper-large-v3';

function getClient(apiKey: string): OpenAI {
  const cleanKey = apiKey.replace(/\s+/g, '');
  if (cachedClient && cachedApiKey === cleanKey) return cachedClient;
  cachedClient = new OpenAI({
    apiKey: cleanKey,
    baseURL: 'https://api.groq.com/openai/v1',
    timeout: 15_000,
    maxRetries: 2,
  });
  cachedApiKey = cleanKey;
  return cachedClient;
}

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
  const file = await toFile(wavBuffer, 'audio.wav', { type: 'audio/wav' });

  const client = getClient(apiKey);
  const langCode = resolveCloudLanguage(language);

  const transcription = await client.audio.transcriptions.create({
    file,
    model: CLOUD_TRANSCRIPTION_MODEL,
    response_format: 'verbose_json',
    ...(langCode !== 'auto' ? { language: langCode } : {}),
    prompt: 'Transcribe the speech exactly as spoken. Keep the original language and script. Do not translate.',
    temperature: 0,
  });

  return {
    text: String((transcription as any).text ?? '').replace(/\s+/g, ' ').trim(),
    detectedLanguage: typeof (transcription as any).language === 'string'
      ? String((transcription as any).language).trim()
      : undefined,
  };
}
