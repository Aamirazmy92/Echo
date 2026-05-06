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

function run(cmd, args, opts = {}) {
  const printable = `${cmd} ${args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`;
  console.log(`  $ ${printable}`);
  const result = spawnSync(cmd, args, {
    stdio: 'inherit',
    cwd: projectRoot,
    shell: process.platform === 'win32',
    env: process.env,
    ...opts,
  });
  if (result.status !== 0) {
    fail(`Command failed (exit ${result.status}): ${printable}`);
  }
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
