/*
 * immich-federation – inject.js
 * Injected by the gateway into the HTML responses of the (unmodified) Immich web app.
 * Vanilla JS, no dependencies. Everything is defensive: if a DOM anchor is missing (e.g. after an
 * Immich update), the respective extension is silently skipped.
 * Texts come from i18n.js (window.__ifedI18n, loaded before this file) and follow the Immich language setting.
 * All anchors are structural (ids, hrefs, icon paths) – never Immich's own (translated) UI texts.
 *
 * Anchors (verified against Immich v3.3.0, web/src):
 *  - Sidebar:      nav#sidebar  > div  >  …a[href="/sharing"]          (UserSidebar.svelte, Sidebar.svelte)
 *  - Account menu: #account-info-panel a[href="/user-settings"]          (AccountInfoPanel.svelte)
 *  - Album list:   button with <path d=mdiPlusBoxOutline> in <main>      (albums/AlbumsControls.svelte)
 *                  fallback: #user-page-header → header bar              (layouts/UserPageLayout.svelte)
 *  - Album cards:  a[href="/albums/<id>"] [data-testid="album-details"]  (album-page/AlbumCard.svelte)
 *  - Album page:   #virtual-timeline > section > section (title area)    (timeline/Timeline.svelte, albums/[albumId]/…/+page.svelte)
 *  - Asset viewer: #immich-asset-viewer, #detail-panel                  (asset-viewer/AssetViewer.svelte, DetailPanel.svelte)
 */
(function () {
  'use strict';

  if (window.__immichFederation) return;

  // ---------------------------------------------------------------------------------------------
  // Basics
  // ---------------------------------------------------------------------------------------------

  var BASE = (function () {
    try {
      var s = document.currentScript && document.currentScript.src;
      if (s) {
        var u = new URL('.', s);
        if (u.origin === location.origin) return u.pathname.replace(/\/$/, '');
      }
    } catch (e) {
      /* ignore */
    }
    return '/federation';
  })();
  var API = BASE + '/api';
  var UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
  var RE_ALBUMS = /^\/albums\/?$/;
  var RE_ALBUM = new RegExp('^/albums/(' + UUID + ')(?:/|$)');
  var RE_ASSET = new RegExp('/photos/(' + UUID + ')/?$');

  /** i18n.js (window.__ifedI18n) – normally loaded before this script; see boot at the end of the file. */
  function I() {
    return window.__ifedI18n;
  }
  function t(key, params) {
    return I().t(key, params);
  }

  var ICON = {
    plusBox:
      'M19,19V5H5V19H19M19,3A2,2 0 0,1 21,5V19A2,2 0 0,1 19,21H5A2,2 0 0,1 3,19V5C3,3.89 3.9,3 5,3H19M11,7H13V11H17V13H13V17H11V13H7V11H11V7Z',
    earth:
      'M17.9,17.39C17.64,16.59 16.89,16 16,16H15V13A1,1 0 0,0 14,12H8V10H10A1,1 0 0,0 11,9V7H13A2,2 0 0,0 15,5V4.59C17.93,5.77 20,8.64 20,12C20,14.08 19.2,15.97 17.9,17.39M11,19.93C7.05,19.44 4,16.08 4,12C4,11.38 4.08,10.78 4.21,10.21L9,15V16A2,2 0 0,0 11,18M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2Z',
    earthPlus:
      'M17 14H19V17H22V19H19V22H17V19H14V17H17V14M20 12C20 8.64 17.93 5.77 15 4.59V5C15 6.1 14.1 7 13 7H11V9C11 9.55 10.55 10 10 10H8V12H14C14.5 12 14.9 12.35 15 12.81C13.2 13.85 12 15.79 12 18C12 19.5 12.54 20.85 13.44 21.9L12 22C6.5 22 2 17.5 2 12C2 6.5 6.5 2 12 2C17.5 2 22 6.5 22 12L21.9 13.44C21.34 12.96 20.7 12.59 20 12.34L20 12M11 19.93V18C9.9 18 9 17.1 9 16V15L4.21 10.21C4.08 10.78 4 11.38 4 12C4 16.08 7.06 19.44 11 19.93Z',
    sync: 'M12,18A6,6 0 0,1 6,12C6,11 6.25,10.03 6.7,9.2L5.24,7.74C4.46,8.97 4,10.43 4,12A8,8 0 0,0 12,20V23L16,19L12,15M12,4V1L8,5L12,9V6A6,6 0 0,1 18,12C18,13 17.75,13.97 17.3,14.8L18.76,16.26C19.54,15.03 20,13.57 20,12A8,8 0 0,0 12,4Z',
    linkOff:
      'M2,5.27L3.28,4L20,20.72L18.73,22L13.9,17.17L11.29,19.78C9.34,21.73 6.17,21.73 4.22,19.78C2.27,17.83 2.27,14.66 4.22,12.71L5.71,11.22C5.7,12.04 5.83,12.86 6.11,13.65L5.64,14.12C4.46,15.29 4.46,17.19 5.64,18.36C6.81,19.54 8.71,19.54 9.88,18.36L12.5,15.76L10.88,14.15C10.87,14.39 10.77,14.64 10.59,14.83C10.2,15.22 9.56,15.22 9.17,14.83C8.12,13.77 7.63,12.37 7.72,11L2,5.27M12.71,4.22C14.66,2.27 17.83,2.27 19.78,4.22C21.73,6.17 21.73,9.34 19.78,11.29L18.29,12.78C18.3,11.96 18.17,11.14 17.89,10.36L18.36,9.88C19.54,8.71 19.54,6.81 18.36,5.64C17.19,4.46 15.29,4.46 14.12,5.64L10.79,8.97L9.38,7.55L12.71,4.22M13.41,9.17C13.8,8.78 14.44,8.78 14.83,9.17C16.2,10.54 16.61,12.5 16.06,14.23L14.28,12.46C14.23,11.78 13.94,11.11 13.41,10.59C13,10.2 13,9.56 13.41,9.17Z',
    close:
      'M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z',
    cog: 'M12,15.5A3.5,3.5 0 0,1 8.5,12A3.5,3.5 0 0,1 12,8.5A3.5,3.5 0 0,1 15.5,12A3.5,3.5 0 0,1 12,15.5M19.43,12.97C19.47,12.65 19.5,12.33 19.5,12C19.5,11.67 19.47,11.34 19.43,11L21.54,9.37C21.73,9.22 21.78,8.95 21.66,8.73L19.66,5.27C19.54,5.05 19.27,4.96 19.05,5.05L16.56,6.05C16.04,5.66 15.5,5.32 14.87,5.07L14.5,2.42C14.46,2.18 14.25,2 14,2H10C9.75,2 9.54,2.18 9.5,2.42L9.13,5.07C8.5,5.32 7.96,5.66 7.44,6.05L4.95,5.05C4.73,4.96 4.46,5.05 4.34,5.27L2.34,8.73C2.21,8.95 2.27,9.22 2.46,9.37L4.57,11C4.53,11.34 4.5,11.67 4.5,12C4.5,12.33 4.53,12.65 4.57,12.97L2.46,14.63C2.27,14.78 2.21,15.05 2.34,15.27L4.34,18.73C4.46,18.95 4.73,19.03 4.95,18.95L7.44,17.94C7.96,18.34 8.5,18.68 9.13,18.93L9.5,21.58C9.54,21.82 9.75,22 10,22H14C14.25,22 14.46,21.82 14.5,21.58L14.87,18.93C15.5,18.67 16.04,18.34 16.56,17.94L19.05,18.95C19.27,19.03 19.54,18.95 19.66,18.73L21.66,15.27C21.78,15.05 21.73,14.78 21.54,14.63L19.43,12.97Z',
    alert:
      'M11,15H13V17H11V15M11,7H13V13H11V7M12,2C6.47,2 2,6.5 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M12,20A8,8 0 0,1 4,12A8,8 0 0,1 12,4A8,8 0 0,1 20,12A8,8 0 0,1 12,20Z',
    refresh:
      'M17.65,6.35C16.2,4.9 14.21,4 12,4A8,8 0 0,0 4,12A8,8 0 0,0 12,20C15.73,20 18.84,17.45 19.73,14H17.65C16.83,16.33 14.61,18 12,18A6,6 0 0,1 6,12A6,6 0 0,1 12,6C13.66,6 15.14,6.69 16.22,7.78L13,11H20V4L17.65,6.35Z',
  };

  function safe(fn) {
    return function () {
      try {
        return fn.apply(this, arguments);
      } catch (e) {
        if (safeGet('ifed-debug')) console.warn('[immich-federation]', e);
      }
    };
  }

  /** Report missing DOM anchors once (only with localStorage ifed-debug=1), remember them for diagnose(). */
  var missingSeen = {};
  function missing(name) {
    if (!missingSeen[name] && safeGet('ifed-debug')) console.info('[immich-federation] anchor missing: ' + name);
    missingSeen[name] = true;
  }

  function safeGet(key) {
    try {
      return localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }

  /** Small DOM builder. Texts always via textContent (album names etc. come from foreign servers). */
  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        var v = attrs[k];
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    append(el, children);
    return el;
  }

  function append(el, children) {
    if (children === undefined || children === null || children === false) return;
    if (!Array.isArray(children)) children = [children];
    for (var i = 0; i < children.length; i++) {
      var c = children[i];
      if (c === undefined || c === null || c === false) continue;
      if (Array.isArray(c)) append(el, c);
      else el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
  }

  function svg(path, size, cls) {
    var NS = 'http://www.w3.org/2000/svg';
    var s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', size || '1em');
    s.setAttribute('height', size || '1em');
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('focusable', 'false');
    if (cls) s.setAttribute('class', cls);
    var p = document.createElementNS(NS, 'path');
    p.setAttribute('d', path);
    p.setAttribute('fill', 'currentColor');
    s.appendChild(p);
    return s;
  }

  function errorMessage(res) {
    if (!res) return t('error.unknown');
    if (res.status === 401) return t('error.login');
    var d = res.data;
    if (d && typeof d === 'object') {
      var m = d.message || d.error;
      if (Array.isArray(m)) m = m.join(', ');
      if (m) return String(m);
    }
    if (typeof d === 'string' && d && d.length < 300) return d;
    if (res.status === 0) return t('error.unreachable');
    return t('error.http', { status: res.status });
  }

  function api(method, path, body) {
    // X-Federation-Lang: the gateway localizes error messages and stored texts (sync errors) accordingly
    var opts = { method: method, credentials: 'same-origin', headers: { Accept: 'application/json', 'X-Federation-Lang': I().lang() } };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(API + path, opts).then(
      function (r) {
        return r.text().then(function (txt) {
          var data = null;
          if (txt) {
            try {
              data = JSON.parse(txt);
            } catch (e) {
              data = txt;
            }
          }
          return { ok: r.ok, status: r.status, data: data };
        });
      },
      function () {
        return { ok: false, status: 0, data: null };
      },
    );
  }

  function relTime(iso) {
    return I().relativeTime(iso);
  }

  function absTime(iso) {
    return I().formatDateTime(iso);
  }

  /** SPA navigation via the SvelteKit router (clicks a temporary link), fallback: hard navigation. */
  function spaNavigate(href) {
    try {
      var a = document.createElement('a');
      a.href = href;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
      var target = new URL(href, location.href).pathname;
      setTimeout(function () {
        if (location.pathname !== target) location.assign(href);
      }, 1500);
    } catch (e) {
      location.assign(href);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Data caches
  // ---------------------------------------------------------------------------------------------

  var linksCache = { at: 0, promise: null, data: null };

  function getLinks(force) {
    var now = Date.now();
    if (!force && linksCache.promise && now - linksCache.at < 15000) return linksCache.promise;
    linksCache.at = now;
    linksCache.promise = api('GET', '/links').then(function (res) {
      if (res.ok && Array.isArray(res.data)) {
        linksCache.data = res.data;
        return res.data;
      }
      // On error, don't cache for long
      linksCache.at = 0;
      return linksCache.data || [];
    });
    return linksCache.promise;
  }

  var assetCache = new Map(); // id -> { at, ttl, promise }

  function getAssetInfo(id) {
    var now = Date.now();
    var c = assetCache.get(id);
    if (c && now - c.at < c.ttl) return c.promise;
    var entry = { at: now, ttl: 5 * 60 * 1000, promise: null };
    entry.promise = api('GET', '/assets/' + encodeURIComponent(id)).then(function (res) {
      if (res.ok && res.data && res.data.federated) return res.data;
      if (res.status !== 404) entry.ttl = 30 * 1000; // network/server error: retry soon
      return null;
    });
    assetCache.set(id, entry);
    if (assetCache.size > 500) assetCache.delete(assetCache.keys().next().value);
    return entry.promise;
  }

  // ---------------------------------------------------------------------------------------------
  // CSS (once, prefix ifed-). Colors via Immich UI variables → follows light/dark automatically.
  // ---------------------------------------------------------------------------------------------

  var CSS = [
    ':root{--ifed-primary:var(--immich-ui-primary-500,#4250af);--ifed-fg:var(--immich-ui-dark,#3a3a3a);--ifed-bg:var(--immich-ui-light,#fff);',
    '--ifed-subtle:var(--immich-ui-gray,#f6f6f8);--ifed-muted:var(--immich-ui-muted,#a1a1aa);--ifed-danger:var(--immich-ui-danger-500,#e5484d);',
    '--ifed-success:var(--immich-ui-success-500,#30a46c);--ifed-warning:var(--immich-ui-warning-500,#f5a524);',
    '--ifed-border:color-mix(in oklab,var(--ifed-fg) 18%,transparent)}',
    '.ifed-spin{animation:ifed-spin 1s linear infinite}@keyframes ifed-spin{to{transform:rotate(360deg)}}',
    '@media (prefers-reduced-motion:reduce){.ifed-spin{animation:none}}',
    // Buttons
    '.ifed-btn{display:inline-flex;align-items:center;justify-content:center;gap:.375rem;border-radius:.5rem;padding:.4rem .85rem;font:inherit;font-size:.875rem;font-weight:500;line-height:1.25rem;border:1px solid transparent;background:transparent;color:var(--ifed-fg);cursor:pointer;transition:background-color .15s,opacity .15s;white-space:nowrap}',
    '.ifed-btn:hover:not(:disabled){background:color-mix(in oklab,var(--ifed-fg) 10%,transparent)}',
    '.ifed-btn:focus-visible,.ifed-input:focus-visible,.ifed-switch:focus-visible{outline:2px solid var(--ifed-primary);outline-offset:2px}',
    '.ifed-btn:disabled{opacity:.5;cursor:not-allowed}',
    '.ifed-btn-primary{background:var(--ifed-primary);color:var(--ifed-bg)}',
    '.ifed-btn-primary:hover:not(:disabled){background:color-mix(in oklab,var(--ifed-primary) 85%,var(--ifed-fg))}',
    '.ifed-btn-outline{border-color:var(--ifed-border)}',
    '.ifed-btn-danger{color:var(--ifed-danger)}.ifed-btn-danger:hover:not(:disabled){background:color-mix(in oklab,var(--ifed-danger) 14%,transparent)}',
    '.ifed-btn-danger-filled{background:var(--ifed-danger);color:#fff}.ifed-btn-danger-filled:hover:not(:disabled){background:color-mix(in oklab,var(--ifed-danger) 85%,#000)}',
    '.ifed-icon-btn{padding:.4rem;border-radius:9999px}',
    // Banner (album page)
    '.ifed-banner{display:flex;flex-wrap:wrap;align-items:center;gap:.75rem 1rem;margin:.75rem 0 .5rem;padding:.75rem 1rem;border-radius:1rem;border:1px solid var(--ifed-border);background:color-mix(in oklab,var(--ifed-primary) 7%,var(--ifed-bg));color:var(--ifed-fg);font-size:.875rem}',
    '.ifed-banner-main{display:flex;align-items:flex-start;gap:.75rem;flex:1 1 18rem;min-width:0}',
    '.ifed-banner-icon{color:var(--ifed-primary);flex:none;margin-top:.1rem}',
    '.ifed-banner-title{font-weight:600;overflow-wrap:anywhere}.ifed-banner-title b{color:var(--ifed-primary);font-weight:600}',
    '.ifed-banner-meta{display:flex;flex-wrap:wrap;align-items:center;gap:.25rem .5rem;margin-top:.15rem;opacity:.85}',
    '.ifed-sep{opacity:.5}',
    '.ifed-actions{display:flex;flex-wrap:wrap;align-items:center;gap:.25rem}',
    '.ifed-err{color:var(--ifed-danger);overflow-wrap:anywhere}',
    '.ifed-ok{color:var(--ifed-success)}',
    '.ifed-confirm{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem .75rem;flex:1 1 100%;padding-top:.5rem;border-top:1px solid var(--ifed-border)}',
    '.ifed-check{display:inline-flex;align-items:center;gap:.4rem;cursor:pointer}',
    '.ifed-check input{accent-color:var(--ifed-primary);width:1rem;height:1rem}',
    // Chips
    '[data-ifed=card-chip]{margin-top:.35rem;max-width:100%;overflow:hidden;text-overflow:ellipsis}',
    '.ifed-chip{display:inline-flex;align-items:center;gap:.25rem;padding:.05rem .45rem;border-radius:9999px;font-size:.75rem;font-weight:500;background:color-mix(in oklab,var(--ifed-primary) 14%,transparent);color:var(--ifed-primary);white-space:nowrap}',
    // Asset badge
    '.ifed-asset-badge{display:flex;align-items:flex-start;gap:.6rem;margin:.5rem 1rem 0;padding:.6rem .8rem;border-radius:.75rem;font-size:.8125rem;line-height:1.15rem;background:color-mix(in oklab,var(--ifed-primary) 10%,transparent);color:var(--ifed-fg)}',
    '.ifed-asset-badge svg{color:var(--ifed-primary);flex:none;margin-top:.05rem}',
    '.ifed-asset-badge b{font-weight:600;overflow-wrap:anywhere}',
    '.ifed-asset-badge small{display:block;opacity:.75;font-size:.75rem}',
    '.ifed-asset-float{position:absolute;top:72px;left:16px;z-index:5;display:inline-flex;align-items:center;gap:.35rem;max-width:calc(100% - 32px);padding:.25rem .6rem;border-radius:9999px;background:rgba(0,0,0,.55);color:#fff;font-size:.75rem;pointer-events:none;backdrop-filter:blur(4px)}',
    '.ifed-asset-float span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    // Modal
    '.ifed-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:1rem;background:rgba(0,0,0,.5);animation:ifed-fade .12s ease-out}',
    '@keyframes ifed-fade{from{opacity:0}to{opacity:1}}',
    '.ifed-modal{width:min(32rem,100%);max-height:calc(100dvh - 2rem);overflow:auto;border-radius:1.5rem;background:var(--ifed-bg);color:var(--ifed-fg);border:1px solid var(--ifed-border);box-shadow:0 20px 50px rgba(0,0,0,.35);font-size:.9375rem}',
    '.ifed-modal-head{display:flex;align-items:center;gap:.75rem;padding:1.25rem 1.25rem .25rem 1.5rem}',
    '.ifed-modal-head h2{flex:1;margin:0;font-size:1.25rem;font-weight:600;color:var(--ifed-primary)}',
    '.ifed-modal-body{padding:.5rem 1.5rem 0;display:flex;flex-direction:column;gap:1rem}',
    '.ifed-modal-body p{margin:0;line-height:1.4rem;opacity:.85}',
    '.ifed-modal-foot{display:flex;justify-content:flex-end;gap:.5rem;padding:1.25rem 1.5rem 1.5rem}',
    '.ifed-label{display:block;font-weight:500;font-size:.875rem;margin-bottom:.35rem;opacity:.85}',
    '.ifed-input{box-sizing:border-box;width:100%;padding:.625rem 1rem;border-radius:.5rem;border:1px solid var(--ifed-border);background:var(--ifed-subtle);color:var(--ifed-fg);font:inherit;font-size:1rem}',
    '.ifed-input:focus{border-color:var(--ifed-primary);outline:none}',
    '.ifed-hint{font-size:.8125rem;opacity:.7;margin-top:.35rem}',
    '.ifed-row{display:flex;align-items:center;justify-content:space-between;gap:1rem}',
    '.ifed-switch{appearance:none;-webkit-appearance:none;flex:none;position:relative;width:2.5rem;height:1.4rem;border-radius:9999px;background:color-mix(in oklab,var(--ifed-fg) 25%,transparent);cursor:pointer;transition:background-color .15s;margin:0}',
    '.ifed-switch::after{content:"";position:absolute;top:.2rem;left:.2rem;width:1rem;height:1rem;border-radius:9999px;background:#fff;transition:transform .15s}',
    '.ifed-switch:checked{background:var(--ifed-primary)}.ifed-switch:checked::after{transform:translateX(1.1rem)}',
    '.ifed-alert{display:flex;gap:.5rem;align-items:flex-start;padding:.6rem .8rem;border-radius:.6rem;background:color-mix(in oklab,var(--ifed-danger) 12%,transparent);color:var(--ifed-danger);font-size:.875rem}',
    '.ifed-alert a{color:inherit;font-weight:600}',
    '.ifed-sidebar-link svg{flex:none}',
  ].join('');

  function ensureStyle() {
    if (document.getElementById('ifed-style')) return;
    var st = document.createElement('style');
    st.id = 'ifed-style';
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  // ---------------------------------------------------------------------------------------------
  // d) Sidebar entry + account menu link
  // ---------------------------------------------------------------------------------------------

  var ensureSidebar = safe(function () {
    var nav = document.querySelector('nav#sidebar') || document.querySelector('[data-testid="sidebar-parent"]');
    if (!nav) return;
    // Immich v3.3 wraps the items in a focus trap: <div data-focus-trap="start"> <div data-focus-trap="backup"> <div class="flex … flex-col">
    // → the item container is the direct nav child that holds the reference link, not simply the first child.
    var ref =
      nav.querySelector('a[href="/sharing"]') ||
      nav.querySelector('a[href="/shared-links"]') ||
      nav.querySelector('a[href="/albums"]') ||
      nav.querySelector('a[href="/photos"]');
    var existing = nav.querySelector('[data-ifed="sidebar"]');
    // Pages with their own sidebar (folder/tag explorer under /folders, /tags) have no navigation links →
    // don't insert an entry there (the account menu still offers the link).
    if (!ref) {
      if (existing) existing.remove();
      missing('sidebar');
      return;
    }
    var container = ref;
    while (container && container.parentElement !== nav) container = container.parentElement;
    if (!container) return;
    if (existing && existing.parentElement === container) return;
    if (existing) existing.remove();

    var refItem = ref;
    while (refItem && refItem.parentElement !== container) refItem = refItem.parentElement;

    // Copy the classes of the real navbar entry (minus the active state) → identical look
    var linkClass = ref
      ? ref.className
          .split(/\s+/)
          .filter(function (c) {
            return c && c !== 'bg-primary/10' && c !== 'text-primary';
          })
          .join(' ')
      : 'flex w-full place-items-center gap-4 rounded-e-full ps-5 py-3 hover:bg-subtle hover:text-primary';
    var innerClass =
      (ref && ref.firstElementChild && ref.firstElementChild.className) || 'relative flex w-full place-items-center gap-4';
    var active = location.pathname.indexOf(BASE + '/') === 0 || location.pathname === BASE;

    var item = h('div', { 'data-ifed': 'sidebar' }, [
      h('div', { class: 'relative flex items-center' }, [
        h(
          'a',
          {
            href: BASE + '/',
            'data-sveltekit-reload': '',
            class: 'ifed-sidebar-link ' + linkClass + (active ? ' bg-primary/10 text-primary' : ''),
            draggable: 'false',
            title: t('nav.manageTitle'),
          },
          [h('div', { class: innerClass }, [svg(ICON.earth, '1.375em', 'shrink-0'), h('span', { class: 'truncate text-sm font-medium', text: t('common.federation') })])],
        ),
      ]),
    ]);

    if (refItem && refItem.nextSibling) container.insertBefore(item, refItem.nextSibling);
    else container.appendChild(item);
  });

  var ensureAccountMenu = safe(function () {
    var panel = document.getElementById('account-info-panel');
    if (!panel || panel.querySelector('[data-ifed="account"]')) return;
    var ref = panel.querySelector('a[href="/user-settings"]') || panel.querySelector('a[href^="/user-settings"]');
    if (!ref || !ref.parentElement) return missing('account');
    var a = h(
      'a',
      { href: BASE + '/', 'data-sveltekit-reload': '', 'data-ifed': 'account', class: ref.className },
      [
        h('div', { class: 'flex place-content-center place-items-center gap-2 px-2 text-center' }, [
          svg(ICON.earth, '18'),
          t('common.federation'),
        ]),
      ],
    );
    ref.parentElement.insertBefore(a, ref.nextSibling);
  });

  // ---------------------------------------------------------------------------------------------
  // a) Album list: "Connect federated album" button + marking of federated albums
  // ---------------------------------------------------------------------------------------------

  function findCreateAlbumButton() {
    var root = document.querySelector('main') || document;
    var paths = root.querySelectorAll('button svg path');
    for (var i = 0; i < paths.length; i++) {
      if (paths[i].getAttribute('d') === ICON.plusBox) return paths[i].closest('button');
    }
    return null;
  }

  var ensureAlbumsButton = safe(function () {
    if (document.querySelector('[data-ifed="connect-btn"]')) return;

    var createBtn = findCreateAlbumButton();
    var parent;
    var before = null;
    var cls;
    if (createBtn && createBtn.parentElement) {
      parent = createBtn.parentElement;
      before = createBtn.nextSibling;
      cls = createBtn.className;
    } else {
      // Fallback: the page's header bar (UserPageLayout, #user-page-header)
      var header = document.getElementById('user-page-header');
      var bar = header && header.closest('div.absolute');
      if (!bar) return missing('albums-button');
      parent = bar;
      before = header.parentElement ? header.parentElement.nextSibling : null;
      cls = 'ifed-btn';
    }

    var btn = h(
      'button',
      {
        type: 'button',
        class: cls,
        'data-ifed': 'connect-btn',
        title: t('connect.title'),
        'aria-label': t('connect.title'),
        onclick: function (e) {
          openConnectModal(e.currentTarget);
        },
      },
      [h('div', null, [svg(ICON.earthPlus, '1rem', 'h-4 w-4')]), h('p', { class: 'hidden md:block', text: t('connect.title') })],
    );
    parent.insertBefore(btn, before);
  });

  var markAlbumCards = safe(function () {
    var links = linksCache.data;
    if (!links || !links.length) return;
    var byAlbum = {};
    links.forEach(function (l) {
      if (l && l.albumId) byAlbum[l.albumId] = l;
    });
    var anchors = document.querySelectorAll('main a[href^="/albums/"]');
    for (var i = 0; i < anchors.length; i++) {
      var a = anchors[i];
      var m = RE_ALBUM.exec(a.getAttribute('href') || '');
      if (!m || !byAlbum[m[1]]) continue;
      var details = a.querySelector('[data-testid="album-details"]');
      if (!details || a.querySelector('[data-ifed="card-chip"]')) continue;
      var l = byAlbum[m[1]];
      // below the "N items" row (inside it the chip overflows narrow cards)
      details.parentElement.insertBefore(
        h('span', { class: 'ifed-chip', 'data-ifed': 'card-chip', title: t('albums.federatedFrom', { host: l.serverHost || '' }) }, [
          svg(ICON.earth, '0.9em'),
          l.serverHost || t('albums.federated'),
        ]),
        details.nextSibling,
      );
    }
  });

  // ---------------------------------------------------------------------------------------------
  // Modal "Connect federated album"
  // ---------------------------------------------------------------------------------------------

  var modalState = null;

  function focusables(root) {
    return Array.prototype.filter.call(
      root.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])'),
      function (el) {
        return el.offsetParent !== null || el === document.activeElement;
      },
    );
  }

  function closeModal() {
    if (!modalState) return;
    var st = modalState;
    modalState = null;
    try {
      st.overlay.remove();
    } catch (e) {
      /* ignore */
    }
    document.removeEventListener('keydown', st.onDocKey, true);
    try {
      if (st.returnFocus && st.returnFocus.isConnected) st.returnFocus.focus();
    } catch (e) {
      /* ignore */
    }
  }

  function openConnectModal(trigger) {
    ensureStyle();
    if (modalState) return;

    var errorBox = h('div', { class: 'ifed-alert', role: 'alert', hidden: true });
    var input = h('input', {
      id: 'ifed-share-url',
      class: 'ifed-input',
      type: 'url',
      inputmode: 'url',
      autocomplete: 'off',
      spellcheck: 'false',
      required: true,
      placeholder: t('connect.placeholder'),
      'aria-describedby': 'ifed-share-hint',
    });
    var toggle = h('input', { id: 'ifed-show-timeline', class: 'ifed-switch', type: 'checkbox', role: 'switch' });
    var videoToggle = h('input', { id: 'ifed-import-videos', class: 'ifed-switch', type: 'checkbox', role: 'switch', checked: true });
    var cancelBtn = h('button', { type: 'button', class: 'ifed-btn ifed-btn-outline', text: t('common.cancel'), onclick: closeModal });
    var submitBtn = h('button', { type: 'submit', class: 'ifed-btn ifed-btn-primary' }, [svg(ICON.earthPlus, '1rem'), t('common.connect')]);
    var closeBtn = h('button', { type: 'button', class: 'ifed-btn ifed-icon-btn', 'aria-label': t('common.close'), title: t('common.close'), onclick: closeModal }, [
      svg(ICON.close, '1.25rem'),
    ]);

    function showError(msg, login) {
      errorBox.textContent = '';
      append(errorBox, [svg(ICON.alert, '1.1rem'), h('span', null, [msg, login ? ' ' : null, login ? h('a', { href: '/auth/login?continue=' + encodeURIComponent(location.pathname), text: t('common.toLogin') }) : null])]);
      errorBox.hidden = false;
    }

    var busy = false;
    function setBusy(b) {
      busy = b;
      submitBtn.disabled = b;
      input.disabled = b;
      toggle.disabled = b;
      videoToggle.disabled = b;
      submitBtn.textContent = '';
      append(submitBtn, b ? [svg(ICON.sync, '1rem', 'ifed-spin'), t('common.connecting')] : [svg(ICON.earthPlus, '1rem'), t('common.connect')]);
    }

    var form = h(
      'form',
      {
        novalidate: true,
        onsubmit: function (e) {
          e.preventDefault();
          if (busy) return;
          errorBox.hidden = true;
          var url = (input.value || '').trim();
          var parsed = null;
          try {
            parsed = new URL(url);
          } catch (err) {
            parsed = null;
          }
          if (!parsed || !/^https?:$/.test(parsed.protocol)) {
            showError(t('connect.invalidUrl'));
            input.focus();
            return;
          }
          if (!/\/(share|s)\/[^/]+/.test(parsed.pathname)) {
            showError(t('connect.notShareLink'));
            input.focus();
            return;
          }
          setBusy(true);
          api('POST', '/links', { shareUrl: url, showInTimeline: !!toggle.checked, importVideos: !!videoToggle.checked }).then(function (res) {
            if (!modalState) return;
            setBusy(false);
            if (res.ok && res.data && res.data.albumId) {
              getLinks(true);
              closeModal();
              spaNavigate('/albums/' + encodeURIComponent(res.data.albumId));
              return;
            }
            showError(errorMessage(res), res.status === 401);
            input.focus();
          });
        },
      },
      [
        h('div', { class: 'ifed-modal-body' }, [
          h('p', {
            id: 'ifed-modal-desc',
            text: t('connect.description'),
          }),
          h('div', null, [
            h('label', { class: 'ifed-label', for: 'ifed-share-url', text: t('connect.shareLink') }),
            input,
            h('div', { id: 'ifed-share-hint', class: 'ifed-hint', text: t('connect.shareHint') }),
          ]),
          h('div', { class: 'ifed-row' }, [
            h('label', { for: 'ifed-show-timeline', style: { cursor: 'pointer' } }, [
              h('div', { style: { fontWeight: '500' }, text: t('connect.showInTimeline') }),
              h('div', { class: 'ifed-hint', style: { marginTop: '0' }, text: t('connect.showInTimelineHint') }),
            ]),
            toggle,
          ]),
          h('div', { class: 'ifed-row' }, [
            h('label', { for: 'ifed-import-videos', style: { cursor: 'pointer' } }, [
              h('div', { style: { fontWeight: '500' }, text: t('connect.importVideos') }),
              h('div', {
                class: 'ifed-hint',
                style: { marginTop: '0' },
                text: t('connect.importVideosHint'),
              }),
            ]),
            videoToggle,
          ]),
          errorBox,
        ]),
        h('div', { class: 'ifed-modal-foot' }, [cancelBtn, submitBtn]),
      ],
    );

    var dialog = h('div', { class: 'ifed-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'ifed-modal-title', 'aria-describedby': 'ifed-modal-desc' }, [
      h('div', { class: 'ifed-modal-head' }, [h('h2', { id: 'ifed-modal-title', text: t('connect.title') }), closeBtn]),
      form,
    ]);

    var overlay = h('div', { class: 'ifed-overlay', 'data-ifed': 'modal' }, [dialog]);
    overlay.addEventListener('mousedown', function (e) {
      if (e.target === overlay && !busy) closeModal();
    });
    // Don't pass keyboard events on to Immich's global shortcuts
    overlay.addEventListener('keydown', function (e) {
      e.stopPropagation();
    });
    overlay.addEventListener('keyup', function (e) {
      e.stopPropagation();
    });

    var onDocKey = function (e) {
      if (!modalState) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (!busy) closeModal();
        return;
      }
      if (e.key === 'Tab') {
        var f = focusables(dialog);
        if (!f.length) return;
        var first = f[0];
        var last = f[f.length - 1];
        if (!dialog.contains(document.activeElement)) {
          e.preventDefault();
          first.focus();
        } else if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onDocKey, true);

    modalState = { overlay: overlay, onDocKey: onDocKey, returnFocus: trigger || document.activeElement };
    document.body.appendChild(overlay);
    setTimeout(function () {
      try {
        input.focus();
      } catch (e) {
        /* ignore */
      }
    }, 0);
  }

  // ---------------------------------------------------------------------------------------------
  // b) Banner on the album page
  // ---------------------------------------------------------------------------------------------

  var banner = { albumId: null, link: null, el: null, timer: null, confirming: false, busy: false, msg: null, wasEmpty: false, startCount: null };

  function resetBanner() {
    if (banner.timer) clearTimeout(banner.timer);
    if (banner.el) banner.el.remove();
    banner = { albumId: null, link: null, el: null, timer: null, confirming: false, busy: false, msg: null, wasEmpty: false, startCount: null };
  }

  function findAlbumAnchor() {
    var top = document.querySelector('#virtual-timeline > section');
    if (!top) return null;
    var sections = top.children;
    for (var i = 0; i < sections.length; i++) {
      var s = sections[i];
      if (s.tagName === 'SECTION' && s.id !== 'empty-album') return { parent: s, mode: 'append' };
    }
    return { parent: top, mode: 'prepend' };
  }

  function placeBanner() {
    if (!banner.el) return;
    var anchor = findAlbumAnchor();
    if (!anchor) return;
    if (banner.el.parentElement === anchor.parent) {
      // Already in place – no need to keep it behind Svelte content when appending
      return;
    }
    if (anchor.mode === 'append') anchor.parent.appendChild(banner.el);
    else anchor.parent.insertBefore(banner.el, anchor.parent.firstChild);
  }

  function schedulePoll() {
    if (banner.timer) clearTimeout(banner.timer);
    banner.timer = null;
    if (!banner.link || !banner.link.syncing) return;
    var albumId = banner.albumId;
    banner.timer = setTimeout(function () {
      if (banner.albumId !== albumId) return;
      refreshBanner(true);
    }, 5000);
  }

  function refreshBanner(force) {
    var albumId = banner.albumId;
    return getLinks(force).then(
      safe(function (links) {
        if (banner.albumId !== albumId) return;
        var link = null;
        for (var i = 0; i < links.length; i++) if (links[i] && links[i].albumId === albumId) link = links[i];
        var prev = banner.link;
        banner.link = link;
        if (!link) {
          if (banner.el) banner.el.remove();
          banner.el = null;
          return;
        }
        if (banner.startCount === null) banner.startCount = link.assetCount;
        // Sync just finished → refresh the view if needed
        if (prev && prev.syncing && !link.syncing) {
          var changed = link.assetCount !== banner.startCount;
          if (changed && document.getElementById('empty-album') && !modalState && !banner.confirming) {
            location.reload();
            return;
          }
          if (changed) banner.msg = { kind: 'reload', key: 'banner.syncDone' };
        }
        // Don't re-render during the disconnect confirmation (keeps focus/checkbox)
        if (!banner.confirming || !banner.el) renderBanner();
        schedulePoll();
      }),
    );
  }

  function renderBanner() {
    var l = banner.link;
    if (!l) return;
    if (!banner.el) {
      banner.el = h('div', { class: 'ifed-banner', 'data-ifed': 'banner', role: 'region', 'aria-label': t('banner.label') });
      banner.el.addEventListener('keydown', onBannerKey);
    }
    var el = banner.el;
    el.textContent = '';

    var meta = [];
    if (l.syncing) {
      var p = l.progress;
      meta.push(
        h('span', { class: 'ifed-chip' }, [
          svg(ICON.sync, '0.9em', 'ifed-spin'),
          p && p.total ? t('common.syncingProgress', { done: I().formatNumber(p.done), total: I().formatNumber(p.total) }) : t('common.syncing'),
        ]),
      );
    } else if (l.lastSyncedAt) {
      meta.push(h('span', { title: absTime(l.lastSyncedAt), text: t('banner.lastSynced', { time: relTime(l.lastSyncedAt) }) }));
    } else {
      meta.push(h('span', { text: t('banner.neverSynced') }));
    }
    if (typeof l.assetCount === 'number') {
      meta.push(h('span', { class: 'ifed-sep', text: '·', 'aria-hidden': 'true' }));
      meta.push(h('span', { text: t('banner.items', { count: l.assetCount }) }));
    }
    if (l.importVideos === false) {
      meta.push(h('span', { class: 'ifed-sep', text: '·', 'aria-hidden': 'true' }));
      meta.push(h('span', { text: t('banner.noVideos') }));
    }
    if (l.allowDownload === false) {
      meta.push(h('span', { class: 'ifed-sep', text: '·', 'aria-hidden': 'true' }));
      meta.push(h('span', { title: t('banner.originalsBlockedTitle'), text: t('banner.originalsBlocked') }));
    }

    var main = h('div', { class: 'ifed-banner-main' }, [
      svg(ICON.earth, '1.5rem', 'ifed-banner-icon'),
      h('div', { style: { minWidth: '0' } }, [
        h('div', { class: 'ifed-banner-title' }, [
          I().parts('banner.federatedFrom', { host: h('b', { text: l.serverHost || t('banner.unknownServer') }) }),
          l.remoteOwnerName ? ' (' + l.remoteOwnerName + ')' : null,
        ]),
        h('div', { class: 'ifed-banner-meta', 'aria-live': 'polite' }, meta),
        l.allowDownload !== false
          ? h('div', {
              class: 'ifed-hint',
              style: { marginTop: '.2rem' },
              text: t('banner.zipHint'),
            })
          : null,
        l.lastError && !l.syncing
          ? h('div', { class: 'ifed-err', style: { marginTop: '.25rem' }, text: t('banner.lastSyncError', { error: String(l.lastError) }) })
          : null,
        banner.msg && banner.msg.kind === 'error' ? h('div', { class: 'ifed-err', role: 'alert', style: { marginTop: '.25rem' }, text: banner.msg.text }) : null,
        banner.msg && banner.msg.kind === 'reload'
          ? h('div', { class: 'ifed-ok', style: { marginTop: '.25rem', display: 'flex', alignItems: 'center', gap: '.5rem', flexWrap: 'wrap' } }, [
              t(banner.msg.key),
              h('button', { type: 'button', class: 'ifed-btn ifed-btn-outline', style: { padding: '.15rem .6rem' }, onclick: function () { location.reload(); } }, [
                svg(ICON.refresh, '1em'),
                t('banner.refreshView'),
              ]),
            ])
          : null,
      ]),
    ]);

    var actions = h('div', { class: 'ifed-actions' }, [
      h(
        'button',
        {
          type: 'button',
          class: 'ifed-btn',
          disabled: l.syncing || banner.busy,
          onclick: function () {
            syncNow();
          },
        },
        [svg(ICON.sync, '1.1em', l.syncing ? 'ifed-spin' : null), t('common.syncNow')],
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'ifed-btn ifed-btn-danger',
          disabled: banner.busy,
          'aria-expanded': banner.confirming ? 'true' : 'false',
          onclick: function () {
            banner.confirming = true;
            banner.msg = null;
            renderBanner();
            var c = el.querySelector('[data-ifed="confirm-yes"]');
            if (c) c.focus();
          },
        },
        [svg(ICON.linkOff, '1.1em'), t('common.disconnect')],
      ),
      h('a', { class: 'ifed-btn', href: BASE + '/', 'data-sveltekit-reload': '', title: t('banner.manageTitle') }, [svg(ICON.cog, '1.1em'), h('span', { text: t('banner.manage') })]),
    ]);

    append(el, [main, banner.confirming ? null : actions]);

    if (banner.confirming) {
      var del = h('input', {
        type: 'checkbox',
        checked: banner.deleteAssets !== false,
        onchange: function (e) {
          banner.deleteAssets = !!e.currentTarget.checked;
        },
      });
      append(
        el,
        h('div', { class: 'ifed-confirm', role: 'group', 'aria-label': t('common.confirmDisconnect') }, [
          h('span', { style: { fontWeight: '500' }, text: t('banner.confirmQuestion', { host: l.serverHost || t('common.thisServer') }) }),
          h('label', { class: 'ifed-check' }, [del, t('banner.deleteLocal')]),
          h('span', { style: { flex: '1' } }),
          h('button', {
            type: 'button',
            class: 'ifed-btn ifed-btn-outline',
            text: t('common.cancel'),
            disabled: banner.busy,
            onclick: function () {
              banner.confirming = false;
              renderBanner();
            },
          }),
          h(
            'button',
            {
              type: 'button',
              class: 'ifed-btn ifed-btn-danger-filled',
              'data-ifed': 'confirm-yes',
              disabled: banner.busy,
              onclick: function () {
                disconnect(!!del.checked);
              },
            },
            banner.busy ? [svg(ICON.sync, '1em', 'ifed-spin'), t('common.disconnecting')] : [svg(ICON.linkOff, '1em'), t('common.disconnect')],
          ),
        ]),
      );
    }
    placeBanner();
  }

  function onBannerKey(e) {
    if (e.key === 'Escape' && banner.confirming && !banner.busy) {
      e.stopPropagation();
      banner.confirming = false;
      renderBanner();
    }
  }

  function syncNow() {
    var l = banner.link;
    if (!l || banner.busy) return;
    banner.busy = true;
    banner.msg = null;
    renderBanner();
    api('POST', '/links/' + encodeURIComponent(l.id) + '/sync').then(function (res) {
      banner.busy = false;
      if (banner.link !== l && (!banner.link || banner.link.id !== l.id)) return;
      if (res.ok) {
        banner.link = Object.assign({}, banner.link, { syncing: true });
        banner.startCount = banner.link.assetCount;
        renderBanner();
        schedulePoll();
      } else {
        banner.msg = { kind: 'error', text: errorMessage(res) };
        renderBanner();
      }
    });
  }

  function disconnect(deleteAssets) {
    var l = banner.link;
    if (!l || banner.busy) return;
    banner.busy = true;
    renderBanner();
    api('DELETE', '/links/' + encodeURIComponent(l.id) + (deleteAssets ? '?deleteAssets=true' : '?deleteAssets=false')).then(function (res) {
      banner.busy = false;
      if (res.ok || res.status === 404) {
        getLinks(true);
        resetBanner();
        if (deleteAssets) spaNavigate('/albums');
        return;
      }
      banner.confirming = false;
      banner.msg = { kind: 'error', text: errorMessage(res) };
      renderBanner();
    });
  }

  var ensureAlbumBanner = safe(function (albumId) {
    if (banner.albumId !== albumId) {
      resetBanner();
      banner.albumId = albumId;
      banner.wasEmpty = !!document.getElementById('empty-album');
      refreshBanner(false);
      return;
    }
    if (banner.el && !banner.el.isConnected) placeBanner();
    else if (banner.el) placeBanner();
  });

  // ---------------------------------------------------------------------------------------------
  // c) Badge in the asset viewer
  // ---------------------------------------------------------------------------------------------

  var assetBadge = { id: null, info: undefined, panelEl: null, floatEl: null };

  function resetAssetBadge() {
    if (assetBadge.panelEl) assetBadge.panelEl.remove();
    if (assetBadge.floatEl) assetBadge.floatEl.remove();
    assetBadge = { id: null, info: undefined, panelEl: null, floatEl: null };
  }

  function placeAssetBadge() {
    var info = assetBadge.info;
    if (!info) return;
    var viewer = document.getElementById('immich-asset-viewer');
    if (!viewer) return;
    var panel = document.getElementById('detail-panel');
    // Only use the info panel (DetailPanel.svelte: <section class="relative p-2">), not the editor
    // (section.h-full) and not the faces panel (section.absolute)
    var panelSection = panel && panel.querySelector(':scope > section.relative:not(.h-full):not(.absolute)');
    var header = panelSection && panelSection.firstElementChild;
    var host = info.serverHost || t('asset.anotherServer');

    if (header) {
      if (!assetBadge.panelEl) {
        assetBadge.panelEl = h('div', { class: 'ifed-asset-badge', 'data-ifed': 'asset-badge', role: 'note' }, [
          svg(ICON.earth, '1.25rem'),
          h('div', { style: { minWidth: '0' } }, [
            I().parts('asset.originalOn', { host: h('b', { text: host }) }),
            info.remoteOwnerName ? h('small', { text: t('asset.sharedBy', { name: info.remoteOwnerName }) }) : null,
            h('small', {
              text: info.allowDownload === false ? t('asset.downloadBlocked') : t('asset.localInfo'),
            }),
          ]),
        ]);
      }
      if (assetBadge.panelEl.previousElementSibling !== header || assetBadge.panelEl.parentElement !== panelSection) {
        panelSection.insertBefore(assetBadge.panelEl, header.nextSibling);
      }
      if (assetBadge.floatEl) {
        assetBadge.floatEl.remove();
      }
    } else {
      if (assetBadge.panelEl) assetBadge.panelEl.remove();
      if (!assetBadge.floatEl) {
        assetBadge.floatEl = h('div', { class: 'ifed-asset-float', 'data-ifed': 'asset-float', role: 'note' }, [
          svg(ICON.earth, '1em'),
          h('span', { text: t('asset.originalOn', { host: host }) }),
        ]);
      }
      if (assetBadge.floatEl.parentElement !== viewer) viewer.appendChild(assetBadge.floatEl);
    }
  }

  var ensureAssetBadge = safe(function (assetId) {
    if (assetBadge.id !== assetId) {
      resetAssetBadge();
      assetBadge.id = assetId;
      getAssetInfo(assetId).then(
        safe(function (info) {
          if (assetBadge.id !== assetId) return;
          assetBadge.info = info;
          placeAssetBadge();
        }),
      );
      return;
    }
    if (assetBadge.info) placeAssetBadge();
  });

  // ---------------------------------------------------------------------------------------------
  // Main loop: routing + DOM observation
  // ---------------------------------------------------------------------------------------------

  var lastPath = null;
  var lastLang = null;

  /** The Immich language changed at runtime → rebuild every injected element with the new texts. */
  function relocalize() {
    var els = document.querySelectorAll('[data-ifed="sidebar"],[data-ifed="account"],[data-ifed="connect-btn"],[data-ifed="card-chip"]');
    for (var i = 0; i < els.length; i++) els[i].remove();
    if (banner.el && banner.link) renderBanner();
    if (assetBadge.panelEl) assetBadge.panelEl.remove();
    if (assetBadge.floatEl) assetBadge.floatEl.remove();
    assetBadge.panelEl = null;
    assetBadge.floatEl = null;
    if (assetBadge.info) placeAssetBadge();
    if (modalState) closeModal();
  }

  var run = safe(function () {
    if (!I()) return; // i18n.js not loaded (yet)
    ensureStyle();
    // Resolved lazily on every pass (cheap, cached in i18n.js): follows a language change in Immich's settings
    var lang = I().lang();
    if (lang !== lastLang) {
      if (lastLang !== null) relocalize();
      lastLang = lang;
    }
    var path = location.pathname;
    // Do nothing on login/onboarding pages
    if (/^\/(auth|share|s)\//.test(path)) {
      resetBanner();
      resetAssetBadge();
      return;
    }

    if (path !== lastPath) {
      lastPath = path;
      if (modalState && !RE_ALBUMS.test(path)) closeModal();
    }

    ensureSidebar();
    ensureAccountMenu();

    if (RE_ALBUMS.test(path)) {
      ensureAlbumsButton();
      if (linksCache.data) markAlbumCards();
      else getLinks(false).then(markAlbumCards);
    }

    var am = RE_ALBUM.exec(path);
    if (am) ensureAlbumBanner(am[1]);
    else if (banner.albumId) resetBanner();

    var asm = RE_ASSET.exec(path);
    if (asm && document.getElementById('immich-asset-viewer')) ensureAssetBadge(asm[1]);
    else if (assetBadge.id) resetAssetBadge();
  });

  var scheduled = null;
  function schedule() {
    if (scheduled) return;
    scheduled = setTimeout(function () {
      scheduled = null;
      run();
    }, 120);
  }

  function hookHistory(name) {
    try {
      var orig = history[name];
      if (typeof orig !== 'function') return;
      history[name] = function () {
        var r = orig.apply(this, arguments);
        schedule();
        return r;
      };
    } catch (e) {
      /* ignore */
    }
  }
  hookHistory('pushState');
  hookHistory('replaceState');
  window.addEventListener('popstate', schedule);

  // Keep the banner's relative time ("3 minutes ago") up to date
  setInterval(
    safe(function () {
      if (banner.el && banner.link && !banner.link.syncing && !banner.confirming && !banner.busy) renderBanner();
    }),
    60000,
  );

  function start() {
    try {
      var mo = new MutationObserver(function (records) {
        // Ignore our own changes to avoid loops
        for (var i = 0; i < records.length; i++) {
          var target = records[i].target;
          if (!(target && target.closest && target.closest('[data-ifed]'))) {
            schedule();
            return;
          }
        }
      });
      mo.observe(document.body || document.documentElement, { childList: true, subtree: true });
    } catch (e) {
      /* ignore */
    }
    schedule();
  }

  window.__immichFederation = {
    version: 1,
    refresh: function () {
      getLinks(true);
      assetCache.clear();
      schedule();
    },
    openConnect: function () {
      if (I()) openConnectModal(null);
    },
    /**
     * After an Immich update, checks which DOM anchors are found on the CURRENT page.
     * Call in the browser console: __immichFederation.diagnose()
     */
    diagnose: function () {
      var q = function (sel) {
        try {
          return !!document.querySelector(sel);
        } catch (e) {
          return false;
        }
      };
      var path = location.pathname;
      var r = {
        path: path,
        'sidebar (nav#sidebar + a[href=/sharing|/albums])': q('nav#sidebar a[href="/sharing"]') || q('nav#sidebar a[href="/albums"]'),
        'sidebar entry inserted': q('[data-ifed="sidebar"]'),
        'account menu (#account-info-panel, only when open)': q('#account-info-panel a[href^="/user-settings"]'),
      };
      if (RE_ALBUMS.test(path)) {
        r['albums: create button (mdiPlusBoxOutline)'] = !!findCreateAlbumButton();
        r['albums: fallback #user-page-header'] = q('#user-page-header');
        r['albums: cards [data-testid=album-details]'] = q('main a[href^="/albums/"] [data-testid="album-details"]');
        r['albums: connect button inserted'] = q('[data-ifed="connect-btn"]');
      }
      if (RE_ALBUM.test(path)) {
        r['album: #virtual-timeline > section'] = q('#virtual-timeline > section');
        r['album: banner inserted (federated albums only)'] = q('[data-ifed="banner"]');
      }
      if (RE_ASSET.test(path)) {
        r['viewer: #immich-asset-viewer'] = q('#immich-asset-viewer');
        r['viewer: #detail-panel > section.relative (only with info open)'] = q('#detail-panel > section.relative');
        r['viewer: badge inserted (federated assets only)'] = q('[data-ifed="asset-badge"]') || q('[data-ifed="asset-float"]');
      }
      r.lang = I() ? I().lang() : null;
      r.missing = Object.keys(missingSeen);
      try {
        console.table(r);
      } catch (e) {
        /* ignore */
      }
      return r;
    },
  };

  function boot() {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
    // Language changed in another tab (same tab: the DOM mutations of Immich's re-render trigger run())
    try {
      I().onChange(schedule);
    } catch (e) {
      /* ignore */
    }
  }

  // The gateway injects i18n.js right before this script (both `defer` → executed in document order).
  // If it is missing anyway (e.g. HTML cached from an older gateway version), load it on demand.
  if (I()) {
    boot();
  } else {
    var loader = document.createElement('script');
    loader.src = BASE + '/i18n.js';
    loader.onload = function () {
      if (I()) boot();
    };
    (document.head || document.documentElement).appendChild(loader);
  }
})();
