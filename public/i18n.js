/*
 * immich-federation – i18n.js
 * Tiny, dependency-free translation helper shared by inject.js (inside the Immich web app) and the
 * /federation/ page (ui.js). Exposes window.__ifedI18n.
 *
 * The language follows the user's Immich setting (same origin, so the same localStorage):
 *  - localStorage "lang":   UI language chosen in Immich (e.g. "de", "en", "de-CH", "pt_BR"; "dev" = en).
 *                           Missing → Immich uses the browser languages (navigator.languages).
 *  - localStorage "locale": formatting locale for dates/numbers ("default" or a BCP 47 tag).
 * Both are re-read lazily (cheap; cached per raw value), so a language change in Immich's settings is picked up
 * on the next render without a reload.
 *
 * Adding a language: add one object to CATALOGS (missing keys fall back to English per key).
 * Message syntax: "{name}" placeholders; plurals as { one: '…', other: '…' } (selected via Intl.PluralRules
 * with params.count; "{count}" is formatted as a number).
 */
(function () {
  'use strict';

  if (window.__ifedI18n) return;

  var FALLBACK = 'en';
  var ALIASES = { gsw: 'de', swg: 'de', dev: 'en' };

  var CATALOGS = {
    en: {
      // common
      'common.federation': 'Federation',
      'common.cancel': 'Cancel',
      'common.close': 'Close',
      'common.connect': 'Connect',
      'common.connecting': 'Connecting …',
      'common.disconnect': 'Disconnect',
      'common.disconnecting': 'Disconnecting …',
      'common.syncNow': 'Sync now',
      'common.syncing': 'Syncing …',
      'common.syncingProgress': 'Syncing … {done} / {total}',
      'common.toLogin': 'Log in',
      'common.loading': 'Loading …',
      'common.openAlbum': 'Open album',
      'common.thisServer': 'this server',
      'common.confirmDisconnect': 'Confirm disconnect',
      'time.justNow': 'just now',

      // errors
      'error.unknown': 'Unknown error.',
      'error.login': 'Please log in to Immich.',
      'error.unreachable': 'Gateway unreachable. Please check your connection.',
      'error.http': 'Error (HTTP {status}).',

      // connect form / modal
      'connect.title': 'Connect federated album',
      'connect.description':
        "Paste the share link of an album from another Immich server. Thumbnails, metadata and search indexes are created locally; originals are only loaded from the other server when you open them.",
      'connect.shareLink': 'Share link',
      'connect.placeholder': 'https://photos.example.org/share/…',
      'connect.shareHint': 'The other person creates this link in their Immich via "Share → Create link" on the album.',
      'connect.showInTimeline': 'Show in timeline',
      'connect.showInTimelineHint': 'Off: photos only appear in the album (archived).',
      'connect.importVideos': 'Import videos',
      'connect.importVideosHint': 'Each video is downloaded in full once and downscaled. Off: photos only.',
      'connect.invalidUrl': 'Please paste a complete share link (starting with https:// or http://).',
      'connect.notShareLink':
        "This doesn't look like an Immich share link. Expected …/share/<key> or …/s/<name>.",
      'connect.success': 'Connected – syncing runs in the background.',

      // injected into the Immich web app
      'nav.manageTitle': 'Manage federated albums',
      'albums.federatedFrom': 'Federated from {host}',
      'albums.federated': 'Federated',
      'banner.label': 'Federated album',
      'banner.federatedFrom': 'Federated from {host}',
      'banner.unknownServer': 'an unknown server',
      'banner.lastSynced': 'last synced {time}',
      'banner.neverSynced': 'not synced yet',
      'banner.items': { one: '{count} item', other: '{count} items' },
      'banner.noVideos': 'without videos',
      'banner.originalsBlocked': 'originals not shared',
      'banner.originalsBlockedTitle': "The other server doesn't allow downloads – the local preview is shown.",
      'banner.zipHint':
        'Note: a ZIP download (whole album or multi-select) only contains the local preview copies – download originals one by one.',
      'banner.lastSyncError': 'Last sync failed: {error}',
      'banner.syncDone': 'Sync complete.',
      'banner.refreshView': 'Refresh view',
      'banner.manage': 'Manage',
      'banner.manageTitle': 'Manage federation',
      'banner.confirmQuestion': 'Really disconnect from {host}?',
      'banner.deleteLocal': 'Delete album and local copies',
      'asset.originalOn': 'Original is stored on {host}',
      'asset.anotherServer': 'another server',
      'asset.sharedBy': 'Shared by {name}',
      'asset.downloadBlocked': 'Download not allowed – the local preview is shown.',
      'asset.localInfo': 'Preview, metadata and search are local; the original is loaded on demand.',

      // /federation/ page
      'page.title': 'Federation · Immich',
      'page.skip': 'Skip to content',
      'page.backToImmich': 'Back to Immich',
      'page.heading': 'Federated albums',
      'page.lead':
        "Connect albums from your friends' Immich servers to your own Immich. Thumbnails, metadata and all search indexes (smart search, faces, text recognition) are stored locally; the original is only loaded from the other server when you open it.",
      'page.authTitle': 'Please log in to Immich',
      'page.authText': 'This page uses your Immich login.',
      'page.connectTitle': 'Connect album',
      'page.linksTitle': 'Connected albums',
      'page.reload': 'Refresh',
      'page.reloadTitle': 'Refresh list',
      'page.openImmich': 'Open Immich',
      'page.empty': 'No federated albums yet. Paste a share link above.',
      'status.error': 'Error',
      'status.upToDate': 'Up to date',
      'status.pending': 'Pending',
      'link.inTimeline': 'In timeline',
      'link.albumOnly': 'Album only',
      'link.noVideos': 'No videos',
      'link.originalsLocked': 'Originals locked',
      'link.originalsLockedTitle': "The other server doesn't allow downloads – the local previews are shown.",
      'link.items': 'Items',
      'link.lastSynced': 'Last synced',
      'link.server': 'Server',
      'link.owner': 'Owner',
      'link.never': 'never',
      'link.unknownServer': 'unknown server',
      'link.unnamed': 'Unnamed album',
      'link.albumFallback': 'Album',
      'link.lastError': 'Last error: {error}',
      'link.confirmQuestion': 'Disconnect "{name}" from {host}?',
      'link.deleteLocal': 'Delete local album and local copies',
      'link.confirmYes': 'Yes, disconnect',
      'link.disconnectedDeleted': '"{name}" was disconnected and deleted locally.',
      'link.disconnectedKept': '"{name}" was disconnected. The local copies are kept.',
    },

    de: {
      'common.federation': 'Föderation',
      'common.cancel': 'Abbrechen',
      'common.close': 'Schließen',
      'common.connect': 'Verbinden',
      'common.connecting': 'Verbinde …',
      'common.disconnect': 'Trennen',
      'common.disconnecting': 'Trenne …',
      'common.syncNow': 'Jetzt synchronisieren',
      'common.syncing': 'Synchronisiere …',
      'common.syncingProgress': 'Synchronisiere … {done} / {total}',
      'common.toLogin': 'Zur Anmeldung',
      'common.loading': 'Lade …',
      'common.openAlbum': 'Album öffnen',
      'common.thisServer': 'diesem Server',
      'common.confirmDisconnect': 'Trennen bestätigen',
      'time.justNow': 'gerade eben',

      'error.unknown': 'Unbekannter Fehler.',
      'error.login': 'Bitte in Immich anmelden.',
      'error.unreachable': 'Gateway nicht erreichbar. Bitte Verbindung prüfen.',
      'error.http': 'Fehler (HTTP {status}).',

      'connect.title': 'Föderiertes Album verbinden',
      'connect.description':
        'Füge den Freigabe-Link eines Albums von einem anderen Immich-Server ein. Vorschaubilder, Metadaten und Suchindizes werden lokal angelegt; Originale werden erst beim Öffnen vom anderen Server geladen.',
      'connect.shareLink': 'Freigabe-Link',
      'connect.placeholder': 'https://fotos.example.org/share/…',
      'connect.shareHint': 'Den Link erstellt die andere Person in ihrem Immich unter „Album teilen → Link erstellen“.',
      'connect.showInTimeline': 'In Zeitleiste anzeigen',
      'connect.showInTimelineHint': 'Aus: Fotos erscheinen nur im Album (archiviert).',
      'connect.importVideos': 'Videos importieren',
      'connect.importVideosHint': 'Dafür wird jedes Video einmal ganz geladen und verkleinert. Aus: nur Fotos.',
      'connect.invalidUrl': 'Bitte einen vollständigen Freigabe-Link einfügen (beginnt mit https:// oder http://).',
      'connect.notShareLink':
        'Das sieht nicht nach einem Immich-Freigabe-Link aus. Erwartet wird …/share/<Schlüssel> oder …/s/<Name>.',
      'connect.success': 'Verbunden – die Synchronisierung läuft im Hintergrund.',

      'nav.manageTitle': 'Föderierte Alben verwalten',
      'albums.federatedFrom': 'Föderiert von {host}',
      'albums.federated': 'Föderiert',
      'banner.label': 'Föderiertes Album',
      'banner.federatedFrom': 'Föderiert von {host}',
      'banner.unknownServer': 'unbekanntem Server',
      'banner.lastSynced': 'zuletzt synchronisiert {time}',
      'banner.neverSynced': 'noch nicht synchronisiert',
      'banner.items': { one: '{count} Eintrag', other: '{count} Einträge' },
      'banner.noVideos': 'ohne Videos',
      'banner.originalsBlocked': 'Originale nicht freigegeben',
      'banner.originalsBlockedTitle': 'Der andere Server erlaubt keinen Download – es wird die lokale Vorschau angezeigt.',
      'banner.zipHint':
        'Hinweis: Ein ZIP-Download (ganzes Album oder Mehrfachauswahl) enthält nur die lokalen Vorschau-Kopien – Originale einzeln herunterladen.',
      'banner.lastSyncError': 'Fehler bei der letzten Synchronisierung: {error}',
      'banner.syncDone': 'Synchronisierung abgeschlossen.',
      'banner.refreshView': 'Ansicht aktualisieren',
      'banner.manage': 'Verwalten',
      'banner.manageTitle': 'Föderation verwalten',
      'banner.confirmQuestion': 'Verbindung zu {host} wirklich trennen?',
      'banner.deleteLocal': 'Album und lokale Kopien löschen',
      'asset.originalOn': 'Original liegt auf {host}',
      'asset.anotherServer': 'einem anderen Server',
      'asset.sharedBy': 'Geteilt von {name}',
      'asset.downloadBlocked': 'Download nicht freigegeben – angezeigt wird die lokale Vorschau.',
      'asset.localInfo': 'Vorschau, Metadaten und Suche sind lokal; das Original wird bei Bedarf geladen.',

      'page.title': 'Föderation · Immich',
      'page.skip': 'Zum Inhalt springen',
      'page.backToImmich': 'Zurück zu Immich',
      'page.heading': 'Föderierte Alben',
      'page.lead':
        'Verbinde Alben von Immich-Servern deiner Freunde mit deinem eigenen Immich. Vorschaubilder, Metadaten und alle Suchindizes (Smart Search, Gesichter, Texterkennung) liegen lokal; das Original wird erst beim Öffnen vom anderen Server geladen.',
      'page.authTitle': 'Bitte in Immich anmelden',
      'page.authText': 'Diese Seite nutzt deine Immich-Anmeldung.',
      'page.connectTitle': 'Album verbinden',
      'page.linksTitle': 'Verbundene Alben',
      'page.reload': 'Aktualisieren',
      'page.reloadTitle': 'Liste aktualisieren',
      'page.openImmich': 'Immich öffnen',
      'page.empty': 'Noch keine föderierten Alben. Füge oben einen Freigabe-Link ein.',
      'status.error': 'Fehler',
      'status.upToDate': 'Aktuell',
      'status.pending': 'Ausstehend',
      'link.inTimeline': 'In Zeitleiste',
      'link.albumOnly': 'Nur im Album',
      'link.noVideos': 'Ohne Videos',
      'link.originalsLocked': 'Originale gesperrt',
      'link.originalsLockedTitle': 'Der andere Server erlaubt keinen Download – es werden die lokalen Vorschauen angezeigt.',
      'link.items': 'Einträge',
      'link.lastSynced': 'Zuletzt synchronisiert',
      'link.server': 'Server',
      'link.owner': 'Besitzer',
      'link.never': 'noch nie',
      'link.unknownServer': 'unbekannter Server',
      'link.unnamed': 'Unbenanntes Album',
      'link.albumFallback': 'Album',
      'link.lastError': 'Letzter Fehler: {error}',
      'link.confirmQuestion': '„{name}“ von {host} trennen?',
      'link.deleteLocal': 'Lokales Album und lokale Kopien löschen',
      'link.confirmYes': 'Ja, trennen',
      'link.disconnectedDeleted': '„{name}“ wurde getrennt und lokal gelöscht.',
      'link.disconnectedKept': '„{name}“ wurde getrennt. Die lokalen Kopien bleiben erhalten.',
    },
  };

  // --- Language resolution ---------------------------------------------------------------------------

  function readStore(key) {
    var v = null;
    try {
      v = window.localStorage.getItem(key);
    } catch (e) {
      return null;
    }
    if (typeof v !== 'string') return null;
    v = v.trim();
    // Immich stores the raw string, but tolerate a JSON-quoted value
    if (v.length >= 2 && v.charAt(0) === '"' && v.charAt(v.length - 1) === '"') v = v.slice(1, -1).trim();
    return v || null;
  }

  function normalize(tag) {
    return String(tag || '')
      .trim()
      .toLowerCase()
      .replace(/_/g, '-');
  }

  /** Maps any language tag to a supported language: full match, primary subtag, alias; otherwise the fallback. */
  function resolve(tag) {
    var n = normalize(tag);
    if (!n) return FALLBACK;
    if (Object.prototype.hasOwnProperty.call(CATALOGS, n)) return n;
    if (Object.prototype.hasOwnProperty.call(ALIASES, n)) return ALIASES[n];
    var primary = n.split('-')[0];
    if (Object.prototype.hasOwnProperty.call(CATALOGS, primary)) return primary;
    if (Object.prototype.hasOwnProperty.call(ALIASES, primary)) return ALIASES[primary];
    return FALLBACK;
  }

  function browserLanguage() {
    try {
      var nav = window.navigator || {};
      if (nav.languages && nav.languages.length) return String(nav.languages[0]);
      return nav.language ? String(nav.language) : null;
    } catch (e) {
      return null;
    }
  }

  var cache = { key: null, lang: FALLBACK, locale: undefined };

  /** Re-reads the Immich settings; cheap because the result is cached per raw value. */
  function current() {
    var rawLang = readStore('lang');
    var rawLocale = readStore('locale');
    var browser = rawLang && rawLocale ? null : browserLanguage();
    var key = rawLang + '|' + rawLocale + '|' + browser;
    if (key === cache.key) return cache;
    // Like Immich: an explicit setting wins, otherwise the first browser language.
    var lang = resolve(rawLang || browser);
    var locale;
    if (rawLocale && rawLocale.toLowerCase() !== 'default') {
      locale = rawLocale.replace(/_/g, '-');
      try {
        locale = Intl.getCanonicalLocales(locale)[0];
      } catch (e) {
        locale = undefined;
      }
    }
    // "default" in Immich means the browser's formatting locale
    if (!locale) locale = browser || undefined;
    cache = { key: key, lang: lang, locale: locale };
    return cache;
  }

  // --- Formatting --------------------------------------------------------------------------------------

  var pluralRules = {};
  function pluralCategory(lang, n) {
    try {
      if (!pluralRules[lang]) pluralRules[lang] = new Intl.PluralRules(lang);
      return pluralRules[lang].select(n);
    } catch (e) {
      return n === 1 ? 'one' : 'other';
    }
  }

  function formatNumber(n) {
    if (typeof n !== 'number' || !isFinite(n)) return String(n);
    var c = current();
    try {
      return new Intl.NumberFormat(c.locale || c.lang).format(n);
    } catch (e) {
      return String(n);
    }
  }

  function lookup(lang, key) {
    var cat = CATALOGS[lang];
    if (cat && Object.prototype.hasOwnProperty.call(cat, key)) return cat[key];
    cat = CATALOGS[FALLBACK];
    if (Object.prototype.hasOwnProperty.call(cat, key)) return cat[key];
    return null;
  }

  function pick(lang, key, params) {
    var msg = lookup(lang, key);
    if (msg === null) return key;
    if (typeof msg === 'object') {
      var n = params && typeof params.count === 'number' ? params.count : 0;
      msg = msg[pluralCategory(lang, n)] || msg.other || '';
    }
    return String(msg);
  }

  function paramValue(params, name) {
    var v = params[name];
    if (name === 'count' && typeof v === 'number') return formatNumber(v);
    return v;
  }

  /** Translate a key; "{name}" placeholders are replaced by params (unknown placeholders stay as they are). */
  function t(key, params) {
    var msg = pick(current().lang, key, params);
    if (!params) return msg;
    return msg.replace(/\{(\w+)\}/g, function (m, name) {
      if (!Object.prototype.hasOwnProperty.call(params, name)) return m;
      var v = paramValue(params, name);
      return v === undefined || v === null ? '' : String(v);
    });
  }

  /**
   * Like t(), but returns an array of parts so params can be DOM nodes (e.g. a <b> host name):
   * strings for text, the param value itself for non-string params.
   */
  function parts(key, params) {
    var msg = pick(current().lang, key, params);
    var out = [];
    var re = /\{(\w+)\}/g;
    var last = 0;
    var m;
    while ((m = re.exec(msg))) {
      if (!params || !Object.prototype.hasOwnProperty.call(params, m[1])) continue;
      if (m.index > last) out.push(msg.slice(last, m.index));
      var v = paramValue(params, m[1]);
      if (v !== undefined && v !== null) out.push(typeof v === 'object' ? v : String(v));
      last = re.lastIndex;
    }
    if (last < msg.length) out.push(msg.slice(last));
    return out;
  }

  function toDate(value) {
    if (value === undefined || value === null || value === '') return null;
    var d = value instanceof Date ? value : new Date(value);
    return isFinite(d.getTime()) ? d : null;
  }

  /** Absolute date + time in the Immich formatting locale. */
  function formatDateTime(value) {
    var d = toDate(value);
    if (!d) return '';
    var c = current();
    try {
      return d.toLocaleString(c.locale || c.lang, { dateStyle: 'medium', timeStyle: 'short' });
    } catch (e) {
      return d.toISOString();
    }
  }

  /** Long date (e.g. "12 October 2026" / "12. Oktober 2026"). */
  function formatDate(value) {
    var d = toDate(value);
    if (!d) return '';
    var c = current();
    try {
      return d.toLocaleDateString(c.locale || c.lang, { day: 'numeric', month: 'long', year: 'numeric' });
    } catch (e) {
      return d.toISOString().slice(0, 10);
    }
  }

  var rtfCache = {};
  /** Relative time in the UI language ("5 minutes ago" / "vor 5 Minuten"); older than ~30 days → long date. */
  function relativeTime(value) {
    var d = toDate(value);
    if (!d) return null;
    var lang = current().lang;
    var diff = (d.getTime() - Date.now()) / 1000;
    var abs = Math.abs(diff);
    if (abs < 45) return t('time.justNow');
    if (abs >= 86400 * 30) return formatDate(d);
    var rtf = rtfCache[lang];
    if (rtf === undefined) {
      try {
        rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
      } catch (e) {
        rtf = null;
      }
      rtfCache[lang] = rtf;
    }
    if (!rtf) return formatDateTime(d);
    if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
    if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
    return rtf.format(Math.round(diff / 86400), 'day');
  }

  // --- Change notification -------------------------------------------------------------------------------

  var listeners = [];
  var lastNotified = null;
  function checkChange() {
    var lang = current().lang;
    if (lastNotified === null) lastNotified = lang;
    if (lang === lastNotified) return;
    lastNotified = lang;
    for (var i = 0; i < listeners.length; i++) {
      try {
        listeners[i](lang);
      } catch (e) {
        /* ignore */
      }
    }
  }
  try {
    // Language changed in another tab (same tab: callers re-check lazily on their next render)
    window.addEventListener('storage', function (e) {
      if (!e.key || e.key === 'lang' || e.key === 'locale') {
        cache.key = null;
        checkChange();
      }
    });
    window.addEventListener('languagechange', checkChange);
  } catch (e) {
    /* ignore */
  }

  window.__ifedI18n = {
    /** Supported languages (keys of the catalogs). */
    languages: Object.keys(CATALOGS),
    catalogs: CATALOGS,
    /** Resolved UI language ("en" | "de"), re-evaluated lazily. */
    lang: function () {
      return current().lang;
    },
    /** Formatting locale for dates/numbers (Immich "locale" setting, else browser default). */
    locale: function () {
      return current().locale;
    },
    resolve: resolve,
    t: t,
    parts: parts,
    has: function (key) {
      return lookup(current().lang, key) !== null;
    },
    formatNumber: formatNumber,
    formatDate: formatDate,
    formatDateTime: formatDateTime,
    relativeTime: relativeTime,
    /** Header object for gateway API requests. */
    headers: function () {
      return { 'X-Federation-Lang': current().lang };
    },
    /** fn(lang) on a language change detected via the storage/languagechange events or check(). */
    onChange: function (fn) {
      if (typeof fn === 'function') listeners.push(fn);
      if (lastNotified === null) lastNotified = current().lang;
    },
    /** Re-check the language now and notify listeners if it changed. */
    check: checkChange,
  };
})();
