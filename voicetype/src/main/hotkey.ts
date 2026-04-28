import { BrowserWindow } from 'electron';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { updateOverlayState } from './overlay';
import { updateTrayState } from './tray';
import { prewarmInjectHelper } from './inject';
import { type Settings } from '../shared/types';
import {
  DEFAULT_CANCEL_HOTKEY,
  DEFAULT_PUSH_TO_TALK_HOTKEY,
  DEFAULT_TOGGLE_HOTKEY,
  normalizeHotkeyAccelerator,
  normalizeHotkeyList,
} from '../shared/hotkey';

type ShortcutMode = 'idle' | 'toggle' | 'push-to-talk';

type RegisteredHotkeys = {
  toggleHotkey: string[];
  pushToTalkHotkey: string[];
  cancelHotkey: string[];
};

type HotkeySpec = {
  keys: number[];
  requiredModifiers: number[];
};

let isRecording = false;
let recordingMode: ShortcutMode = 'idle';
let boundWindow: BrowserWindow | null = null;
let currentHotkeys: RegisteredHotkeys = {
  toggleHotkey: [DEFAULT_TOGGLE_HOTKEY],
  pushToTalkHotkey: [DEFAULT_PUSH_TO_TALK_HOTKEY],
  cancelHotkey: [DEFAULT_CANCEL_HOTKEY],
};
let hotkeyWatcher: ChildProcessWithoutNullStreams | null = null;
let hotkeyWatcherReady = false;
let hotkeyWatcherReadyWaiters: Array<(ready: boolean) => void> = [];
let cancelDictationHandler: (() => void) | null = null;

let cachedActiveAppScript: string | null = null;
let lastActiveApp: string = 'Unknown';

function getCompiledScript(): string {
  if (cachedActiveAppScript) return cachedActiveAppScript;
  cachedActiveAppScript = `
Add-Type @"
    using System;
    using System.Runtime.InteropServices;
    public class Win32 {
        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")]
        public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    }
"@
$hwnd = [Win32]::GetForegroundWindow()
$pid = 0
[Win32]::GetWindowThreadProcessId($hwnd, [ref]$pid) | Out-Null
try { (Get-Process -Id $pid).ProcessName } catch { "Unknown" }
`;
  return cachedActiveAppScript;
}

export function getActiveAppName(): string {
  return lastActiveApp;
}

async function fetchAndCacheActiveApp() {
  return new Promise<void>((resolve) => {
    const script = getCompiledScript();
    const base64Script = Buffer.from(script, 'utf16le').toString('base64');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', base64Script], { timeout: 2000 }, (_, stdout) => {
      lastActiveApp = stdout ? stdout.trim() : 'Unknown';
      resolve();
    });
  });
}

export async function refreshActiveAppName(): Promise<string> {
  await fetchAndCacheActiveApp();
  return lastActiveApp;
}

export function prewarmActiveAppDetection() {
  void fetchAndCacheActiveApp();
}

function stopHotkeyWatcher() {
  if (!hotkeyWatcher) return;
  hotkeyWatcher.kill();
  hotkeyWatcher = null;
  hotkeyWatcherReady = false;
}

function flushHotkeyWatcherReady(ready: boolean) {
  hotkeyWatcherReady = ready;
  const waiters = hotkeyWatcherReadyWaiters;
  hotkeyWatcherReadyWaiters = [];
  for (const waiter of waiters) {
    waiter(ready);
  }
}

function resolveVirtualKey(part: string): number | null {
  if (/^[A-Z]$/.test(part)) return part.charCodeAt(0);
  if (/^[0-9]$/.test(part)) return part.charCodeAt(0);

  const keyMap: Record<string, number> = {
    CommandOrControl: 0x11,
    Ctrl: 0x11,
    Control: 0x11,
    Alt: 0x12,
    Shift: 0x10,
    Super: 0x5b,
    Win: 0x5b,
    LCtrl: 0xa2,
    RCtrl: 0xa3,
    LAlt: 0xa4,
    RAlt: 0xa5,
    LShift: 0xa0,
    RShift: 0xa1,
    LSuper: 0x5b,
    RSuper: 0x5c,
    MouseMiddle: 0x04,
    Mouse4: 0x05,
    Mouse5: 0x06,
    Space: 0x20,
    Enter: 0x0d,
    Tab: 0x09,
    Esc: 0x1b,
    Escape: 0x1b,
    Backspace: 0x08,
    Delete: 0x2e,
    Insert: 0x2d,
    Home: 0x24,
    End: 0x23,
    PageUp: 0x21,
    PageDown: 0x22,
    Up: 0x26,
    Down: 0x28,
    Left: 0x25,
    Right: 0x27,
    ';': 0xba,
    '=': 0xbb,
    ',': 0xbc,
    '-': 0xbd,
    '.': 0xbe,
    '/': 0xbf,
    '`': 0xc0,
    '[': 0xdb,
    '\\': 0xdc,
    ']': 0xdd,
    "'": 0xde,
  };

  if (keyMap[part] !== undefined) return keyMap[part];

  const functionKeyMatch = /^F([1-9]|1[0-9]|2[0-4])$/.exec(part);
  if (functionKeyMatch) {
    return 0x70 + Number(functionKeyMatch[1]) - 1;
  }

  return null;
}

function buildHotkeySpec(hotkey: string, fallback: string): HotkeySpec | null {
  const normalizedHotkey = normalizeHotkeyAccelerator(hotkey, fallback);
  const keys: number[] = [];
  const requiredModifiers = new Set<number>();

  for (const rawPart of normalizedHotkey.split('+')) {
    const part = rawPart.trim();
    if (!part) continue;

    const virtualKey = resolveVirtualKey(part);
    if (virtualKey === null) {
      return null;
    }

    keys.push(virtualKey);
    if ([0x10, 0x11, 0x12, 0x5b, 0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0x5c].includes(virtualKey)) {
      requiredModifiers.add(virtualKey);
    }
  }

  if (!keys.length) return null;

  return {
    keys,
    requiredModifiers: Array.from(requiredModifiers),
  };
}

function serializeHotkeySpecsPS(specs: HotkeySpec[]): string {
  return specs.map((spec) => `[HotkeySpec]::Create([int[]]@(${spec.keys.join(',')}),[int[]]@(${spec.requiredModifiers.join(',')}))`).join(',');
}

function createHotkeyWatchScript(toggleSpecs: HotkeySpec[], pushToTalkSpecs: HotkeySpec[], cancelSpecs: HotkeySpec[]): string {
  const toggleSpecsPS = serializeHotkeySpecsPS(toggleSpecs);
  const pushSpecsPS = serializeHotkeySpecsPS(pushToTalkSpecs);
  const cancelSpecsPS = serializeHotkeySpecsPS(cancelSpecs);

  return `
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.dll -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Diagnostics;

public class HotkeySpec {
    public int[] Keys;
    public int[] RequiredModifiers;
    public HotkeySpec(int[] keys, int[] requiredModifiers) { Keys = keys; RequiredModifiers = requiredModifiers; }
    public static HotkeySpec Create(int[] keys, int[] requiredModifiers) { return new HotkeySpec(keys, requiredModifiers); }
}

public class KeyboardHook : IDisposable {
    private delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);

    [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UnhookWindowsHookEx(IntPtr hhk);

    [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern IntPtr GetModuleHandle(string lpModuleName);

    private const int WH_KEYBOARD_LL = 13;
    private const int WM_KEYDOWN = 0x0100;
    private const int WM_KEYUP = 0x0101;
    private const int WM_SYSKEYDOWN = 0x0104;
    private const int WM_SYSKEYUP = 0x0105;

    private IntPtr _hookId = IntPtr.Zero;
    private LowLevelKeyboardProc _proc;
    private HotkeySpec[] _toggleSpecs;
    private HotkeySpec[] _pushSpecs;
    private HotkeySpec[] _cancelSpecs;

    private bool _toggleDown = false;
    private bool _pushDown = false;
    private bool _cancelDown = false;

    private HashSet<int> _pressed = new HashSet<int>();

    private static readonly object _writeLock = new object();

    private static void EmitEvent(string evt) {
        // Write directly from the hook callback — the callback runs on the
        // installing thread during message processing, but GetMessage itself
        // never returns when no window messages exist, so a deferred flush
        // approach would never reach stdout.
        lock (_writeLock) {
            Console.WriteLine(evt);
            Console.Out.Flush();
        }
    }

    private static readonly int[] GenericModifierCodes = { 0x10, 0x11, 0x12, 0x5B };
    private static readonly int[] LeftModifierCodes  = { 0xA0, 0xA2, 0xA4, 0x5B };
    private static readonly int[] RightModifierCodes = { 0xA1, 0xA3, 0xA5, 0x5C };
    private static readonly int[] SidedModifierCodes = { 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5, 0x5C };

    public KeyboardHook(HotkeySpec[] toggleSpecs, HotkeySpec[] pushSpecs, HotkeySpec[] cancelSpecs) {
        _toggleSpecs = toggleSpecs;
        _pushSpecs = pushSpecs;
        _cancelSpecs = cancelSpecs;
        _proc = HookCallback;
        using (var curProcess = Process.GetCurrentProcess())
        using (var curModule = curProcess.MainModule)
            _hookId = SetWindowsHookEx(WH_KEYBOARD_LL, _proc, GetModuleHandle(curModule.ModuleName), 0);
    }

    private bool IsKeyPressed(int vk) {
        if (_pressed.Contains(vk)) return true;
        // Generic modifier aliases — a generic code is considered pressed if
        // either sided variant is currently held.
        if (vk == 0x10) return _pressed.Contains(0xA0) || _pressed.Contains(0xA1);
        if (vk == 0x11) return _pressed.Contains(0xA2) || _pressed.Contains(0xA3);
        if (vk == 0x12) return _pressed.Contains(0xA4) || _pressed.Contains(0xA5);
        if (vk == 0x5B) return _pressed.Contains(0x5C);
        return false;
    }

    private bool TestHotkey(HotkeySpec spec) {
        bool usesSided = false;
        foreach (var mod in spec.RequiredModifiers) {
            foreach (var s in SidedModifierCodes) {
                if (mod == s) { usesSided = true; break; }
            }
            if (usesSided) break;
        }

        if (usesSided) {
            foreach (var vk in spec.Keys) {
                if (!IsKeyPressed(vk)) return false;
            }
            for (int i = 0; i < GenericModifierCodes.Length; i++) {
                bool leftRequired = Array.IndexOf(spec.RequiredModifiers, LeftModifierCodes[i]) >= 0;
                bool rightRequired = Array.IndexOf(spec.RequiredModifiers, RightModifierCodes[i]) >= 0;
                bool genericRequired = Array.IndexOf(spec.RequiredModifiers, GenericModifierCodes[i]) >= 0;
                bool leftPressed = IsKeyPressed(LeftModifierCodes[i]);
                bool rightPressed = IsKeyPressed(RightModifierCodes[i]);

                if (leftRequired && !leftPressed) return false;
                if (rightRequired && !rightPressed) return false;
                if (!leftRequired && !rightRequired && !genericRequired && (leftPressed || rightPressed)) return false;
            }
            return true;
        } else {
            for (int i = 0; i < GenericModifierCodes.Length; i++) {
                bool isRequired = Array.IndexOf(spec.RequiredModifiers, GenericModifierCodes[i]) >= 0;
                bool isPressed = IsKeyPressed(LeftModifierCodes[i]) || IsKeyPressed(RightModifierCodes[i]);
                if (isRequired != isPressed) return false;
            }
            foreach (var vk in spec.Keys) {
                if (!IsKeyPressed(vk)) return false;
            }
            return true;
        }
    }

    private bool TestHotkeyGroup(HotkeySpec[] specs) {
        foreach (var spec in specs) {
            if (TestHotkey(spec)) return true;
        }
        return false;
    }

    private IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam) {
        if (nCode >= 0) {
            int vkCode = Marshal.ReadInt32(lParam);
            int msg = wParam.ToInt32();

            if (msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN) {
                _pressed.Add(vkCode);
                // On key-down, check if a hotkey combination is now fully pressed
                bool toggleNow = TestHotkeyGroup(_toggleSpecs);
                if (toggleNow && !_toggleDown) {
                    EmitEvent("toggle_down");
                }
                _toggleDown = toggleNow;

                bool pushNow = TestHotkeyGroup(_pushSpecs);
                if (pushNow && !_pushDown) {
                    EmitEvent("push_down");
                }
                _pushDown = pushNow;

                bool cancelNow = TestHotkeyGroup(_cancelSpecs);
                if (cancelNow && !_cancelDown) {
                    EmitEvent("cancel_down");
                }
                _cancelDown = cancelNow;
            } else if (msg == WM_KEYUP || msg == WM_SYSKEYUP) {
                _pressed.Remove(vkCode);
                // On key-up, re-evaluate push-to-talk release
                bool pushNow = TestHotkeyGroup(_pushSpecs);
                if (!pushNow && _pushDown) {
                    EmitEvent("push_up");
                }
                _pushDown = pushNow;
                _toggleDown = TestHotkeyGroup(_toggleSpecs);
                _cancelDown = TestHotkeyGroup(_cancelSpecs);
            }
        }
        return CallNextHookEx(_hookId, nCode, wParam, lParam);
    }

    public void Dispose() {
        if (_hookId != IntPtr.Zero) UnhookWindowsHookEx(_hookId);
    }
}

public static class MessagePump {
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct MSG {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public POINT pt;
    }

    [DllImport("user32.dll")]
    private static extern int GetMessage(out MSG msg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

    [DllImport("user32.dll")]
    private static extern bool TranslateMessage(ref MSG msg);

    [DllImport("user32.dll")]
    private static extern IntPtr DispatchMessage(ref MSG msg);

    public static void Run() {
        MSG msg;
        int ret;
        while ((ret = GetMessage(out msg, IntPtr.Zero, 0, 0)) != 0 && ret != -1) {
            TranslateMessage(ref msg);
            DispatchMessage(ref msg);
        }
    }
}
"@ -Language CSharp

\$hook = New-Object KeyboardHook(
    [HotkeySpec[]]@(${toggleSpecsPS}),
    [HotkeySpec[]]@(${pushSpecsPS}),
    [HotkeySpec[]]@(${cancelSpecsPS})
)

[Console]::Out.WriteLine('ready')
[Console]::Out.Flush()

try {
    [MessagePump]::Run()
} finally {
    \$hook.Dispose()
}
`;
}

function sanitizePowerShellError(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';

  if (!trimmed.startsWith('#< CLIXML')) {
    return trimmed;
  }

  const withoutHeader = trimmed.replace(/^#<\s*CLIXML\s*/i, '');
  const decoded = withoutHeader
    .replace(/<[^>]+>/g, ' ')
    .replace(/_x000D__x000A_/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

  return decoded;
}

function startRecording(mode: Exclude<ShortcutMode, 'idle'>) {
  if (isRecording) {
    return;
  }

  isRecording = true;
  recordingMode = mode;
  updateOverlayState('recording');
  boundWindow?.webContents.send('start-recording');

  // Capture the foreground app after the UI has already reacted to the hotkey.
  setImmediate(() => {
    void fetchAndCacheActiveApp();
  });

  // Warm the SendInput helper while the user is speaking. Recording always
  // takes meaningfully longer than the helper's cold start, so by the time
  // transcription + cleanup finish, injection is a single instant syscall
  // instead of a 500–1500 ms PowerShell + `Add-Type` compile. This also
  // recovers automatically if the helper died between dictations.
  void prewarmInjectHelper().catch((error) => {
    console.warn('[hotkey] inject helper prewarm failed:', error?.message ?? error);
  });
}

function stopRecording(mode?: Exclude<ShortcutMode, 'idle'>) {
  if (!isRecording) return;
  if (mode && recordingMode !== mode) return;

  isRecording = false;
  recordingMode = 'idle';
  updateOverlayState('processing');
  boundWindow?.webContents.send('stop-recording');
}

function cancelDictation() {
  isRecording = false;
  recordingMode = 'idle';
  updateTrayState('idle');
  updateOverlayState('idle');
  cancelDictationHandler?.();
  boundWindow?.webContents.send('cancel-dictation');
}

function arraysEqual(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function removeBlockedHotkeys(hotkeys: string[], blocked: string[]) {
  const blockedSet = new Set(blocked);
  return hotkeys.filter((hotkey) => !blockedSet.has(hotkey));
}

function ensureAtLeastOneHotkey(hotkeys: string[], blocked: string[], candidates: string[], fallback: string) {
  const trimmed = removeBlockedHotkeys(hotkeys, blocked);
  if (trimmed.length) return trimmed;

  const blockedSet = new Set(blocked);
  for (const candidate of candidates) {
    const normalized = normalizeHotkeyAccelerator(candidate, '');
    if (normalized && !blockedSet.has(normalized)) {
      return [normalized];
    }
  }

  const normalizedFallback = normalizeHotkeyAccelerator(fallback, fallback);
  return blockedSet.has(normalizedFallback) ? [] : [normalizedFallback];
}

function resolveRegisteredHotkeys(
  normalizedToggleHotkeys: string[],
  normalizedPushToTalkHotkeys: string[],
  normalizedCancelHotkeys: string[],
  previousHotkeys: RegisteredHotkeys
): RegisteredHotkeys {
  let resolvedToggleHotkeys = [...normalizedToggleHotkeys];
  let resolvedPushToTalkHotkeys = [...normalizedPushToTalkHotkeys];

  const toggleChanged = !arraysEqual(normalizedToggleHotkeys, previousHotkeys.toggleHotkey);
  const pushChanged = !arraysEqual(normalizedPushToTalkHotkeys, previousHotkeys.pushToTalkHotkey);

  if (toggleChanged && !pushChanged) {
    resolvedToggleHotkeys = removeBlockedHotkeys(resolvedToggleHotkeys, resolvedPushToTalkHotkeys);
  } else {
    resolvedPushToTalkHotkeys = removeBlockedHotkeys(resolvedPushToTalkHotkeys, resolvedToggleHotkeys);
  }

  resolvedToggleHotkeys = ensureAtLeastOneHotkey(
    resolvedToggleHotkeys,
    resolvedPushToTalkHotkeys,
    [...normalizedToggleHotkeys, ...previousHotkeys.toggleHotkey],
    DEFAULT_TOGGLE_HOTKEY
  );
  resolvedPushToTalkHotkeys = ensureAtLeastOneHotkey(
    resolvedPushToTalkHotkeys,
    resolvedToggleHotkeys,
    [...normalizedPushToTalkHotkeys, ...previousHotkeys.pushToTalkHotkey],
    DEFAULT_PUSH_TO_TALK_HOTKEY
  );

  return {
    toggleHotkey: resolvedToggleHotkeys,
    pushToTalkHotkey: resolvedPushToTalkHotkeys,
    cancelHotkey: ensureAtLeastOneHotkey(
      removeBlockedHotkeys(normalizedCancelHotkeys, [...resolvedToggleHotkeys, ...resolvedPushToTalkHotkeys]),
      [...resolvedToggleHotkeys, ...resolvedPushToTalkHotkeys],
      [...normalizedCancelHotkeys, ...previousHotkeys.cancelHotkey],
      DEFAULT_CANCEL_HOTKEY
    ),
  };
}

function startHotkeyWatcher(toggleHotkeys: string[], pushToTalkHotkeys: string[], cancelHotkeys: string[]): RegisteredHotkeys | null {
  const toggleSpecs = toggleHotkeys
    .map((hotkey) => buildHotkeySpec(hotkey, DEFAULT_TOGGLE_HOTKEY))
    .filter((spec): spec is HotkeySpec => spec !== null);
  const pushToTalkSpecs = pushToTalkHotkeys
    .map((hotkey) => buildHotkeySpec(hotkey, DEFAULT_PUSH_TO_TALK_HOTKEY))
    .filter((spec): spec is HotkeySpec => spec !== null);
  const cancelSpecs = cancelHotkeys
    .map((hotkey) => buildHotkeySpec(hotkey, DEFAULT_CANCEL_HOTKEY))
    .filter((spec): spec is HotkeySpec => spec !== null);

  if (!toggleSpecs.length || !pushToTalkSpecs.length || !cancelSpecs.length) {
    console.error('[hotkey] Cannot start watcher: missing specs — toggle:', toggleSpecs.length, 'pushToTalk:', pushToTalkSpecs.length, 'cancel:', cancelSpecs.length);
    return null;
  }

  stopHotkeyWatcher();
  hotkeyWatcherReady = false;

  const script = createHotkeyWatchScript(toggleSpecs, pushToTalkSpecs, cancelSpecs);
  const encodedScript = Buffer.from(script, 'utf16le').toString('base64');
  const watcher: ChildProcessWithoutNullStreams = spawn('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedScript], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  hotkeyWatcher = watcher;

  let stdoutBuffer = '';
  watcher.stdout.on('data', (chunk: Buffer) => {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? '';

    for (const line of lines.map((value) => value.trim()).filter(Boolean)) {
      if (line === 'ready') {
        flushHotkeyWatcherReady(true);
      } else if (line === 'toggle_down') {
        if (recordingMode === 'toggle') {
          stopRecording('toggle');
        } else if (recordingMode === 'idle') {
          startRecording('toggle');
        }
      } else if (line === 'push_down') {
        if (recordingMode === 'idle') {
          startRecording('push-to-talk');
        }
      } else if (line === 'push_up') {
        stopRecording('push-to-talk');
      } else if (line === 'cancel_down') {
        cancelDictation();
      }
    }
  });

  watcher.stderr.on('data', (chunk: Buffer) => {
    const message = sanitizePowerShellError(chunk.toString());
    if (message) {
      console.error('[hotkey] Watcher error:', message);
    }
  });

  watcher.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error('[hotkey] Watcher exited with code:', code);
    }
    if (hotkeyWatcher === watcher) {
      hotkeyWatcher = null;
    }
    flushHotkeyWatcherReady(false);

    // Auto-restart the watcher if it exits unexpectedly and we still have a bound window
    if (boundWindow && !boundWindow.isDestroyed() && code !== 0) {
      setTimeout(() => {
        if (boundWindow && !boundWindow.isDestroyed() && !hotkeyWatcher) {
          const restarted = startHotkeyWatcher(currentHotkeys.toggleHotkey, currentHotkeys.pushToTalkHotkey, currentHotkeys.cancelHotkey);
          if (restarted) {
            currentHotkeys = restarted;
          } else {
            console.error('[hotkey] Watcher restart failed');
          }
        }
      }, 2000);
    }
  });

  return {
    toggleHotkey: normalizeHotkeyList(toggleHotkeys, DEFAULT_TOGGLE_HOTKEY),
    pushToTalkHotkey: normalizeHotkeyList(pushToTalkHotkeys, DEFAULT_PUSH_TO_TALK_HOTKEY),
    cancelHotkey: normalizeHotkeyList(cancelHotkeys, DEFAULT_CANCEL_HOTKEY),
  };
}

export function registerHotkeys(
  settings: Pick<Settings, 'toggleHotkey' | 'pushToTalkHotkey' | 'cancelHotkey'>,
  mainWindow: BrowserWindow,
  onCancelDictation?: () => void
): RegisteredHotkeys {
  boundWindow = mainWindow;
  cancelDictationHandler = onCancelDictation ?? null;

  const previousHotkeys = { ...currentHotkeys };
  const normalizedToggleHotkeys = normalizeHotkeyList(settings.toggleHotkey, DEFAULT_TOGGLE_HOTKEY);
  const normalizedPushToTalkHotkeys = normalizeHotkeyList(settings.pushToTalkHotkey, DEFAULT_PUSH_TO_TALK_HOTKEY);
  const normalizedCancelHotkeys = normalizeHotkeyList(settings.cancelHotkey, DEFAULT_CANCEL_HOTKEY);
  const resolved = resolveRegisteredHotkeys(
    normalizedToggleHotkeys,
    normalizedPushToTalkHotkeys,
    normalizedCancelHotkeys,
    previousHotkeys
  );

  const started = startHotkeyWatcher(resolved.toggleHotkey, resolved.pushToTalkHotkey, resolved.cancelHotkey);
  if (started) {
    currentHotkeys = started;
    return currentHotkeys;
  }

  const restored = startHotkeyWatcher(previousHotkeys.toggleHotkey, previousHotkeys.pushToTalkHotkey, previousHotkeys.cancelHotkey);
  if (restored) {
    currentHotkeys = restored;
    return currentHotkeys;
  }

  currentHotkeys = previousHotkeys;
  return currentHotkeys;
}

export function resetHotkeyState(state: boolean): void {
  isRecording = state;
  if (!state) {
    recordingMode = 'idle';
  }
}

export function unregisterAll(): void {
  if (isRecording) stopRecording();
  stopHotkeyWatcher();
}

export function suspendHotkey(): void {
  if (isRecording) stopRecording();
  isRecording = false;
  recordingMode = 'idle';
  stopHotkeyWatcher();
}

export function waitForHotkeyWatcherReady(timeoutMs = 2500): Promise<boolean> {
  if (hotkeyWatcherReady) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ready);
    };

    const timer = setTimeout(() => finish(false), timeoutMs);
    hotkeyWatcherReadyWaiters.push(finish);
  });
}
