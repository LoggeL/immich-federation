import type { IncomingMessage } from 'node:http';

/** Headers Immich v3.3.0 accepts for authentication (server/src/enum.ts ImmichHeader + cookies + bearer). */
const AUTH_HEADERS = [
  'cookie',
  'authorization',
  'x-api-key',
  'x-immich-user-token',
  'x-immich-session-token',
  'x-immich-share-key',
  'x-immich-share-slug',
] as const;

/** Query params Immich accepts for authentication (ImmichQuery). */
const AUTH_QUERY = ['key', 'slug', 'apiKey', 'sessionKey'] as const;

export interface ForwardedAuth {
  headers: Record<string, string>;
  query: URLSearchParams;
}

export function extractAuth(req: IncomingMessage, { allowSharedLink = true } = {}): ForwardedAuth {
  const headers: Record<string, string> = {};
  for (const name of AUTH_HEADERS) {
    if (!allowSharedLink && (name === 'x-immich-share-key' || name === 'x-immich-share-slug')) {
      continue;
    }
    const value = req.headers[name];
    if (typeof value === 'string' && value) {
      headers[name] = value;
    }
  }
  const query = new URLSearchParams();
  const url = new URL(req.url ?? '/', 'http://local');
  for (const name of AUTH_QUERY) {
    if (!allowSharedLink && (name === 'key' || name === 'slug')) {
      continue;
    }
    const value = url.searchParams.get(name);
    if (value) {
      query.set(name, value);
    }
  }
  return { headers, query };
}

export function hasAuth(auth: ForwardedAuth) {
  return Object.keys(auth.headers).length > 0 || [...auth.query.keys()].length > 0;
}
