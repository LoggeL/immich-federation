import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { FederatedAssetInfo, Store } from './db.ts';
import { describeError, logger, redactUrl } from './log.ts';
import { isWebCompatibleImageMime } from './media.ts';
import type { RemoteClient } from './remote.ts';
import { remoteRef } from './sync.ts';

const log = logger('intercept');

export type InterceptKind = 'original' | 'fullsize' | 'playback';

export interface InterceptMatch {
  assetId: string;
  kind: InterceptKind;
  /** Canonical path built from the match (never the raw client path) – used for the local auth check. */
  checkPath: string;
  /** Raw query string incl. leading "?" (or ""). */
  search: string;
}

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
/**
 * Matched against the RAW request target, without any normalization. Dot segments, percent-encoding,
 * backslashes or absolute-form targets never match, so the path Immich sees for the auth check is exactly
 * the path that was matched (a normalized match + raw check would let `/x/../api/...` hit Immich's SPA
 * fallback, which answers 200 without auth).
 */
const ASSET_PATH = new RegExp(`^/api/assets/(${UUID})/(original|thumbnail|video/playback)/?(\\?[^#]*)?$`);

/** Which requests may be served from the remote server. Only GET/HEAD of original, fullsize and playback. */
export function matchIntercept(method: string | undefined, rawUrl: string | undefined): InterceptMatch | null {
  if (method !== 'GET' && method !== 'HEAD') {
    return null;
  }
  const match = ASSET_PATH.exec(rawUrl ?? '');
  if (!match) {
    return null;
  }
  const [, rawId, what, search = ''] = match;
  const assetId = rawId.toLowerCase();
  const query = new URLSearchParams(search);
  if (what === 'original') {
    return { assetId, kind: 'original', checkPath: `/api/assets/${assetId}/original`, search };
  }
  if (what === 'video/playback') {
    return { assetId, kind: 'playback', checkPath: `/api/assets/${assetId}/video/playback`, search };
  }
  if (what === 'thumbnail' && query.get('size') === 'fullsize') {
    return { assetId, kind: 'fullsize', checkPath: `/api/assets/${assetId}/thumbnail`, search };
  }
  return null;
}

/** Content types we serve inline on the user's Immich origin. Everything else is forced to a download. */
export function safeMediaType(remoteType: string | null | undefined): { type: string; inline: boolean } {
  const type = (remoteType ?? '').split(';')[0].trim().toLowerCase();
  if (/^(image|video|audio)\/[a-z0-9.+-]+$/.test(type) && !type.includes('svg') && !type.includes('xml')) {
    return { type, inline: true };
  }
  return { type: 'application/octet-stream', inline: false };
}

const PASS_HEADERS = ['content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'];

export interface LocalCheck {
  status: number;
  contentType: string;
}

export interface InterceptDeps {
  store: Store;
  remote: RemoteClient;
  /** Ask local Immich whether the CLIENT may access this exact endpoint (HEAD of `path` with the client's auth). */
  checkLocal: (req: IncomingMessage, path: string) => Promise<LocalCheck>;
  /** True if the local asset has non-destructive edits (crop/rotate) the client would get from local Immich. */
  isLocallyEdited?: (req: IncomingMessage, assetId: string) => Promise<boolean>;
  /** Hand the request to the normal proxy (local Immich serves its preview copy). */
  passThrough: (req: IncomingMessage, res: ServerResponse) => void;
  /** Header timeout for interactive remote requests (fallback to the local copy afterwards). */
  timeoutMs?: number;
}

/** Immich serves the edited version for `edited=true` and always for shared-link access. */
function wantsEdited(req: IncomingMessage, match: InterceptMatch) {
  const query = new URLSearchParams(match.search);
  return (
    query.get('edited') === 'true' ||
    query.has('key') ||
    query.has('slug') ||
    !!req.headers['x-immich-share-key'] ||
    !!req.headers['x-immich-share-slug']
  );
}

function remotePathFor(info: FederatedAssetInfo, match: InterceptMatch, req: IncomingMessage) {
  const id = encodeURIComponent(info.remoteAssetId);
  if (match.kind === 'playback') {
    return { path: `/api/assets/${id}/video/playback`, query: {} };
  }
  if (match.kind === 'fullsize') {
    return { path: `/api/assets/${id}/thumbnail`, query: { size: 'fullsize', edited: 'true' } };
  }
  // original: for <img> loads of a non web-compatible original (HEIC/RAW/…) use the remote fullsize JPEG
  // instead, because the local copy is a JPEG and the web client therefore asked for /original.
  const dest = String(req.headers['sec-fetch-dest'] ?? '');
  const accept = String(req.headers.accept ?? '');
  const isImgLoad = dest === 'image' || accept.startsWith('image/');
  if (info.type === 'IMAGE' && isImgLoad && !isWebCompatibleImageMime(info.originalMimeType)) {
    return { path: `/api/assets/${id}/thumbnail`, query: { size: 'fullsize', edited: 'true' } };
  }
  return { path: `/api/assets/${id}/original`, query: {} };
}

/**
 * Returns true if the request was handled (streamed from remote or delegated), false if it is not a
 * federated asset and the caller should proxy normally.
 */
export async function handleIntercept(
  req: IncomingMessage,
  res: ServerResponse,
  match: InterceptMatch,
  deps: InterceptDeps,
): Promise<boolean> {
  const info = deps.store.getFederatedAsset(match.assetId);
  if (!info) {
    return false;
  }

  // Remote forbids downloads -> originals are not obtainable, the local preview copy is all we have.
  if (match.kind === 'original' && !info.allowDownload && info.type === 'IMAGE') {
    deps.passThrough(req, res);
    return true;
  }

  // 1. authorization: same endpoint, same auth material, HEAD against local Immich
  let check: LocalCheck;
  try {
    check = await deps.checkLocal(req, match.checkPath + match.search);
  } catch (error) {
    log.warn(`Lokale Zugriffsprüfung für ${match.assetId} fehlgeschlagen`, (error as Error).message);
    deps.passThrough(req, res);
    return true;
  }
  if (check.status < 200 || check.status >= 300 || /html/i.test(check.contentType)) {
    // 3xx (e.g. fullsize -> original redirect), 401, 403, 404 …: let Immich answer exactly as it would.
    // An HTML 2xx is never media (SPA fallback) -> never treat it as authorized.
    deps.passThrough(req, res);
    return true;
  }

  // locally edited (crop/rotate) and the client asks for the edited version -> local Immich has it
  if (match.kind !== 'playback' && deps.isLocallyEdited && wantsEdited(req, match)) {
    if (await deps.isLocallyEdited(req, match.assetId).catch(() => false)) {
      deps.passThrough(req, res);
      return true;
    }
  }

  // 2. stream from the remote
  const { path, query } = remotePathFor(info, match, req);
  const ref = remoteRef(info);
  const url = deps.remote.url(ref, path, query);
  const headers: Record<string, string> = { 'accept-encoding': 'identity' };
  if (typeof req.headers.range === 'string') {
    headers.range = req.headers.range;
  }
  if (typeof req.headers['if-range'] === 'string') {
    headers['if-range'] = req.headers['if-range'];
  }
  const controller = new AbortController();
  const onClose = () => controller.abort();
  res.on('close', onClose);

  let response: Response;
  try {
    response = await deps.remote.fetch(url, { method: req.method, headers, signal: controller.signal }, deps.timeoutMs);
  } catch (error) {
    res.off('close', onClose);
    if (!res.headersSent && !res.destroyed) {
      log.warn(`Remote ${info.serverHost} nicht erreichbar, nutze lokale Kopie: ${describeError(error)}`);
      deps.passThrough(req, res);
    }
    return true;
  }

  if (!(response.ok || response.status === 206 || response.status === 416 || response.status === 304)) {
    await response.body?.cancel().catch(() => {});
    res.off('close', onClose);
    log.warn(`Remote ${redactUrl(url.toString())} -> ${response.status}, nutze lokale Kopie`);
    deps.passThrough(req, res);
    return true;
  }

  const outHeaders: Record<string, string> = {};
  for (const name of PASS_HEADERS) {
    const value = response.headers.get(name);
    if (value) {
      outHeaders[name] = value;
    }
  }
  if (response.headers.get('content-encoding')) {
    delete outHeaders['content-length']; // fetch already decoded the body
  }
  // the friend's server is a third party: never let it choose an active content type on our origin
  const media = safeMediaType(response.headers.get('content-type'));
  outHeaders['content-type'] = media.type;
  outHeaders['x-content-type-options'] = 'nosniff';
  outHeaders['content-security-policy'] = "sandbox; default-src 'none'";
  outHeaders['cache-control'] = 'private, max-age=86400, no-transform';
  outHeaders['x-immich-federation'] = info.serverHost;
  const disposition = media.inline ? 'inline' : 'attachment';
  if (match.kind === 'original' && info.originalFileName) {
    outHeaders['content-disposition'] = `${disposition}; filename*=UTF-8''${encodeURIComponent(info.originalFileName)}`;
  } else if (!media.inline) {
    outHeaders['content-disposition'] = 'attachment';
  }
  res.writeHead(response.status, outHeaders);

  if (req.method === 'HEAD' || !response.body) {
    await response.body?.cancel().catch(() => {});
    res.end();
    res.off('close', onClose);
    return true;
  }
  const body = Readable.fromWeb(response.body as any);
  body.on('error', (error) => {
    if (!controller.signal.aborted) {
      log.debug(`Remote-Stream abgebrochen: ${error.message}`);
    }
    res.destroy();
  });
  body.pipe(res);
  return true;
}
