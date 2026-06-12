// Builds the main, preload, and renderer bundles via Vite's JS API in a
// single Node process, parallelizing where output directories allow.
//
//   node scripts/build-bundles.cjs         production build (used by package/make/publish)
//   node scripts/build-bundles.cjs --dev   fast local build: skips minification,
//                                          sourcemaps, and gzip-size reporting
//
// Ordering constraint: the main build empties .vite/build, which the preload
// build also writes into, so preload must run after main. The renderer build
// has its own outDir and runs concurrently with both.
async function main() {
  const { build } = await import('vite');
  const dev = process.argv.includes('--dev');
  const buildOverrides = dev
    ? { minify: false, sourcemap: false, reportCompressedSize: false }
    : {};

  const run = (configFile) => build({ configFile, build: { ...buildOverrides } });

  const started = Date.now();
  await Promise.all([
    (async () => {
      await run('vite.main.config.ts');
      await run('vite.preload.config.ts');
    })(),
    run('vite.renderer.config.ts'),
  ]);

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`Bundles built in ${seconds}s${dev ? ' (dev: unminified)' : ''}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
