/*
 * UI smoke test of inject.js in the REAL Immich web app (through the gateway), e.g. after an Immich update.
 * Not part of `npm test` (needs a running Immich + browser).
 *
 *   npm i -D playwright-core   # optional, or PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core
 *   FED_URL=http://localhost:2283 FED_EMAIL=… FED_PASSWORD=… \
 *   [CHROME_PATH=/path/to/chrome] [FED_SHOTS=./ui-shots] node test/ui/ui-smoke.cjs
 *
 * Expects at least one connected federated album for the logged-in user.
 * Runs light mode with a German browser and dark mode with an English one (no Immich "lang" setting stored →
 * Immich and the injected UI follow the browser language). All selectors are structural, never UI texts.
 * Exit code 1 if an anchor is missing.
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');

const G = (process.env.FED_URL || 'http://localhost:2283').replace(/\/$/, '');
const EMAIL = process.env.FED_EMAIL;
const PASSWORD = process.env.FED_PASSWORD;
const SHOTS = process.env.FED_SHOTS || '';
if (!EMAIL || !PASSWORD) {
  console.error('Set FED_EMAIL and FED_PASSWORD');
  process.exit(2);
}
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
const step = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(ok ? 'PASS' : 'FAIL', name, typeof detail === 'string' ? detail : JSON.stringify(detail));
};
const shot = (page, name) => (SHOTS ? page.screenshot({ path: path.join(SHOTS, name + '.png') }) : Promise.resolve());

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  const runs = [
    { scheme: 'light', locale: 'de-DE', lang: 'de', federation: 'Föderation' },
    { scheme: 'dark', locale: 'en-US', lang: 'en', federation: 'Federation' },
  ];
  for (const { scheme, locale, lang, federation } of runs) {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, colorScheme: scheme, locale });
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('pageerror', (e) => errors.push('pageerror ' + e.message));
    const fedResponses = [];
    page.on('response', (r) => r.headers()['x-immich-federation'] && fedResponses.push(`${r.status()} ${r.url().replace(G, '')}`));
    const langHeaders = new Set();
    page.on('request', (r) => r.url().includes('/federation/api/') && langHeaders.add(r.headers()['x-federation-lang'] || '(none)'));

    await page.goto(G + '/auth/login', { waitUntil: 'networkidle' });
    await page.fill('#email', EMAIL);
    await page.fill('#password', PASSWORD);
    await page.click('button[type=submit]');
    await page.waitForURL(/\/photos/, { timeout: 20000 });
    await page.waitForTimeout(1500);
    step(`[${scheme}] inject.js + i18n.js loaded`, await page.evaluate(() => !!window.__immichFederation && !!window.__ifedI18n));
    step(`[${scheme}] language resolves to ${lang}`, (await page.evaluate(() => window.__ifedI18n.lang())) === lang);
    step(`[${scheme}] sidebar entry`, (await page.locator('[data-ifed=sidebar]').count()) === 1);
    const sidebarText = (await page.locator('[data-ifed=sidebar]').innerText().catch(() => '')).trim();
    step(`[${scheme}] sidebar entry in ${lang}`, sidebarText === federation, sidebarText);
    await shot(page, `${scheme}-1-photos`);

    // Account menu
    // NavigationBar.svelte: <button title="<name> (<email>)"> with the avatar
    await page.locator(`button[title*="(${EMAIL})"]`).first().click().catch(() => {});
    await page.waitForTimeout(800);
    step(`[${scheme}] account menu link`, (await page.locator('[data-ifed=account]').count()) === 1);
    await page.keyboard.press('Escape');

    await page.click('nav#sidebar a[href="/albums"]');
    await page.waitForURL(/\/albums$/);
    await page.waitForTimeout(1500);
    step(`[${scheme}] albums: connect button`, (await page.locator('[data-ifed=connect-btn]').count()) === 1);
    const chips = await page.locator('[data-ifed=card-chip]').count();
    step(`[${scheme}] albums: chip on federated cards`, chips >= 1, String(chips));
    await shot(page, `${scheme}-2-albums`);

    if (scheme === 'light') {
      await page.locator('[data-ifed=connect-btn]').click();
      step('[light] modal opens', (await page.locator('[data-ifed=modal]').count()) === 1);
      step('[light] modal: videos switch', (await page.locator('#ifed-import-videos').count()) === 1);
      await shot(page, `${scheme}-3-modal`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      step('[light] modal: Esc closes', (await page.locator('[data-ifed=modal]').count()) === 0);
    }

    // a federated album whose share allows downloads (otherwise there is no original from the friend)
    const href = await page.evaluate(async () => {
      const links = await (await fetch('/federation/api/links', { headers: window.__ifedI18n.headers() })).json();
      const l = links.find((x) => x.allowDownload && x.assetCount > 0) || links[0];
      return l ? '/albums/' + l.albumId : null;
    });
    if (href) {
      await page.click(`a[href="${href}"]`);
      await page.waitForURL(new RegExp(href + '$'));
      await page.waitForTimeout(2000);
      const banner = page.locator('[data-ifed=banner]');
      step(`[${scheme}] album: banner`, (await banner.count()) === 1, (await banner.innerText().catch(() => '')).replace(/\s+/g, ' '));
      await shot(page, `${scheme}-4-album`);
      await page.locator('#virtual-timeline a[href*="/photos/"]').first().click();
      await page.waitForURL(/\/photos\/[0-9a-f-]{36}/, { timeout: 15000 });
      await page.waitForTimeout(2500);
      step(`[${scheme}] viewer: badge/chip`, (await page.locator('[data-ifed=asset-float], [data-ifed=asset-badge]').count()) >= 1);
      await page.keyboard.press('i');
      await page.waitForTimeout(1500);
      step(`[${scheme}] viewer: badge in info panel`, (await page.locator('[data-ifed=asset-badge]').count()) === 1);
      await shot(page, `${scheme}-5-viewer`);
      const diag = await page.evaluate(() => window.__immichFederation.diagnose());
      const viewerKeys = Object.entries(diag).filter(([k]) => k.startsWith('viewer:'));
      step(`[${scheme}] diagnose() in viewer`, viewerKeys.length > 0 && viewerKeys.every(([, v]) => v === true), Object.fromEntries(viewerKeys));
      for (let i = 0; i < 6 && (await page.locator('#immich-asset-viewer video').count()) > 0; i++) {
        await page.keyboard.press('ArrowRight');
        await page.waitForTimeout(1500);
      }
      fedResponses.length = 0;
      await page.mouse.dblclick(500, 450);
      await page.waitForTimeout(4000);
      step(`[${scheme}] zoom loads original from friend`, fedResponses.length > 0, fedResponses.slice(0, 4));
      await page.keyboard.press('Escape');
    }

    for (const p of ['/folders', '/tags']) {
      await page.goto(G + p, { waitUntil: 'networkidle' });
      await page.waitForTimeout(1200);
      step(`[${scheme}] ${p}: no sidebar entry in explorer`, (await page.locator('[data-ifed=sidebar]').count()) === 0);
    }

    await page.goto(G + '/federation/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);
    const cards = await page.locator('article.link').count();
    step(`[${scheme}] /federation/ lists links`, cards >= 1, String(cards));
    step(`[${scheme}] /federation/ <html lang>`, (await page.evaluate(() => document.documentElement.lang)) === lang);
    step(`[${scheme}] API requests send X-Federation-Lang: ${lang}`, langHeaders.size > 0 && [...langHeaders].every((v) => v === lang), [...langHeaders]);
    await shot(page, `${scheme}-6-federation`);
    step(`[${scheme}] no console errors`, errors.filter((e) => !/favicon/.test(e)).length === 0, errors.slice(0, 5));
    await ctx.close();
  }
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
