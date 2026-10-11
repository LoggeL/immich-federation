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
import { DatabaseSync } from 'node:sqlite';
import { immichErrorMessage } from '../src/api.ts';
import { Store, type LinkRow } from '../src/db.ts';
import {
  acceptLanguage,
  catalogs,
  encodeStored,
  format,
  localizeStored,
  LocalizedError,
  msg,
  requestLang,
  resolveLang,
  storedIs,
  t,
} from '../src/i18n.ts';
import { ImmichError } from '../src/immich.ts';
import { RemoteError } from '../src/remote.ts';
import { albumDescription, buildDateTimeOriginal, federationDescription, syncErrorMessage } from '../src/sync.ts';

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
  it('describes the origin in the link language', () => {
    assert.equal(federationDescription({ id: 'x', type: 'IMAGE' }, 'h:1', 'Anna', 'de'), 'Föderiert von h:1 · Anna');
    assert.equal(federationDescription({ id: 'x', type: 'IMAGE' }, 'h:1', 'Anna', 'en'), 'Federated from h:1 · Anna');
    assert.equal(
      federationDescription({ id: 'x', type: 'IMAGE', exifInfo: { description: 'Strand' } }, 'h', '', 'de'),
      'Strand\n\nFöderiert von h',
    );
    assert.equal(
      federationDescription({ id: 'x', type: 'IMAGE', exifInfo: { description: ' Beach ' } }, 'h', '', 'en'),
      'Beach\n\nFederated from h',
    );
    assert.equal(albumDescription('h', 'Anna', 'de'), 'Föderiert von h (Anna)');
    assert.equal(albumDescription('h', '', 'en'), 'Federated from h');
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

describe('i18n', () => {
  it('resolves language codes', () => {
    assert.equal(resolveLang('de'), 'de');
    assert.equal(resolveLang('de-CH'), 'de');
    assert.equal(resolveLang('de_CH'), 'de');
    assert.equal(resolveLang('DE_at'), 'de');
    assert.equal(resolveLang('gsw'), 'de');
    assert.equal(resolveLang('swg'), 'de');
    assert.equal(resolveLang('en-US'), 'en');
    assert.equal(resolveLang('fr'), 'en');
    assert.equal(resolveLang('dev'), 'en');
    assert.equal(resolveLang(''), 'en');
    assert.equal(resolveLang(undefined), 'en');
    assert.equal(resolveLang(null), 'en');
  });

  it('picks the request language from X-Federation-Lang, then Accept-Language', () => {
    assert.equal(requestLang({ 'x-federation-lang': 'de-CH' }), 'de');
    assert.equal(requestLang({ 'x-federation-lang': 'en', 'accept-language': 'de' }), 'en');
    assert.equal(requestLang({ 'x-federation-lang': 'fr', 'accept-language': 'de' }), 'en');
    assert.equal(requestLang({ 'accept-language': 'fr-FR, de-DE;q=0.8, en;q=0.5' }), 'de');
    assert.equal(requestLang({ 'accept-language': 'en;q=0.4, de;q=0.9' }), 'de');
    assert.equal(requestLang({ 'accept-language': 'fr, *;q=0.1' }), 'en');
    assert.equal(requestLang({}), 'en');
    assert.equal(acceptLanguage('de;q=0, en'), 'en');
    assert.equal(acceptLanguage(''), undefined);
  });

  it('translates with params, nested messages and fallbacks', () => {
    assert.equal(t('en', 'album_already_connected', { name: 'Urlaub' }), 'This album is already connected (Urlaub)');
    assert.equal(t('de', 'album_already_connected', { name: 'Urlaub' }), 'Dieses Album ist bereits verbunden (Urlaub)');
    const nested = msg('items_failed', { count: 2, example: msg('file_too_large', { mb: 5 }) });
    assert.equal(format('en', nested), '2 item(s) failed, e.g.: File too large (5 MB) – skipped');
    assert.equal(format('de', nested), '2 Element(e) fehlgeschlagen, z.B.: Datei zu groß (5 MB) – übersprungen');
    assert.equal(t('en', 'sync_failed', { detail: '{detail} $& stays' }), 'Sync failed: {detail} $& stays');
    assert.equal(t('fr' as any, 'not_logged_in'), 'Not logged in');
  });

  it('has the same keys and placeholders in every catalog', () => {
    const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    assert.deepEqual(Object.keys(catalogs.de).sort(), Object.keys(catalogs.en).sort());
    for (const key of Object.keys(catalogs.en) as Array<keyof typeof catalogs.en>) {
      assert.deepEqual(placeholders(catalogs.de[key]), placeholders(catalogs.en[key]), key);
    }
  });

  it('LocalizedError has an English message and stays translatable', () => {
    const error = new RemoteError('remote_http', { status: 500, suffix: '' }, 500);
    assert.ok(error instanceof LocalizedError);
    assert.equal(error.message, 'Remote server responded with HTTP 500');
    assert.equal(format('de', error.toMsg()), 'Entfernter Server antwortete mit HTTP 500');
  });

  it('stores markers and translates them when read; legacy text passes through', () => {
    const stored = encodeStored(msg('sync_failed', { detail: msg('timeout', { ms: 20000 }) }));
    assert.equal(stored, '{"$t":"sync_failed","p":{"detail":{"$t":"timeout","p":{"ms":20000}}}}');
    assert.equal(localizeStored(stored, 'en'), 'Sync failed: Timed out after 20000 ms');
    assert.equal(localizeStored(stored, 'de'), 'Synchronisation fehlgeschlagen: Zeitüberschreitung nach 20000 ms');
    assert.equal(localizeStored('Sync fertig in 3 s: +1 / -0', 'en'), 'Sync fertig in 3 s: +1 / -0');
    assert.equal(localizeStored('{"not":"a marker"}', 'de'), '{"not":"a marker"}');
    assert.equal(localizeStored('{"$t":broken', 'de'), '{"$t":broken');
    assert.equal(localizeStored(null, 'de'), null);
    assert.equal(encodeStored('plain'), 'plain');
    const long = encodeStored(msg('sync_failed', { detail: 'x'.repeat(5000) }));
    assert.ok(long.length < 1100);
    assert.match(localizeStored(long, 'en'), /^Sync failed: x+…$/);
  });

  it('recognizes stored messages by key, including legacy German rows', () => {
    assert.equal(storedIs(encodeStored(msg('api_key_invalid', { detail: 'x' })), 'api_key_invalid'), true);
    assert.equal(storedIs(encodeStored(msg('sync_failed', { detail: 'x' })), 'api_key_invalid'), false);
    assert.equal(
      storedIs(
        'API-Schlüssel des Gateways ungültig – Föderationsseite einmal öffnen, dann wird er erneuert: Immich GET /api/users/me -> 401',
        'api_key_invalid',
      ),
      true,
    );
    assert.equal(storedIs('Synchronisation fehlgeschlagen: x', 'api_key_invalid'), false);
    assert.equal(storedIs(null, 'api_key_invalid'), false);
  });

  it('maps sync and Immich errors to messages', () => {
    assert.equal(syncErrorMessage(new ImmichError('Immich GET /api/users/me -> 401', 401)).$t, 'api_key_invalid');
    assert.equal(
      format('de', syncErrorMessage(new RemoteError('remote_link_invalid', { suffix: '' }, 401))),
      'Freigabelink ungültig, abgelaufen oder widerrufen',
    );
    assert.equal(
      format('en', syncErrorMessage(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))),
      'Sync failed: fetch failed (ECONNREFUSED)',
    );
    const created = new ImmichError('technical', 403, undefined, msg('api_key_create_failed'));
    assert.equal(syncErrorMessage(created).$t, 'api_key_create_failed');
    assert.equal(immichErrorMessage(created).$t, 'api_key_create_failed');
    assert.equal(immichErrorMessage(new ImmichError('x', 401)).$t, 'immich_session_expired');
    assert.equal(format('de', immichErrorMessage(new ImmichError('x', 0))), 'Immich ist gerade nicht erreichbar (Netzwerk)');
    assert.equal(format('en', immichErrorMessage(new ImmichError('x', 503))), 'Immich is currently unreachable (503)');
    assert.equal(format('en', immichErrorMessage(new ImmichError('x', 422))), 'Immich rejected the request (422)');
  });
});

describe('links.lang migration', () => {
  const box = new SecretBox('a-very-secret-secret-value');
  const link = (id: string, lang: 'en' | 'de'): LinkRow => ({
    id,
    userId: 'u1',
    baseUrl: 'https://friend.example',
    serverHost: 'friend.example',
    shareKey: 'KEY12345678',
    shareSlug: null,
    remoteLinkId: id,
    remoteAlbumId: null,
    remoteAlbumName: 'A',
    remoteOwnerName: '',
    albumId: 'album-' + id,
    showInTimeline: true,
    importVideos: true,
    allowDownload: true,
    showMetadata: true,
    lang,
    createdAt: new Date().toISOString(),
    lastSyncedAt: null,
    lastError: null,
  });

  it('marks links created before i18n as German, keeps the language of new links', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fed-migrate-'));
    // pre-i18n schema: no lang column
    const old = new DatabaseSync(join(dir, 'federation.sqlite'));
    old.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL, apiKeyId TEXT NOT NULL,
        apiKeyEnc TEXT NOT NULL, createdAt TEXT NOT NULL);
      CREATE TABLE links (id TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id), baseUrl TEXT NOT NULL,
        serverHost TEXT NOT NULL, shareKeyEnc TEXT, shareSlugEnc TEXT, remoteLinkId TEXT NOT NULL, remoteAlbumId TEXT,
        remoteAlbumName TEXT NOT NULL, remoteOwnerName TEXT NOT NULL, albumId TEXT NOT NULL,
        showInTimeline INTEGER NOT NULL DEFAULT 1, allowDownload INTEGER NOT NULL DEFAULT 1,
        showMetadata INTEGER NOT NULL DEFAULT 1, createdAt TEXT NOT NULL, lastSyncedAt TEXT, lastError TEXT);
      INSERT INTO users VALUES ('u1', 'a@x', 'A', 'k', 'v1:x', '2025-01-01');
      INSERT INTO links (id, userId, baseUrl, serverHost, remoteLinkId, remoteAlbumName, remoteOwnerName, albumId, createdAt, lastError)
        VALUES ('old', 'u1', 'https://f', 'f', 'r', 'A', '', 'al', '2025-01-01', 'Synchronisation fehlgeschlagen: x');
    `);
    old.close();

    const store = new Store(dir, box);
    assert.equal(store.getLink('old')!.lang, 'de');
    assert.equal(localizeStored(store.getLink('old')!.lastError, 'en'), 'Synchronisation fehlgeschlagen: x');
    store.insertLink(link('new-en', 'en'));
    store.insertLink(link('new-de', 'de'));
    store.close();

    const reopened = new Store(dir, box);
    assert.equal(reopened.getLink('old')!.lang, 'de');
    assert.equal(reopened.getLink('new-en')!.lang, 'en');
    assert.equal(reopened.getLink('new-de')!.lang, 'de');
    reopened.log('new-en', 'info', msg('connected_by', { email: 'a@x' }));
    reopened.log('new-en', 'info', 'legacy text');
    assert.deepEqual(
      reopened.getLog('new-en').map((e) => localizeStored(e.message, 'de')),
      ['legacy text', 'Verbunden durch a@x'],
    );
    reopened.close();
  });

  it('fresh databases store the given language', () => {
    const store = new Store(mkdtempSync(join(tmpdir(), 'fed-fresh-')), box);
    store.db.prepare("INSERT INTO users VALUES ('u1', 'a@x', 'A', 'k', 'v1:x', '2025-01-01')").run();
    store.insertLink(link('l1', 'en'));
    assert.equal(store.getLink('l1')!.lang, 'en');
    store.close();
  });
});

describe('proxy upstream error', () => {
  it('answers 502 in the request language', async () => {
    const { Proxy } = await import('../src/proxy.ts');
    const http = await import('node:http');
    const { setLogLevel } = await import('../src/log.ts');
    setLogLevel('silent');
    const proxy = new Proxy({ upstream: new URL('http://127.0.0.1:9') });
    const server = http.createServer((req, res) => proxy.web(req, res));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const { port } = server.address() as import('node:net').AddressInfo;
    try {
      const en = await fetch(`http://127.0.0.1:${port}/api/x`);
      assert.equal(en.status, 502);
      assert.deepEqual(await en.json(), { message: 'Immich is unreachable (gateway)', statusCode: 502, code: 'immich_unreachable_gateway' });
      const de = await fetch(`http://127.0.0.1:${port}/api/x`, { headers: { 'x-federation-lang': 'de' } });
      assert.equal(((await de.json()) as any).message, 'Immich ist nicht erreichbar (Gateway)');
    } finally {
      proxy.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      setLogLevel(process.env.LOG_LEVEL ?? 'info');
    }
  });
});
