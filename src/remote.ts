import { safeFetch, type FetchLike } from './ssrf.ts';
import { shareAuthParams } from './share-url.ts';

/** Remote (friend's) Immich, accessed exclusively through a shared link (?key= / ?slug=). */
export interface RemoteLinkRef {
  baseUrl: string;
  key?: string | null;
  slug?: string | null;
}

export interface RemoteLinkInfo {
  id: string;
  type: 'ALBUM' | 'INDIVIDUAL' | string;
  albumId: string | null;
  albumName: string;
  ownerName: string;
  allowDownload: boolean;
  showMetadata: boolean;
  expiresAt: string | null;
  /** Only for INDIVIDUAL links */
  assets: Array<{ id: string; type: string }>;
}

export interface RemoteAssetRef {
  id: string;
  isImage: boolean;
  /** UTC, from the timeline bucket (still present when the link hides metadata) */
  fileCreatedAt?: string;
}

const asUtc = (value: string | undefined) =>
  !value ? undefined : /(?:Z|[+-]\d\d:?\d\d)$/.test(value) ? value : `${value}Z`;

export interface RemoteAsset {
  id: string;
  type: 'IMAGE' | 'VIDEO' | string;
  originalFileName?: string;
  originalMimeType?: string;
  fileCreatedAt?: string;
  fileModifiedAt?: string;
  localDateTime?: string;
  duration?: string | null;
  checksum?: string;
  isTrashed?: boolean;
  livePhotoVideoId?: string | null;
  exifInfo?: {
    dateTimeOriginal?: string | null;
    timeZone?: string | null;
    latitude?: number | null;
    longitude?: number | null;
    description?: string | null;
    make?: string | null;
    model?: string | null;
  };
}

export class RemoteError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export interface RemoteClientOptions {
  allowPrivate: boolean;
  timeoutMs: number;
  fetch?: FetchLike;
}

export class RemoteClient {
  #options: RemoteClientOptions;

  constructor(options: RemoteClientOptions) {
    this.#options = options;
  }

  url(link: RemoteLinkRef, path: string, query: Record<string, string | undefined> = {}): URL {
    const url = new URL(link.baseUrl.replace(/\/$/, '') + path);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) {
        url.searchParams.set(k, v);
      }
    }
    for (const [k, v] of shareAuthParams(link)) {
      url.searchParams.set(k, v);
    }
    return url;
  }

  fetch(url: URL, init: RequestInit = {}, timeoutMs = this.#options.timeoutMs): Promise<Response> {
    return safeFetch(url, init, { ...this.#options, timeoutMs });
  }

  async #json<T>(link: RemoteLinkRef, path: string, query?: Record<string, string | undefined>): Promise<T> {
    const response = await this.fetch(this.url(link, path, query), { headers: { accept: 'application/json' } });
    if (!response.ok) {
      let detail = '';
      try {
        const body = (await response.json()) as { message?: string | string[] };
        detail = Array.isArray(body.message) ? body.message.join(', ') : (body.message ?? '');
      } catch {
        /* ignore */
      }
      throw new RemoteError(describeRemoteStatus(response.status, detail), response.status);
    }
    return (await response.json()) as T;
  }

  async getLinkInfo(link: RemoteLinkRef): Promise<RemoteLinkInfo> {
    const raw = await this.#json<any>(link, '/api/shared-links/me');
    const album = raw.album ?? null;
    const owner = album?.albumUsers?.find((u: any) => u.role === 'owner')?.user ?? album?.albumUsers?.[0]?.user;
    return {
      id: raw.id,
      type: raw.type,
      albumId: album?.id ?? null,
      albumName: album?.albumName || raw.description || 'Föderiertes Album',
      ownerName: owner?.name || owner?.email || '',
      allowDownload: raw.allowDownload !== false,
      showMetadata: raw.showMetadata !== false,
      expiresAt: raw.expiresAt ?? null,
      assets: Array.isArray(raw.assets) ? raw.assets.map((a: any) => ({ id: a.id, type: a.type })) : [],
    };
  }

  /**
   * All (non-trashed) assets of the linked album. Uses the timeline bucket API without a visibility filter
   * (= Immich default: timeline + archive, hidden live-photo motion parts excluded).
   */
  async listAlbumAssets(link: RemoteLinkRef, albumId: string): Promise<RemoteAssetRef[]> {
    const buckets = await this.#json<Array<{ timeBucket: string; count: number }>>(link, '/api/timeline/buckets', {
      albumId,
    });
    const result: RemoteAssetRef[] = [];
    const seen = new Set<string>();
    for (const { timeBucket } of buckets) {
      const bucket = await this.#json<{
        id?: string[];
        isImage?: boolean[];
        isTrashed?: boolean[];
        fileCreatedAt?: string[];
      }>(
        link,
        '/api/timeline/bucket',
        { albumId, timeBucket },
      );
      const ids = bucket.id ?? [];
      for (let i = 0; i < ids.length; i++) {
        if (bucket.isTrashed?.[i] || seen.has(ids[i])) {
          continue;
        }
        seen.add(ids[i]);
        const fileCreatedAt = asUtc(bucket.fileCreatedAt?.[i]);
        result.push({ id: ids[i], isImage: bucket.isImage?.[i] ?? true, ...(fileCreatedAt ? { fileCreatedAt } : {}) });
      }
    }
    return result;
  }

  async listAssets(link: RemoteLinkRef, info: RemoteLinkInfo): Promise<RemoteAssetRef[]> {
    if (info.albumId) {
      return this.listAlbumAssets(link, info.albumId);
    }
    return info.assets.map((a) => ({ id: a.id, isImage: a.type !== 'VIDEO' }));
  }

  getAsset(link: RemoteLinkRef, id: string): Promise<RemoteAsset> {
    return this.#json<RemoteAsset>(link, `/api/assets/${encodeURIComponent(id)}`);
  }
}

export function describeRemoteStatus(status: number, detail = ''): string {
  const suffix = detail ? ` (${detail})` : '';
  if (status === 401 && /password/i.test(detail)) {
    return 'Der Freigabelink ist passwortgeschützt – das wird nicht unterstützt';
  }
  if (status === 401 || status === 403) {
    return `Freigabelink ungültig, abgelaufen oder widerrufen${suffix}`;
  }
  if (status === 404) {
    return `Nicht gefunden auf dem entfernten Server${suffix}`;
  }
  return `Entfernter Server antwortete mit HTTP ${status}${suffix}`;
}
