import { Settings, SpeechMetrics } from '../shared/types';
import { resolveRecognitionLanguage } from '../shared/languages';
import { transcribeWithLocalModel } from './localTranscribe';
import { transcribeWithCloud } from './cloudTranscribe';
import { getGroqApiKeyPlain } from './store';

const SILENCE_FRAME_THRESHOLD = 5;
const SILENCE_RMS_THRESHOLD = 0.04;
const SILENCE_BAND_THRESHOLD = 0.20;
const SILENCE_SPEECH_RATIO = 0.12;

function isLikelySilentClip(metrics?: SpeechMetrics, durationMs?: number): boolean {
  if (!metrics || metrics.frameCount === 0) return false;

  const speechRatio = metrics.speechFrames / metrics.frameCount;
  const longestSpeechMs = metrics.longestSpeechRunFrames * 33;

  // No meaningful speech frames detected
  if (metrics.speechFrames <= SILENCE_FRAME_THRESHOLD && metrics.peakRms < SILENCE_RMS_THRESHOLD) {
    return true;
  }

  // Very low speech ratio with weak signal — background noise, not speech
  if (
    speechRatio < SILENCE_SPEECH_RATIO &&
    longestSpeechMs < 200 &&
    metrics.peakRms < SILENCE_RMS_THRESHOLD &&
    metrics.peakBand < SILENCE_BAND_THRESHOLD
  ) {
    return true;
  }

  // Low average energy across the whole clip — likely ambient noise
  if (metrics.averageRms < 0.012 && metrics.averageBand < 0.04) {
    return true;
  }

  return false;
}

export function normalizeTranscript(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function normalizeTokenForComparison(token: string): string {
  return token.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

function removeImmediateRepeatedWords(text: string): string {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return text;

  const result: string[] = [];

  for (const token of tokens) {
    const previous = result[result.length - 1];
    if (
      previous &&
      normalizeTokenForComparison(previous) &&
      normalizeTokenForComparison(previous) === normalizeTokenForComparison(token)
    ) {
      continue;
    }

    result.push(token);
  }

  return result.join(' ');
}

export function removeImmediateRepeatedPhrases(text: string): string {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length < 6) return text;

  const result: string[] = [];

  for (let index = 0; index < tokens.length; ) {
    let collapsed = false;

    for (let span = Math.min(6, Math.floor((tokens.length - index) / 2)); span >= 2; span -= 1) {
      let matches = true;

      for (let offset = 0; offset < span; offset += 1) {
        const left = normalizeTokenForComparison(tokens[index + offset] ?? '');
        const right = normalizeTokenForComparison(tokens[index + span + offset] ?? '');

        if (!left || !right || left !== right) {
          matches = false;
          break;
        }
      }

      if (matches) {
        result.push(...tokens.slice(index, index + span));
        index += span * 2;
        collapsed = true;
        break;
      }
    }

    if (!collapsed) {
      result.push(tokens[index]);
      index += 1;
    }
  }

  return result.join(' ');
}

export function removeTranscriptArtifacts(text: string): string {
  return normalizeTranscript(removeImmediateRepeatedWords(removeImmediateRepeatedPhrases(text)));
}

export function hasMeaningfulTranscriptContent(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

const WHISPER_PHANTOMS = new Set([
  'thank you',
  'thank you very much',
  'thanks',
  'thanks a lot',
  'thank you for watching',
  'thanks for watching',
  'thanks for watching please subscribe',
  'thank you for listening',
  'thanks for listening',
  'okay thank you',
  'ok thank you',
  'please subscribe',
  'subscribe',
  'like and subscribe',
  'please like and subscribe',
  'bye',
  'bye bye',
  'goodbye',
  'blank audio',
  'blankaudio',
  'silence',
  'no audio',
  'inaudible',
  'music',
  'music playing',
  'applause',
  'laughter',
  'you',
  'the',
  'okay',
  'ok',
  'so',
  'and',
  'but',
  'oh',
  'um',
  'uh',
  'hmm',
  'mm hmm',
  'mm-hmm',
  'mhm',
  'mmm',
  'ah',
  'right',
  'well',
  'yeah',
  'yes',
  'no',
  'huh',
  'i',
  'a',
  'it',
  'is',
]);

function isWhisperPhantom(text: string): boolean {
  const normalized = text.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  return WHISPER_PHANTOMS.has(normalized);
}

export interface TranscribeResult {
  text: string;
  method: 'cloud' | 'local' | 'local (cloud-fallback)';
  cloudError?: string;
  detectedLanguage?: string;
}

// Compute RMS energy directly from the raw waveform — the most reliable silence check
const WAVEFORM_RMS_FLOOR = 0.008;
const WAVEFORM_PEAK_FLOOR = 0.05;

function isWaveformSilent(audioBuffer: ArrayBuffer): boolean {
  let samples: Float32Array;
  if (audioBuffer instanceof ArrayBuffer) {
    samples = new Float32Array(audioBuffer);
  } else if (ArrayBuffer.isView(audioBuffer)) {
    const view = audioBuffer as unknown as Uint8Array;
    const raw = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
    samples = new Float32Array(raw);
  } else {
    return false;
  }

  if (samples.length === 0) return true;

  let sumSquares = 0;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const abs = Math.abs(samples[i]);
    sumSquares += samples[i] * samples[i];
    if (abs > peak) peak = abs;
  }

  const rms = Math.sqrt(sumSquares / samples.length);
  return rms < WAVEFORM_RMS_FLOOR && peak < WAVEFORM_PEAK_FLOOR;
}

export async function transcribeAudio(
  audioBuffer: ArrayBuffer,
  settings: Settings,
  durationMs?: number,
  speechMetrics?: SpeechMetrics
): Promise<TranscribeResult> {
  if (!audioBuffer || audioBuffer.byteLength === 0) {
    return { text: '', method: 'local' };
  }

  // Primary guard: check actual audio waveform energy
  if (isWaveformSilent(audioBuffer)) {
    return { text: '', method: 'local' };
  }

  // Secondary guard: check renderer-reported speech metrics
  if (isLikelySilentClip(speechMetrics, durationMs)) {
    return { text: '', method: 'local' };
  }

  try {
    let raw: string;
    let method: TranscribeResult['method'] = 'local';
    let cloudError: string | undefined;
    let detectedLanguage: string | undefined;
    const recognitionLanguage = resolveRecognitionLanguage(settings);

    const groqApiKey = getGroqApiKeyPlain();
    if (settings.useCloudTranscription && groqApiKey) {
      try {
        const cloudResult = await transcribeWithCloud(audioBuffer, groqApiKey, recognitionLanguage);
        raw = cloudResult.text;
        detectedLanguage = cloudResult.detectedLanguage;
        method = 'cloud';
      } catch (err: any) {
        cloudError = err?.message || String(err);
        console.warn(`[transcribe] Cloud failed (key set=${!!groqApiKey}, len=${groqApiKey?.length ?? 0}), error:`, cloudError);
        console.warn('[transcribe] Error status:', err?.status, 'type:', err?.type);
        raw = await transcribeWithLocalModel(audioBuffer, recognitionLanguage);
        method = 'local (cloud-fallback)';
      }
    } else {
      raw = await transcribeWithLocalModel(audioBuffer, recognitionLanguage);
    }

    const text = removeTranscriptArtifacts(raw);

    // Filter punctuation-only results (e.g. "." from cloud on silence)
    if (!text || !hasMeaningfulTranscriptContent(text)) {
      return { text: '', method, cloudError, detectedLanguage };
    }

    // Filter only Whisper's notorious phantom phrases — these are never real dictation
    if (isWhisperPhantom(text)) {
      return { text: '', method, cloudError, detectedLanguage };
    }

    return { text, method, cloudError, detectedLanguage };
  } catch (error: any) {
    throw new Error('Transcription failed: ' + (error?.message || 'Unknown error'));
  }
}
