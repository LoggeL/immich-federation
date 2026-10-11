import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

/** Serves gateway/public under /federation/. Returns false if the file does not exist. */
export async function serveStatic(req: IncomingMessage, res: ServerResponse, publicDir: string): Promise<boolean> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return false;
  }
  const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://local').pathname);
  let rel = pathname.replace(/^\/federation\/?/, '');
  if (rel === '' || rel.endsWith('/')) {
    rel += 'index.html';
  }
  const root = normalize(publicDir + sep);
  const file = normalize(join(root, rel));
  if (!file.startsWith(root) || rel.split('/').some((s) => s.startsWith('.'))) {
    return false;
  }
  let info;
  try {
    info = await stat(file);
  } catch {
    return false;
  }
  if (!info.isFile()) {
    return false;
  }
  res.writeHead(200, {
    'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': info.size,
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
    'last-modified': info.mtime.toUTCString(),
  });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  createReadStream(file).on('error', () => res.destroy()).pipe(res);
  return true;
}
