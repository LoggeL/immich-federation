import { lookup as lookupCb, type LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';
import { LocalizedError } from './i18n.ts';

const blocked = new BlockList();
// IPv4
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link local / cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
// IPv6
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7], // ULA
  ['fe80::', 10], // link local
  ['ff00::', 8], // multicast
  ['2001:db8::', 32], // documentation
  ['64:ff9b::', 96], // NAT64 (may embed private v4)
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    return blocked.check(address, 'ipv4');
  }
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) {
      return blocked.check(mapped[1], 'ipv4');
    }
    return blocked.check(address, 'ipv6');
  }
  return true; // not an IP at all -> treat as unsafe
}

export class SsrfError extends LocalizedError {}

export interface SsrfOptions {
  allowPrivate: boolean;
}

/** Throws SsrfError if the URL is not http(s) or (unless allowed) resolves to a private address. */
export async function assertSafeUrl(url: URL, { allowPrivate }: SsrfOptions): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfError('ssrf_protocol', { protocol: url.protocol });
  }
  if (url.username || url.password) {
    throw new SsrfError('ssrf_credentials');
  }
  if (allowPrivate) {
    return;
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true, verbatim: true }).catch(() => {
        throw new SsrfError('ssrf_unresolvable', { host: hostname });
      });
  if (addresses.length === 0) {
    throw new SsrfError('ssrf_unresolvable', { host: hostname });
  }
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new SsrfError('ssrf_private', { host: hostname, address });
    }
  }
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/**
 * DNS lookup used for the actual TCP connect: every resolved address is checked, so the address that was
 * validated is the address that is connected to (no DNS-rebinding window between check and connect).
 */
export function guardedLookup(hostname: string, options: { all?: boolean; family?: number }, callback: LookupCallback) {
  lookupCb(hostname, { ...options, all: true, verbatim: true }, (error, addresses) => {
    if (error) {
      return callback(error, '');
    }
    const list = addresses as LookupAddress[];
    const bad = list.find((a) => isPrivateAddress(a.address));
    if (list.length === 0 || bad) {
      return callback(
        Object.assign(new SsrfError('ssrf_private_connect', { host: hostname, address: bad?.address ?? '–' }), {
          code: 'ESSRF',
        }) as NodeJS.ErrnoException,
        '',
      );
    }
    if (options.all) {
      return callback(null, list);
    }
    callback(null, list[0].address, list[0].family);
  });
}

const agentOptions = { keepAlive: true, maxSockets: 16, lookup: guardedLookup as any };
const guardedAgents = { http: new http.Agent(agentOptions), https: new https.Agent(agentOptions) };
const openAgents = { http: new http.Agent({ keepAlive: true, maxSockets: 16 }), https: new https.Agent({ keepAlive: true, maxSockets: 16 }) };

const NULL_BODY = new Set([101, 103, 204, 205, 304]);

/**
 * Minimal fetch() on top of node:http(s) so the connect-time DNS lookup can be guarded (global fetch offers
 * no lookup hook without the undici package). GET/HEAD only, no automatic redirects, gzip/br/deflate decoded.
 */
export function nodeFetch(input: string | URL, init: RequestInit = {}, { allowPrivate = false } = {}): Promise<Response> {
  const url = new URL(input);
  const method = (init.method ?? 'GET').toUpperCase();
  if (init.body != null) {
    return Promise.reject(new Error('nodeFetch does not support a request body'));
  }
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, key) => {
    headers[key] = value;
  });
  headers['accept-encoding'] ??= 'gzip, deflate, br';
  const isHttps = url.protocol === 'https:';
  const agents = allowPrivate ? openAgents : guardedAgents;
  return new Promise<Response>((resolve, reject) => {
    const req = (isHttps ? https : http).request(
      url,
      { method, headers, agent: isHttps ? agents.https : agents.http, signal: init.signal ?? undefined },
      (res) => {
        const status = res.statusCode ?? 502;
        const out = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          if (value === undefined) continue;
          for (const v of Array.isArray(value) ? value : [value]) out.append(name, v);
        }
        let stream: Readable = res;
        const encoding = String(res.headers['content-encoding'] ?? '').toLowerCase();
        const decoder =
          encoding === 'gzip' || encoding === 'x-gzip'
            ? zlib.createGunzip()
            : encoding === 'br'
              ? zlib.createBrotliDecompress()
              : encoding === 'deflate'
                ? zlib.createInflate()
                : null;
        if (decoder) {
          out.delete('content-encoding');
          out.delete('content-length');
          res.on('error', (error) => decoder.destroy(error));
          stream = res.pipe(decoder);
        }
        const noBody = method === 'HEAD' || NULL_BODY.has(status);
        if (noBody) {
          res.resume();
        }
        try {
          const body = noBody ? null : (Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>);
          const response = new Response(body, { status: status < 200 || status > 599 ? 502 : status, statusText: res.statusMessage, headers: out });
          Object.defineProperty(response, 'url', { value: url.toString() });
          resolve(response);
        } catch (error) {
          res.destroy();
          reject(error);
        }
      },
    );
    req.on('error', (error) => {
      const cause = (error as { code?: string }).code === 'ESSRF' ? error : undefined;
      reject(cause ?? Object.assign(new Error('fetch failed', { cause: error })));
    });
    req.end();
  });
}

export interface SafeFetchOptions extends SsrfOptions {
  fetch?: FetchLike;
  /** Timeout until response headers arrive (body streaming is not limited). */
  timeoutMs: number;
  maxRedirects?: number;
}

/**
 * fetch() with SSRF checks on every hop (redirects are followed manually) and a header timeout.
 * The returned body is NOT subject to the timeout, so large media can stream.
 */
export async function safeFetch(
  input: string | URL,
  init: RequestInit & { signal?: AbortSignal } = {},
  options: SafeFetchOptions,
): Promise<Response> {
  const doFetch: FetchLike = options.fetch ?? ((u, i) => nodeFetch(u, i, { allowPrivate: options.allowPrivate }));
  let url = new URL(input);
  const maxRedirects = options.maxRedirects ?? 3;

  for (let hop = 0; ; hop++) {
    await assertSafeUrl(url, options);
    const controller = new AbortController();
    const onAbort = () => controller.abort(init.signal?.reason);
    init.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new LocalizedError('timeout', { ms: options.timeoutMs })),
      options.timeoutMs,
    );
    let response: Response;
    try {
      response = await doFetch(url, { ...init, redirect: 'manual', signal: controller.signal });
    } catch (error) {
      throw controller.signal.aborted && controller.signal.reason instanceof Error ? controller.signal.reason : error;
    } finally {
      clearTimeout(timer);
    }

    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel().catch(() => {});
      if (hop >= maxRedirects) {
        throw new LocalizedError('too_many_redirects');
      }
      url = new URL(location, url);
      continue;
    }
    return response;
  }
}
