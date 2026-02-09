import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, 'dist');

const watch = process.argv.includes('--watch');

async function build() {
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

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
