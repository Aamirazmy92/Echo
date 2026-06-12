// Continuous AudioWorklet capture. The worklet mixes input channels to
// mono and posts ~21 ms Float32 chunks. While idle the chunks feed a
// pre-roll ring; while recording they accumulate. stop() returns the
// pre-roll + recording at the context's native sample rate — no
// container encode/decode anywhere.

import { PreRollBuffer, concatFloat32 } from './pcmCapture';

const WORKLET_NAME = 'echo-pcm-capture';
const CHUNK_SAMPLES = 1024;
const PRE_ROLL_MS = 300;
const PRE_ROLL_CAPACITY_MS = 1000;

const WORKLET_SOURCE = `
class EchoPcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Float32Array(${CHUNK_SAMPLES});
    this._offset = 0;
  }
  process(inputs) {
    const channels = inputs[0];
    if (!channels || channels.length === 0 || !channels[0]) return true;
    const frames = channels[0].length;
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (let c = 0; c < channels.length; c++) sum += channels[c][i];
      this._buffer[this._offset++] = sum / channels.length;
      if (this._offset === this._buffer.length) {
        const out = this._buffer;
        this.port.postMessage(out, [out.buffer]);
        this._buffer = new Float32Array(${CHUNK_SAMPLES});
        this._offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('${WORKLET_NAME}', EchoPcmCaptureProcessor);
`;

const moduleLoadedContexts = new WeakSet<AudioContext>();

async function ensureWorkletModule(context: AudioContext): Promise<void> {
  if (moduleLoadedContexts.has(context)) return;
  const blobUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
  try {
    await context.audioWorklet.addModule(blobUrl);
    moduleLoadedContexts.add(context);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

export class PcmRecorder {
  private node: AudioWorkletNode;
  private silentSink: GainNode;
  private preRoll: PreRollBuffer;
  private recordedChunks: Float32Array[] = [];
  private recording = false;
  private disposed = false;

  readonly sampleRate: number;

  private constructor(context: AudioContext, node: AudioWorkletNode) {
    this.node = node;
    this.sampleRate = context.sampleRate;
    this.preRoll = new PreRollBuffer(Math.round((PRE_ROLL_CAPACITY_MS / 1000) * context.sampleRate));

    // A worklet node with an unconnected output may be skipped by the
    // renderer; route it through a muted gain to keep it pumping.
    this.silentSink = context.createGain();
    this.silentSink.gain.value = 0;
    this.node.connect(this.silentSink);
    this.silentSink.connect(context.destination);

    this.node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (this.disposed) return;
      const chunk = event.data;
      if (this.recording) {
        this.recordedChunks.push(chunk);
      } else {
        this.preRoll.push(chunk);
      }
    };
  }

  static async attach(context: AudioContext, source: MediaStreamAudioSourceNode): Promise<PcmRecorder> {
    await ensureWorkletModule(context);
    const node = new AudioWorkletNode(context, WORKLET_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: 'max',
    });
    const recorder = new PcmRecorder(context, node);
    source.connect(node);
    return recorder;
  }

  get isRecording(): boolean {
    return this.recording;
  }

  start(preRollMs: number = PRE_ROLL_MS): void {
    if (this.recording || this.disposed) return;
    const preRollSamples = Math.round((preRollMs / 1000) * this.sampleRate);
    this.recordedChunks = [this.preRoll.snapshot(preRollSamples)];
    this.preRoll.clear();
    this.recording = true;
  }

  /** Synchronous: everything captured so far is already in memory. */
  stop(): { samples: Float32Array; sampleRate: number } {
    this.recording = false;
    const samples = concatFloat32(this.recordedChunks);
    this.recordedChunks = [];
    return { samples, sampleRate: this.sampleRate };
  }

  /** Drop any captured audio without producing a result. */
  discard(): void {
    this.recording = false;
    this.recordedChunks = [];
  }

  dispose(): void {
    this.disposed = true;
    this.node.port.onmessage = null;
    try {
      this.node.disconnect();
      this.silentSink.disconnect();
    } catch {
      // Context may already be closed.
    }
  }
}
