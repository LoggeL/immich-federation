import { openAsBlob } from 'node:fs';
import type { ForwardedAuth } from './auth.ts';
import type { Msg } from './i18n.ts';

/** Minimal client for the LOCAL (upstream) Immich v3.3.0 public API. */

/** `message` is technical (for logs); `localized` optionally carries a user-facing message. */
export class ImmichError extends Error {
  status: number;
  body: unknown;
  localized?: Msg;
  constructor(message: string, status: number, body?: unknown, localized?: Msg) {
    super(message);
    this.status = status;
    this.body = body;
    this.localized = localized;
  }
}

/**
 * Permissions for the gateway's background-sync API key. Values verified against
 * immich v3.3.0 server/src/enum.ts `Permission`.
 */
export const SYNC_PERMISSIONS = [
  'asset.read',
  'asset.upload',
  'asset.update',
  'asset.delete',
  'album.create',
  'album.read',
  'album.update',
  'album.delete',
  'albumAsset.create',
  'albumAsset.delete',
  'user.read',
] as const;

export type ImmichAuth = { apiKey: string } | ForwardedAuth;

export interface UploadInput {
  filePath: string;
  filename: string;
  contentType: string;
  fileCreatedAt: string;
  fileModifiedAt: string;
  visibility?: 'timeline' | 'archive';
  sha1?: string;
  metadata?: Array<{ key: string; value: Record<string, unknown> }>;
}

export class ImmichClient {
  #base: URL;
  #timeoutMs: number;

  constructor(baseUrl: URL, timeoutMs = 60_000) {
    this.#base = baseUrl;
    this.#timeoutMs = timeoutMs;
  }

  #build(path: string, auth: ImmichAuth, query?: Record<string, string>) {
    const url = new URL(path, this.#base);
    for (const [k, v] of Object.entries(query ?? {})) {
      url.searchParams.set(k, v);
    }
    const headers: Record<string, string> = { accept: 'application/json' };
    if ('apiKey' in auth) {
      headers['x-api-key'] = auth.apiKey;
    } else {
      Object.assign(headers, auth.headers);
      for (const [k, v] of auth.query) {
        url.searchParams.set(k, v);
      }
    }
    return { url, headers };
  }

  async request<T = any>(
    method: string,
    path: string,
    auth: ImmichAuth,
    options: {
      body?: unknown;
      query?: Record<string, string>;
      form?: FormData;
      headers?: Record<string, string>;
      timeoutMs?: number;
    } = {},
  ): Promise<T> {
    const { url, headers } = this.#build(path, auth, options.query);
    Object.assign(headers, options.headers);
    let body: BodyInit | undefined;
    if (options.form) {
      body = options.form;
    } else if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
    const response = await fetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(options.timeoutMs ?? this.#timeoutMs),
    });
    const text = await response.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!response.ok) {
      const message = (parsed as any)?.message;
      throw new ImmichError(
        `Immich ${method} ${path} -> ${response.status}${message ? `: ${Array.isArray(message) ? message.join(', ') : message}` : ''}`,
        response.status,
        parsed,
      );
    }
    return parsed as T;
  }

  getMe(auth: ImmichAuth) {
    return this.request<{ id: string; email: string; name: string }>('GET', '/api/users/me', auth);
  }

  getAsset(auth: ImmichAuth, id: string) {
    return this.request<any>('GET', `/api/assets/${id}`, auth);
  }

  createApiKey(auth: ImmichAuth, name: string, permissions: readonly string[]) {
    return this.request<{ id: string; secret: string }>('POST', '/api/api-keys', auth, {
      body: { name, permissions },
    });
  }

  deleteApiKey(auth: ImmichAuth, id: string) {
    return this.request('DELETE', `/api/api-keys/${id}`, auth);
  }

  createAlbum(auth: ImmichAuth, albumName: string, description: string) {
    return this.request<{ id: string; albumName: string }>('POST', '/api/albums', auth, {
      body: { albumName, description },
    });
  }

  getAlbum(auth: ImmichAuth, id: string) {
    return this.request<{ id: string; albumName: string; assetCount: number }>('GET', `/api/albums/${id}`, auth);
  }

  updateAlbum(auth: ImmichAuth, id: string, body: { albumName?: string; description?: string }) {
    return this.request('PATCH', `/api/albums/${id}`, auth, { body });
  }

  deleteAlbum(auth: ImmichAuth, id: string) {
    return this.request('DELETE', `/api/albums/${id}`, auth);
  }

  addAssetsToAlbum(auth: ImmichAuth, albumId: string, ids: string[]) {
    return this.request<Array<{ id: string; success: boolean; error?: string }>>(
      'PUT',
      `/api/albums/${albumId}/assets`,
      auth,
      { body: { ids } },
    );
  }

  /** Local album content (non-trashed, timeline + archive) via the timeline bucket API. */
  async listAlbumAssetIds(auth: ImmichAuth, albumId: string): Promise<Set<string>> {
    const ids = new Set<string>();
    const buckets = await this.request<Array<{ timeBucket: string }>>('GET', '/api/timeline/buckets', auth, {
      query: { albumId },
    });
    for (const { timeBucket } of buckets) {
      const bucket = await this.request<{ id?: string[] }>('GET', '/api/timeline/bucket', auth, {
        query: { albumId, timeBucket },
      });
      for (const id of bucket.id ?? []) {
        ids.add(id);
      }
    }
    return ids;
  }

  updateAsset(auth: ImmichAuth, id: string, body: Record<string, unknown>) {
    return this.request('PUT', `/api/assets/${id}`, auth, { body });
  }

  deleteAssets(auth: ImmichAuth, ids: string[], force = true) {
    return this.request('DELETE', '/api/assets', auth, { body: { ids, force } });
  }

  /**
   * POST /api/assets (multipart). v3.3.0 AssetMediaCreateDto: fileCreatedAt, fileModifiedAt (required),
   * filename, visibility, metadata (JSON), assetData (file). There is no deviceAssetId/deviceId anymore.
   * Text fields go BEFORE the file part, because multer evaluates `body.filename` when the file arrives.
   */
  async uploadAsset(auth: ImmichAuth, input: UploadInput): Promise<{ id: string; status: 'created' | 'duplicate' }> {
    const form = new FormData();
    form.set('fileCreatedAt', input.fileCreatedAt);
    form.set('fileModifiedAt', input.fileModifiedAt);
    form.set('filename', input.filename);
    if (input.visibility) {
      form.set('visibility', input.visibility);
    }
    if (input.metadata?.length) {
      form.set('metadata', JSON.stringify(input.metadata));
    }
    const blob = await openAsBlob(input.filePath, { type: input.contentType });
    form.set('assetData', blob, input.filename);
    return this.request('POST', '/api/assets', auth, {
      form,
      headers: input.sha1 ? { 'x-immich-checksum': input.sha1 } : {},
      timeoutMs: 10 * 60_000,
    });
  }
}
