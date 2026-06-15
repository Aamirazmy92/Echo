// Watches source files and restarts the whole app on any change, so you don't
// have to re-run `npm start` by hand.
//
//   npm run dev      (or: node scripts/dev.cjs)
//
// Each restart rebuilds the bundles (unminified) then launches Electron. On a
// file change we kill the running app, WAIT for it to actually exit (so the
// single-instance lock in src/main/index.ts is released before the next
// instance asks for it), then rebuild and relaunch. Saves are debounced so a
// burst of edits restarts once.
//
// We resolve the Electron binary via `require('electron')` instead of relying
// on the `electron` command being on PATH. PATH only contains node_modules/.bin
// when a command runs through an npm script; this watcher spawns its own child
// processes directly, where that bin dir is NOT on PATH.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const electronBin = require('electron'); // absolute path to electron.exe
const buildScript = path.join(root, 'scripts', 'build-bundles.cjs');

const watchTargets = [
  path.join(root, 'src'),
  path.join(root, 'index.html'),
  path.join(root, 'vite.main.config.ts'),
  path.join(root, 'vite.preload.config.ts'),
  path.join(root, 'vite.renderer.config.ts'),
  path.join(root, 'tailwind.config.js'),
  path.join(root, 'postcss.config.js'),
];
const watchedExt = new Set(['.ts', '.tsx', '.js', '.jsx', '.cjs', '.css', '.html', '.json']);

let child = null; // the build process or the electron process, whichever is live
let busy = false; // a start/restart sequence is in progress
let pending = false; // a change arrived mid-sequence; restart again when done
let debounce = null;

// Kill a process tree. Windows needs taskkill /T to reach Electron's child
// renderer/GPU processes; the shell-PID's children won't die otherwise.
function killTree(pid) {
  return new Promise((resolve) => {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }).on('exit', () => resolve());
  });
}

// Kill whatever child is currently running and wait for its real exit event,
// not just for taskkill to return. The exit event is when the OS has actually
// reaped the process and released the single-instance lock.
async function killCurrent() {
  const c = child;
  if (!c || c.pid == null) return;
  const exited = new Promise((res) => c.once('exit', res));
  await killTree(c.pid);
  await exited;
}

function runBuild() {
  return new Promise((resolve) => {
    const b = spawn(process.execPath, [buildScript, '--dev'], { cwd: root, stdio: 'inherit' });
    child = b;
    b.on('exit', (code) => {
      if (child === b) child = null;
      resolve(code === 0);
    });
  });
}

function launchElectron() {
  const e = spawn(electronBin, ['.'], { cwd: root, stdio: 'inherit' });
  child = e;
  e.on('exit', (code) => {
    if (child === e) child = null;
    // A clean (code 0) or killed-for-restart exit is expected; only surface
    // genuine crashes, and only when we're not mid-restart.
    if (!busy && code) {
      console.log(`\n[dev] app exited (code ${code}). Waiting for a file change to retry...`);
    }
  });
}

async function startSequence() {
  busy = true;
  do {
    pending = false;
    await killCurrent();
    console.log('\n[dev] building...');
    const ok = await runBuild();
    if (!ok) {
      console.log('[dev] build failed — fix the error and save again to retry.');
      break;
    }
    console.log('[dev] launching app...');
    launchElectron();
  } while (pending); // a change landed during build/launch — go again
  busy = false;
}

function restart() {
  if (busy) {
    pending = true; // fold into the in-flight sequence
    return;
  }
  console.log('\n[dev] change detected — restarting app...');
  startSequence();
}

function onChange(filename) {
  if (filename && !watchedExt.has(path.extname(filename))) return;
  clearTimeout(debounce);
  debounce = setTimeout(restart, 200);
}

for (const target of watchTargets) {
  if (!fs.existsSync(target)) continue;
  const recursive = fs.statSync(target).isDirectory();
  fs.watch(target, { recursive }, (_event, filename) => onChange(filename));
}

process.on('SIGINT', async () => {
  busy = true; // suppress the crash message from the kill
  if (child && child.pid != null) await killTree(child.pid);
  process.exit(0);
});

console.log('[dev] watching for changes (Ctrl+C to stop). Starting app...');
startSequence();
