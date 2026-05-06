import { app, BrowserWindow } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import https from 'https';
import crypto from 'crypto';
import net from 'net';
import { ChildProcess, spawn } from 'child_process';
import { resolveCloudLanguage } from '../shared/languages';

const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin';
const MODEL_SHA256 = '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe';
const WHISPER_NAMESPACE = 'whispercpp';
const WHISPER_SERVER_RELATIVE_PATH = path.join('bin', 'Release', 'whisper-server.exe');
const WHISPER_BLAS_SERVER_RELATIVE_PATH = path.join('blas-bin', 'Release', 'whisper-server.exe');
const USER_DATA_MODEL_PATH = path.join(WHISPER_NAMESPACE, 'models', 'ggml-base.bin');
const DEV_MODEL_PATH = path.join('vendor', 'whispercpp', 'ggml-base.bin');
const RESOURCES_PATH = typeof process.resourcesPath === 'string' ? process.resourcesPath : '';
const PACKAGED_MODEL_PATH = path.join(RESOURCES_PATH, 'models', 'ggml-base.bin');
const DEV_BINARY_PATH = path.join('vendor', 'whispercpp', WHISPER_SERVER_RELATIVE_PATH);
const DEV_BLAS_BINARY_PATH = path.join('vendor', 'whispercpp', WHISPER_BLAS_SERVER_RELATIVE_PATH);
const PACKAGED_BINARY_PATH = path.join(RESOURCES_PATH, 'bin', 'Release', 'whisper-server.exe');
const PACKAGED_BLAS_BINARY_PATH = path.join(RESOURCES_PATH, 'blas-bin', 'Release', 'whisper-server.exe');
const SERVER_HOST = '127.0.0.1';
const SERVER_STARTUP_TIMEOUT_MS = 30_000;
const SERVER_START_RETRY_COUNT = 3;
const INFERENCE_TIMEOUT_MS = 60_000;

let binaryReadyPromise: Promise<string> | null = null;
let modelReadyPromise: Promise<string> | null = null;
let serverProcess: ChildProcess | null = null;
let serverReadyPromise: Promise<void> | null = null;
let serverConfigKey: string | null = null;
let serverPort: number | null = null;

const MAX_DOWNLOAD_RETRIES = 3;
const DOWNLOAD_RETRY_BASE_DELAY_MS = 2_000;

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function fileExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function getUserDataPath(...segments: string[]): string {
  return path.join(app.getPath('userData'), ...segments);
}

function sendModelDownloadProgress(
  state: 'downloading' | 'verifying' | 'ready' | 'error',
  progress?: { percent: number; bytesReceived: number; bytesTotal: number },
  error?: string
) {
  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) {
    win.webContents.send('model-download-progress', { state, progress, error });
  }
}

function verifyFileHash(filePath: string, expectedSha256: string): boolean {
  try {
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(filePath, 'r');
    const bufferSize = 1024 * 1024;
    const buffer = Buffer.alloc(bufferSize);
    let bytesRead: number;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, bufferSize, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
    fs.closeSync(fd);
    const actual = hash.digest('hex');
    return actual === expectedSha256;
  } catch {
    return false;
  }
}

function downloadFileWithProgress(url: string, destination: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ensureDir(path.dirname(destination));

    const request = https.get(
      url,
      {
        headers: {
          'User-Agent': 'Echo/1.0 whisper.cpp downloader',
        },
      },
      (response) => {
        const statusCode = response.statusCode ?? 0;
        const redirect = response.headers.location;

        if (statusCode >= 300 && statusCode < 400 && redirect) {
          response.resume();
          const nextUrl = new URL(redirect, url).toString();
          downloadFileWithProgress(nextUrl, destination).then(resolve, reject);
          return;
        }

        if (statusCode < 200 || statusCode >= 300) {
          response.resume();
          reject(new Error(`Download failed with status ${statusCode} for ${url}`));
          return;
        }

        const contentLength = parseInt(response.headers['content-length'] ?? '0', 10);
        let bytesReceived = 0;
        let lastProgressPercent = -1;

        const tempPath = `${destination}.download`;
        const file = fs.createWriteStream(tempPath);

        response.on('data', (chunk: Buffer) => {
          bytesReceived += chunk.length;
          if (contentLength > 0) {
            const percent = Math.floor((bytesReceived / contentLength) * 100);
            if (percent !== lastProgressPercent) {
              lastProgressPercent = percent;
              sendModelDownloadProgress('downloading', {
                percent,
                bytesReceived,
                bytesTotal: contentLength,
              });
            }
          }
        });

        response.pipe(file);
        file.on('finish', () => {
          file.close((closeError) => {
            if (closeError) {
              fs.rmSync(tempPath, { force: true });
              reject(closeError);
              return;
            }

            try {
              fs.renameSync(tempPath, destination);
              resolve();
            } catch (renameError) {
              fs.rmSync(tempPath, { force: true });
              reject(renameError);
            }
          });
        });

        file.on('error', (error) => {
          response.destroy();
          fs.rmSync(tempPath, { force: true });
          reject(error);
        });
      }
    );

    request.on('error', reject);
  });
}

function resolveDevBinaryPath(): string | null {
  const candidate = path.join(app.getAppPath(), DEV_BINARY_PATH);
  return fileExists(candidate) ? candidate : null;
}

function resolveDevBlasBinaryPath(): string | null {
  const candidate = path.join(app.getAppPath(), DEV_BLAS_BINARY_PATH);
  return fileExists(candidate) ? candidate : null;
}

function resolveDevModelPath(): string | null {
  const candidate = path.join(app.getAppPath(), DEV_MODEL_PATH);
  return fileExists(candidate) ? candidate : null;
}

function resolvePackagedModelPath(): string | null {
  return fileExists(PACKAGED_MODEL_PATH) ? PACKAGED_MODEL_PATH : null;
}

async function ensureWhisperBinary(): Promise<string> {
  if (!binaryReadyPromise) {
    binaryReadyPromise = (async () => {
      if (fileExists(PACKAGED_BLAS_BINARY_PATH)) {
        return PACKAGED_BLAS_BINARY_PATH;
      }

      if (fileExists(PACKAGED_BINARY_PATH)) {
        return PACKAGED_BINARY_PATH;
      }

      const devBlasBinaryPath = resolveDevBlasBinaryPath();
      if (devBlasBinaryPath) {
        return devBlasBinaryPath;
      }

      const devBinaryPath = resolveDevBinaryPath();
      if (devBinaryPath) {
        return devBinaryPath;
      }

      throw new Error('The bundled whisper.cpp server binary is missing. Reinstall Echo from a trusted build.');
    })().catch((error) => {
      binaryReadyPromise = null;
      throw error;
    });
  }

  return binaryReadyPromise;
}

async function downloadModelWithRetry(destination: string): Promise<void> {
  for (let attempt = 1; attempt <= MAX_DOWNLOAD_RETRIES; attempt++) {
    try {
      sendModelDownloadProgress('downloading', { percent: 0, bytesReceived: 0, bytesTotal: 0 });
      await downloadFileWithProgress(MODEL_URL, destination);

      sendModelDownloadProgress('verifying');
      if (!verifyFileHash(destination, MODEL_SHA256)) {
        fs.rmSync(destination, { force: true });
        throw new Error('SHA-256 checksum verification failed - the downloaded model may be corrupted.');
      }

      sendModelDownloadProgress('ready');
      return;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      fs.rmSync(destination, { force: true });
      if (attempt < MAX_DOWNLOAD_RETRIES) {
        const delay = DOWNLOAD_RETRY_BASE_DELAY_MS * attempt;
        sendModelDownloadProgress('error', undefined, `Download attempt ${attempt} failed: ${message}. Retrying in ${delay / 1000}s...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      } else {
        sendModelDownloadProgress('error', undefined, `Model download failed after ${MAX_DOWNLOAD_RETRIES} attempts: ${message}`);
        throw error;
      }
    }
  }
}

async function ensureWhisperModel(): Promise<string> {
  if (!modelReadyPromise) {
    modelReadyPromise = (async () => {
      const packagedModelPath = resolvePackagedModelPath();
      if (packagedModelPath) {
        return packagedModelPath;
      }

      const devModelPath = resolveDevModelPath();
      if (devModelPath) {
        return devModelPath;
      }

      const modelPath = getUserDataPath(USER_DATA_MODEL_PATH);
      if (fileExists(modelPath)) {
        if (verifyFileHash(modelPath, MODEL_SHA256)) {
          return modelPath;
        }
        fs.rmSync(modelPath, { force: true });
      }

      await downloadModelWithRetry(modelPath);
      return modelPath;
    })().catch((error) => {
      modelReadyPromise = null;
      throw error;
    });
  }

  return modelReadyPromise;
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

function getThreadCount(): number {
  const cpuCount =
    typeof (os as typeof os & { availableParallelism?: () => number }).availableParallelism === 'function'
      ? (os as typeof os & { availableParallelism: () => number }).availableParallelism()
      : os.cpus()?.length ?? 4;
  return Math.max(4, cpuCount);
}

function normalizeWaveform(audioBuffer: ArrayBuffer): Float32Array {
  if (audioBuffer instanceof ArrayBuffer) {
    return new Float32Array(audioBuffer);
  }
  if (ArrayBuffer.isView(audioBuffer)) {
    const view = audioBuffer as unknown as Uint8Array;
    const raw = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
    return new Float32Array(raw);
  }
  return new Float32Array();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function reserveServerPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();

    probe.once('error', reject);
    probe.listen(0, SERVER_HOST, () => {
      const address = probe.address();
      if (!address || typeof address === 'string') {
        probe.close(() => reject(new Error('Failed to reserve a localhost port for whisper-server.')));
        return;
      }

      const selectedPort = address.port;
      probe.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(selectedPort);
      });
    });
  });
}

function healthCheck(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://${SERVER_HOST}:${port}/health`, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1000, () => { req.destroy(); resolve(false); });
  });
}

function resolveLocalLanguage(language: string): string {
  return resolveCloudLanguage(language);
}

function clearServerState() {
  serverProcess = null;
  serverReadyPromise = null;
  serverConfigKey = null;
  serverPort = null;
}

function stopServerProcess() {
  const processToStop = serverProcess;
  clearServerState();

  if (processToStop && processToStop.exitCode === null && !processToStop.killed) {
    processToStop.kill();
  }
}

async function waitForServerStartup(child: ChildProcess, port: number, getStartupError: () => Error | null): Promise<void> {
  const deadline = Date.now() + SERVER_STARTUP_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const startupError = getStartupError();
    if (startupError) {
      throw startupError;
    }

    if (child.exitCode !== null) {
      throw new Error(`whisper-server exited before becoming ready (code=${child.exitCode})`);
    }

    if (await healthCheck(port)) {
      return;
    }

    await sleep(150);
  }

  throw new Error('whisper-server failed to start within timeout');
}

async function ensureServerRunning(language: string): Promise<void> {
  const normalizedLanguage = resolveLocalLanguage(language);
  const [binaryPath, modelPath] = await Promise.all([
    ensureWhisperBinary(),
    ensureWhisperModel(),
  ]);
  const nextServerConfigKey = [binaryPath, modelPath, normalizedLanguage].join('|');

  if (serverReadyPromise && serverConfigKey === nextServerConfigKey) {
    return serverReadyPromise;
  }

  if (serverProcess && serverConfigKey !== nextServerConfigKey) {
    stopServerProcess();
  }

  if (serverReadyPromise) return serverReadyPromise;

  serverReadyPromise = (async () => {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= SERVER_START_RETRY_COUNT; attempt += 1) {
      const port = await reserveServerPort();
      let startupError: Error | null = null;

      const args = [
        '-m', modelPath,
        '-l', normalizedLanguage,
        '-t', String(getThreadCount()),
        '-bo', '2',
        '-fa',
        '-sns',
        '--port', String(port),
        '--host', SERVER_HOST,
      ];

      const child = spawn(binaryPath, args, {
        cwd: path.dirname(binaryPath),
        windowsHide: true,
        stdio: 'ignore',
      });

      serverProcess = child;
      serverPort = port;

      child.on('exit', (code, signal) => {
        if (code !== 0 && signal !== 'SIGTERM' && signal !== 'SIGKILL') {
          console.warn(`[localTranscribe] whisper-server exited unexpectedly (code=${code}, signal=${signal}) - will respawn on next dictation.`);
        }
        if (serverProcess === child) {
          clearServerState();
        }
      });

      child.on('error', (error) => {
        startupError = error;
        console.warn('[localTranscribe] whisper-server process error:', error);
      });

      try {
        await waitForServerStartup(child, port, () => startupError);
        serverConfigKey = nextServerConfigKey;
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        stopServerProcess();

        if (attempt < SERVER_START_RETRY_COUNT) {
          await sleep(150);
        }
      }
    }

    throw lastError ?? new Error('whisper-server failed to start');
  })().catch((error) => {
    serverReadyPromise = null;
    throw error;
  });

  return serverReadyPromise;
}

function postAudioToServer(wavBuffer: Buffer, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const boundary = '----WhisperBoundary' + Date.now().toString(36);
    const fieldHeaders = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="audio.wav"',
      'Content-Type: audio/wav',
      '',
    ].join('\r\n');
    const tail = `\r\n--${boundary}--\r\n`;

    const headerBuf = Buffer.from(fieldHeaders + '\r\n', 'utf-8');
    const tailBuf = Buffer.from(tail, 'utf-8');
    const contentLength = headerBuf.length + wavBuffer.length + tailBuf.length;

    const req = http.request(
      {
        hostname: SERVER_HOST,
        port,
        path: '/inference',
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': contentLength,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8');
          if (res.statusCode !== 200) {
            reject(new Error(`whisper-server returned ${res.statusCode}: ${body}`));
            return;
          }
          try {
            const json = JSON.parse(body);
            resolve((json.text ?? '').trim());
          } catch {
            resolve(body.trim());
          }
        });
      }
    );

    req.on('error', reject);
    req.setTimeout(INFERENCE_TIMEOUT_MS, () => { req.destroy(new Error('Inference timeout')); });

    req.write(headerBuf);
    req.write(wavBuffer);
    req.end(tailBuf);
  });
}

export async function transcribeWithLocalModel(
  audioBuffer: ArrayBuffer,
  language: string
): Promise<string> {
  const waveform = normalizeWaveform(audioBuffer);
  if (!waveform.length) {
    return '';
  }

  await ensureServerRunning(language);
  if (serverPort === null) {
    throw new Error('whisper-server did not expose a listening port.');
  }

  const wavBuffer = encodeWav(waveform, 16000);
  const text = await postAudioToServer(wavBuffer, serverPort);
  return text.replace(/\s+/g, ' ').trim();
}

export function shutdownLocalServer(): void {
  stopServerProcess();
}
