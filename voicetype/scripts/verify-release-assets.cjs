const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

// Whisper-server binaries are mandatory — without them the local
// transcription mode cannot run, and there is no recovery short of a new
// release. The model file (`ggml-base.bin`) is intentionally optional:
// the app downloads it on first run when the user enables local
// transcription, so shipping without it just means a smaller installer.
const requiredAssets = [
  path.join(root, 'vendor', 'whispercpp', 'blas-bin', 'Release', 'whisper-server.exe'),
];

const optionalAssets = [
  path.join(root, 'vendor', 'whispercpp', 'ggml-base.bin'),
];

const missingRequired = requiredAssets.filter((assetPath) => !fs.existsSync(assetPath));

if (missingRequired.length > 0) {
  const missingList = missingRequired
    .map((assetPath) => `- ${path.relative(root, assetPath)}`)
    .join('\n');

  console.error(
    'Release assets are incomplete.\n' +
    'Echo release builds require the whisper.cpp server binaries.\n' +
    'Add the missing files before running package/make/publish:\n' +
    `${missingList}`
  );
  process.exit(1);
}

// ---------- Code-signing enforcement ----------
//
// NSIS/electron-updater should ship signed installers for the best Windows
// trust and update experience. Existing unsigned local smoke tests can opt
// out explicitly, but public releases should always be signed.
//
// electron-builder can produce unsigned installers when SIGNING_CERT_PATH /
// SIGNING_CERT_PASSWORD are missing, so this guard fails fast before release
// artifacts are generated.
const lifecycleEvent = process.env.npm_lifecycle_event || '';
const releaseLifecycles = new Set(['make', 'make:nsis', 'publish', 'publish:nsis']);
const isReleaseBuild = releaseLifecycles.has(lifecycleEvent);
const allowUnsigned = process.env.ECHO_ALLOW_UNSIGNED === '1';

if (isReleaseBuild) {
  const certPath = (process.env.SIGNING_CERT_PATH || '').trim();
  const certPassword = process.env.SIGNING_CERT_PASSWORD || '';

  if (!certPath || !certPassword) {
    if (allowUnsigned) {
      console.warn(
        '\n[!] Building UNSIGNED release artifacts because ECHO_ALLOW_UNSIGNED=1.\n' +
        '    Use only for local smoke tests, never for a release pushed to users.\n'
      );
    } else {
      console.error(
        '\nCode-signing is required for `npm run ' + lifecycleEvent + '`.\n' +
        '\n' +
        'Set both env vars before invoking this command:\n' +
        '  - SIGNING_CERT_PATH       absolute path to your .pfx / .p12 cert\n' +
        '  - SIGNING_CERT_PASSWORD   password for that cert\n' +
        '\n' +
        'If this is intentionally a local-only test build, opt out with:\n' +
        '  ECHO_ALLOW_UNSIGNED=1 npm run ' + lifecycleEvent + '\n'
      );
      process.exit(1);
    }
  } else if (!fs.existsSync(certPath)) {
    console.error(
      '\nSIGNING_CERT_PATH points to a file that does not exist:\n' +
      `  ${certPath}\n` +
      '\nFix the path or unset the variable and re-run.'
    );
    process.exit(1);
  } else {
    console.log('Code-signing cert located:', path.basename(certPath));
  }
}

const missingOptional = optionalAssets.filter((assetPath) => !fs.existsSync(assetPath));
if (missingOptional.length > 0) {
  const missingList = missingOptional
    .map((assetPath) => `  - ${path.relative(root, assetPath)}`)
    .join('\n');
  console.warn(
    'Release assets verified (without bundled Whisper model).\n' +
    'The app will download these on first use of local transcription:\n' +
    `${missingList}`
  );
} else {
  console.log('Release assets verified (with bundled Whisper model).');
}
