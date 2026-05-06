import { ChildProcessByStdio, execFile, spawn } from 'child_process';
import { Readable, Writable } from 'stream';
const SEND_INPUT_HELPER_TIMEOUT_MS = 5_000;

let sendInputHelper: ChildProcessByStdio<Writable, Readable, Readable> | null = null;
let sendInputHelperReadyPromise: Promise<void> | null = null;
let sendInputHelperReady = false;
let sendInputHelperStdoutBuffer = '';
let sendInputHelperLineWaiters: Array<(line: string) => void> = [];

const SEND_INPUT_HELPER_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.dll -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public class SendInputTyper {
    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT {
        public uint type;
        public InputUnion U;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBOARDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBOARDINPUT {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct HARDWAREINPUT {
        public uint uMsg;
        public ushort wParamL;
        public ushort wParamH;
    }

    private const uint INPUT_KEYBOARD = 1;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const uint KEYEVENTF_UNICODE = 0x0004;
    private const ushort VK_CONTROL = 0x11;
    private const ushort VK_V = 0x56;

    // Resolve the INPUT struct size at runtime. A hard-coded value (e.g. 0x30)
    // does NOT match the managed layout of our INPUT type (32 bytes on x64,
    // 28 on x86). When cbSize is wrong, SendInput silently returns 0 and no
    // keystroke is delivered.
    private static readonly int INPUT_SIZE = Marshal.SizeOf(typeof(INPUT));

    public static int TypeText(string text) {
        if (string.IsNullOrEmpty(text)) return 0;

        // Build one INPUT[] containing key-down + key-up for every character
        // and dispatch with a single SendInput call. This is effectively
        // instantaneous (one syscall) and avoids any per-character delay.
        var inputs = new INPUT[text.Length * 2];
        int idx = 0;
        foreach (char ch in text) {
            inputs[idx].type = INPUT_KEYBOARD;
            inputs[idx].U.ki.wScan = (ushort)ch;
            inputs[idx].U.ki.dwFlags = KEYEVENTF_UNICODE;
            idx++;

            inputs[idx].type = INPUT_KEYBOARD;
            inputs[idx].U.ki.wScan = (ushort)ch;
            inputs[idx].U.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
            idx++;
        }

        return (int)SendInput((uint)inputs.Length, inputs, INPUT_SIZE);
    }

    // Send a single Ctrl+V chord so the target app sees one WM_PASTE and
    // renders the entire clipboard payload atomically. This avoids the
    // per-character message-pump stalls that KEYEVENTF_UNICODE triggers on
    // receivers that do layout/autocomplete work on every WM_CHAR (browsers,
    // Electron apps, chat clients). Used for dictation injection so long
    // transcripts land in one frame regardless of length.
    public static int PressCtrlV() {
        var inputs = new INPUT[4];
        inputs[0].type = INPUT_KEYBOARD;
        inputs[0].U.ki.wVk = VK_CONTROL;
        inputs[1].type = INPUT_KEYBOARD;
        inputs[1].U.ki.wVk = VK_V;
        inputs[2].type = INPUT_KEYBOARD;
        inputs[2].U.ki.wVk = VK_V;
        inputs[2].U.ki.dwFlags = KEYEVENTF_KEYUP;
        inputs[3].type = INPUT_KEYBOARD;
        inputs[3].U.ki.wVk = VK_CONTROL;
        inputs[3].U.ki.dwFlags = KEYEVENTF_KEYUP;
        return (int)SendInput((uint)inputs.Length, inputs, INPUT_SIZE);
    }
}
"@ -Language CSharp

[Console]::Out.WriteLine('ready')
[Console]::Out.Flush()

while (($line = [Console]::In.ReadLine()) -ne $null) {
  if ($line.StartsWith('type:')) {
    $encoded = $line.Substring(5)
    try {
      $bytes = [System.Convert]::FromBase64String($encoded)
      $text = [System.Text.Encoding]::UTF8.GetString($bytes)
      $sent = [SendInputTyper]::TypeText($text)
      $expected = $text.Length * 2
      if ($sent -lt $expected) {
        $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
        [Console]::Out.WriteLine("error:SendInput accepted $sent of $expected events (lastError=$err)")
      } else {
        [Console]::Out.WriteLine('ok')
      }
      [Console]::Out.Flush()
    } catch {
      [Console]::Out.WriteLine("error:$($_.Exception.Message)")
      [Console]::Out.Flush()
    }
  } elseif ($line -eq 'paste') {
    try {
      $sent = [SendInputTyper]::PressCtrlV()
      if ($sent -lt 4) {
        $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
        [Console]::Out.WriteLine("error:SendInput accepted $sent of 4 events (lastError=$err)")
      } else {
        [Console]::Out.WriteLine('ok')
      }
      [Console]::Out.Flush()
    } catch {
      [Console]::Out.WriteLine("error:$($_.Exception.Message)")
      [Console]::Out.Flush()
    }
  }
}
`;

function pushSendInputHelperOutput(chunk: Buffer): void {
  sendInputHelperStdoutBuffer += chunk.toString('utf8');

  while (true) {
    const newlineIndex = sendInputHelperStdoutBuffer.indexOf('\n');
    if (newlineIndex === -1) break;

    const line = sendInputHelperStdoutBuffer.slice(0, newlineIndex).replace(/\r$/, '');
    sendInputHelperStdoutBuffer = sendInputHelperStdoutBuffer.slice(newlineIndex + 1);

    const waiter = sendInputHelperLineWaiters.shift();
    if (waiter) {
      waiter(line);
    }
  }
}

function waitForSendInputHelperLine(expectedLine: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      sendInputHelperLineWaiters = sendInputHelperLineWaiters.filter((waiter) => waiter !== onLine);
      reject(new Error(`Timed out waiting for SendInput helper response: ${expectedLine}`));
    }, timeoutMs);

    const onLine = (line: string) => {
      clearTimeout(timeoutId);
      if (line === expectedLine) {
        resolve();
        return;
      }
      if (line.startsWith('error')) {
        reject(new Error(`SendInput helper reported: ${line}`));
        return;
      }
      reject(new Error(`Unexpected SendInput helper response: ${line}`));
    };

    sendInputHelperLineWaiters.push(onLine);
  });
}

function ensureSendInputHelper(): Promise<void> {
  if (sendInputHelperReadyPromise) return sendInputHelperReadyPromise;

  sendInputHelperReadyPromise = (async () => {
    sendInputHelperReady = false;
    const encodedScript = Buffer.from(SEND_INPUT_HELPER_SCRIPT, 'utf16le').toString('base64');

    const helperProcess = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        encodedScript,
      ],
      {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );

    sendInputHelper = helperProcess;

    helperProcess.stdout.on('data', pushSendInputHelperOutput);
    // Capture stderr so PowerShell compile/runtime errors surface in the
    // main-process console instead of silently timing out the ready signal.
    // PowerShell's CLIXML wrapper (`#< CLIXML`) is harmless — skip it.
    helperProcess.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (!text || text.startsWith('#< CLIXML')) return;
      console.warn('[inject] powershell stderr:', text);
    });
    helperProcess.on('exit', (code, signal) => {
      if (code !== 0 && signal !== 'SIGTERM') {
        console.warn(`[inject] SendInput helper exited unexpectedly (code=${code}, signal=${signal})`);
      }
      sendInputHelper = null;
      sendInputHelperReady = false;
      sendInputHelperReadyPromise = null;
      sendInputHelperStdoutBuffer = '';
      sendInputHelperLineWaiters = [];
    });

    await waitForSendInputHelperLine('ready', SEND_INPUT_HELPER_TIMEOUT_MS);
    sendInputHelperReady = true;
  })().catch((error) => {
    if (sendInputHelper) {
      sendInputHelper.kill();
      sendInputHelper = null;
    }
    sendInputHelperReady = false;
    sendInputHelperReadyPromise = null;
    throw error;
  });

  return sendInputHelperReadyPromise;
}

function _isSendInputHelperReady(): boolean {
  return sendInputHelperReady && !!sendInputHelper && !sendInputHelper.killed;
}

async function _typeWithSendInput(text: string): Promise<void> {
  await ensureSendInputHelper();

  if (!sendInputHelper) {
    throw new Error('SendInput helper is not available.');
  }

  // Fire-and-verify: hand the payload to the helper and return as soon as
  // the stdin write is flushed. The helper's ack/error response is consumed
  // asynchronously on the next tick so we never block the critical path on
  // the pipe round-trip. Any SendInput failure still surfaces via
  // console.warn through the waiter.
  const encoded = Buffer.from(text, 'utf-8').toString('base64');
  sendInputHelper.stdin.write(`type:${encoded}\n`);

  waitForSendInputHelperLine('ok', SEND_INPUT_HELPER_TIMEOUT_MS).catch((error) => {
    console.warn('[inject]', error?.message ?? error);
  });
}

// Windows paste-based injection. Per-character SendInput caused receivers
// (browsers, Electron apps, chat clients) to stall at newlines and other
// characters that trigger layout/autocomplete work on every WM_CHAR, making
// long dictations appear chunked. Dropping the transcript on the clipboard
// and firing a single Ctrl+V chord makes the target app see one WM_PASTE
// and render the full payload in a single frame.
async function pasteWithSendInput(text: string): Promise<void> {
  await ensureSendInputHelper();

  if (!sendInputHelper) {
    throw new Error('SendInput helper is not available.');
  }

  const { clipboard } = await import('electron');
  const previousClipboard = clipboard.readText();
  clipboard.writeText(text);

  sendInputHelper.stdin.write('paste\n');

  waitForSendInputHelperLine('ok', SEND_INPUT_HELPER_TIMEOUT_MS).catch((error) => {
    console.warn('[inject]', error?.message ?? error);
  });

  // Restore the previous clipboard contents after the target app has had
  // time to consume the paste. 200ms is generous enough for every mainstream
  // text surface we've tested (Chromium, Electron, Win32, WPF, Slack, VS
  // Code). Too short and the paste races the target's clipboard read.
  setTimeout(() => {
    try {
      clipboard.writeText(previousClipboard);
    } catch {
      // Clipboard occasionally fails if the user is interacting with it at
      // the exact moment we write — ignore, the original content is already
      // gone and there's nothing we can do to recover.
    }
  }, 200);
}

function pasteWithAppleScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      'osascript',
      ['-e', 'tell application "System Events" to keystroke "v" using command down'],
      (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      }
    );
  });
}

export async function injectText(text: string): Promise<void> {
  if (process.platform === 'win32') {
    await pasteWithSendInput(text);
    return;
  }

  if (process.platform === 'darwin') {
    // macOS: still uses clipboard + paste as fallback (no native SendInput available)
    const { clipboard } = await import('electron');
    const oldText = clipboard.readText();
    clipboard.writeText(text);
    try {
      await pasteWithAppleScript();
    } finally {
      setTimeout(() => {
        clipboard.writeText(oldText);
      }, 150);
    }
    return;
  }

  throw new Error(`Unsupported injection platform: ${process.platform}`);
}

export async function prewarmInjectHelper(): Promise<void> {
  if (process.platform === 'win32') {
    await ensureSendInputHelper();
    return;
  }

  if (process.platform === 'darwin') {
    return;
  }
}

export function shutdownInjectHelper(): void {
  if (sendInputHelper) {
    sendInputHelper.kill();
    sendInputHelper = null;
  }
  sendInputHelperReady = false;
  sendInputHelperReadyPromise = null;
  sendInputHelperStdoutBuffer = '';
  sendInputHelperLineWaiters = [];
}
