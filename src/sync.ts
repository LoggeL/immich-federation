import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from './config.ts';
import type { AssetRow, LinkRow, Store } from './db.ts';
import { ImmichClient, ImmichError, SYNC_PERMISSIONS, type ImmichAuth } from './immich.ts';
import type { ForwardedAuth } from './auth.ts';
import { describeError, logger } from './log.ts';
import {
  extensionForMime,
  hasFfmpeg,
  Semaphore,
  sha1File,
  streamToFile,
  TempDir,
  TooLargeError,
  transcodeVideoProxy,
  uploadFilename,
} from './media.ts';
import { RemoteClient, RemoteError, type RemoteAsset, type RemoteAssetRef, type RemoteLinkRef } from './remote.ts';

const log = logger('sync');

export const FEDERATION_METADATA_KEY = 'immich-federation';
const API_KEY_NAME = 'Immich Federation Gateway';
const UPLOAD_CONCURRENCY = 3;
/** Prefix of lastError when the stored Immich API key stopped working (e.g. deleted by the user). */
export const API_KEY_INVALID = 'API-Schlüssel des Gateways ungültig – Föderationsseite einmal öffnen, dann wird er erneuert';

export interface LinkStatus {
  syncing: boolean;
  progress: { done: number; total: number; failed: number } | null;
}

interface RunState {
  promise: Promise<void>;
  cancelled: boolean;
  rerun: boolean;
  progress: { done: number; total: number; failed: number };
}

export function remoteRef(link: Pick<LinkRow, 'baseUrl' | 'shareKey' | 'shareSlug'>): RemoteLinkRef {
  return { baseUrl: link.baseUrl, key: link.shareKey, slug: link.shareSlug };
}

/** Immich expects dateTimeOriginal as ISO string; an explicit offset makes it keep the local time zone. */
export function buildDateTimeOriginal(asset: RemoteAsset): string {
  const utc = asset.exifInfo?.dateTimeOriginal ?? asset.fileCreatedAt ?? asset.localDateTime ?? new Date().toISOString();
  const utcMs = Date.parse(utc);
  if (!Number.isFinite(utcMs)) {
    return new Date().toISOString();
  }
  let offsetMin = 0;
  const localMs = asset.localDateTime ? Date.parse(asset.localDateTime) : Number.NaN;
  if (Number.isFinite(localMs) && (asset.exifInfo?.dateTimeOriginal || asset.fileCreatedAt)) {
    offsetMin = Math.round((localMs - utcMs) / 60_000 / 15) * 15;
    if (Math.abs(offsetMin) > 14 * 60) {
      offsetMin = 0;
    }
  }
  const local = new Date(utcMs + offsetMin * 60_000).toISOString().replace(/Z$/, '');
  const sign = offsetMin < 0 ? '-' : '+';
  const abs = Math.abs(offsetMin);
  return `${local}${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

export function federationDescription(asset: RemoteAsset, host: string, owner: string) {
  const footer = `Föderiert von ${host}${owner ? ` · ${owner}` : ''}`;
  const remote = asset.exifInfo?.description?.trim();
  return remote ? `${remote}\n\n${footer}` : footer;
}

export class SyncEngine {
  #store: Store;
  #immich: ImmichClient;
  #remote: RemoteClient;
  #config: Config;
  #tmp: TempDir;
  #runs = new Map<string, RunState>();
  /** remote downloads across all links (politeness + disk) */
  #downloads: Semaphore;
  /** full video downloads strictly one after another */
  #videoDownloads = new Semaphore(1);
  #timer: NodeJS.Timeout | undefined;
  #startupTimer: NodeJS.Timeout | undefined;

  constructor(deps: { store: Store; immich: ImmichClient; remote: RemoteClient; config: Config; tmp: TempDir }) {
    this.#store = deps.store;
    this.#immich = deps.immich;
    this.#remote = deps.remote;
    this.#config = deps.config;
    this.#tmp = deps.tmp;
    this.#downloads = new Semaphore(deps.config.downloadConcurrency ?? 3);
  }

  // ---------------- scheduling ----------------

  start() {
    const everyMs = this.#config.syncIntervalMinutes * 60_000;
    this.#timer = setInterval(() => void this.syncAll(), everyMs);
    this.#timer.unref();
    this.#startupTimer = setTimeout(() => void this.syncAll(), 30_000);
    this.#startupTimer.unref();
    log.info(`Sync alle ${this.#config.syncIntervalMinutes} min aktiviert`);
  }

  stop() {
    clearInterval(this.#timer);
    clearTimeout(this.#startupTimer);
    for (const run of this.#runs.values()) {
      run.cancelled = true;
    }
  }

  async syncAll() {
    for (const link of this.#store.listLinks()) {
      try {
        await this.trigger(link.id);
      } catch (error) {
        log.error(`Sync von ${link.id} fehlgeschlagen`, error);
      }
    }
  }

  status(linkId: string): LinkStatus {
    const run = this.#runs.get(linkId);
    return run ? { syncing: true, progress: { ...run.progress } } : { syncing: false, progress: null };
  }

  /** Start a sync (or schedule one more pass if one is already running). Resolves when done. */
  trigger(linkId: string): Promise<void> {
    const existing = this.#runs.get(linkId);
    if (existing) {
      existing.rerun = true;
      return existing.promise;
    }
    const state: RunState = {
      promise: Promise.resolve(),
      cancelled: false,
      rerun: false,
      progress: { done: 0, total: 0, failed: 0 },
    };
    state.promise = (async () => {
      try {
        do {
          state.rerun = false;
          state.progress = { done: 0, total: 0, failed: 0 };
          await this.#syncLink(linkId, state);
        } while (state.rerun && !state.cancelled);
      } finally {
        this.#runs.delete(linkId);
      }
    })();
    this.#runs.set(linkId, state);
    return state.promise;
  }

  async #cancelAndWait(linkId: string) {
    const run = this.#runs.get(linkId);
    if (run) {
      run.cancelled = true;
      run.rerun = false;
      await run.promise.catch(() => {});
    }
  }

  // ---------------- credentials ----------------

  /**
   * Make sure we hold a working API key for the caller (created through the caller's own Immich session).
   * Returns the Immich user.
   */
  async ensureUserKey(auth: ForwardedAuth): Promise<{ id: string; email: string; name: string }> {
    const me = await this.#immich.getMe(auth);
    const existing = this.#store.getUser(me.id);
    if (existing) {
      try {
        await this.#immich.getMe({ apiKey: existing.apiKey });
        return me;
      } catch (error) {
        if (!(error instanceof ImmichError) || (error.status !== 401 && error.status !== 403)) {
          throw error;
        }
        log.warn(`API-Schlüssel für ${me.email} ungültig, erstelle neuen`);
        await this.#immich.deleteApiKey(auth, existing.apiKeyId).catch(() => {});
      }
    }
    let created: { id: string; secret: string };
    try {
      created = await this.#immich.createApiKey(auth, API_KEY_NAME, SYNC_PERMISSIONS);
    } catch (error) {
      if (error instanceof ImmichError && (error.status === 400 || error.status === 403)) {
        throw new ImmichError(
          'Konnte keinen API-Schlüssel für die Synchronisation anlegen. Bitte normal im Immich-Web angemeldet verbinden ' +
            `(${error.message})`,
          403,
        );
      }
      throw error;
    }
    this.#store.upsertUser({ id: me.id, email: me.email, name: me.name, apiKeyId: created.id, apiKey: created.secret });
    log.info(`API-Schlüssel für ${me.email} angelegt`);
    return me;
  }

  #authFor(link: LinkRow): ImmichAuth {
    const user = this.#store.getUser(link.userId);
    if (!user) {
      throw new Error('Kein API-Schlüssel für diesen Benutzer gespeichert – Link bitte neu verbinden');
    }
    return { apiKey: user.apiKey };
  }

  // ---------------- link lifecycle ----------------

  async deleteLink(linkId: string, deleteAssets: boolean) {
    const link = this.#store.getLink(linkId);
    if (!link) {
      return;
    }
    await this.#cancelAndWait(linkId);
    if (deleteAssets) {
      const auth = this.#authFor(link);
      const removable = this.#store
        .listAssets(linkId)
        .filter((a) => a.owned && this.#store.countLocalReferences(a.localAssetId) === 1)
        .map((a) => a.localAssetId);
      // album first: deleting it while Immich's background jobs still remove the just-deleted assets from
      // album_asset can deadlock in Postgres (seen live: 500 "Failed to delete album"); retry once anyway
      const dropAlbum = () => this.#immich.deleteAlbum(auth, link.albumId);
      await dropAlbum()
        .catch(async (error) => {
          if (error instanceof ImmichError && error.status >= 500) {
            await new Promise((r) => setTimeout(r, 1500));
            return dropAlbum();
          }
          throw error;
        })
        .catch((error) => {
          log.warn(`Konnte lokales Album ${link.albumId} nicht löschen`, error.message);
        });
      const notDeleted = await this.#deleteLocalAssets(auth, removable).catch((error) => {
        log.warn(`Konnte lokale Assets von ${linkId} nicht löschen`, error.message);
        return [];
      });
      if (notDeleted.length > 0) {
        log.warn(`${notDeleted.length} lokale Assets von ${linkId} konnten nicht gelöscht werden (gesperrter Ordner?)`);
      }
    }
    this.#store.deleteLink(linkId);
    log.info(`Link ${linkId} (${link.serverHost} / ${link.remoteAlbumName}) getrennt, Assets gelöscht: ${deleteAssets}`);
  }

  // ---------------- the actual sync ----------------

  async #syncLink(linkId: string, state: RunState) {
    let link = this.#store.getLink(linkId);
    if (!link) {
      return;
    }
    const started = Date.now();
    const ref = remoteRef(link);
    try {
      const auth = this.#authFor(link);

      // 1. remote link still valid? refresh name/owner/permissions
      const info = await this.#remote.getLinkInfo(ref);
      this.#store.updateLink(linkId, {
        remoteAlbumName: info.albumName,
        remoteOwnerName: info.ownerName,
        allowDownload: info.allowDownload,
        showMetadata: info.showMetadata,
        remoteAlbumId: info.albumId,
      });

      // 2. local album exists? (user may have deleted it in Immich)
      const albumId = await this.#ensureAlbum(link, auth, info.albumName);
      link = this.#store.getLink(linkId)!;

      // 3. diff
      const remoteAssets = await this.#remote.listAssets(ref, info);
      const remoteIds = new Set(remoteAssets.map((a) => a.id));
      const mapped = new Map(this.#store.listAssets(linkId).map((a) => [a.remoteAssetId, a]));
      const toAdd = remoteAssets.filter((a) => !mapped.has(a.id) && (link!.importVideos || a.isImage));
      const toRemove = [...mapped.values()].filter((a) => !remoteIds.has(a.remoteAssetId));
      state.progress.total = toAdd.length;
      log.info(
        `[${link.serverHost} / ${link.remoteAlbumName}] remote ${remoteAssets.length}, neu ${toAdd.length}, entfernt ${toRemove.length}`,
      );

      // 4. import new assets
      const errors: string[] = [];
      const queue = [...toAdd];
      const newLocalIds: string[] = [];
      const worker = async () => {
        while (queue.length > 0 && !state.cancelled) {
          const item = queue.shift()!;
          try {
            const row = await this.#importAsset(link!, auth, item);
            if (row && !row.dismissed) {
              newLocalIds.push(row.localAssetId);
            }
          } catch (error) {
            state.progress.failed++;
            const message = describeError(error);
            errors.push(message);
            log.warn(`Import ${item.id} von ${link!.serverHost} fehlgeschlagen: ${message}`);
          } finally {
            state.progress.done++;
          }
          if (newLocalIds.length >= 50) {
            await this.#addToAlbum(auth, albumId, newLocalIds.splice(0));
          }
        }
      };
      await Promise.all(Array.from({ length: UPLOAD_CONCURRENCY }, worker));
      if (newLocalIds.length > 0) {
        await this.#addToAlbum(auth, albumId, newLocalIds.splice(0));
      }
      if (state.cancelled) {
        return;
      }

      // 5. remove assets that disappeared remotely
      await this.#removeAssets(link, auth, albumId, toRemove);

      // 5b. metadata that could not be applied earlier (restart between upload and PUT, transient errors)
      await this.#retryMetadata(link, auth, state);

      // 6. reconcile local album membership (user removed/trashed/deleted assets locally)
      await this.#reconcileAlbum(link, auth, albumId);

      const failedNote = errors.length
        ? `${errors.length} Element(e) fehlgeschlagen, z.B.: ${errors[0]}`
        : null;
      this.#store.updateLink(linkId, { lastSyncedAt: new Date().toISOString(), lastError: failedNote });
      this.#store.log(
        linkId,
        errors.length ? 'warn' : 'info',
        `Sync fertig in ${Math.round((Date.now() - started) / 1000)} s: +${toAdd.length - errors.length} / -${toRemove.length}` +
          (errors.length ? `, ${errors.length} Fehler` : ''),
      );
    } catch (error) {
      const message =
        error instanceof ImmichError && error.status === 401
          ? `${API_KEY_INVALID}: ${error.message}`
          : error instanceof RemoteError || error instanceof ImmichError
            ? error.message
            : `Synchronisation fehlgeschlagen: ${describeError(error)}`;
      log.warn(`[${link.serverHost}] ${message}`);
      if (this.#store.getLink(linkId)) {
        this.#store.updateLink(linkId, { lastError: message });
        this.#store.log(linkId, 'error', message);
      }
    }
  }

  async #ensureAlbum(link: LinkRow, auth: ImmichAuth, remoteName: string): Promise<string> {
    try {
      const album = await this.#immich.getAlbum(auth, link.albumId);
      if (remoteName && link.remoteAlbumName !== remoteName && album.albumName === link.remoteAlbumName) {
        await this.#immich.updateAlbum(auth, link.albumId, { albumName: remoteName }).catch(() => {});
      }
      return link.albumId;
    } catch (error) {
      if (!(error instanceof ImmichError) || (error.status !== 400 && error.status !== 404)) {
        throw error;
      }
    }
    const album = await this.#immich.createAlbum(
      auth,
      remoteName || link.remoteAlbumName,
      `Föderiert von ${link.serverHost}${link.remoteOwnerName ? ` (${link.remoteOwnerName})` : ''}`,
    );
    this.#store.updateLink(link.id, { albumId: album.id });
    this.#store.log(link.id, 'warn', 'Lokales Album fehlte und wurde neu angelegt');
    return album.id;
  }

  async #addToAlbum(auth: ImmichAuth, albumId: string, ids: string[]) {
    if (ids.length === 0) {
      return [];
    }
    return this.#immich.addAssetsToAlbum(auth, albumId, ids);
  }

  async #importAsset(link: LinkRow, auth: ImmichAuth, item: RemoteAssetRef): Promise<AssetRow | undefined> {
    const ref = remoteRef(link);
    const remoteId = item.id;
    const asset = await this.#remote.getAsset(ref, remoteId);
    if (asset.isTrashed) {
      return undefined;
    }
    // links with "show metadata" off strip fileCreatedAt; the timeline bucket still has it
    asset.fileCreatedAt ??= item.fileCreatedAt;
    const isVideo = asset.type === 'VIDEO';
    const dir = await this.#tmp.make('import');
    try {
      const download = isVideo
        ? this.#remote.url(ref, `/api/assets/${remoteId}/video/playback`)
        : this.#remote.url(ref, `/api/assets/${remoteId}/thumbnail`, { size: 'preview', edited: 'true' });
      const inputFile = join(dir, 'input');
      const maxBytes = isVideo ? this.#config.maxVideoBytes : this.#config.maxPreviewBytes;
      const fetchToFile = async () => {
        const response = await this.#remote.fetch(download, { signal: AbortSignal.timeout(60 * 60_000) });
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          throw new RemoteError(`Download ${isVideo ? 'Video' : 'Vorschau'} -> HTTP ${response.status}`, response.status);
        }
        const length = Number(response.headers.get('content-length') ?? '');
        if (Number.isFinite(length) && length > maxBytes) {
          await response.body?.cancel().catch(() => {});
          throw new TooLargeError(`Datei zu groß (${Math.round(length / 1024 / 1024)} MB) – übersprungen`);
        }
        await streamToFile(response.body, inputFile, maxBytes);
        return (response.headers.get('content-type') ?? '').split(';')[0].trim();
      };
      const contentType = isVideo
        ? await this.#videoDownloads.run(() => this.#downloads.run(fetchToFile))
        : await this.#downloads.run(fetchToFile);

      let uploadFile = inputFile;
      let uploadType = contentType || (isVideo ? 'video/mp4' : 'image/jpeg');
      let ext = extensionForMime(uploadType, isVideo ? '.mp4' : '.jpg');
      if (isVideo && (await hasFfmpeg(this.#config.ffmpegPath))) {
        uploadFile = join(dir, 'proxy.mp4');
        await transcodeVideoProxy(this.#config.ffmpegPath, inputFile, uploadFile, this.#config.videoProxyHeight);
        uploadType = 'video/mp4';
        ext = '.mp4';
      } else if (isVideo) {
        log.warn('ffmpeg nicht verfügbar – Video wird ohne Verkleinerung übernommen');
      }

      const filename = uploadFilename(asset.originalFileName, remoteId, ext);
      const date = buildDateTimeOriginal(asset);
      const isoDate = new Date(Date.parse(date)).toISOString();
      const sha1 = await sha1File(uploadFile);
      const uploaded = await this.#immich.uploadAsset(auth, {
        filePath: uploadFile,
        filename,
        contentType: uploadType,
        fileCreatedAt: isoDate,
        fileModifiedAt: isoDate,
        visibility: link.showInTimeline ? 'timeline' : 'archive',
        sha1,
        metadata: [
          {
            key: FEDERATION_METADATA_KEY,
            value: { host: link.serverHost, linkId: link.id, remoteAssetId: remoteId, originalFileName: asset.originalFileName ?? null },
          },
        ],
      });

      let owned = uploaded.status === 'created';
      if (!owned) {
        owned = this.#store.isOwnedLocalAsset(uploaded.id) || (await this.#hasFederationMarker(auth, uploaded.id));
      }
      // also for our own duplicates (restart between upload and PUT) – never for foreign assets
      const metaApplied = owned ? await this.#applyMetadata(link, auth, uploaded.id, asset) : true;

      const row: AssetRow = {
        linkId: link.id,
        remoteAssetId: remoteId,
        localAssetId: uploaded.id,
        type: asset.type,
        originalFileName: asset.originalFileName ?? null,
        originalMimeType: asset.originalMimeType ?? null,
        owned,
        dismissed: false,
        metaApplied,
        syncedAt: new Date().toISOString(),
      };
      this.#store.upsertAsset(row);
      return row;
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async #hasFederationMarker(auth: ImmichAuth, localId: string) {
    try {
      const items = await this.#immich.request<Array<{ key: string }>>('GET', `/api/assets/${localId}/metadata`, auth);
      return Array.isArray(items) && items.some((i) => i.key === FEDERATION_METADATA_KEY);
    } catch {
      return false;
    }
  }

  async #removeAssets(link: LinkRow, auth: ImmichAuth, albumId: string, rows: AssetRow[]) {
    if (rows.length === 0) {
      return;
    }
    const toDelete: string[] = [];
    const toUnlink: string[] = [];
    for (const row of rows) {
      if (row.owned && this.#store.countLocalReferences(row.localAssetId) === 1) {
        toDelete.push(row.localAssetId);
      } else {
        toUnlink.push(row.localAssetId);
      }
    }
    const notDeleted = await this.#deleteLocalAssets(auth, toDelete);
    if (notDeleted.length > 0) {
      this.#store.log(link.id, 'warn', `${notDeleted.length} lokale Kopie(n) konnten nicht gelöscht werden (gesperrter Ordner?)`);
    }
    if (toUnlink.length > 0) {
      await this.#immich
        .request('DELETE', `/api/albums/${albumId}/assets`, auth, { body: { ids: toUnlink } })
        .catch((error) => log.warn(`Konnte Assets nicht aus Album entfernen: ${error.message}`));
    }
    for (const row of rows) {
      this.#store.deleteAsset(link.id, row.remoteAssetId);
    }
  }

  /**
   * DELETE /api/assets (force) tolerant to ids that are already gone or not deletable (Locked folder):
   * Immich rejects the whole batch with 400 if a single id fails its access check, so retry one by one.
   * Returns the ids that still exist but could not be deleted.
   */
  async #deleteLocalAssets(auth: ImmichAuth, ids: string[]): Promise<string[]> {
    const failed: string[] = [];
    for (let i = 0; i < ids.length; i += 500) {
      const batch = ids.slice(i, i + 500);
      try {
        await this.#immich.deleteAssets(auth, batch, true);
        continue;
      } catch (error) {
        if (!(error instanceof ImmichError) || (error.status !== 400 && error.status !== 404)) {
          throw error;
        }
      }
      for (const id of batch) {
        try {
          await this.#immich.deleteAssets(auth, [id], true);
        } catch (error) {
          if (!(error instanceof ImmichError) || (error.status !== 400 && error.status !== 404)) {
            throw error;
          }
          // gone already (trash emptied / deleted) -> fine; still there (locked) -> report
          const exists = await this.#immich
            .getAsset(auth, id)
            .then(() => true)
            .catch(() => false);
          if (exists) {
            failed.push(id);
          }
        }
      }
    }
    return failed;
  }

  #metadataBody(link: LinkRow, asset: RemoteAsset) {
    const body: Record<string, unknown> = {
      dateTimeOriginal: buildDateTimeOriginal(asset),
      description: federationDescription(asset, link.serverHost, link.remoteOwnerName),
    };
    const { latitude, longitude } = asset.exifInfo ?? {};
    if (typeof latitude === 'number' && typeof longitude === 'number' && (latitude !== 0 || longitude !== 0)) {
      body.latitude = latitude;
      body.longitude = longitude;
    }
    return body;
  }

  async #applyMetadata(link: LinkRow, auth: ImmichAuth, localId: string, asset: RemoteAsset): Promise<boolean> {
    try {
      await this.#immich.updateAsset(auth, localId, this.#metadataBody(link, asset));
      return true;
    } catch (error) {
      log.warn(`Metadaten für ${localId} nicht gesetzt (wird beim nächsten Sync erneut versucht): ${describeError(error)}`);
      return false;
    }
  }

  async #retryMetadata(link: LinkRow, auth: ImmichAuth, state: RunState) {
    const pending = this.#store.listAssets(link.id).filter((r) => r.owned && !r.dismissed && !r.metaApplied);
    for (const row of pending) {
      if (state.cancelled) {
        return;
      }
      try {
        const asset = await this.#remote.getAsset(remoteRef(link), row.remoteAssetId);
        if (!asset.fileCreatedAt && !asset.exifInfo) {
          // link hides metadata: the date comes from the timeline bucket -> re-list is not worth it, use what we have
          const local = await this.#immich.getAsset(auth, row.localAssetId);
          asset.fileCreatedAt ??= local?.fileCreatedAt;
        }
        if (await this.#applyMetadata(link, auth, row.localAssetId, asset)) {
          this.#store.setMetaApplied(link.id, row.remoteAssetId, true);
        }
      } catch (error) {
        if (error instanceof ImmichError && (error.status === 400 || error.status === 404)) {
          continue; // local asset gone -> reconcile handles it
        }
        log.warn(`Metadaten-Nachtrag für ${row.localAssetId} fehlgeschlagen: ${describeError(error)}`);
      }
    }
  }

  async #reconcileAlbum(link: LinkRow, auth: ImmichAuth, albumId: string) {
    const rows = this.#store.listAssets(link.id);
    if (rows.length === 0) {
      return;
    }
    const present = await this.#immich.listAlbumAssetIds(auth, albumId);
    for (const row of rows) {
      if (row.dismissed && present.has(row.localAssetId)) {
        this.#store.setDismissed(link.id, row.remoteAssetId, false); // restored from trash
      }
    }
    const missing = rows.filter((r) => !r.dismissed && !present.has(r.localAssetId));
    if (missing.length === 0) {
      return;
    }
    const results = await this.#addToAlbum(
      auth,
      albumId,
      missing.map((r) => r.localAssetId),
    );
    const byId = new Map(results.map((r) => [r.id, r]));
    for (const row of missing) {
      const result = byId.get(row.localAssetId);
      if (result?.success) {
        continue;
      }
      // still in album but not listed (trashed) or gone entirely -> respect the user's decision
      let gone = result?.error !== 'duplicate';
      if (!gone) {
        try {
          const local = await this.#immich.getAsset(auth, row.localAssetId);
          gone = !!local?.isTrashed;
        } catch {
          gone = true;
        }
      }
      if (gone) {
        this.#store.setDismissed(link.id, row.remoteAssetId, true);
      }
    }
  }
}
