export const VIRTUAL_AUDIO_INPUT_DEVICE_IDS = new Set(['', 'default', 'communications']);

export function isSelectableAudioInputDevice(device: {
  deviceId: string;
  kind: MediaDeviceKind | string;
}): boolean {
  return (
    device.kind === 'audioinput'
    && !!device.deviceId
    && !VIRTUAL_AUDIO_INPUT_DEVICE_IDS.has(device.deviceId)
  );
}

export function dedupeAudioInputDevices<T extends { deviceId: string }>(devices: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];

  for (const device of devices) {
    if (!isSelectableAudioInputDevice(device)) continue;
    if (seen.has(device.deviceId)) continue;
    seen.add(device.deviceId);
    result.push(device);
  }

  return result;
}
