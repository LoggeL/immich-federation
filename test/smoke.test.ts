/**
 * End-to-end smoke test: gateway in front of a fake "local Immich", syncing from a fake "friend Immich".
 * Covers streaming proxy, Set-Cookie, WebSocket upgrade, HTML injection, link creation + sync,
 * interception (incl. Range), auth fallthrough, remote-down fallback, deletion sync and disconnect.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { after, before, describe, it } from 'node:test';
import type { Config } from '../src/config.ts';
import { setLogLevel } from '../src/log.ts';
import { createGateway, type Gateway } from '../src/server.ts';

setLogLevel(process.env.LOG_LEVEL ?? 'warn');

const tmp = mkdtempSync(join(tmpdir(), 'fed-smoke-'));
const HTML = '<!doctype html><html><head><title>Immich</title></head><body><div id="app"></div></body></html>';
const SHARE_KEY = 'FRIENDKEY1234';

// ---------------- fake local Immich ----------------
const local = {
  albums: new Map<string, { id: string; albumName: string; description: string; assets: Set<string> }>(),
  assets: new Map<string, { id: string; filename: string; size: number; fieldsBeforeFile: boolean; type: string }>(),
  updates: new Map<string, any>(),
  deleted: [] as string[],
  apiKeys: 0,
  failPuts: 0,
};
const USER = { id: 'user-1', email: 'me@test', name: 'Me' };
const authorized = (req: http.IncomingMessage) =>
  String(req.headers.cookie ?? '').includes('immich_access_token=good') || req.headers['x-api-key'] === 'secret-key';

const readBody = async (req: http.IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
};
const sendJson = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const localServer = http.createServer(async (req, res) => {
  const url = new URL(req.url!, 'http://x');
  const p = url.pathname;
  if (p === '/' || p === '/photos') {
    const gz = String(req.headers['accept-encoding'] ?? '').includes('gzip');
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      etag: '"abc"',
      ...(gz ? { 'content-encoding': 'gzip' } : {}),
    });
    return res.end(gz ? gzipSync(HTML) : HTML);
  }
  if (p === '/api/echo') {
    const body = await readBody(req);
    return sendJson(res, 200, { length: body.length, method: req.method, xff: req.headers['x-forwarded-for'], host: req.headers.host });
  }
  if (p === '/api/cookies') {
    res.setHeader('set-cookie', ['a=1; Path=/', 'b=2; Path=/']);
    return sendJson(res, 200, {});
  }
  if (!authorized(req)) {
    return sendJson(res, 401, { message: 'Authentication required' });
  }
  if (p === '/api/users/me') return sendJson(res, 200, USER);
  if (p === '/api/api-keys' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString());
    assert.ok(body.permissions.includes('asset.upload'));
    local.apiKeys++;
    return sendJson(res, 201, { id: 'key-1', secret: 'secret-key' });
  }
  if (p === '/api/albums' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString());
    const album = { id: randomUUID(), albumName: body.albumName, description: body.description, assets: new Set<string>() };
    local.albums.set(album.id, album);
    return sendJson(res, 201, { id: album.id, albumName: album.albumName });
  }
  let m = /^\/api\/albums\/([^/]+)(\/assets)?$/.exec(p);
  if (m) {
    const album = local.albums.get(m[1]);
    if (!album) return sendJson(res, 400, { message: 'Album not found' });
    if (m[2] && req.method === 'PUT') {
      const { ids } = JSON.parse((await readBody(req)).toString());
      return sendJson(
        res,
        200,
        ids.map((id: string) => {
          if (!local.assets.has(id)) return { id, success: false, error: 'no_permission' };
          if (album.assets.has(id)) return { id, success: false, error: 'duplicate' };
          album.assets.add(id);
          return { id, success: true };
        }),
      );
    }
    if (m[2] && req.method === 'DELETE') {
      const { ids } = JSON.parse((await readBody(req)).toString());
      ids.forEach((id: string) => album.assets.delete(id));
      return sendJson(res, 200, []);
    }
    if (req.method === 'DELETE') {
      local.albums.delete(album.id);
      res.writeHead(204);
      return res.end();
    }
    return sendJson(res, 200, { id: album.id, albumName: album.albumName, assetCount: album.assets.size });
  }
  if (p === '/api/timeline/buckets') {
    const album = local.albums.get(url.searchParams.get('albumId')!);
    return sendJson(res, 200, album?.assets.size ? [{ timeBucket: '2025-01-01T00:00:00.000Z', count: album.assets.size }] : []);
  }
  if (p === '/api/timeline/bucket') {
    const album = local.albums.get(url.searchParams.get('albumId')!);
    return sendJson(res, 200, { id: [...(album?.assets ?? [])] });
  }
  if (p === '/api/assets' && req.method === 'POST') {
    const body = (await readBody(req)).toString('latin1');
    const fileIdx = body.indexOf('name="assetData"');
    assert.ok(fileIdx > 0, 'assetData part present');
    const fieldsBeforeFile = ['fileCreatedAt', 'fileModifiedAt', 'filename', 'metadata'].every((f) => {
      const i = body.indexOf(`name="${f}"`);
      return i > 0 && i < fileIdx;
    });
    const filename = /name="filename"\r\n\r\n([^\r]*)/.exec(body)?.[1] ?? '';
    const type = /name="assetData"; filename="[^"]*"\r\nContent-Type: ([^\r]*)/i.exec(body)?.[1] ?? '';
    const id = randomUUID();
    local.assets.set(id, { id, filename, size: body.length, fieldsBeforeFile, type });
    return sendJson(res, 201, { id, status: 'created' });
  }
  if (p === '/api/assets' && req.method === 'DELETE') {
    const { ids, force } = JSON.parse((await readBody(req)).toString());
    assert.equal(force, true);
    // like Immich v3.3.0 requireAccess: the whole batch fails if one id is not accessible
    if (ids.some((id: string) => !local.assets.has(id))) {
      return sendJson(res, 400, { message: 'Not found or no asset.delete access' });
    }
    for (const id of ids) {
      local.deleted.push(id);
      local.assets.delete(id);
      for (const a of local.albums.values()) a.assets.delete(id);
    }
    res.writeHead(204);
    return res.end();
  }
  m = /^\/api\/assets\/([^/]+)(\/original|\/video\/playback|\/thumbnail)?$/.exec(p);
  if (m) {
    if (!m[2] && req.method === 'PUT') {
      if (local.failPuts > 0) {
        local.failPuts--;
        return sendJson(res, 500, { message: 'boom' });
      }
      local.updates.set(m[1], JSON.parse((await readBody(req)).toString()));
      return sendJson(res, 200, {});
    }
    if (!local.assets.has(m[1])) return sendJson(res, 400, { message: 'Asset not found' });
    if (!m[2]) return sendJson(res, 200, { id: m[1], isTrashed: false });
    res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': '13' });
    return res.end(req.method === 'HEAD' ? undefined : 'LOCAL-PREVIEW');
  }
  // like Immich ApiService.ssr(): every GET/HEAD outside /api gets the SPA shell with 200 – no auth
  if ((req.method === 'GET' || req.method === 'HEAD') && !p.startsWith('/api')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(req.method === 'HEAD' ? undefined : HTML);
  }
  sendJson(res, 404, { message: 'not found' });
});

// WebSocket-ish echo: 101 then echo raw bytes
localServer.on('upgrade', (req, socket) => {
  if (!req.url!.startsWith('/api/socket.io/')) {
    socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Up: yes\r\n\r\n');
  socket.on('data', (d) => socket.write(Buffer.concat([Buffer.from('echo:'), d])));
  socket.on('end', () => socket.destroy());
});

// ---------------- fake friend Immich ----------------
const ORIGINAL = Buffer.from('REMOTE-ORIGINAL-BYTES-0123456789');
let friendAssets = [
  { id: 'r-img-1', isImage: true },
  { id: 'r-vid-1', isImage: false },
];
let videoBytes = Buffer.alloc(0);
const friendServer = http.createServer(async (req, res) => {
  const url = new URL(req.url!, 'http://x');
  if (url.searchParams.get('key') !== SHARE_KEY) return sendJson(res, 401, { message: 'Invalid share key' });
  const p = url.pathname;
  if (p === '/api/shared-links/me') {
    return sendJson(res, 200, {
      id: 'remote-link-1',
      type: 'ALBUM',
      allowDownload: true,
      showMetadata: true,
      assets: [],
      album: { id: 'remote-album-1', albumName: 'Urlaub 2025', albumUsers: [{ role: 'owner', user: { name: 'Anna' } }] },
    });
  }
  if (p === '/api/timeline/buckets') return sendJson(res, 200, [{ timeBucket: '2025-07-01T00:00:00.000Z', count: friendAssets.length }]);
  if (p === '/api/timeline/bucket') {
    return sendJson(res, 200, {
      id: friendAssets.map((a) => a.id),
      isImage: friendAssets.map((a) => a.isImage),
      isTrashed: friendAssets.map(() => false),
    });
  }
  const m = /^\/api\/assets\/([^/]+)(\/original|\/video\/playback|\/thumbnail)?$/.exec(p);
  if (m) {
    const isVideo = m[1].startsWith('r-vid');
    if (!m[2]) {
      return sendJson(res, 200, {
        id: m[1],
        type: isVideo ? 'VIDEO' : 'IMAGE',
        originalFileName: isVideo ? 'clip.MOV' : 'PXL_20250701.jpg',
        originalMimeType: isVideo ? 'video/quicktime' : 'image/jpeg',
        fileCreatedAt: '2025-07-01T12:00:00.000Z',
        fileModifiedAt: '2025-07-01T12:00:00.000Z',
        localDateTime: '2025-07-01T14:00:00.000Z',
        exifInfo: { dateTimeOriginal: '2025-07-01T12:00:00.000Z', latitude: 47.5, longitude: 11.1, description: null },
      });
    }
    if (m[2] === '/thumbnail') {
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      return res.end(Buffer.from('\xff\xd8\xff-JPEGDATA', 'latin1'));
    }
    if (m[2] === '/video/playback') {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(videoBytes.length) });
      return res.end(videoBytes);
    }
    // original with Range support
    const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ''));
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Number(range[2]) : ORIGINAL.length - 1;
      res.writeHead(206, {
        'content-type': 'image/jpeg',
        'content-range': `bytes ${start}-${end}/${ORIGINAL.length}`,
        'content-length': String(end - start + 1),
        'accept-ranges': 'bytes',
      });
      return res.end(ORIGINAL.subarray(start, end + 1));
    }
    res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': String(ORIGINAL.length), 'accept-ranges': 'bytes' });
    return res.end(req.method === 'HEAD' ? undefined : ORIGINAL);
  }
  sendJson(res, 404, { message: 'not found' });
});

const listen = (server: http.Server) =>
  new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)));

let gateway: Gateway;
let base = '';
let friendPort = 0;
const COOKIE = { cookie: 'immich_access_token=good' };

before(async () => {
  const ff = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=10', '-t', '1', '-pix_fmt', 'yuv420p', '-y', join(tmp, 'in.mp4')]);
  videoBytes = ff.status === 0 ? readFileSync(join(tmp, 'in.mp4')) : Buffer.from('not-a-video');
  const localPort = await listen(localServer);
  friendPort = await listen(friendServer);
  writeFileSync(join(tmp, 'inject.js'), 'console.log("federation")');
  const config: Config = {
    immichUrl: new URL(`http://127.0.0.1:${localPort}`),
    port: 0,
    host: '127.0.0.1',
    dataDir: join(tmp, 'data'),
    publicDir: tmp,
    federationSecret: 'test-secret-test-secret',
    syncIntervalMinutes: 30,
    allowPrivateRemotes: true,
    ffmpegPath: ff.status === 0 ? 'ffmpeg' : '/nonexistent/ffmpeg',
    videoProxyHeight: 240,
    remoteTimeoutMs: 3000,
    interactiveTimeoutMs: 3000,
    maxPreviewBytes: 50 * 1024 * 1024,
    maxVideoBytes: 500 * 1024 * 1024,
    downloadConcurrency: 3,
    logLevel: 'warn',
  };
  const { mkdirSync } = await import('node:fs');
  mkdirSync(config.dataDir, { recursive: true });
  gateway = await createGateway(config, { startSync: false });
  base = `http://127.0.0.1:${await gateway.listen()}`;
});

after(async () => {
  await gateway?.close();
  localServer.closeAllConnections();
  friendServer.closeAllConnections();
  await new Promise((r) => localServer.close(r));
  await new Promise((r) => friendServer.close(r));
  rmSync(tmp, { recursive: true, force: true });
});

describe('proxy', () => {
  it('serves health and static files', async () => {
    assert.deepEqual(await (await fetch(`${base}/federation/api/health`)).json(), { ok: true });
    const js = await fetch(`${base}/federation/inject.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type')!, /javascript/);
    assert.equal((await fetch(`${base}/federation/ui.css`)).status, 404);
    assert.equal((await fetch(`${base}/federation/..%2F..%2Fetc%2Fpasswd`)).status, 404);
  });

  it('injects the script into HTML navigations (even when the client accepts gzip)', async () => {
    const res = await fetch(`${base}/photos`, { headers: { accept: 'text/html', 'accept-encoding': 'gzip, br' } });
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.ok(text.includes('<script src="/federation/inject.js" defer></script></head>'), text);
    assert.equal(res.headers.get('content-encoding'), null);
    assert.equal(res.headers.get('etag'), null);
    assert.equal(Number(res.headers.get('content-length')), Buffer.byteLength(text));
  });

  it('does not touch non-navigation requests', async () => {
    const res = await fetch(`${base}/`, { headers: { accept: '*/*', 'accept-encoding': 'gzip' } });
    assert.equal(await res.text(), HTML); // fetch decodes gzip transparently
    assert.equal(res.headers.get('etag'), '"abc"');
  });

  it('streams large bodies and sets X-Forwarded-*', async () => {
    const big = Buffer.alloc(5 * 1024 * 1024, 7);
    const res = await fetch(`${base}/api/echo`, { method: 'POST', body: big });
    const body = (await res.json()) as any;
    assert.equal(body.length, big.length);
    assert.equal(body.xff, '127.0.0.1');
    assert.equal(body.host, new URL(base).host); // Host header preserved
  });

  it('keeps multiple Set-Cookie headers', async () => {
    const res = await fetch(`${base}/api/cookies`);
    assert.deepEqual(res.headers.getSetCookie(), ['a=1; Path=/', 'b=2; Path=/']);
  });

  it('proxies WebSocket upgrades', async () => {
    const { port } = new URL(base);
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(Number(port), '127.0.0.1', () => {
        socket.write(
          'GET /api/socket.io/?EIO=4&transport=websocket HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
        );
      });
      let data = '';
      socket.on('data', (d) => {
        data += d.toString();
        if (data.includes('\r\n\r\n') && !data.includes('echo:')) socket.write('ping');
        if (data.includes('echo:ping')) {
          socket.destroy();
          resolve(data);
        }
      });
      socket.on('error', reject);
      setTimeout(() => reject(new Error('timeout: ' + data)), 3000);
    });
    assert.match(reply, /^HTTP\/1.1 101/);
    assert.match(reply, /X-Up: yes/);
  });

  it('proxies unknown API paths unchanged', async () => {
    const res = await fetch(`${base}/api/whatever`, { headers: COOKIE });
    assert.equal(res.status, 404);
  });
});

describe('federation', () => {
  let linkId = '';
  let albumId = '';
  const waitIdle = async () => {
    for (let i = 0; i < 200; i++) {
      const links = (await (await fetch(`${base}/federation/api/links`, { headers: COOKIE })).json()) as any[];
      const link = links.find((l) => l.id === linkId);
      if (link && !link.syncing) return link;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('sync did not finish');
  };
  const localImageId = () => {
    const row = gateway.store.listAssets(linkId).find((a) => a.remoteAssetId === 'r-img-1');
    return row!.localAssetId;
  };

  it('requires authentication', async () => {
    assert.equal((await fetch(`${base}/federation/api/links`)).status, 401);
    const res = await fetch(`${base}/federation/api/links`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'immich_access_token=bad' },
      body: JSON.stringify({ shareUrl: 'http://x/share/abcdefghij' }),
    });
    assert.equal(res.status, 401);
  });

  it('localizes API errors (X-Federation-Lang, then Accept-Language, default English)', async () => {
    const error = async (headers: Record<string, string>) => {
      const res = await fetch(`${base}/federation/api/links`, { headers });
      assert.equal(res.status, 401);
      return (await res.json()) as { message: string; statusCode: number; code: string };
    };
    assert.deepEqual(await error({}), { message: 'Not logged in', statusCode: 401, code: 'not_logged_in' });
    assert.deepEqual(await error({ 'x-federation-lang': 'de' }), {
      message: 'Nicht angemeldet',
      statusCode: 401,
      code: 'not_logged_in',
    });
    assert.equal((await error({ 'x-federation-lang': 'gsw' })).message, 'Nicht angemeldet');
    assert.equal((await error({ 'accept-language': 'fr, de-CH;q=0.9' })).message, 'Nicht angemeldet');
    assert.equal((await error({ 'x-federation-lang': 'fr', 'accept-language': 'de' })).message, 'Not logged in');
    const unknown = await fetch(`${base}/federation/api/nope`, { headers: { 'x-federation-lang': 'de_AT' } });
    assert.deepEqual(await unknown.json(), { message: 'Unbekannter Endpunkt', statusCode: 404, code: 'unknown_endpoint' });
  });

  it('rejects cross-origin writes', async () => {
    const res = await fetch(`${base}/federation/api/links`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example', ...COOKIE },
      body: '{}',
    });
    assert.equal(res.status, 403);
  });

  it('rejects invalid share links', async () => {
    const post = (headers: Record<string, string> = {}) =>
      fetch(`${base}/federation/api/links`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...COOKIE, ...headers },
        body: JSON.stringify({ shareUrl: `http://127.0.0.1:${friendPort}/share/WRONGKEY99` }),
      });
    let res = await post();
    assert.equal(res.status, 400);
    let body = (await res.json()) as any;
    assert.match(body.message, /^Share link invalid, expired or revoked/);
    assert.equal(body.code, 'remote_link_invalid');
    res = await post({ 'x-federation-lang': 'de' });
    body = (await res.json()) as any;
    assert.match(body.message, /^Freigabelink ungültig/);
    assert.equal(body.code, 'remote_link_invalid');

    res = await fetch(`${base}/federation/api/links`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-federation-lang': 'de', ...COOKIE },
      body: JSON.stringify({ shareUrl: 'https://friend.example/albums/123' }),
    });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as any).message, /^Das ist kein Immich-Freigabelink/);
  });

  it('connects a link and syncs previews + video proxy into local Immich', async () => {
    // connected by a German user: everything written into Immich for this link is German
    const res = await fetch(`${base}/federation/api/links`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-federation-lang': 'de-DE', ...COOKIE },
      body: JSON.stringify({ shareUrl: `http://127.0.0.1:${friendPort}/share/${SHARE_KEY}`, showInTimeline: true }),
    });
    assert.equal(res.status, 201, await res.clone().text());
    ({ id: linkId, albumId } = (await res.json()) as any);
    const link = await waitIdle();
    assert.equal(link.lastError, null, link.lastError);
    assert.equal(link.assetCount, 2);
    assert.equal(link.remoteAlbumName, 'Urlaub 2025');
    assert.equal(link.remoteOwnerName, 'Anna');
    assert.equal(link.serverHost, `127.0.0.1:${friendPort}`);
    assert.equal('shareKey' in link, false);
    assert.equal(local.apiKeys, 1);
    assert.equal(local.albums.get(albumId)!.albumName, 'Urlaub 2025');
    assert.equal(local.albums.get(albumId)!.description, `Föderiert von 127.0.0.1:${friendPort} (Anna)`);
    assert.equal(gateway.store.getLink(linkId)!.lang, 'de');
    assert.equal(local.albums.get(albumId)!.assets.size, 2);

    const uploads = [...local.assets.values()];
    assert.ok(uploads.every((u) => u.fieldsBeforeFile), 'text fields precede the file part');
    assert.deepEqual(uploads.map((u) => u.filename).sort(), ['PXL_20250701.jpg', 'clip.mp4']);
    const update = local.updates.get(localImageId());
    assert.equal(update.dateTimeOriginal, '2025-07-01T14:00:00.000+02:00');
    assert.equal(update.latitude, 47.5);
    assert.match(update.description, /Föderiert von 127\.0\.0\.1:\d+ · Anna/);
  });

  it('localizes the stored sync log at read time', async () => {
    const detail = async (lang?: string) =>
      (await (
        await fetch(`${base}/federation/api/links/${linkId}`, { headers: { ...COOKIE, ...(lang ? { 'x-federation-lang': lang } : {}) } })
      ).json()) as any;
    const en = await detail();
    const de = await detail('de');
    assert.ok(en.log.some((e: any) => e.message === 'Connected by me@test'), JSON.stringify(en.log));
    assert.ok(en.log.some((e: any) => /^Sync finished in \d+ s: \+2 \/ -0$/.test(e.message)), JSON.stringify(en.log));
    assert.ok(de.log.some((e: any) => e.message === 'Verbunden durch me@test'), JSON.stringify(de.log));
    assert.ok(de.log.some((e: any) => /^Sync fertig in \d+ s: \+2 \/ -0$/.test(e.message)), JSON.stringify(de.log));
  });

  it('refuses to connect the same album twice', async () => {
    const res = await fetch(`${base}/federation/api/links`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...COOKIE },
      body: JSON.stringify({ shareUrl: `http://127.0.0.1:${friendPort}/share/${SHARE_KEY}` }),
    });
    assert.equal(res.status, 409);
  });

  it('serves originals of federated assets from the remote (incl. Range)', async () => {
    const id = localImageId();
    const full = await fetch(`${base}/api/assets/${id}/original`, { headers: COOKIE });
    assert.equal(full.status, 200);
    assert.equal(Buffer.from(await full.arrayBuffer()).toString(), ORIGINAL.toString());
    assert.match(full.headers.get('content-disposition')!, /PXL_20250701\.jpg/);
    assert.equal(full.headers.get('x-immich-federation'), `127.0.0.1:${friendPort}`);

    const part = await fetch(`${base}/api/assets/${id}/original`, { headers: { ...COOKIE, range: 'bytes=0-5' } });
    assert.equal(part.status, 206);
    assert.equal(await part.text(), 'REMOTE');
    assert.equal(part.headers.get('content-range'), `bytes 0-5/${ORIGINAL.length}`);
  });

  it('lets local Immich answer when the client is not allowed', async () => {
    const res = await fetch(`${base}/api/assets/${localImageId()}/original`);
    assert.equal(res.status, 401);
  });

  it('does not stream from the friend for un-normalized paths (dot segments, encodings, absolute form)', async () => {
    const id = localImageId();
    const port = Number(new URL(base).port);
    const raw = (target: string, method = 'GET') =>
      new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method, path: target }, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
        });
        req.on('error', reject);
        req.end();
      });
    for (const target of [
      `/x/../api/assets/${id}/original`,
      `/x/%2e%2e/api/assets/${id}/original`,
      `/x/..\\api/assets/${id}/original`,
      `/api/assets/${id}/x/../original`,
      `http://x/api/assets/${id}/original`,
      `/x/../api/assets/${id}/video/playback`,
      `/x/../api/assets/${id}/thumbnail?size=fullsize`,
    ]) {
      for (const method of ['GET', 'HEAD']) {
        const res = await raw(target, method);
        assert.equal(res.headers['x-immich-federation'], undefined, `${method} ${target}`);
        assert.ok(!res.body.includes('REMOTE'), `${method} ${target}`);
      }
    }
    // the canonical path still needs auth
    assert.equal((await raw(`/api/assets/${id}/original`)).status, 401);
  });

  it('marks intercepted responses nosniff + sandboxed', async () => {
    const res = await fetch(`${base}/api/assets/${localImageId()}/original`, { headers: COOKIE });
    await res.arrayBuffer();
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('content-security-policy')!, /sandbox/);
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
  });

  it('exposes federation info for an asset', async () => {
    const res = await fetch(`${base}/federation/api/assets/${localImageId()}`, { headers: COOKIE });
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.federated, true);
    assert.equal(body.linkId, linkId);
    assert.equal(body.remoteOwnerName, 'Anna');
    assert.equal((await fetch(`${base}/federation/api/assets/${localImageId()}`)).status, 404);
    assert.equal((await fetch(`${base}/federation/api/assets/${randomUUID()}`, { headers: COOKIE })).status, 404);
  });

  it('deletes local copies when the friend removes an asset', async () => {
    const videoRow = gateway.store.listAssets(linkId).find((a) => a.remoteAssetId === 'r-vid-1')!;
    friendAssets = friendAssets.filter((a) => a.id !== 'r-vid-1');
    const res = await fetch(`${base}/federation/api/links/${linkId}/sync`, { method: 'POST', headers: COOKIE });
    assert.equal(res.status, 202);
    const link = await waitIdle();
    assert.equal(link.assetCount, 1);
    assert.deepEqual(local.deleted, [videoRow.localAssetId]);
  });

  it('re-adds assets the user removed from the album, dismisses deleted ones', async () => {
    const id = localImageId();
    local.albums.get(albumId)!.assets.delete(id);
    await gateway.sync.trigger(linkId);
    assert.ok(local.albums.get(albumId)!.assets.has(id));
  });

  it('retries failed metadata and tolerates assets already deleted locally', async () => {
    // a new remote asset whose metadata PUT fails twice (import + same-run retry)
    local.failPuts = 2;
    friendAssets = [...friendAssets, { id: 'r-img-2', isImage: true }];
    await gateway.sync.trigger(linkId);
    let row = gateway.store.listAssets(linkId).find((a) => a.remoteAssetId === 'r-img-2')!;
    assert.equal(row.metaApplied, false);
    assert.equal(local.updates.has(row.localAssetId), false);
    await gateway.sync.trigger(linkId);
    row = gateway.store.listAssets(linkId).find((a) => a.remoteAssetId === 'r-img-2')!;
    assert.equal(row.metaApplied, true);
    assert.equal(local.updates.get(row.localAssetId).latitude, 47.5);

    // user deletes it locally (trash emptied), later the friend removes it as well -> no stuck 400
    local.assets.delete(row.localAssetId);
    for (const a of local.albums.values()) a.assets.delete(row.localAssetId);
    await gateway.sync.trigger(linkId); // marks it dismissed
    friendAssets = friendAssets.filter((a) => a.id !== 'r-img-2');
    await gateway.sync.trigger(linkId);
    const link = await waitIdle();
    assert.equal(link.lastError, null, link.lastError);
    assert.equal(gateway.store.listAssets(linkId).some((a) => a.remoteAssetId === 'r-img-2'), false);
    assert.equal(link.assetCount, 1);
  });

  it('falls back to the local copy when the friend is offline', async () => {
    friendServer.closeAllConnections();
    await new Promise((r) => friendServer.close(r));
    const res = await fetch(`${base}/api/assets/${localImageId()}/original`, { headers: COOKIE });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'LOCAL-PREVIEW');
    // sync records the error but keeps the assets
    await gateway.sync.trigger(linkId);
    const link = await waitIdle();
    assert.match(link.lastError, /^Sync failed: .*ECONNREFUSED/);
    assert.equal(link.assetCount, 1);
    const de = (await (
      await fetch(`${base}/federation/api/links/${linkId}`, { headers: { ...COOKIE, 'x-federation-lang': 'de' } })
    ).json()) as any;
    assert.match(de.lastError, /^Synchronisation fehlgeschlagen: .*ECONNREFUSED/);
    assert.match(de.log[0].message, /^Synchronisation fehlgeschlagen: /);
    await listen(friendServer).then((p) => {
      // re-listen on a new port is fine; the link keeps pointing at the old one (offline)
      void p;
    });
  });

  it('disconnects and removes album + assets', async () => {
    const res = await fetch(`${base}/federation/api/links/${linkId}?deleteAssets=true`, {
      method: 'DELETE',
      headers: COOKIE,
    });
    assert.equal(res.status, 204);
    assert.equal(local.albums.has(albumId), false);
    assert.equal(local.assets.size, 0);
    assert.deepEqual(await (await fetch(`${base}/federation/api/links`, { headers: COOKIE })).json(), []);
  });
});
