import type { IncomingHttpHeaders } from 'node:http';
import { describeError } from './log.ts';

/**
 * Server-side translations for everything a user gets to see (API errors, link errors, sync log,
 * descriptions written into Immich). Server logs stay plain English and do not go through here.
 */

export const LANGS = ['en', 'de'] as const;
export type Lang = (typeof LANGS)[number];
export const DEFAULT_LANG: Lang = 'en';

/** Header the federation UI sends with the user's Immich language code. */
export const LANG_HEADER = 'x-federation-lang';

const en = {
  // API
  content_type_json: 'Content-Type application/json expected',
  request_too_large: 'Request too large',
  invalid_json: 'Invalid JSON',
  cross_origin_rejected: 'Cross-origin request rejected',
  not_logged_in: 'Not logged in',
  link_not_found: 'Link not found',
  unknown_endpoint: 'Unknown endpoint',
  internal_error: 'Internal error in the federation gateway',
  share_url_missing: 'shareUrl missing',
  share_link_empty: 'The share link contains no media',
  album_already_connected: 'This album is already connected ({name})',
  not_federated: 'Not federated',
  // local Immich
  immich_session_expired: 'Not logged in – please sign in to the Immich web app again',
  immich_forbidden: 'Immich denied access (403)',
  immich_not_found: 'Not found in Immich (404)',
  immich_unavailable: 'Immich is currently unreachable ({status})',
  immich_unavailable_network: 'Immich is currently unreachable (network)',
  immich_rejected: 'Immich rejected the request ({status})',
  api_key_create_failed:
    'Could not create an API key for syncing. Please connect while signed in normally to the Immich web app',
  immich_unreachable_gateway: 'Immich is unreachable (gateway)',
  gateway_error: 'Gateway error',
  // share links
  share_url_empty: 'No share link given',
  share_url_invalid: 'Invalid URL',
  share_url_protocol: 'Only http(s) links are supported',
  share_url_credentials: 'Links with credentials in the URL are not supported',
  share_url_not_immich: 'This is not an Immich share link (expected …/share/<key> or …/s/<slug>)',
  // remote server / SSRF
  ssrf_protocol: 'Protocol {protocol} is not allowed',
  ssrf_credentials: 'Credentials in URLs are not allowed',
  ssrf_unresolvable: 'Host {host} cannot be resolved',
  ssrf_private: 'Host {host} points to a private address ({address}). Set ALLOW_PRIVATE_REMOTES=true for LAN servers.',
  ssrf_private_connect: 'Host {host} points to a private address ({address})',
  timeout: 'Timed out after {ms} ms',
  too_many_redirects: 'Too many redirects',
  remote_password: 'The share link is password-protected – that is not supported',
  remote_link_invalid: 'Share link invalid, expired or revoked{suffix}',
  remote_not_found: 'Not found on the remote server{suffix}',
  remote_http: 'Remote server responded with HTTP {status}{suffix}',
  // sync
  api_key_invalid: "Gateway API key invalid – open the federation page once and it will be renewed: {detail}",
  no_api_key: 'No API key stored for this user – please reconnect the link',
  sync_failed: 'Sync failed: {detail}',
  sync_done: 'Sync finished in {seconds} s: +{added} / -{removed}',
  sync_done_errors: 'Sync finished in {seconds} s: +{added} / -{removed}, {errors} errors',
  items_failed: '{count} item(s) failed, e.g.: {example}',
  album_recreated: 'Local album was missing and has been recreated',
  copies_not_deleted: '{count} local copies could not be deleted (locked folder?)',
  connected_by: 'Connected by {email}',
  download_video_failed: 'Video download -> HTTP {status}',
  download_preview_failed: 'Preview download -> HTTP {status}',
  file_too_large: 'File too large ({mb} MB) – skipped',
  file_exceeds_limit: 'File larger than {mb} MB – skipped',
  empty_response: 'Empty response',
  ffmpeg_failed: 'ffmpeg failed ({code}): {detail}',
  // written into Immich
  default_album_name: 'Federated album',
  federated_from: 'Federated from {host}',
  federated_from_album_owner: 'Federated from {host} ({owner})',
  federated_from_asset_owner: 'Federated from {host} · {owner}',
};

export type MessageKey = keyof typeof en;

const de: Record<MessageKey, string> = {
  // API
  content_type_json: 'Content-Type application/json erwartet',
  request_too_large: 'Anfrage zu groß',
  invalid_json: 'Ungültiges JSON',
  cross_origin_rejected: 'Cross-Origin-Anfrage abgelehnt',
  not_logged_in: 'Nicht angemeldet',
  link_not_found: 'Verknüpfung nicht gefunden',
  unknown_endpoint: 'Unbekannter Endpunkt',
  internal_error: 'Interner Fehler im Föderations-Gateway',
  share_url_missing: 'shareUrl fehlt',
  share_link_empty: 'Der Freigabelink enthält keine Medien',
  album_already_connected: 'Dieses Album ist bereits verbunden ({name})',
  not_federated: 'Nicht föderiert',
  // local Immich
  immich_session_expired: 'Nicht angemeldet – bitte im Immich-Web neu anmelden',
  immich_forbidden: 'Immich verweigert den Zugriff (403)',
  immich_not_found: 'In Immich nicht gefunden (404)',
  immich_unavailable: 'Immich ist gerade nicht erreichbar ({status})',
  immich_unavailable_network: 'Immich ist gerade nicht erreichbar (Netzwerk)',
  immich_rejected: 'Immich hat die Anfrage abgelehnt ({status})',
  api_key_create_failed:
    'Konnte keinen API-Schlüssel für die Synchronisation anlegen. Bitte normal im Immich-Web angemeldet verbinden',
  immich_unreachable_gateway: 'Immich ist nicht erreichbar (Gateway)',
  gateway_error: 'Gateway-Fehler',
  // share links
  share_url_empty: 'Kein Freigabelink angegeben',
  share_url_invalid: 'Ungültige URL',
  share_url_protocol: 'Nur http(s)-Links werden unterstützt',
  share_url_credentials: 'Links mit Zugangsdaten in der URL werden nicht unterstützt',
  share_url_not_immich: 'Das ist kein Immich-Freigabelink (erwartet …/share/<schlüssel> oder …/s/<slug>)',
  // remote server / SSRF
  ssrf_protocol: 'Protokoll {protocol} ist nicht erlaubt',
  ssrf_credentials: 'Zugangsdaten in URLs sind nicht erlaubt',
  ssrf_unresolvable: 'Host {host} kann nicht aufgelöst werden',
  ssrf_private:
    'Host {host} zeigt auf eine private Adresse ({address}). Für LAN-Server ALLOW_PRIVATE_REMOTES=true setzen.',
  ssrf_private_connect: 'Host {host} zeigt auf eine private Adresse ({address})',
  timeout: 'Zeitüberschreitung nach {ms} ms',
  too_many_redirects: 'Zu viele Weiterleitungen',
  remote_password: 'Der Freigabelink ist passwortgeschützt – das wird nicht unterstützt',
  remote_link_invalid: 'Freigabelink ungültig, abgelaufen oder widerrufen{suffix}',
  remote_not_found: 'Nicht gefunden auf dem entfernten Server{suffix}',
  remote_http: 'Entfernter Server antwortete mit HTTP {status}{suffix}',
  // sync
  api_key_invalid: 'API-Schlüssel des Gateways ungültig – Föderationsseite einmal öffnen, dann wird er erneuert: {detail}',
  no_api_key: 'Kein API-Schlüssel für diesen Benutzer gespeichert – Link bitte neu verbinden',
  sync_failed: 'Synchronisation fehlgeschlagen: {detail}',
  sync_done: 'Sync fertig in {seconds} s: +{added} / -{removed}',
  sync_done_errors: 'Sync fertig in {seconds} s: +{added} / -{removed}, {errors} Fehler',
  items_failed: '{count} Element(e) fehlgeschlagen, z.B.: {example}',
  album_recreated: 'Lokales Album fehlte und wurde neu angelegt',
  copies_not_deleted: '{count} lokale Kopie(n) konnten nicht gelöscht werden (gesperrter Ordner?)',
  connected_by: 'Verbunden durch {email}',
  download_video_failed: 'Download Video -> HTTP {status}',
  download_preview_failed: 'Download Vorschau -> HTTP {status}',
  file_too_large: 'Datei zu groß ({mb} MB) – übersprungen',
  file_exceeds_limit: 'Datei größer als {mb} MB – übersprungen',
  empty_response: 'Leere Antwort',
  ffmpeg_failed: 'ffmpeg fehlgeschlagen ({code}): {detail}',
  // written into Immich
  default_album_name: 'Föderiertes Album',
  federated_from: 'Föderiert von {host}',
  federated_from_album_owner: 'Föderiert von {host} ({owner})',
  federated_from_asset_owner: 'Föderiert von {host} · {owner}',
};

export const catalogs: Record<Lang, Record<MessageKey, string>> = { en, de };

/** Immich locale codes that are German dialects without their own "de-…" prefix. */
const ALIASES: Record<string, Lang> = { gsw: 'de', swg: 'de' };

/** Supported language for a code (`de-CH`, `de_CH`, `gsw` -> de), or undefined if none matches. */
export function matchLang(code: string | null | undefined): Lang | undefined {
  const normalized = String(code ?? '').trim().toLowerCase().replace(/_/g, '-');
  if (!normalized) {
    return undefined;
  }
  const primary = normalized.split('-')[0];
  for (const candidate of [normalized, primary]) {
    if ((LANGS as readonly string[]).includes(candidate)) {
      return candidate as Lang;
    }
    if (ALIASES[candidate]) {
      return ALIASES[candidate];
    }
  }
  return undefined;
}

export function resolveLang(code: string | null | undefined): Lang {
  return matchLang(code) ?? DEFAULT_LANG;
}

/** First supported entry of an Accept-Language header (by q-value), if any. */
export function acceptLanguage(header: string | null | undefined): Lang | undefined {
  const entries = String(header ?? '')
    .split(',')
    .map((part, index) => {
      const [tag, ...attrs] = part.trim().split(';');
      const q = attrs.map((a) => /^\s*q=([\d.]+)\s*$/.exec(a)?.[1]).find(Boolean);
      return { tag: tag.trim(), q: q === undefined ? 1 : Number(q), index };
    })
    .filter((e) => e.tag && e.tag !== '*' && e.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index);
  for (const { tag } of entries) {
    const lang = matchLang(tag);
    if (lang) {
      return lang;
    }
  }
  return undefined;
}

/** Request language: X-Federation-Lang (the user's Immich setting) -> Accept-Language -> English. */
export function requestLang(headers: IncomingHttpHeaders): Lang {
  const header = headers[LANG_HEADER];
  const explicit = Array.isArray(header) ? header[0] : header;
  if (explicit && explicit.trim()) {
    return resolveLang(explicit);
  }
  const accept = headers['accept-language'];
  return acceptLanguage(Array.isArray(accept) ? accept.join(',') : accept) ?? DEFAULT_LANG;
}

// ---------------- messages ----------------

/** A translatable message; params may themselves be messages (e.g. the cause of a sync failure). */
export interface Msg {
  $t: MessageKey;
  p?: Params;
}
export type Param = string | number | Msg;
export type Params = Record<string, Param>;

export function msg(key: MessageKey, params?: Params): Msg {
  return params && Object.keys(params).length > 0 ? { $t: key, p: params } : { $t: key };
}

const isMsg = (value: unknown): value is Msg =>
  !!value && typeof value === 'object' && typeof (value as Msg).$t === 'string';

export function t(lang: Lang, key: MessageKey, params: Params = {}): string {
  const template = catalogs[lang]?.[key] ?? catalogs[DEFAULT_LANG][key] ?? String(key);
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = params[name];
    return value === undefined || value === null ? '' : format(lang, value);
  });
}

/** Format a message object or pass a plain (untranslated) string through. */
export function format(lang: Lang, value: Param): string {
  return isMsg(value) ? t(lang, value.$t, value.p) : String(value);
}

/** Error whose `.message` is English (for logs) and that can be re-rendered in any language. */
export class LocalizedError extends Error {
  key: MessageKey;
  params: Params;
  constructor(key: MessageKey, params: Params = {}, options?: ErrorOptions) {
    super(t('en', key, params), options);
    this.key = key;
    this.params = params;
  }

  toMsg(): Msg {
    return msg(this.key, this.params);
  }
}

/** Localizable description of any error: LocalizedErrors stay translatable, others become their (technical) text. */
export function errorParam(error: unknown): Param {
  return error instanceof LocalizedError ? error.toMsg() : describeError(error);
}

// ---------------- stored messages ----------------

const MAX_PARAM_LENGTH = 1000;

const trimParams = (params: Params): Params =>
  Object.fromEntries(
    Object.entries(params).map(([k, v]) => [
      k,
      typeof v === 'string' && v.length > MAX_PARAM_LENGTH
        ? v.slice(0, MAX_PARAM_LENGTH) + '…'
        : isMsg(v) && v.p
          ? { ...v, p: trimParams(v.p) }
          : v,
    ]),
  );

/**
 * Encode a message for the database (link lastError, sync_log) as a JSON marker `{"$t":"key","p":{…}}`,
 * so it can be translated when read. Plain strings are stored unchanged.
 */
export function encodeStored(value: Msg | string): string {
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value.p ? { $t: value.$t, p: trimParams(value.p) } : { $t: value.$t });
}

/** Parse a stored marker; undefined for plain (e.g. legacy German) text. */
export function decodeStored(value: string | null | undefined): Msg | undefined {
  if (!value || !value.startsWith('{"$t":')) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value);
    return isMsg(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Translate a stored value in `lang`; values that are not markers (legacy rows) are returned as-is. */
export function localizeStored(value: string, lang: Lang): string;
export function localizeStored(value: string | null, lang: Lang): string | null;
export function localizeStored(value: string | null, lang: Lang): string | null {
  if (value === null) {
    return null;
  }
  const decoded = decodeStored(value);
  return decoded ? format(lang, decoded) : value;
}

/**
 * Does a stored value represent message `key`? Matches markers by key and legacy plain-text rows
 * (written in German before i18n) by the German text in front of the first placeholder.
 */
export function storedIs(value: string | null | undefined, key: MessageKey): boolean {
  if (!value) {
    return false;
  }
  const decoded = decodeStored(value);
  if (decoded) {
    return decoded.$t === key;
  }
  const prefix = catalogs.de[key].split('{')[0].replace(/[:\s]+$/, '');
  return prefix.length > 0 && value.startsWith(prefix);
}
