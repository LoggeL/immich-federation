import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SecretBox } from '../src/crypto.ts';
import { injectScript, INJECT_TAG, isNavigationRequest, isHtmlResponse } from '../src/inject.ts';
import { matchIntercept, safeMediaType } from '../src/intercept.ts';
import { extensionForMime, uploadFilename } from '../src/media.ts';
import { parseShareUrl } from '../src/share-url.ts';
import { guardedLookup, isPrivateAddress, nodeFetch, SsrfError } from '../src/ssrf.ts';
import { streamToFile, TooLargeError } from '../src/media.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDateTimeOriginal, federationDescription } from '../src/sync.ts';

const ID = '0195f3a2-7c4b-7d1e-9a2b-1234567890ab';

describe('parseShareUrl', () => {
  it('parses album share links', () => {
    assert.deepEqual(parseShareUrl('https://photos.friend.de/share/AbC_dEf-123456789'), {
      baseUrl: 'https://photos.friend.de',
      host: 'photos.friend.de',
      key: 'AbC_dEf-123456789',
    });
  });
  it('keeps ports and handles deep links / trailing parts', () => {
    const p = parseShareUrl(`http://friend.example:2291/share/KEYkey123456/photos/${ID}?x=1#y`);
    assert.equal(p.baseUrl, 'http://friend.example:2291');
    assert.equal(p.host, 'friend.example:2291');
    assert.equal(p.key, 'KEYkey123456');
  });
  it('parses slug links', () => {
    const p = parseShareUrl('https://friend.example/s/sommer-2025');
    assert.equal(p.slug, 'sommer-2025');
    assert.equal(p.key, undefined);
  });
  it('preserves a base path', () => {
    assert.equal(parseShareUrl('https://x.example/immich/share/abcdefgh12').baseUrl, 'https://x.example/immich');
  });
  it('adds https when scheme is missing and trims whitespace', () => {
    assert.equal(parseShareUrl('  friend.example/share/abcdefgh12 ').baseUrl, 'https://friend.example');
  });
  it('rejects garbage', () => {
    assert.throws(() => parseShareUrl(''));
    assert.throws(() => parseShareUrl('https://friend.example/albums/123'));
    assert.throws(() => parseShareUrl('ftp://friend.example/share/abcdefgh12'));
    assert.throws(() => parseShareUrl('https://u:p@friend.example/share/abcdefgh12'));
    assert.throws(() => parseShareUrl('https://friend.example/share/short'));
  });
});

describe('matchIntercept', () => {
  it('matches original, playback and fullsize only', () => {
    assert.deepEqual(matchIntercept('GET', `/api/assets/${ID}/original?c=abc`), {
      assetId: ID,
      kind: 'original',
      checkPath: `/api/assets/${ID}/original`,
      search: '?c=abc',
    });
    assert.equal(matchIntercept('HEAD', `/api/assets/${ID}/video/playback`)?.kind, 'playback');
    assert.deepEqual(matchIntercept('GET', `/api/assets/${ID}/thumbnail?size=fullsize&c=1`), {
      assetId: ID,
      kind: 'fullsize',
      checkPath: `/api/assets/${ID}/thumbnail`,
      search: '?size=fullsize&c=1',
    });
  });
  it('lowercases ids', () => {
    assert.equal(matchIntercept('GET', `/api/assets/${ID.toUpperCase()}/original`)?.assetId, ID);
  });
  it('ignores previews, thumbnails, other methods and other paths', () => {
    assert.equal(matchIntercept('GET', `/api/assets/${ID}/thumbnail?size=preview`), null);
    assert.equal(matchIntercept('GET', `/api/assets/${ID}/thumbnail`), null);
    assert.equal(matchIntercept('PUT', `/api/assets/${ID}/original`), null);
    assert.equal(matchIntercept('GET', `/api/assets/${ID}`), null);
    assert.equal(matchIntercept('GET', `/api/assets/not-a-uuid/original`), null);
    assert.equal(matchIntercept('GET', `/api/assets/${ID}/video/stream/main.m3u8`), null);
    assert.equal(matchIntercept('GET', `/x/api/assets/${ID}/original`), null);
  });
  it('never matches un-normalized request targets', () => {
    for (const target of [
      `/x/../api/assets/${ID}/original`,
      `/x/%2e%2e/api/assets/${ID}/original`,
      `/x/..\\api/assets/${ID}/original`,
      `/api/assets/${ID}/x/../original`,
      `/api/assets/${ID}/%6friginal`,
      `/api//assets/${ID}/original`,
      `http://x/api/assets/${ID}/original`,
      `//x/api/assets/${ID}/original`,
    ]) {
      assert.equal(matchIntercept('GET', target), null, target);
    }
  });
});

describe('HTML injection', () => {
  it('injects before </head>', () => {
    const out = injectScript('<html><head><title>x</title></head><body></body></html>');
    assert.equal(out, `<html><head><title>x</title>${INJECT_TAG}</head><body></body></html>`);
  });
  it('falls back to </body> or appends', () => {
    assert.equal(injectScript('<body>a</BODY>'), `<body>a${INJECT_TAG}</BODY>`);
    assert.equal(injectScript('plain'), `plain${INJECT_TAG}`);
  });
  it('is idempotent', () => {
    const once = injectScript('<head></head>');
    assert.equal(injectScript(once), once);
  });
  it('detects navigation requests', () => {
    const nav = (url: string, headers: Record<string, string>, method = 'GET') =>
      isNavigationRequest({ method, url, headers } as any);
    assert.equal(nav('/photos', { accept: 'text/html,application/xhtml+xml' }), true);
    assert.equal(nav('/albums/x', { accept: 'text/html', 'sec-fetch-dest': 'document' }), true);
    assert.equal(nav('/api/server/ping', { accept: 'text/html' }), false);
    assert.equal(nav('/_app/immutable/x.js', { accept: '*/*' }), false);
    assert.equal(nav('/federation/', { accept: 'text/html' }), false);
    assert.equal(nav('/photos', { accept: 'application/json' }), false);
    assert.equal(nav('/photos', { accept: 'text/html', 'sec-fetch-dest': 'image' }), false);
    assert.equal(nav('/photos', { accept: 'text/html' }, 'POST'), false);
    assert.equal(isHtmlResponse('text/html; charset=utf-8'), true);
    assert.equal(isHtmlResponse('application/json'), false);
  });
});

describe('SecretBox', () => {
  it('roundtrips and uses random IVs', () => {
    const box = new SecretBox('a-very-secret-secret-value');
    const a = box.encrypt('hello wörld 🔑');
    const b = box.encrypt('hello wörld 🔑');
    assert.notEqual(a, b);
    assert.match(a, /^v1:/);
    assert.equal(box.decrypt(a), 'hello wörld 🔑');
  });
  it('detects tampering and wrong keys', () => {
    const box = new SecretBox('a-very-secret-secret-value');
    const enc = box.encrypt('secret');
    const raw = Buffer.from(enc.slice(3), 'base64');
    raw[raw.length - 1] ^= 1;
    assert.throws(() => box.decrypt('v1:' + raw.toString('base64')));
    assert.throws(() => new SecretBox('another-secret-value-123').decrypt(enc));
    assert.throws(() => new SecretBox('short'));
  });
});

describe('SSRF address checks', () => {
  it('blocks private ranges', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.178.20', '172.20.0.5', '169.254.169.254', '::1', 'fd00::1', 'fe80::1', '::ffff:192.168.0.1', '100.64.1.1', '0.0.0.0']) {
      assert.equal(isPrivateAddress(ip), true, ip);
    }
  });
  it('allows public addresses', () => {
    for (const ip of ['1.1.1.1', '8.8.8.8', '2a00:1450:4001:80b::200e', '172.32.0.1']) {
      assert.equal(isPrivateAddress(ip), false, ip);
    }
  });
});

describe('sync helpers', () => {
  it('builds dateTimeOriginal with the local offset', () => {
    assert.equal(
      buildDateTimeOriginal({
        id: 'x',
        type: 'IMAGE',
        localDateTime: '2025-07-01T14:00:00.000Z',
        exifInfo: { dateTimeOriginal: '2025-07-01T12:00:00.000Z' },
      }),
      '2025-07-01T14:00:00.000+02:00',
    );
    assert.equal(
      buildDateTimeOriginal({
        id: 'x',
        type: 'IMAGE',
        localDateTime: '2025-01-01T07:00:00.000Z',
        fileCreatedAt: '2025-01-01T12:00:00.000Z',
      }),
      '2025-01-01T07:00:00.000-05:00',
    );
  });
  it('derives the offset from bucket fileCreatedAt when metadata is hidden', () => {
    assert.equal(
      buildDateTimeOriginal({ id: 'x', type: 'IMAGE', localDateTime: '2026-08-23T20:00:03.114Z', fileCreatedAt: '2026-08-23T18:00:03.114Z' }),
      '2026-08-23T20:00:03.114+02:00',
    );
  });
  it('uses localDateTime as UTC when nothing else is known', () => {
    assert.equal(
      buildDateTimeOriginal({ id: 'x', type: 'IMAGE', localDateTime: '2025-01-01T07:00:00.000Z' }),
      '2025-01-01T07:00:00.000+00:00',
    );
  });
  it('describes the origin', () => {
    assert.equal(federationDescription({ id: 'x', type: 'IMAGE' }, 'h:1', 'Anna'), 'Föderiert von h:1 · Anna');
    assert.equal(
      federationDescription({ id: 'x', type: 'IMAGE', exifInfo: { description: 'Strand' } }, 'h', ''),
      'Strand\n\nFöderiert von h',
    );
  });
  it('builds upload filenames', () => {
    assert.equal(uploadFilename('PXL_2025.HEIC', 'r', extensionForMime('image/jpeg', '.jpg')), 'PXL_2025.jpg');
    assert.equal(uploadFilename('a/b.mov', 'r', '.mp4'), 'a_b.mp4');
    assert.equal(uploadFilename(undefined, 'r1', '.webp'), 'federated-r1.webp');
  });
});

describe('safeMediaType', () => {
  it('keeps image/video types and neutralizes active content', () => {
    assert.deepEqual(safeMediaType('image/jpeg'), { type: 'image/jpeg', inline: true });
    assert.deepEqual(safeMediaType('video/mp4; codecs=x'), { type: 'video/mp4', inline: true });
    for (const t of ['text/html', 'image/svg+xml', 'application/xhtml+xml', 'application/javascript', '', null]) {
      assert.deepEqual(safeMediaType(t), { type: 'application/octet-stream', inline: false }, String(t));
    }
  });
});

describe('ssrf connect guard', () => {
  it('guardedLookup rejects private resolutions', async () => {
    const error = await new Promise<unknown>((resolve) => guardedLookup('localhost', {}, (e) => resolve(e)));
    assert.ok(error instanceof SsrfError);
  });
  it('nodeFetch refuses to connect to a name resolving to a private address', async () => {
    await assert.rejects(nodeFetch('http://localhost:9/', {}, { allowPrivate: false }), SsrfError);
  });
});

describe('streamToFile', () => {
  it('aborts above the byte limit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fed-unit-'));
    const body = new Response(new Uint8Array(4096)).body;
    await assert.rejects(streamToFile(body, join(dir, 'x'), 1000), TooLargeError);
    assert.equal(await streamToFile(new Response(new Uint8Array(500)).body, join(dir, 'y'), 1000), 500);
  });
});
