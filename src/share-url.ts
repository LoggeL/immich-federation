import { LocalizedError } from './i18n.ts';

export interface ParsedShareUrl {
  /** Origin incl. optional base path, without trailing slash, e.g. `https://photos.friend.de` */
  baseUrl: string;
  host: string;
  /** Exactly one of key / slug is set */
  key?: string;
  slug?: string;
}

const KEY_RE = /^[A-Za-z0-9_-]{8,}$/;
const SLUG_RE = /^[A-Za-z0-9._~-]{1,200}$/;

/**
 * Accepts Immich share links:
 *   https://host/share/<key>                (album / individual share link)
 *   https://host/share/<key>/photos/<id>    (deep link into a shared album)
 *   https://host/s/<slug>                   (custom slug link)
 * A base path in front of /share or /s is preserved (reverse proxies with sub paths).
 */
export function parseShareUrl(input: string): ParsedShareUrl {
  const raw = (input ?? '').trim();
  if (!raw) {
    throw new LocalizedError('share_url_empty');
  }

  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new LocalizedError('share_url_invalid');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new LocalizedError('share_url_protocol');
  }
  if (url.username || url.password) {
    throw new LocalizedError('share_url_credentials');
  }

  let segments: string[];
  try {
    segments = url.pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
  } catch {
    throw new LocalizedError('share_url_invalid');
  }
  // search from the end so a base path containing "share" does not confuse us
  for (let i = segments.length - 2; i >= 0; i--) {
    const kind = segments[i];
    const value = segments[i + 1];
    if (kind !== 'share' && kind !== 's') {
      continue;
    }
    const basePath = segments.slice(0, i).map(encodeURIComponent).join('/');
    const baseUrl = url.origin + (basePath ? `/${basePath}` : '');
    if (kind === 'share' && KEY_RE.test(value)) {
      return { baseUrl, host: url.host, key: value };
    }
    if (kind === 's' && SLUG_RE.test(value)) {
      return { baseUrl, host: url.host, slug: value };
    }
  }

  // also accept ".../something?key=<key>" style links
  const key = url.searchParams.get('key');
  if (key && KEY_RE.test(key)) {
    return { baseUrl: url.origin, host: url.host, key };
  }

  throw new LocalizedError('share_url_not_immich');
}

/** Query string fragment authenticating against the remote as that shared link */
export function shareAuthParams(link: { key?: string | null; slug?: string | null }): URLSearchParams {
  const params = new URLSearchParams();
  if (link.key) {
    params.set('key', link.key);
  } else if (link.slug) {
    params.set('slug', link.slug);
  }
  return params;
}
