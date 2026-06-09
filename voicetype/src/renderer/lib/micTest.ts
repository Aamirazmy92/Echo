export const MIC_TEST_ACTIVE_EVENT = 'echo-mic-test-active';

export function setMicTestActive(active: boolean) {
  window.dispatchEvent(new CustomEvent(MIC_TEST_ACTIVE_EVENT, { detail: { active } }));
}

export async function acquireMicStream(deviceId: string): Promise<MediaStream> {
  if (deviceId) {
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } } });
    } catch {
      return navigator.mediaDevices.getUserMedia({ audio: true });
    }
  }

  return navigator.mediaDevices.getUserMedia({ audio: true });
}

export function computeMicBarLevels(analyser: AnalyserNode, barCount: number): number[] {
  const freqData = new Uint8Array(analyser.frequencyBinCount);
  const timeData = new Uint8Array(analyser.fftSize);
  analyser.getByteFrequencyData(freqData);
  analyser.getByteTimeDomainData(timeData);

  const voiceBins = Math.min(analyser.frequencyBinCount, 64);
  let maxBand = 0;

  for (let i = 0; i < voiceBins; i += 1) {
    const floor = 12 + i * 0.5;
    const val = Math.max(0, freqData[i] - floor);
    const normalized = Math.min(1, val / 85);
    const shaped = Math.pow(normalized, 1.15) * 1.4;
    if (shaped > maxBand) maxBand = shaped;
  }

  let rmsTotal = 0;
  for (let i = 0; i < timeData.length; i += 1) {
    const sample = (timeData[i] - 128) / 128;
    rmsTotal += sample * sample;
  }
  const rms = Math.sqrt(rmsTotal / timeData.length);
  const volume = Math.min(1, rms * 12);
  const overall = Math.min(1, Math.max(maxBand, volume));

  return Array.from({ length: barCount }, (_, index) => {
    const center = (barCount - 1) / 2;
    const centerWeight = 1 - (Math.abs(index - center) / (center || 1)) * 0.35;
    const variation = 0.85 + ((index * 17) % 7) * 0.03;
    return Math.min(1, overall * centerWeight * variation);
  });
}

export type MicTestSession = {
  stream: MediaStream;
  audioContext: AudioContext;
  analyser: AnalyserNode;
  stop: () => Promise<void>;
};

export async function startMicTestSession(deviceId: string): Promise<MicTestSession> {
  const stream = await acquireMicStream(deviceId);
  const [track] = stream.getAudioTracks();

  if (!track || track.readyState !== 'live') {
    stream.getTracks().forEach((activeTrack) => activeTrack.stop());
    throw new Error('Microphone is unavailable.');
  }

  const audioContext = new AudioContext();
  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }

  const source = audioContext.createMediaStreamSource(stream);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.35;
  analyser.minDecibels = -85;
  analyser.maxDecibels = -10;

  const monitor = audioContext.createGain();
  monitor.gain.value = 0;

  source.connect(analyser);
  analyser.connect(monitor);
  monitor.connect(audioContext.destination);

  return {
    stream,
    audioContext,
    analyser,
    stop: async () => {
      source.disconnect();
      analyser.disconnect();
      monitor.disconnect();
      stream.getTracks().forEach((activeTrack) => activeTrack.stop());
      await audioContext.close().catch(() => undefined);
    },
  };
}

export function micTestErrorMessage(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
      return 'Microphone access was blocked. Allow Echo to use your mic and try again.';
    }
    if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
      return 'No microphone was found. Connect a mic or choose another device.';
    }
    if (error.name === 'NotReadableError') {
      return 'Microphone is in use by another app. Close it and try again.';
    }
  }

  return error instanceof Error ? error.message : 'Could not access the microphone.';
}
