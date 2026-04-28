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
