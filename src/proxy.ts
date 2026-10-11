import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import type { Duplex } from 'node:stream';
import { injectScript, isHtmlResponse, isNavigationRequest } from './inject.ts';
import { logger } from './log.ts';

const log = logger('proxy');

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const MAX_HTML_BYTES = 8 * 1024 * 1024;

export interface ProxyOptions {
  upstream: URL;
}

function connectionTokens(headers: IncomingHttpHeaders): Set<string> {
  const value = headers.connection;
  const tokens = new Set<string>();
  for (const part of (Array.isArray(value) ? value.join(',') : (value ?? '')).split(',')) {
    const t = part.trim().toLowerCase();
    if (t) {
      tokens.add(t);
    }
  }
  return tokens;
}

/** Client IP etc. so Immich (with IMMICH_TRUSTED_PROXIES) sees the real client. */
function forwardedHeaders(req: IncomingMessage) {
  const remote = req.socket.remoteAddress ?? '';
  const prior = req.headers['x-forwarded-for'];
  const encrypted = (req.socket as { encrypted?: boolean }).encrypted;
  return {
    'x-forwarded-for': prior ? `${Array.isArray(prior) ? prior.join(', ') : prior}, ${remote}` : remote,
    'x-forwarded-proto': (req.headers['x-forwarded-proto'] as string) || (encrypted ? 'https' : 'http'),
    'x-forwarded-host': (req.headers['x-forwarded-host'] as string) || req.headers.host || '',
  };
}

export function upstreamHeaders(
  req: IncomingMessage,
  { keepUpgrade = false, html = false }: { keepUpgrade?: boolean; html?: boolean } = {},
): Record<string, string | string[]> {
  const drop = connectionTokens(req.headers);
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) {
      continue;
    }
    const lower = name.toLowerCase();
    if ((HOP_BY_HOP.has(lower) || drop.has(lower)) && !(keepUpgrade && (lower === 'upgrade' || lower === 'connection'))) {
      continue;
    }
    if (html && (lower === 'accept-encoding' || lower === 'if-none-match' || lower === 'if-modified-since')) {
      continue;
    }
    out[lower] = value;
  }
  Object.assign(out, forwardedHeaders(req));
  if (keepUpgrade) {
    out.connection = 'Upgrade';
    out.upgrade = (req.headers.upgrade as string) || 'websocket';
  }
  return out;
}

function responseRawHeaders(raw: string[], dropExtra: Set<string> = new Set()): string[] {
  // raw headers keep duplicates (Set-Cookie!) and original casing
  const connection = new Set<string>();
  for (let i = 0; i < raw.length; i += 2) {
    if (raw[i].toLowerCase() === 'connection') {
      for (const t of raw[i + 1].split(',')) {
        connection.add(t.trim().toLowerCase());
      }
    }
  }
  const out: string[] = [];
  for (let i = 0; i < raw.length; i += 2) {
    const lower = raw[i].toLowerCase();
    if (HOP_BY_HOP.has(lower) || connection.has(lower) || dropExtra.has(lower)) {
      continue;
    }
    out.push(raw[i], raw[i + 1]);
  }
  return out;
}

const reason = (res: IncomingMessage) => res.statusMessage || http.STATUS_CODES[res.statusCode ?? 502] || '';

export class Proxy {
  #upstream: URL;
  #agent: http.Agent;
  #module: typeof http | typeof https;

  constructor({ upstream }: ProxyOptions) {
    this.#upstream = upstream;
    this.#module = upstream.protocol === 'https:' ? https : http;
    this.#agent = new this.#module.Agent({ keepAlive: true, maxSockets: 512, keepAliveMsecs: 10_000 });
  }

  #requestOptions(req: IncomingMessage, headers: Record<string, string | string[]>, method = req.method, path = req.url) {
    return {
      protocol: this.#upstream.protocol,
      hostname: this.#upstream.hostname,
      port: this.#upstream.port || (this.#upstream.protocol === 'https:' ? 443 : 80),
      method,
      path,
      headers,
      agent: this.#agent,
    };
  }

  /** Streaming pass-through. Only page loads of the web app are buffered (to inject the script). */
  web(req: IncomingMessage, res: ServerResponse) {
    const html = isNavigationRequest(req);
    const upstreamReq = this.#module.request(this.#requestOptions(req, upstreamHeaders(req, { html })));
    upstreamReq.setTimeout(15 * 60_000, () => upstreamReq.destroy(new Error('upstream idle timeout')));

    upstreamReq.on('response', (upstreamRes) => {
      const status = upstreamRes.statusCode ?? 502;
      const encoding = upstreamRes.headers['content-encoding'];
      const rewrite =
        html &&
        status === 200 &&
        isHtmlResponse(upstreamRes.headers['content-type']) &&
        (!encoding || encoding === 'identity');

      if (!rewrite) {
        res.writeHead(status, reason(upstreamRes), responseRawHeaders(upstreamRes.rawHeaders) as any);
        upstreamRes.pipe(res);
        upstreamRes.on('error', () => res.destroy());
        return;
      }

      const drop = new Set(['content-length', 'etag', 'last-modified']);
      if (req.method === 'HEAD') {
        res.writeHead(status, reason(upstreamRes), responseRawHeaders(upstreamRes.rawHeaders, drop) as any);
        res.end();
        upstreamRes.resume();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let overflow = false;
      upstreamRes.on('data', (chunk: Buffer) => {
        if (overflow) {
          return;
        }
        size += chunk.length;
        chunks.push(chunk);
        if (size > MAX_HTML_BYTES) {
          // too big to be the SPA shell – give up rewriting and stream the rest unchanged
          overflow = true;
          upstreamRes.pause();
          res.writeHead(status, reason(upstreamRes), responseRawHeaders(upstreamRes.rawHeaders) as any);
          res.write(Buffer.concat(chunks));
          upstreamRes.pipe(res);
          upstreamRes.resume();
        }
      });
      upstreamRes.on('end', () => {
        if (overflow) {
          return;
        }
        const body = Buffer.from(injectScript(Buffer.concat(chunks).toString('utf8')), 'utf8');
        const headers = responseRawHeaders(upstreamRes.rawHeaders, drop);
        headers.push('Content-Length', String(body.length));
        res.writeHead(status, reason(upstreamRes), headers as any);
        res.end(body);
      });
      upstreamRes.on('error', () => res.destroy());
    });

    upstreamReq.on('error', (error) => {
      log.warn(`Upstream-Fehler ${req.method} ${req.url?.split('?')[0]}: ${error.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'Immich ist nicht erreichbar (Gateway)', statusCode: 502 }));
      } else {
        res.destroy();
      }
    });

    // client went away -> abort upstream
    res.on('close', () => {
      if (!res.writableFinished) {
        upstreamReq.destroy();
      }
    });
    req.pipe(upstreamReq);
  }

  /**
   * HEAD of `path` (a canonical path built by the caller, never the raw client path) with the client's
   * auth headers -> local Immich's status code and content type.
   */
  checkStatus(req: IncomingMessage, path: string, timeoutMs = 15_000): Promise<{ status: number; contentType: string }> {
    return new Promise((resolve, reject) => {
      const headers = upstreamHeaders(req);
      delete headers.range;
      delete headers['if-range'];
      delete headers['if-none-match'];
      delete headers['if-modified-since'];
      delete headers['content-length'];
      const check = this.#module.request(this.#requestOptions(req, headers, 'HEAD', path), (response) => {
        response.resume();
        resolve({ status: response.statusCode ?? 502, contentType: String(response.headers['content-type'] ?? '') });
      });
      check.setTimeout(timeoutMs, () => check.destroy(new Error('timeout')));
      check.on('error', reject);
      check.end();
    });
  }

  /** WebSocket (socket.io) upgrade pass-through. */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const upstreamReq = this.#module.request({
      ...this.#requestOptions(req, upstreamHeaders(req, { keepUpgrade: true })),
      agent: false,
    });
    const fail = (error?: Error) => {
      if (error) {
        log.debug(`WebSocket-Upstream-Fehler: ${error.message}`);
      }
      if (!socket.destroyed) {
        socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      }
    };
    upstreamReq.on('error', fail);
    socket.on('error', () => upstreamReq.destroy());

    upstreamReq.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
      let response = `HTTP/1.1 ${upstreamRes.statusCode} ${reason(upstreamRes)}\r\n`;
      const raw = upstreamRes.rawHeaders;
      for (let i = 0; i < raw.length; i += 2) {
        response += `${raw[i]}: ${raw[i + 1]}\r\n`;
      }
      socket.write(response + '\r\n');
      if (upstreamHead?.length) {
        socket.write(upstreamHead);
      }
      if (head?.length) {
        upstreamSocket.write(head);
      }
      upstreamSocket.on('error', () => socket.destroy());
      socket.on('error', () => upstreamSocket.destroy());
      upstreamSocket.on('close', () => socket.destroy());
      socket.on('close', () => upstreamSocket.destroy());
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
    });

    // upstream refused the upgrade (e.g. socket.io polling, 400, 401) -> relay the plain response
    upstreamReq.on('response', (upstreamRes) => {
      let response = `HTTP/1.1 ${upstreamRes.statusCode} ${reason(upstreamRes)}\r\n`;
      const raw = responseRawHeaders(upstreamRes.rawHeaders);
      for (let i = 0; i < raw.length; i += 2) {
        response += `${raw[i]}: ${raw[i + 1]}\r\n`;
      }
      socket.write(response + 'Connection: close\r\n\r\n');
      upstreamRes.pipe(socket);
    });

    upstreamReq.end();
  }

  close() {
    this.#agent.destroy();
  }
}
