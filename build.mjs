import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, 'dist');
const distPopupDir = join(__dirname, 'dist-popup');

const watch = process.argv.includes('--watch');

/** Bump patch version (e.g. 1.0.0 → 1.0.1) in package.json. Returns new version. */
function bumpVersion() {
  const pkgPath = join(__dirname, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  const parts = (pkg.version || '1.0.0').split('.').map(Number);
  if (parts.length < 3) parts.push(0, 0);
  parts[2] = (parts[2] || 0) + 1;
  const newVersion = parts.join('.');
  pkg.version = newVersion;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`Version bumped → ${newVersion}`);
  return newVersion;
}

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

async function build(bump = false) {
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  if (bump) bumpVersion();
  syncVersion();

  await esbuild.build({
    entryPoints: [
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
  // Popup is built by Vite (npm run build:popup); copy from dist-popup
  if (existsSync(distPopupDir)) {
    const popupHtmlNested = join(distPopupDir, 'src', 'popup-react', 'popup.html');
    const popupHtmlRoot = join(distPopupDir, 'popup.html');
    if (existsSync(popupHtmlNested)) {
      copyFileSync(popupHtmlNested, join(outDir, 'popup.html'));
    } else if (existsSync(popupHtmlRoot)) {
      copyFileSync(popupHtmlRoot, join(outDir, 'popup.html'));
    }
    const files = readdirSync(distPopupDir);
    for (const f of files) {
      if (f.startsWith('popup') && (f.endsWith('.js') || f.endsWith('.css'))) {
        copyFileSync(join(distPopupDir, f), join(outDir, f));
      }
    }
  }

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
  await build(true); // auto-increment version on each full build
}
