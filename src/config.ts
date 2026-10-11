import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

export interface Config {
  immichUrl: URL;
  port: number;
  host: string;
  dataDir: string;
  publicDir: string;
  federationSecret: string | undefined;
  syncIntervalMinutes: number;
  allowPrivateRemotes: boolean;
  ffmpegPath: string;
  videoProxyHeight: number;
  remoteTimeoutMs: number;
  /** Header timeout when a user opens an original (shorter, then the local copy is served). */
  interactiveTimeoutMs: number;
  /** Size limits for sync downloads (bytes). */
  maxPreviewBytes: number;
  maxVideoBytes: number;
  /** Parallel remote downloads during sync across ALL links (videos additionally one at a time). */
  downloadConcurrency: number;
  logLevel: string;
}

const bool = (value: string | undefined, fallback: boolean) => {
  if (value === undefined || value === '') {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
};

const int = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const immichUrl = new URL(env.IMMICH_URL || 'http://immich-server:2283');
  if (immichUrl.protocol !== 'http:' && immichUrl.protocol !== 'https:') {
    throw new Error(`IMMICH_URL must be http(s), got ${immichUrl.protocol}`);
  }
  const dataDir = resolve(env.DATA_DIR || './data');
  mkdirSync(dataDir, { recursive: true });

  return {
    immichUrl,
    port: int(env.PORT, 2283),
    host: env.HOST || '0.0.0.0',
    dataDir,
    publicDir: resolve(env.PUBLIC_DIR || new URL('../public', import.meta.url).pathname),
    federationSecret: env.FEDERATION_SECRET || undefined,
    syncIntervalMinutes: Math.max(1, int(env.SYNC_INTERVAL_MINUTES, 30)),
    allowPrivateRemotes: bool(env.ALLOW_PRIVATE_REMOTES, false),
    ffmpegPath: env.FFMPEG_PATH || 'ffmpeg',
    videoProxyHeight: Math.max(144, int(env.VIDEO_PROXY_HEIGHT, 480)),
    remoteTimeoutMs: Math.max(1000, int(env.REMOTE_TIMEOUT_MS, 20_000)),
    interactiveTimeoutMs: Math.max(1000, int(env.INTERACTIVE_TIMEOUT_MS, 8_000)),
    maxPreviewBytes: Math.max(1, int(env.MAX_PREVIEW_MB, 50)) * 1024 * 1024,
    maxVideoBytes: Math.max(1, int(env.MAX_VIDEO_MB, 4096)) * 1024 * 1024,
    downloadConcurrency: Math.min(10, Math.max(1, int(env.DOWNLOAD_CONCURRENCY, 3))),
    logLevel: env.LOG_LEVEL || 'info',
  };
}
