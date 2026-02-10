import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, 'dist');

const watch = process.argv.includes('--watch');

/** Sync version from package.json into manifest.json before copying to dist. */
function syncVersion() {
  const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf-8'));
  const manifestPath = join(__dirname, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  if (manifest.version !== pkg.version) {
    manifest.version = pkg.version;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    console.log(`Synced manifest version → ${pkg.version}`);
  }
}

async function build() {
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  // Sync version before build
  syncVersion();

  await esbuild.build({
    entryPoints: [
      'src/popup/popup.ts',
      'src/content/content.ts',
      'src/background/service-worker.ts',
    ],
    bundle: true,
    outdir: outDir,
    format: 'iife',
    platform: 'browser',
    target: 'chrome100',
    sourcemap: true,
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.css': 'css' },
    outExtension: { '.js': '.js' },
    entryNames: '[name]',
  });

  copyFileSync(join(__dirname, 'manifest.json'), join(outDir, 'manifest.json'));
  copyFileSync(join(__dirname, 'src/popup/popup.html'), join(outDir, 'popup.html'));
  copyFileSync(join(__dirname, 'src/popup/popup.css'), join(outDir, 'popup.css'));

  // Copy extension icons
  const iconsOutDir = join(outDir, 'icons');
  if (!existsSync(iconsOutDir)) mkdirSync(iconsOutDir, { recursive: true });
  for (const size of [16, 32, 48, 128]) {
    const src = join(__dirname, 'icons', `icon${size}.png`);
    if (existsSync(src)) {
      copyFileSync(src, join(iconsOutDir, `icon${size}.png`));
    }
  }

  // PDF.js worker (required for PDF resume parsing)
  const pdfWorkerSrc = join(__dirname, 'node_modules/pdfjs-dist/build/pdf.worker.mjs');
  if (existsSync(pdfWorkerSrc)) {
    copyFileSync(pdfWorkerSrc, join(outDir, 'pdf.worker.mjs'));
  }

  console.log('Build done.');
}

if (watch) {
  const ctx = await esbuild.context({
    entryPoints: [
      'src/popup/popup.ts',
      'src/content/content.ts',
      'src/background/service-worker.ts',
    ],
    bundle: true,
    outdir: outDir,
    format: 'iife',
    platform: 'browser',
    target: 'chrome100',
    sourcemap: true,
    define: { 'process.env.NODE_ENV': '"development"' },
    loader: { '.css': 'css' },
    outExtension: { '.js': '.js' },
    entryNames: '[name]',
  });
  await ctx.watch();
  console.log('Watching...');
} else {
  await build();
}
