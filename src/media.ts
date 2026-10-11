import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { LocalizedError } from './i18n.ts';

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/png': '.png',
  'image/avif': '.avif',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'image/gif': '.gif',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
};

export function extensionForMime(mime: string | null | undefined, fallback: string): string {
  const clean = (mime ?? '').split(';')[0].trim().toLowerCase();
  return EXT_BY_MIME[clean] ?? fallback;
}

/** Original basename + an extension that matches the uploaded content. */
export function uploadFilename(originalFileName: string | undefined | null, remoteId: string, ext: string): string {
  const base = (originalFileName ?? '').replace(/[/\\]/g, '_').replace(/\.[^.]*$/, '').trim();
  return `${base || `federated-${remoteId}`}${ext}`;
}

/** Browser-displayable image types (mirrors immich web isWebCompatibleImage closely enough). */
export function isWebCompatibleImageMime(mime: string | null | undefined): boolean {
  const m = (mime ?? '').toLowerCase();
  return ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/svg+xml', 'image/apng', 'image/bmp'].includes(m);
}

export class TooLargeError extends LocalizedError {}

/** Write a (remote) body to disk, aborting once more than `maxBytes` arrived. */
export async function streamToFile(
  body: ReadableStream<Uint8Array> | null,
  file: string,
  maxBytes = Number.POSITIVE_INFINITY,
): Promise<number> {
  if (!body) {
    throw new LocalizedError('empty_response');
  }
  let seen = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length;
      if (seen > maxBytes) {
        callback(new TooLargeError('file_exceeds_limit', { mb: Math.round(maxBytes / 1024 / 1024) }));
        return;
      }
      callback(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(body as any), limit, createWriteStream(file));
  return (await stat(file)).size;
}

export async function sha1File(file: string): Promise<string> {
  const hash = createHash('sha1');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

export class TempDir {
  root: string;
  constructor(dataDir: string) {
    this.root = join(dataDir, 'tmp');
  }
  async reset() {
    await rm(this.root, { recursive: true, force: true });
    await mkdir(this.root, { recursive: true });
  }
  async make(prefix: string) {
    const dir = join(this.root, `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await mkdir(dir, { recursive: true });
    return dir;
  }
}

let ffmpegAvailable: boolean | undefined;

export async function hasFfmpeg(ffmpegPath: string): Promise<boolean> {
  if (ffmpegAvailable !== undefined) {
    return ffmpegAvailable;
  }
  ffmpegAvailable = await new Promise<boolean>((resolve) => {
    const child = spawn(ffmpegPath, ['-version'], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
  return ffmpegAvailable;
}

/** Simple semaphore (ffmpeg processes, remote downloads). */
export class Semaphore {
  #free: number;
  #waiters: Array<() => void> = [];
  constructor(count: number) {
    this.#free = count;
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#free > 0) {
      this.#free--;
    } else {
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
    try {
      return await fn();
    } finally {
      const next = this.#waiters.shift();
      if (next) {
        next();
      } else {
        this.#free++;
      }
    }
  }
}

const ffmpegSlots = new Semaphore(1);

/**
 * Transcode to a small H.264/AAC proxy (default 480p). Only downscales, keeps aspect ratio,
 * applies rotation, faststart for streaming.
 */
export function transcodeVideoProxy(
  ffmpegPath: string,
  input: string,
  output: string,
  height = 480,
  timeoutMs = 30 * 60_000,
): Promise<void> {
  return ffmpegSlots.run(
    () =>
      new Promise<void>((resolve, reject) => {
        const args = [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-i',
          input,
          '-map',
          '0:v:0',
          '-map',
          '0:a:0?',
          '-vf',
          `scale=-2:'min(${height},ih)':flags=bicubic,format=yuv420p`,
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '28',
          '-maxrate',
          '1500k',
          '-bufsize',
          '3000k',
          '-c:a',
          'aac',
          '-b:a',
          '96k',
          '-ac',
          '2',
          '-movflags',
          '+faststart',
          '-map_metadata',
          '0',
          output,
        ];
        const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (chunk) => {
          stderr = (stderr + chunk.toString()).slice(-4000);
        });
        const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
        child.on('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on('exit', (code, signal) => {
          clearTimeout(timer);
          if (code === 0) {
            resolve();
          } else {
            reject(
              new LocalizedError('ffmpeg_failed', {
                code: String(signal ?? code),
                detail: stderr.trim().split('\n').slice(-3).join(' | '),
              }),
            );
          }
        });
      }),
  );
}
