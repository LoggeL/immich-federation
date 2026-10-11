import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extractAuth, hasAuth, type ForwardedAuth } from './auth.ts';
import type { LinkRow, Store } from './db.ts';
import { ImmichError, type ImmichClient } from './immich.ts';
import { logger } from './log.ts';
import { RemoteError, type RemoteClient } from './remote.ts';
import { parseShareUrl } from './share-url.ts';
import { SsrfError } from './ssrf.ts';
import { API_KEY_INVALID, type SyncEngine } from './sync.ts';

const log = logger('api');

export interface ApiDeps {
  store: Store;
  immich: ImmichClient;
  remote: RemoteClient;
  sync: SyncEngine;
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function send(res: ServerResponse, status: number, body?: unknown) {
  if (body === undefined) {
    res.writeHead(status, { 'cache-control': 'no-store' });
    res.end();
    return;
  }
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
    'cache-control': 'no-store',
  });
  res.end(json);
}

async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<any> {
  const type = String(req.headers['content-type'] ?? '');
  if (!type.includes('application/json')) {
    throw new HttpError(415, 'Content-Type application/json erwartet');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      throw new HttpError(413, 'Anfrage zu groß');
    }
    chunks.push(chunk);
  }
  try {
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  } catch {
    throw new HttpError(400, 'Ungültiges JSON');
  }
}

/** Reject cross-site state-changing requests (cookie auth!). */
function assertSameOrigin(req: IncomingMessage) {
  const origin = req.headers.origin;
  if (!origin || origin === 'null') {
    return;
  }
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '').split(',')[0].trim();
  let originHost = '';
  try {
    originHost = new URL(origin).host;
  } catch {
    /* ignore */
  }
  if (!host || originHost !== host) {
    throw new HttpError(403, 'Cross-Origin-Anfrage abgelehnt');
  }
}

export class Api {
  #deps: ApiDeps;

  constructor(deps: ApiDeps) {
    this.#deps = deps;
  }

  #toDto(link: LinkRow) {
    const status = this.#deps.sync.status(link.id);
    return {
      id: link.id,
      albumId: link.albumId,
      remoteAlbumName: link.remoteAlbumName,
      serverHost: link.serverHost,
      remoteOwnerName: link.remoteOwnerName,
      showInTimeline: link.showInTimeline,
      importVideos: link.importVideos,
      allowDownload: link.allowDownload,
      assetCount: this.#deps.store.countAssets(link.id),
      lastSyncedAt: link.lastSyncedAt,
      lastError: link.lastError,
      syncing: status.syncing,
      progress: status.progress,
    };
  }

  async #currentUser(req: IncomingMessage) {
    const auth = extractAuth(req, { allowSharedLink: false });
    if (!hasAuth(auth)) {
      throw new HttpError(401, 'Nicht angemeldet');
    }
    try {
      const me = await this.#deps.immich.getMe(auth);
      return { me, auth };
    } catch (error) {
      if (error instanceof ImmichError && (error.status === 401 || error.status === 403)) {
        throw new HttpError(401, 'Nicht angemeldet');
      }
      throw error;
    }
  }

  /** The user deleted our API key in Immich? Renew it with their session and resync the affected links. */
  async #healApiKey(userId: string, auth: ForwardedAuth) {
    const broken = this.#deps.store.listLinks(userId).filter((l) => l.lastError?.startsWith(API_KEY_INVALID));
    if (broken.length === 0) {
      return;
    }
    try {
      await this.#deps.sync.ensureUserKey(auth);
      for (const link of broken) {
        this.#deps.store.updateLink(link.id, { lastError: null });
        void this.#deps.sync.trigger(link.id).catch(() => {});
      }
    } catch (error) {
      log.warn(`API-Schlüssel konnte nicht erneuert werden: ${(error as Error).message}`);
    }
  }

  #ownedLink(id: string, userId: string): LinkRow {
    const link = this.#deps.store.getLink(id);
    if (!link || link.userId !== userId) {
      throw new HttpError(404, 'Verknüpfung nicht gefunden');
    }
    return link;
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://local');
    const path = url.pathname.replace(/^\/federation\/api/, '').replace(/\/$/, '') || '/';
    const method = req.method ?? 'GET';
    try {
      if (method !== 'GET' && method !== 'HEAD') {
        assertSameOrigin(req);
      }

      if (path === '/health' && method === 'GET') {
        return send(res, 200, { ok: true });
      }

      if (path === '/links' && method === 'GET') {
        const { me, auth } = await this.#currentUser(req);
        await this.#healApiKey(me.id, auth);
        return send(
          res,
          200,
          this.#deps.store.listLinks(me.id).map((l) => this.#toDto(l)),
        );
      }

      if (path === '/links' && method === 'POST') {
        return send(res, 201, await this.#createLink(req));
      }

      let m = /^\/links\/([0-9a-f-]{36})$/.exec(path);
      if (m && method === 'GET') {
        const { me } = await this.#currentUser(req);
        const link = this.#ownedLink(m[1], me.id);
        return send(res, 200, { ...this.#toDto(link), log: this.#deps.store.getLog(link.id, 30) });
      }
      if (m && method === 'DELETE') {
        const { me } = await this.#currentUser(req);
        const link = this.#ownedLink(m[1], me.id);
        await this.#deps.sync.deleteLink(link.id, url.searchParams.get('deleteAssets') === 'true');
        return send(res, 204);
      }

      m = /^\/links\/([0-9a-f-]{36})\/sync$/.exec(path);
      if (m && method === 'POST') {
        const { me } = await this.#currentUser(req);
        const link = this.#ownedLink(m[1], me.id);
        void this.#deps.sync.trigger(link.id).catch((error) => log.error('Sync fehlgeschlagen', error));
        return send(res, 202, { id: link.id, syncing: true });
      }

      m = /^\/assets\/([0-9a-fA-F-]{36})$/.exec(path);
      if (m && method === 'GET') {
        return send(res, 200, await this.#assetInfo(req, m[1].toLowerCase()));
      }

      throw new HttpError(404, 'Unbekannter Endpunkt');
    } catch (error) {
      if (error instanceof HttpError) {
        return send(res, error.status, { message: error.message, statusCode: error.status });
      }
      if (error instanceof RemoteError || error instanceof SsrfError) {
        return send(res, 400, { message: error.message, statusCode: 400 });
      }
      if (error instanceof ImmichError) {
        const status = error.status >= 400 && error.status < 500 ? error.status : 502;
        log.warn(`${method} ${path}: ${error.message}`);
        return send(res, status, { message: germanImmichError(error), statusCode: status });
      }
      log.error(`${method} ${path} fehlgeschlagen`, error);
      return send(res, 500, { message: 'Interner Fehler im Föderations-Gateway', statusCode: 500 });
    }
  }

  async #createLink(req: IncomingMessage) {
    const { me, auth } = await this.#currentUser(req);
    const body = await readJson(req);
    if (typeof body.shareUrl !== 'string') {
      throw new HttpError(400, 'shareUrl fehlt');
    }
    let parsed;
    try {
      parsed = parseShareUrl(body.shareUrl);
    } catch (error) {
      throw new HttpError(400, (error as Error).message);
    }
    const showInTimeline = body.showInTimeline === undefined ? true : body.showInTimeline === true;
    const importVideos = body.importVideos === undefined ? true : body.importVideos === true;
    const ref = { baseUrl: parsed.baseUrl, key: parsed.key, slug: parsed.slug };

    // validate first: the link must work and point to an album or individual assets
    const info = await this.#deps.remote.getLinkInfo(ref);
    if (info.type !== 'ALBUM' && info.assets.length === 0) {
      throw new HttpError(400, 'Der Freigabelink enthält keine Medien');
    }

    const existing = this.#deps.store.findLinkByRemote(me.id, parsed.baseUrl, info.id, info.albumId);
    if (existing) {
      throw new HttpError(409, `Dieses Album ist bereits verbunden (${existing.remoteAlbumName})`);
    }

    await this.#deps.sync.ensureUserKey(auth);
    const user = this.#deps.store.getUser(me.id)!;
    const album = await this.#deps.immich.createAlbum(
      { apiKey: user.apiKey },
      info.albumName,
      `Föderiert von ${parsed.host}${info.ownerName ? ` (${info.ownerName})` : ''}`,
    );

    const link: LinkRow = {
      id: randomUUID(),
      userId: me.id,
      baseUrl: parsed.baseUrl,
      serverHost: parsed.host,
      shareKey: parsed.key ?? null,
      shareSlug: parsed.slug ?? null,
      remoteLinkId: info.id,
      remoteAlbumId: info.albumId,
      remoteAlbumName: info.albumName,
      remoteOwnerName: info.ownerName,
      albumId: album.id,
      showInTimeline,
      importVideos,
      allowDownload: info.allowDownload,
      showMetadata: info.showMetadata,
      createdAt: new Date().toISOString(),
      lastSyncedAt: null,
      lastError: null,
    };
    this.#deps.store.insertLink(link);
    this.#deps.store.log(link.id, 'info', `Verbunden durch ${me.email}`);
    log.info(`${me.email} hat ${parsed.host} / ${info.albumName} verbunden (${link.id})`);
    void this.#deps.sync.trigger(link.id).catch((error) => log.error('Erst-Sync fehlgeschlagen', error));
    return { id: link.id, albumId: album.id };
  }

  async #assetInfo(req: IncomingMessage, localAssetId: string) {
    const info = this.#deps.store.getFederatedAsset(localAssetId);
    if (!info) {
      throw new HttpError(404, 'Nicht föderiert');
    }
    // only reveal federation details to someone who can see the asset (own user, album member, shared link)
    const auth = extractAuth(req);
    if (!hasAuth(auth)) {
      throw new HttpError(404, 'Nicht föderiert');
    }
    try {
      await this.#deps.immich.getAsset(auth, localAssetId);
    } catch {
      throw new HttpError(404, 'Nicht föderiert');
    }
    return {
      federated: true,
      linkId: info.linkId,
      serverHost: info.serverHost,
      remoteOwnerName: info.remoteOwnerName,
      allowDownload: info.allowDownload,
    };
  }
}

/** Short German message for the UI; the technical detail stays in the server log. */
export function germanImmichError(error: ImmichError): string {
  if (error.message.startsWith('Konnte keinen API-Schlüssel')) {
    return error.message.replace(/ \(Immich [^)]*\)$/, '');
  }
  switch (error.status) {
    case 401:
      return 'Nicht angemeldet – bitte im Immich-Web neu anmelden';
    case 403:
      return 'Immich verweigert den Zugriff (403)';
    case 404:
      return 'In Immich nicht gefunden (404)';
    default:
      return error.status >= 500 || error.status === 0
        ? `Immich ist gerade nicht erreichbar (${error.status || 'Netzwerk'})`
        : `Immich hat die Anfrage abgelehnt (${error.status})`;
  }
}
