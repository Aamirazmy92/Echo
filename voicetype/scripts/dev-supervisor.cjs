const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const restartDelayMs = 180;

let forgeProcess = null;
let restartTimer = null;
let restartPending = null;
let shuttingDown = false;

const watchSpecs = [
  { target: path.join(projectRoot, 'src'), recursive: true, directory: true },
  { target: path.join(projectRoot, 'assets'), recursive: true, directory: true },
  { target: path.join(projectRoot, 'package.json'), directory: false },
  { target: path.join(projectRoot, 'forge.config.ts'), directory: false },
  { target: path.join(projectRoot, 'tailwind.config.js'), directory: false },
  { target: path.join(projectRoot, 'postcss.config.js'), directory: false },
  { target: path.join(projectRoot, 'vite.main.config.ts'), directory: false },
  { target: path.join(projectRoot, 'vite.preload.config.ts'), directory: false },
  { target: path.join(projectRoot, 'vite.renderer.config.ts'), directory: false },
];

const resolveNpmCliPath = () => {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(path.dirname(process.execPath)), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean);

  const match = candidates.find((candidate) => fs.existsSync(candidate));
  if (!match) {
    throw new Error('Unable to locate npm-cli.js for the dev supervisor.');
  }

  return match;
};

const npmCliPath = resolveNpmCliPath();

const getRestartMode = (filePath) => {
  const relativePath = path.relative(projectRoot, filePath).replace(/\\/g, '/');

  if (!relativePath || relativePath.startsWith('..')) {
    return 'none';
  }

  if (
    relativePath.startsWith('.vite/') ||
    relativePath.startsWith('out/') ||
    relativePath.startsWith('node_modules/') ||
    relativePath === '.DS_Store'
  ) {
    return 'none';
  }

  if (
    relativePath.startsWith('src/main/') ||
    relativePath.startsWith('src/shared/')
  ) {
    return 'soft';
  }

  if (
    relativePath === 'forge.config.ts' ||
    relativePath === 'package.json' ||
    relativePath === 'tailwind.config.js' ||
    relativePath === 'postcss.config.js' ||
    relativePath === 'vite.main.config.ts' ||
    relativePath === 'vite.preload.config.ts' ||
    relativePath === 'vite.renderer.config.ts'
  ) {
    return 'hard';
  }

  return 'none';
};

const killForgeTree = () => {
  if (!forgeProcess) {
    return;
  }

  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(forgeProcess.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }

  forgeProcess.kill('SIGTERM');
};

const startForge = () => {
  if (forgeProcess || shuttingDown) {
    return;
  }

  console.log('[dev] starting Electron Forge...');
  forgeProcess = spawn(
    process.execPath,
    [npmCliPath, 'run', 'start:forge'],
    {
      cwd: projectRoot,
      stdio: ['pipe', 'inherit', 'inherit'],
      env: {
        ...process.env,
        ECHO_DEV_SUPERVISOR: '1',
        NODE_OPTIONS: [process.env.NODE_OPTIONS, '--no-deprecation'].filter(Boolean).join(' '),
      },
    }
  );

  forgeProcess.on('exit', (code, signal) => {
    const pendingMode = restartPending;
    forgeProcess = null;

    if (shuttingDown) {
      process.exit(0);
      return;
    }

    if (pendingMode === 'hard') {
      restartPending = null;
      startForge();
      return;
    }

    restartPending = null;
    const reason = signal ? `signal ${signal}` : `code ${code ?? 0}`;
    console.log(`[dev] Electron Forge stopped (${reason}). Waiting for the next change to start it again.`);
  });
};

const requestRestart = (filePath) => {
  const restartMode = getRestartMode(filePath);

  if (restartMode === 'none') {
    if (!forgeProcess) {
      startForge();
    }
    return;
  }

  if (restartTimer) {
    clearTimeout(restartTimer);
  }

  restartTimer = setTimeout(() => {
    restartTimer = null;

    if (!forgeProcess) {
      startForge();
      return;
    }

    const relativePath = path.relative(projectRoot, filePath);

    if (restartMode === 'soft') {
      console.log(`[dev] ${relativePath} changed, restarting the Electron app...`);
      if (forgeProcess.stdin?.writable) {
        forgeProcess.stdin.write('rs\n');
        return;
      }

      restartPending = 'hard';
      killForgeTree();
      return;
    }

    restartPending = 'hard';
    console.log(`[dev] ${relativePath} changed, restarting the Electron dev session...`);
    killForgeTree();
  }, restartDelayMs);
};

const watchers = watchSpecs
  .filter(({ target }) => fs.existsSync(target))
  .map(({ target, recursive, directory }) =>
    fs.watch(target, { recursive: Boolean(recursive) }, (_eventType, fileName) => {
      const resolvedPath =
        directory && typeof fileName === 'string' && fileName.length > 0
          ? path.resolve(target, fileName)
          : target;
      requestRestart(resolvedPath);
    })
  );

const shutdown = () => {
  shuttingDown = true;

  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  for (const watcher of watchers) {
    watcher.close();
  }

  if (forgeProcess) {
    killForgeTree();
    return;
  }

  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

startForge();
