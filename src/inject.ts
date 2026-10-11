import type { IncomingMessage } from 'node:http';

export const INJECT_TAG = '<script src="/federation/inject.js" defer></script>';

/** Insert the federation script into an HTML document (idempotent). */
export function injectScript(html: string, tag = INJECT_TAG): string {
  if (html.includes('/federation/inject.js')) {
    return html;
  }
  const head = html.search(/<\/head\s*>/i);
  if (head !== -1) {
    return html.slice(0, head) + tag + html.slice(head);
  }
  const body = html.search(/<\/body\s*>/i);
  if (body !== -1) {
    return html.slice(0, body) + tag + html.slice(body);
  }
  return html + tag;
}

/**
 * Is this request a page load of the Immich web app (so its HTML response should get the script)?
 * API calls, socket.io, assets of the web build and our own routes are excluded.
 */
export function isNavigationRequest(req: Pick<IncomingMessage, 'method' | 'url' | 'headers'>): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return false;
  }
  const path = (req.url ?? '/').split('?', 1)[0];
  if (
    path.startsWith('/api/') ||
    path === '/api' ||
    path.startsWith('/federation') ||
    path.startsWith('/_app/') ||
    path.startsWith('/.well-known/')
  ) {
    return false;
  }
  const dest = req.headers['sec-fetch-dest'];
  if (typeof dest === 'string' && dest && dest !== 'document' && dest !== 'iframe') {
    return false;
  }
  const accept = String(req.headers.accept ?? '');
  return accept.includes('text/html');
}

export function isHtmlResponse(contentType: string | string[] | undefined): boolean {
  const value = Array.isArray(contentType) ? contentType[0] : contentType;
  return typeof value === 'string' && /^\s*text\/html\b/i.test(value);
}
