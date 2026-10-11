import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extractAuth, hasAuth, type ForwardedAuth } from './auth.ts';
import type { LinkRow, Store } from './db.ts';
import {
  localizeStored,
  LocalizedError,
  msg,
  requestLang,
  storedIs,
  t,
  type Lang,
  type MessageKey,
  type Msg,
  type Params,
} from './i18n.ts';
import { ImmichError, type ImmichClient } from './immich.ts';
import { logger } from './log.ts';
import { RemoteError, type RemoteClient } from './remote.ts';
import { parseShareUrl } from './share-url.ts';
import { SsrfError } from './ssrf.ts';
import { albumDescription, type SyncEngine } from './sync.ts';

const log = logger('api');

export interface ApiDeps {
  store: Store;
  immich: ImmichClient;
  remote: RemoteClient;
  sync: SyncEngine;
}

class HttpError extends LocalizedError {
  status: number;
  constructor(status: number, key: MessageKey, params?: Params) {
    super(key, params);
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
    throw new HttpError(415, 'content_type_json');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      throw new HttpError(413, 'request_too_large');
    }
    chunks.push(chunk);
  }
  try {
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  } catch {
    throw new HttpError(400, 'invalid_json');
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
    throw new HttpError(403, 'cross_origin_rejected');
  }
}

export class Api {
  #deps: ApiDeps;

  constructor(deps: ApiDeps) {
    this.#deps = deps;
  }

  #toDto(link: LinkRow, lang: Lang) {
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
      lastError: localizeStored(link.lastError, lang),
      syncing: status.syncing,
      progress: status.progress,
    };
  }

  async #currentUser(req: IncomingMessage) {
    const auth = extractAuth(req, { allowSharedLink: false });
    if (!hasAuth(auth)) {
      throw new HttpError(401, 'not_logged_in');
    }
    try {
      const me = await this.#deps.immich.getMe(auth);
      return { me, auth };
    } catch (error) {
      if (error instanceof ImmichError && (error.status === 401 || error.status === 403)) {
        throw new HttpError(401, 'not_logged_in');
      }
      throw error;
    }
  }

  /** The user deleted our API key in Immich? Renew it with their session and resync the affected links. */
  async #healApiKey(userId: string, auth: ForwardedAuth) {
    const broken = this.#deps.store.listLinks(userId).filter((l) => storedIs(l.lastError, 'api_key_invalid'));
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
      log.warn(`Could not renew API key: ${(error as Error).message}`);
    }
  }

  #ownedLink(id: string, userId: string): LinkRow {
    const link = this.#deps.store.getLink(id);
    if (!link || link.userId !== userId) {
      throw new HttpError(404, 'link_not_found');
    }
    return link;
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://local');
    const path = url.pathname.replace(/^\/federation\/api/, '').replace(/\/$/, '') || '/';
    const method = req.method ?? 'GET';
    const lang = requestLang(req.headers);
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
          this.#deps.store.listLinks(me.id).map((l) => this.#toDto(l, lang)),
        );
      }

      if (path === '/links' && method === 'POST') {
        return send(res, 201, await this.#createLink(req, lang));
      }

      let m = /^\/links\/([0-9a-f-]{36})$/.exec(path);
      if (m && method === 'GET') {
        const { me } = await this.#currentUser(req);
        const link = this.#ownedLink(m[1], me.id);
        const entries = this.#deps.store
          .getLog(link.id, 30)
          .map((entry) => ({ ...entry, message: localizeStored(entry.message, lang) }));
        return send(res, 200, { ...this.#toDto(link, lang), log: entries });
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
        void this.#deps.sync.trigger(link.id).catch((error) => log.error('Sync failed', error));
        return send(res, 202, { id: link.id, syncing: true });
      }

      m = /^\/assets\/([0-9a-fA-F-]{36})$/.exec(path);
      if (m && method === 'GET') {
        return send(res, 200, await this.#assetInfo(req, m[1].toLowerCase()));
      }

      throw new HttpError(404, 'unknown_endpoint');
    } catch (error) {
      const fail = (status: number, message: Msg) =>
        send(res, status, { message: t(lang, message.$t, message.p), statusCode: status, code: message.$t });
      if (error instanceof HttpError) {
        return fail(error.status, error.toMsg());
      }
      if (error instanceof RemoteError || error instanceof SsrfError) {
        return fail(400, error.toMsg());
      }
      if (error instanceof ImmichError) {
        const status = error.status >= 400 && error.status < 500 ? error.status : 502;
        log.warn(`${method} ${path}: ${error.message}`);
        return fail(status, immichErrorMessage(error));
      }
      if (error instanceof LocalizedError) {
        // e.g. remote timeout / too many redirects / missing API key
        log.warn(`${method} ${path}: ${error.message}`);
        return fail(502, error.toMsg());
      }
      log.error(`${method} ${path} failed`, error);
      return fail(500, msg('internal_error'));
    }
  }

  async #createLink(req: IncomingMessage, lang: Lang) {
    const { me, auth } = await this.#currentUser(req);
    const body = await readJson(req);
    if (typeof body.shareUrl !== 'string') {
      throw new HttpError(400, 'share_url_missing');
    }
    let parsed;
    try {
      parsed = parseShareUrl(body.shareUrl);
    } catch (error) {
      throw error instanceof LocalizedError
        ? new HttpError(400, error.key, error.params)
        : new HttpError(400, 'share_url_invalid');
    }
    const showInTimeline = body.showInTimeline === undefined ? true : body.showInTimeline === true;
    const importVideos = body.importVideos === undefined ? true : body.importVideos === true;
    const ref = { baseUrl: parsed.baseUrl, key: parsed.key, slug: parsed.slug };

    // validate first: the link must work and point to an album or individual assets
    const info = await this.#deps.remote.getLinkInfo(ref, lang);
    if (info.type !== 'ALBUM' && info.assets.length === 0) {
      throw new HttpError(400, 'share_link_empty');
    }

    const existing = this.#deps.store.findLinkByRemote(me.id, parsed.baseUrl, info.id, info.albumId);
    if (existing) {
      throw new HttpError(409, 'album_already_connected', { name: existing.remoteAlbumName });
    }

    await this.#deps.sync.ensureUserKey(auth);
    const user = this.#deps.store.getUser(me.id)!;
    const album = await this.#deps.immich.createAlbum(
      { apiKey: user.apiKey },
      info.albumName,
      albumDescription(parsed.host, info.ownerName, lang),
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
      lang,
      createdAt: new Date().toISOString(),
      lastSyncedAt: null,
      lastError: null,
    };
    this.#deps.store.insertLink(link);
    this.#deps.store.log(link.id, 'info', msg('connected_by', { email: me.email }));
    log.info(`${me.email} connected ${parsed.host} / ${info.albumName} (${link.id})`);
    void this.#deps.sync.trigger(link.id).catch((error) => log.error('Initial sync failed', error));
    return { id: link.id, albumId: album.id };
  }

  async #assetInfo(req: IncomingMessage, localAssetId: string) {
    const info = this.#deps.store.getFederatedAsset(localAssetId);
    if (!info) {
      throw new HttpError(404, 'not_federated');
    }
    // only reveal federation details to someone who can see the asset (own user, album member, shared link)
    const auth = extractAuth(req);
    if (!hasAuth(auth)) {
      throw new HttpError(404, 'not_federated');
    }
    try {
      await this.#deps.immich.getAsset(auth, localAssetId);
    } catch {
      throw new HttpError(404, 'not_federated');
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

/** Short user-facing message for a local Immich error; the technical detail stays in the server log. */
export function immichErrorMessage(error: ImmichError): Msg {
  if (error.localized) {
    return error.localized;
  }
  switch (error.status) {
    case 401:
      return msg('immich_session_expired');
    case 403:
      return msg('immich_forbidden');
    case 404:
      return msg('immich_not_found');
    default:
      if (error.status === 0) {
        return msg('immich_unavailable_network');
      }
      return error.status >= 500 ? msg('immich_unavailable', { status: error.status }) : msg('immich_rejected', { status: error.status });
  }
}
