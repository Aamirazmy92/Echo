#!/usr/bin/env node
/**
 * One-shot release script for Echo.
 *
 * Usage:
 *   npm run release -- <version> "<release notes>"
 *
 * Example:
 *   npm run release -- 1.0.6 "Fix renderer asset paths under file://"
 *
 * Steps:
 *   1. Validate args + clean git tree
 *   2. Bump package.json + package-lock.json to <version>
 *   3. Run typecheck
 *   4. Build NSIS installer (`make:nsis`)
 *   5. Verify dist artifacts (Echo-Setup-<ver>.exe, .blockmap, latest.yml)
 *   6. git add / commit / tag v<version>
 *   7. git push origin main + tag
 *   8. gh release create with assets
 *
 * Required tools on PATH: node, npm, git, gh.
 * Required env (only if your build is signed): SIGNING_CERT_PATH,
 *   SIGNING_CERT_PASSWORD. Set ECHO_ALLOW_UNSIGNED=1 to skip the signing
 *   guard for development releases.
 */

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

function step(title) {
  console.log(`\n──▶ ${title}`);
}

// On Windows, `.cmd` shims (npm, gh, npx) can only be spawned through the
// shell. Real `.exe`s (git, node) must NOT use shell:true because cmd.exe
// re-parses the joined command string and strips the quotes around args
// containing characters like `:`, which then break commands like
// `git commit -m "release: v1.0.6"`.
const CMD_SHIMS = new Set(['npm', 'npx', 'gh', 'yarn', 'pnpm']);

function resolveCommand(cmd) {
  return process.platform === 'win32' && CMD_SHIMS.has(cmd) ? `${cmd}.cmd` : cmd;
}

function run(cmd, args, opts = {}) {
  const printable = `${cmd} ${args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`;
  console.log(`  $ ${printable}`);

  // On Windows, `.cmd` shims must be invoked through their `.cmd` file
  // directly (not through `shell: true`) because `cmd.exe` re-encodes
  // the joined command line in the active codepage, which mangles
  // non-ASCII characters like em-dashes / smart quotes that often end
  // up in release notes. Spawning the resolved `.cmd` directly with
  // `shell: false` keeps the args as-is from the Node process.
  const result = spawnSync(resolveCommand(cmd), args, {
    stdio: 'inherit',
    cwd: projectRoot,
    shell: false,
    env: process.env,
    windowsVerbatimArguments: false,
    ...opts,
  });
  if (result.status !== 0) {
    fail(`Command failed (exit ${result.status}): ${printable}`);
  }
}

function capture(cmd, args) {
  const printable = `${cmd} ${args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`;
  const result = spawnSync(resolveCommand(cmd), args, {
    cwd: projectRoot,
    shell: false,
    env: process.env,
    encoding: 'utf8',
    windowsVerbatimArguments: false,
  });
  if (result.status !== 0) {
    fail(`Command failed (exit ${result.status}): ${printable}\n${result.stderr || result.stdout || ''}`);
  }
  return result.stdout.trim();
}

function captureGit(args) {
  return execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8' }).trim();
}

// ---- 1. Validate args + tree -----------------------------------------------

const [, , versionArg, notesArg] = process.argv;
if (!versionArg) {
  fail('Missing <version>. Usage: npm run release -- <version> "<notes>"');
}
const version = versionArg.replace(/^v/, '');
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  fail(`Invalid version "${version}". Expected semver like 1.0.6 or 1.2.0-beta.1`);
}
const tag = `v${version}`;
const notes = notesArg && notesArg.trim().length > 0
  ? notesArg
  : `Echo ${tag}`;

step(`Releasing ${tag}`);

// Working tree should be clean (otherwise the auto-commit will sweep up
// unrelated changes).
const dirty = captureGit(['status', '--porcelain']);
if (dirty) {
  console.error('\nUncommitted changes detected:');
  console.error(dirty);
  fail('Commit or stash your changes first, then re-run the release.');
}

// Tag must not already exist locally or remotely.
try {
  execFileSync('git', ['rev-parse', '--verify', tag], { cwd: projectRoot, stdio: 'ignore' });
  fail(`Tag ${tag} already exists locally. Delete it first: git tag -d ${tag}`);
} catch {
  // tag doesn't exist locally — good
}

// ---- 2. Bump version --------------------------------------------------------

step(`Bumping package.json to ${version}`);
run('npm', ['version', version, '--no-git-tag-version', '--allow-same-version']);

// ---- 3. Typecheck -----------------------------------------------------------

step('Typechecking');
run('npm', ['run', 'typecheck']);

// ---- 4. Build NSIS installer -----------------------------------------------

step(`Building NSIS installer`);
run('npm', ['run', 'make:nsis']);

// ---- 5. Verify dist artifacts ----------------------------------------------

step('Verifying dist artifacts');
const distDir = path.join(projectRoot, 'dist');
const expected = [
  `Echo-Setup-${version}.exe`,
  `Echo-Setup-${version}.exe.blockmap`,
  'latest.yml',
];
const missing = expected.filter((name) => !fs.existsSync(path.join(distDir, name)));
if (missing.length > 0) {
  fail(`Missing build artifacts in dist/: ${missing.join(', ')}`);
}
console.log(`  ✓ Found ${expected.join(', ')}`);

const appAsarPath = path.join(distDir, 'win-unpacked', 'resources', 'app.asar');
if (!fs.existsSync(appAsarPath)) {
  fail('Missing packaged app.asar in dist/win-unpacked/resources/.');
}

const asarEntries = capture('npx', ['asar', 'list', appAsarPath]).replace(/\\/g, '/');
const requiredAsarEntries = [
  '/.vite/build/main.js',
  '/.vite/build/preload.js',
  '/.vite/renderer/main_window/index.html',
];
const missingAsarEntries = requiredAsarEntries.filter((entry) => !asarEntries.includes(entry));
if (missingAsarEntries.length > 0) {
  fail(`Packaged app.asar is missing required runtime files: ${missingAsarEntries.join(', ')}`);
}
console.log(`  ✓ app.asar contains ${requiredAsarEntries.join(', ')}`);

// ---- 6. Commit + tag --------------------------------------------------------

step('Committing version bump');
run('git', ['add', '-A']);

const stagedDiff = captureGit(['diff', '--cached', '--name-only']);
if (stagedDiff) {
  run('git', ['commit', '-m', `release: ${tag}`]);
} else {
  console.log('  (nothing to commit — package.json was already at this version)');
}

step(`Tagging ${tag}`);
run('git', ['tag', tag]);

// ---- 7. Push ----------------------------------------------------------------

step('Pushing main and tag');
run('git', ['push', 'origin', 'HEAD']);
run('git', ['push', 'origin', tag]);

// ---- 8. Create GitHub release ----------------------------------------------

step(`Creating GitHub release ${tag}`);
const assets = expected.map((name) => path.join('dist', name));
run('gh', ['release', 'create', tag, ...assets, '--title', tag, '--notes', notes]);

step('Verifying release assets');
run('gh', ['release', 'view', tag, '--json', 'assets', '--jq', '.assets[].name']);

console.log(`\n✓ ${tag} released. Existing installs will pick it up on the next update check.\n`);
