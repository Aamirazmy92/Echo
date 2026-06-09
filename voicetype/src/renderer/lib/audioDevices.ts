import { dedupeAudioInputDevices } from '../../shared/audioDevices';

async function unlockAudioInputLabels(): Promise<void> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
  } catch {
    // Permission may be denied — enumerateDevices still returns device ids.
  }
}

export async function enumerateAudioInputDevices(): Promise<MediaDeviceInfo[]> {
  let devices = await navigator.mediaDevices.enumerateDevices();
  let mics = devices.filter((device) => device.kind === 'audioinput');

  if (mics.some((device) => !device.label)) {
    await unlockAudioInputLabels();
    devices = await navigator.mediaDevices.enumerateDevices();
    mics = devices.filter((device) => device.kind === 'audioinput');
  }

  return dedupeAudioInputDevices(mics);
}
