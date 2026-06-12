import { ChildProcessByStdio, execFile, spawn } from 'child_process';
import { clipboard } from 'electron';
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
    private const ushort VK_CONTROL = 0x11;
    private const ushort VK_SHIFT = 0x10;
    private const ushort VK_V = 0x56;

    // Resolve the INPUT struct size at runtime. A hard-coded value (e.g. 0x30)
    // does NOT match the managed layout of our INPUT type (32 bytes on x64,
    // 28 on x86). When cbSize is wrong, SendInput silently returns 0 and no
    // keystroke is delivered.
    private static readonly int INPUT_SIZE = Marshal.SizeOf(typeof(INPUT));

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

    public static int PressCtrlShiftV() {
        var inputs = new INPUT[6];
        inputs[0].type = INPUT_KEYBOARD;
        inputs[0].U.ki.wVk = VK_CONTROL;
        inputs[1].type = INPUT_KEYBOARD;
        inputs[1].U.ki.wVk = VK_SHIFT;
        inputs[2].type = INPUT_KEYBOARD;
        inputs[2].U.ki.wVk = VK_V;
        inputs[3].type = INPUT_KEYBOARD;
        inputs[3].U.ki.wVk = VK_V;
        inputs[3].U.ki.dwFlags = KEYEVENTF_KEYUP;
        inputs[4].type = INPUT_KEYBOARD;
        inputs[4].U.ki.wVk = VK_SHIFT;
        inputs[4].U.ki.dwFlags = KEYEVENTF_KEYUP;
        inputs[5].type = INPUT_KEYBOARD;
        inputs[5].U.ki.wVk = VK_CONTROL;
        inputs[5].U.ki.dwFlags = KEYEVENTF_KEYUP;
        return (int)SendInput((uint)inputs.Length, inputs, INPUT_SIZE);
    }
}
"@ -Language CSharp

[Console]::Out.WriteLine('ready')
[Console]::Out.Flush()

while (($line = [Console]::In.ReadLine()) -ne $null) {
  if ($line -eq 'paste') {
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
  } elseif ($line -eq 'paste-shift') {
    try {
      $sent = [SendInputTyper]::PressCtrlShiftV()
      if ($sent -lt 6) {
        $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
        [Console]::Out.WriteLine("error:SendInput accepted $sent of 6 events (lastError=$err)")
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

// Process names (lower-cased, .exe stripped) where synthetic Ctrl+V is not
// reliably a paste shortcut. Keep this limited to actual terminal hosts.
//
// IDEs such as VS Code, Cursor, Windsurf, and VSCodium must *not* be listed
// here. The foreground-app detector only captures the process name, not the
// focused control inside the window, so treating the whole IDE as a terminal
// forces editor text boxes through KEYEVENTF_UNICODE direct typing. That path
// emits WM_CHAR messages and IDE editors process them incrementally, which is
// the user-visible "dictation arrives in parts" failure. The clipboard paste
// path sends one Ctrl+V and lets editor/input surfaces ingest the transcript
// atomically.
const TERMINAL_PROCESS_NAMES = new Set([
  // Standalone terminals
  'windowsterminal',
  'wt',
  'openconsole',
  'conhost',
  'powershell',
  'pwsh',
  'cmd',
  'wezterm',
  'wezterm-gui',
  'alacritty',
  'mintty',
  'hyper',
  'tabby',
  'conemu64',
  'conemu',
  'cmder',
]);

function isTerminalApp(name: string | undefined | null): boolean {
  if (!name) return false;
  const normalized = name.toLowerCase().replace(/\.exe$/, '').trim();
  return TERMINAL_PROCESS_NAMES.has(normalized);
}

// Windows paste-based injection. Per-character SendInput caused receivers
// (browsers, Electron apps, IDEs, chat clients) to process dictations as
// incremental WM_CHAR streams. Dropping the transcript on the clipboard and
// firing one paste chord makes the target app ingest the payload atomically.
async function pasteWithSendInput(text: string, chord: 'ctrl-v' | 'ctrl-shift-v' = 'ctrl-v'): Promise<void> {
  await ensureSendInputHelper();

  if (!sendInputHelper) {
    throw new Error('SendInput helper is not available.');
  }

  // Keep the paste hot path synchronous and minimal. Reading/restoring the
  // previous clipboard can block on large or locked clipboard payloads, and
  // restoring too early can race editors that defer reading clipboard data.
  clipboard.writeText(text);

  sendInputHelper.stdin.write(chord === 'ctrl-shift-v' ? 'paste-shift\n' : 'paste\n');

  waitForSendInputHelperLine('ok', SEND_INPUT_HELPER_TIMEOUT_MS).catch((error) => {
    console.warn('[inject]', error?.message ?? error);
  });
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

export async function injectText(text: string, activeAppName?: string): Promise<void> {
  if (process.platform === 'win32') {
    // Normal apps and IDE editors receive one Ctrl+V paste. Terminal hosts
    // commonly reserve Ctrl+V for literal input, so use their paste chord
    // instead of falling back to per-character typing.
    await pasteWithSendInput(text, isTerminalApp(activeAppName) ? 'ctrl-shift-v' : 'ctrl-v');
    return;
  }

  if (process.platform === 'darwin') {
    // macOS: still uses clipboard + paste as fallback (no native SendInput available)
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
