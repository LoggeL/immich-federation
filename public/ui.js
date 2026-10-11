/* immich-federation – Verwaltungsseite /federation/ (Vanilla JS, kein Build-Schritt) */
(function () {
  'use strict';

  // --- Theme: Immichs gespeicherte Einstellung (localStorage "immich-ui-theme") hat Vorrang ---------
  (function applyTheme() {
    var pref = null;
    try {
      pref = JSON.parse(localStorage.getItem('immich-ui-theme'));
    } catch (e) {
      pref = null;
    }
    if (pref && typeof pref === 'object') pref = pref.system ? 'system' : pref.value;
    var root = document.documentElement;
    root.classList.remove('dark', 'light');
    if (pref === 'dark') root.classList.add('dark');
    else if (pref === 'light') root.classList.add('light');
    // "system" / nichts gespeichert → CSS folgt prefers-color-scheme
  })();

  var API = '/federation/api';
  var POLL_SYNCING_MS = 5000;
  var POLL_IDLE_MS = 60000;

  var ICON = {
    earth:
      'M17.9,17.39C17.64,16.59 16.89,16 16,16H15V13A1,1 0 0,0 14,12H8V10H10A1,1 0 0,0 11,9V7H13A2,2 0 0,0 15,5V4.59C17.93,5.77 20,8.64 20,12C20,14.08 19.2,15.97 17.9,17.39M11,19.93C7.05,19.44 4,16.08 4,12C4,11.38 4.08,10.78 4.21,10.21L9,15V16A2,2 0 0,0 11,18M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2Z',
    sync: 'M12,18A6,6 0 0,1 6,12C6,11 6.25,10.03 6.7,9.2L5.24,7.74C4.46,8.97 4,10.43 4,12A8,8 0 0,0 12,20V23L16,19L12,15M12,4V1L8,5L12,9V6A6,6 0 0,1 18,12C18,13 17.75,13.97 17.3,14.8L18.76,16.26C19.54,15.03 20,13.57 20,12A8,8 0 0,0 12,4Z',
    linkOff:
      'M2,5.27L3.28,4L20,20.72L18.73,22L13.9,17.17L11.29,19.78C9.34,21.73 6.17,21.73 4.22,19.78C2.27,17.83 2.27,14.66 4.22,12.71L5.71,11.22C5.7,12.04 5.83,12.86 6.11,13.65L5.64,14.12C4.46,15.29 4.46,17.19 5.64,18.36C6.81,19.54 8.71,19.54 9.88,18.36L12.5,15.76L10.88,14.15C10.87,14.39 10.77,14.64 10.59,14.83C10.2,15.22 9.56,15.22 9.17,14.83C8.12,13.77 7.63,12.37 7.72,11L2,5.27M12.71,4.22C14.66,2.27 17.83,2.27 19.78,4.22C21.73,6.17 21.73,9.34 19.78,11.29L18.29,12.78C18.3,11.96 18.17,11.14 17.89,10.36L18.36,9.88C19.54,8.71 19.54,6.81 18.36,5.64C17.19,4.46 15.29,4.46 14.12,5.64L10.79,8.97L9.38,7.55L12.71,4.22M13.41,9.17C13.8,8.78 14.44,8.78 14.83,9.17C16.2,10.54 16.61,12.5 16.06,14.23L14.28,12.46C14.23,11.78 13.94,11.11 13.41,10.59C13,10.2 13,9.56 13.41,9.17Z',
    album:
      'M6,19L9,15.14L11.14,17.72L14.14,13.86L18,19H6M6,4H11V12L8.5,10.5L6,12M18,2H6A2,2 0 0,0 4,4V20A2,2 0 0,0 6,22H18A2,2 0 0,0 20,20V4A2,2 0 0,0 18,2Z',
    check: 'M21,7L9,19L3.5,13.5L4.91,12.09L9,16.17L19.59,5.59L21,7Z',
    alert:
      'M11,15H13V17H11V15M11,7H13V13H11V7M12,2C6.47,2 2,6.5 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M12,20A8,8 0 0,1 4,12A8,8 0 0,1 12,4A8,8 0 0,1 20,12A8,8 0 0,1 12,20Z',
  };

  // --- Helfer ----------------------------------------------------------------------------------------

  function $(id) {
    return document.getElementById(id);
  }

  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === undefined || v === null || v === false) return;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : String(v));
      });
    }
    add(el, children);
    return el;
  }

  function add(el, children) {
    if (children === undefined || children === null || children === false) return;
    if (!Array.isArray(children)) children = [children];
    children.forEach(function (c) {
      if (c === undefined || c === null || c === false) return;
      if (Array.isArray(c)) add(el, c);
      else el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    });
  }

  function svg(path, size, cls) {
    var NS = 'http://www.w3.org/2000/svg';
    var s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', String(size || 18));
    s.setAttribute('height', String(size || 18));
    s.setAttribute('aria-hidden', 'true');
    if (cls) s.setAttribute('class', cls);
    var p = document.createElementNS(NS, 'path');
    p.setAttribute('d', path);
    p.setAttribute('fill', 'currentColor');
    s.appendChild(p);
    return s;
  }

  function request(method, url, body) {
    var opts = { method: method, credentials: 'same-origin', headers: { Accept: 'application/json' } };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(url, opts).then(
      function (r) {
        return r.text().then(function (t) {
          var data = null;
          if (t) {
            try {
              data = JSON.parse(t);
            } catch (e) {
              data = t;
            }
          }
          if (r.status === 401) showLogin();
          return { ok: r.ok, status: r.status, data: data };
        });
      },
      function () {
        return { ok: false, status: 0, data: null };
      },
    );
  }

  function errorMessage(res) {
    if (!res) return 'Unbekannter Fehler.';
    if (res.status === 401) return 'Bitte in Immich anmelden.';
    if (res.status === 0) return 'Gateway nicht erreichbar. Bitte Verbindung prüfen.';
    var d = res.data;
    if (d && typeof d === 'object') {
      var m = d.message || d.error;
      if (Array.isArray(m)) m = m.join(', ');
      if (m) return String(m);
    }
    if (typeof d === 'string' && d && d.length < 300) return d;
    return 'Fehler (HTTP ' + res.status + ').';
  }

  var rtf = (function () {
    try {
      return new Intl.RelativeTimeFormat('de', { numeric: 'auto' });
    } catch (e) {
      return null;
    }
  })();

  function relTime(iso) {
    if (!iso) return null;
    var t = new Date(iso).getTime();
    if (!isFinite(t)) return null;
    var diff = (t - Date.now()) / 1000;
    var abs = Math.abs(diff);
    if (abs < 45) return 'gerade eben';
    if (!rtf) return new Date(t).toLocaleString('de-DE');
    if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
    if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
    if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day');
    return new Date(t).toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' });
  }

  function absTime(iso) {
    try {
      return new Date(iso).toLocaleString('de-DE');
    } catch (e) {
      return '';
    }
  }

  // --- Zustand ---------------------------------------------------------------------------------------

  var state = {
    authed: null,
    links: null,
    listError: null,
    confirmId: null,
    deleteAssets: true,
    busy: {}, // linkId -> 'sync' | 'delete'
    notes: {}, // linkId -> { kind, text }
  };
  var pollTimer = null;

  function showLogin() {
    state.authed = false;
    $('auth').hidden = false;
    $('app').hidden = true;
    $('user').hidden = true;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
  }

  function showApp() {
    state.authed = true;
    $('auth').hidden = true;
    $('app').hidden = false;
  }

  // --- Liste -----------------------------------------------------------------------------------------

  function loadLinks() {
    return request('GET', API + '/links').then(function (res) {
      if (res.status === 401) return;
      if (res.ok && Array.isArray(res.data)) {
        showApp();
        state.links = res.data;
        state.listError = null;
      } else {
        state.listError = errorMessage(res);
        if (state.links === null) state.links = [];
        showApp();
      }
      render();
      schedulePoll();
    });
  }

  function schedulePoll() {
    if (pollTimer) clearTimeout(pollTimer);
    if (state.authed === false) return;
    var syncing = (state.links || []).some(function (l) {
      return l && l.syncing;
    });
    pollTimer = setTimeout(loadLinks, syncing ? POLL_SYNCING_MS : POLL_IDLE_MS);
  }

  function statusChip(l) {
    if (l.syncing) {
      var p = l.progress;
      return h('span', { class: 'chip chip-sync' }, [
        svg(ICON.sync, 14, 'spin'),
        p && p.total ? 'Synchronisiere … ' + p.done + ' / ' + p.total : 'Synchronisiere …',
      ]);
    }
    if (l.lastError) return h('span', { class: 'chip chip-err' }, [svg(ICON.alert, 14), 'Fehler']);
    if (l.lastSyncedAt) return h('span', { class: 'chip chip-ok' }, [svg(ICON.check, 14), 'Aktuell']);
    return h('span', { class: 'chip', text: 'Ausstehend' });
  }

  function fact(label, value, title) {
    return h('div', null, [h('dt', { text: label }), h('dd', { text: value, title: title })]);
  }

  function renderLink(l) {
    var busy = state.busy[l.id];
    var note = state.notes[l.id];
    var albumHref = '/albums/' + encodeURIComponent(l.albumId);
    var lastSync = l.lastSyncedAt ? relTime(l.lastSyncedAt) : 'noch nie';
    var name = l.remoteAlbumName || 'Unbenanntes Album';

    var card = h('article', { class: 'link', 'aria-labelledby': 'link-title-' + l.id }, [
      h('div', { class: 'link-head' }, [
        h('div', { style: 'min-width:0' }, [
          h('h3', { class: 'link-title', id: 'link-title-' + l.id }, [h('a', { href: albumHref, text: name })]),
          h('div', { class: 'link-sub' }, [
            svg(ICON.earth, 16),
            h('span', { text: (l.serverHost || 'unbekannter Server') + (l.remoteOwnerName ? ' · ' + l.remoteOwnerName : '') }),
          ]),
        ]),
        h('div', { class: 'chips' }, [
          statusChip(l),
          h('span', { class: 'chip', text: l.showInTimeline ? 'In Zeitleiste' : 'Nur im Album' }),
          l.importVideos === false ? h('span', { class: 'chip', text: 'Ohne Videos' }) : null,
          l.allowDownload === false ? h('span', { class: 'chip', title: 'Der andere Server erlaubt keinen Download – es werden die lokalen Vorschauen angezeigt.', text: 'Originale gesperrt' }) : null,
        ]),
      ]),
      h('dl', { class: 'facts' }, [
        fact('Einträge', typeof l.assetCount === 'number' ? String(l.assetCount) : '–'),
        fact('Zuletzt synchronisiert', lastSync, l.lastSyncedAt ? absTime(l.lastSyncedAt) : undefined),
        fact('Server', l.serverHost || '–'),
        fact('Besitzer', l.remoteOwnerName || '–'),
      ]),
      l.lastError && !l.syncing ? h('div', { class: 'msg msg-error link-error', text: 'Letzter Fehler: ' + l.lastError }) : null,
      note ? h('div', { class: 'msg ' + (note.kind === 'error' ? 'msg-error' : 'msg-success'), role: note.kind === 'error' ? 'alert' : 'status', text: note.text }) : null,
    ]);

    if (state.confirmId === l.id) {
      card.appendChild(
        h('div', { class: 'confirm', role: 'group', 'aria-label': 'Trennen bestätigen' }, [
          h('div', { class: 'confirm-text', text: '„' + name + '“ von ' + (l.serverHost || 'diesem Server') + ' trennen?' }),
          h('label', { class: 'check' }, [
            h('input', {
              type: 'checkbox',
              checked: state.deleteAssets,
              'data-key': 'del-' + l.id,
              onchange: function (e) {
                state.deleteAssets = !!e.currentTarget.checked;
              },
            }),
            'Lokales Album und lokale Kopien löschen',
          ]),
          h('span', { class: 'spacer' }),
          h('button', {
            type: 'button',
            class: 'btn btn-outline',
            'data-key': 'cancel-' + l.id,
            text: 'Abbrechen',
            disabled: busy === 'delete',
            onclick: function () {
              state.confirmId = null;
              render('disc-' + l.id);
            },
          }),
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-danger-filled',
              'data-key': 'yes-' + l.id,
              disabled: busy === 'delete',
              onclick: function () {
                disconnect(l);
              },
            },
            busy === 'delete' ? [svg(ICON.sync, 16, 'spin'), 'Trenne …'] : [svg(ICON.linkOff, 16), 'Ja, trennen'],
          ),
        ]),
      );
    } else {
      card.appendChild(
        h('div', { class: 'link-actions' }, [
          h('a', { class: 'btn btn-outline', href: albumHref }, [svg(ICON.album, 16), 'Album öffnen']),
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-outline',
              'data-key': 'sync-' + l.id,
              disabled: l.syncing || !!busy,
              onclick: function () {
                syncNow(l);
              },
            },
            [svg(ICON.sync, 16, l.syncing || busy === 'sync' ? 'spin' : null), 'Jetzt synchronisieren'],
          ),
          h('span', { class: 'spacer' }),
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-danger',
              'data-key': 'disc-' + l.id,
              disabled: !!busy,
              onclick: function () {
                state.confirmId = l.id;
                state.deleteAssets = true;
                render('yes-' + l.id);
              },
            },
            [svg(ICON.linkOff, 16), 'Trennen'],
          ),
        ]),
      );
    }
    return card;
  }

  /** Rendert die Liste neu und stellt den Fokus anhand von data-key wieder her. */
  function render(focusKey) {
    var listEl = $('links');
    var active = document.activeElement;
    var key = focusKey || (active && listEl.contains(active) ? active.getAttribute('data-key') : null);

    var err = $('list-error');
    err.hidden = !state.listError;
    err.textContent = state.listError || '';

    listEl.setAttribute('aria-busy', state.links === null ? 'true' : 'false');
    listEl.textContent = '';
    if (state.links === null) {
      listEl.appendChild(h('p', { class: 'empty', text: 'Lade …' }));
    } else if (!state.links.length) {
      listEl.appendChild(h('p', { class: 'empty', text: 'Noch keine föderierten Alben. Füge oben einen Freigabe-Link ein.' }));
    } else {
      state.links.forEach(function (l) {
        if (l && l.id) listEl.appendChild(renderLink(l));
      });
    }

    if (key) {
      var target = listEl.querySelector('[data-key="' + key.replace(/"/g, '') + '"]');
      if (target && !target.disabled) target.focus();
    }
  }

  // --- Aktionen --------------------------------------------------------------------------------------

  function syncNow(l) {
    state.busy[l.id] = 'sync';
    delete state.notes[l.id];
    render();
    request('POST', API + '/links/' + encodeURIComponent(l.id) + '/sync').then(function (res) {
      delete state.busy[l.id];
      if (res.ok) {
        (state.links || []).forEach(function (x) {
          if (x.id === l.id) x.syncing = true;
        });
        render('sync-' + l.id);
        schedulePoll();
      } else if (res.status !== 401) {
        state.notes[l.id] = { kind: 'error', text: errorMessage(res) };
        render();
      }
    });
  }

  function disconnect(l) {
    state.busy[l.id] = 'delete';
    render('yes-' + l.id);
    var del = state.deleteAssets;
    request('DELETE', API + '/links/' + encodeURIComponent(l.id) + '?deleteAssets=' + (del ? 'true' : 'false')).then(function (res) {
      delete state.busy[l.id];
      if (res.ok || res.status === 404) {
        state.confirmId = null;
        state.links = (state.links || []).filter(function (x) {
          return x.id !== l.id;
        });
        render();
        flash('„' + (l.remoteAlbumName || 'Album') + '“ wurde getrennt' + (del ? ' und lokal gelöscht.' : '. Die lokalen Kopien bleiben erhalten.'));
        loadLinks();
      } else if (res.status !== 401) {
        state.notes[l.id] = { kind: 'error', text: errorMessage(res) };
        state.confirmId = null;
        render('disc-' + l.id);
      }
    });
  }

  function flash(text) {
    var el = $('flash');
    el.textContent = text;
    el.hidden = false;
    setTimeout(function () {
      if (el.textContent === text) el.hidden = true;
    }, 6000);
  }

  // --- Verbinden-Formular ----------------------------------------------------------------------------

  function setConnectMsg(kind, children) {
    var m = $('connect-msg');
    m.className = 'msg ' + (kind === 'error' ? 'msg-error' : 'msg-success');
    m.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    m.textContent = '';
    add(m, children);
    m.hidden = false;
  }

  function initForm() {
    var form = $('connect-form');
    var input = $('share-url');
    var toggle = $('show-timeline');
    var videoToggle = $('import-videos');
    var btn = $('connect-btn');
    var busy = false;

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (busy) return;
      $('connect-msg').hidden = true;
      var url = (input.value || '').trim();
      var parsed = null;
      try {
        parsed = new URL(url);
      } catch (err) {
        parsed = null;
      }
      if (!parsed || !/^https?:$/.test(parsed.protocol)) {
        setConnectMsg('error', 'Bitte einen vollständigen Freigabe-Link einfügen (beginnt mit https:// oder http://).');
        input.focus();
        return;
      }
      if (!/\/(share|s)\/[^/]+/.test(parsed.pathname)) {
        setConnectMsg('error', 'Das sieht nicht nach einem Immich-Freigabe-Link aus. Erwartet wird …/share/<Schlüssel> oder …/s/<Name>.');
        input.focus();
        return;
      }
      busy = true;
      btn.disabled = true;
      input.disabled = true;
      toggle.disabled = true;
      videoToggle.disabled = true;
      btn.textContent = '';
      add(btn, [svg(ICON.sync, 16, 'spin'), 'Verbinde …']);

      request('POST', API + '/links', { shareUrl: url, showInTimeline: !!toggle.checked, importVideos: !!videoToggle.checked }).then(function (res) {
        busy = false;
        btn.disabled = false;
        input.disabled = false;
        toggle.disabled = false;
        videoToggle.disabled = false;
        btn.textContent = 'Verbinden';
        if (res.ok && res.data && res.data.albumId) {
          input.value = '';
          setConnectMsg('success', [
            'Verbunden – die Synchronisierung läuft im Hintergrund. ',
            h('a', { href: '/albums/' + encodeURIComponent(res.data.albumId), text: 'Album öffnen' }),
          ]);
          loadLinks();
        } else if (res.status === 401) {
          setConnectMsg('error', 'Bitte in Immich anmelden.');
        } else {
          setConnectMsg('error', errorMessage(res));
          input.focus();
        }
      });
    });
  }

  // --- Start -----------------------------------------------------------------------------------------

  function init() {
    try {
      $('login-link').setAttribute('href', '/auth/login?continue=' + encodeURIComponent(location.pathname + location.search));
    } catch (e) {
      /* ignore */
    }
    initForm();
    $('reload-btn').addEventListener('click', function () {
      loadLinks();
    });

    // Angemeldeten Benutzer anzeigen (gleiche Origin → Immich-API über das Gateway)
    request('GET', '/api/users/me').then(function (res) {
      if (res.ok && res.data && typeof res.data === 'object') {
        var u = $('user');
        u.textContent = res.data.name || res.data.email || '';
        u.title = res.data.email || '';
        u.hidden = !u.textContent;
      }
    });
    loadLinks();

    // Relative Zeiten aktuell halten, ohne Bestätigungsdialoge zu stören
    setInterval(function () {
      if (state.authed && state.links && state.links.length && !state.confirmId) render();
    }, 60000);

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && state.authed !== false) loadLinks();
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && state.confirmId && !state.busy[state.confirmId]) {
        var id = state.confirmId;
        state.confirmId = null;
        render('disc-' + id);
      }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
