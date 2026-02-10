import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { writeFile, mkdir } from 'fs/promises';
import zlib from 'zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, 'dist');

const watch = process.argv.includes('--watch');

function pngChunk(tag, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  const content = Buffer.concat([Buffer.from(tag), data]);
  crc.writeUInt32BE((zlib.crc32?.(content) ?? crc32(content)) >>> 0, 0);
  return Buffer.concat([length, content, crc]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc ^= buffer[i];
    for (let j = 0; j < 8; j++) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (~crc) >>> 0;
}

async function writePng(path, width, height, rows) {
  const header = Buffer.from('\x89PNG\r\n\x1A\n', 'binary');
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8);
  ihdr.writeUInt8(6, 9);
  ihdr.writeUInt8(0, 10);
  ihdr.writeUInt8(0, 11);
  ihdr.writeUInt8(0, 12);

  const raw = Buffer.concat(rows.flatMap((row) => [Buffer.from([0]), Buffer.from(row)]));
  const idat = zlib.deflateSync(raw, { level: 9 });
  const png = Buffer.concat([
    header,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  await writeFile(path, png);
}

function buildIconPixels(size) {
  const pixels = Array.from({ length: size }, () =>
    Array.from({ length: size }, () => [15, 132, 230, 255])
  );

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (x === 0 || y === 0 || x === size - 1 || y === size - 1) {
        pixels[y][x] = [255, 255, 255, 255];
      }
    }
  }

  const bx1 = Math.floor(size * 0.18);
  const by1 = Math.floor(size * 0.42);
  const bx2 = Math.floor(size * 0.82);
  const by2 = Math.floor(size * 0.76);
  for (let y = by1; y < by2; y++) {
    for (let x = bx1; x < bx2; x++) pixels[y][x] = [245, 245, 245, 255];
  }

  const hx1 = Math.floor(size * 0.36);
  const hy1 = Math.floor(size * 0.3);
  const hx2 = Math.floor(size * 0.64);
  const hy2 = Math.floor(size * 0.44);
  for (let y = hy1; y < hy2; y++) {
    for (let x = hx1; x < hx2; x++) {
      if (y - hy1 < 2 || hy2 - y <= 2 || x - hx1 < 2 || hx2 - x <= 2) {
        pixels[y][x] = [245, 245, 245, 255];
      }
    }
  }

  const ix = Math.floor(size * 0.24);
  const iy = Math.floor(size * 0.5);
  const iw = Math.max(1, Math.floor(size / 14));
  const ih = Math.floor(size * 0.18);
  for (let y = iy; y < Math.min(size, iy + ih); y++) {
    for (let x = ix; x < Math.min(size, ix + iw); x++) pixels[y][x] = [10, 102, 194, 255];
    for (let x = ix + iw * 2; x < Math.min(size, ix + iw * 3); x++) pixels[y][x] = [10, 102, 194, 255];
  }

  const line = (x1, y1, x2, y2, color, width) => {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const steps = Math.max(Math.abs(dx), Math.abs(dy), 1);
    for (let i = 0; i <= steps; i++) {
      const x = Math.round(x1 + (dx * i) / steps);
      const y = Math.round(y1 + (dy * i) / steps);
      for (let yy = Math.max(0, y - width); yy <= Math.min(size - 1, y + width); yy++) {
        for (let xx = Math.max(0, x - width); xx <= Math.min(size - 1, x + width); xx++) {
          pixels[yy][xx] = color;
        }
      }
    }
  };

  const lw = Math.max(1, Math.floor(size / 32));
  line(Math.floor(size * 0.55), Math.floor(size * 0.6), Math.floor(size * 0.64), Math.floor(size * 0.69), [22, 163, 74, 255], lw);
  line(Math.floor(size * 0.64), Math.floor(size * 0.69), Math.floor(size * 0.8), Math.floor(size * 0.53), [22, 163, 74, 255], lw);

  return pixels.map((row) => Uint8Array.from(row.flat()));
}

async function generateIcons(outputBaseDir) {
  const iconDir = join(outputBaseDir, 'assets/icons');
  await mkdir(iconDir, { recursive: true });
  for (const size of [16, 32, 48, 128, 256]) {
    await writePng(join(iconDir, `icon${size}.png`), size, size, buildIconPixels(size));
  }
}

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
  await generateIcons(outDir);

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
  await generateIcons(outDir);
  console.log('Watching...');
} else {
  await build();
}
