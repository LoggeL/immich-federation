/*
 * UI-Smoke-Test von inject.js in der ECHTEN Immich-Web-App (durch das Gateway), z. B. nach einem Immich-Update.
 * Nicht Teil von `npm test` (braucht ein laufendes Immich + Browser).
 *
 *   npm i -D playwright-core   # optional, oder PLAYWRIGHT_CORE=/pfad/zu/node_modules/playwright-core
 *   FED_URL=http://localhost:2283 FED_EMAIL=… FED_PASSWORD=… \
 *   [CHROME_PATH=/pfad/zu/chrome] [FED_SHOTS=./ui-shots] node test/ui/ui-smoke.cjs
 *
 * Erwartet mindestens ein verbundenes föderiertes Album beim angemeldeten Benutzer.
 * Exit-Code 1, wenn ein Anker fehlt.
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');

const G = (process.env.FED_URL || 'http://localhost:2283').replace(/\/$/, '');
const EMAIL = process.env.FED_EMAIL;
const PASSWORD = process.env.FED_PASSWORD;
const SHOTS = process.env.FED_SHOTS || '';
if (!EMAIL || !PASSWORD) {
  console.error('FED_EMAIL und FED_PASSWORD setzen');
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
  for (const scheme of ['light', 'dark']) {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, colorScheme: scheme, locale: 'de-DE' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('pageerror', (e) => errors.push('pageerror ' + e.message));
    const fedResponses = [];
    page.on('response', (r) => r.headers()['x-immich-federation'] && fedResponses.push(`${r.status()} ${r.url().replace(G, '')}`));

    await page.goto(G + '/auth/login', { waitUntil: 'networkidle' });
    await page.fill('#email', EMAIL);
    await page.fill('#password', PASSWORD);
    await page.click('button[type=submit]');
    await page.waitForURL(/\/photos/, { timeout: 20000 });
    await page.waitForTimeout(1500);
    step(`[${scheme}] inject.js geladen`, await page.evaluate(() => !!window.__immichFederation));
    step(`[${scheme}] Sidebar-Eintrag`, (await page.locator('[data-ifed=sidebar]').count()) === 1);
    await shot(page, `${scheme}-1-photos`);

    // Konto-Menü
    // NavigationBar.svelte: <button title="<name> (<email>)"> mit dem Avatar
    await page.locator(`button[title*="(${EMAIL})"]`).first().click().catch(() => {});
    await page.waitForTimeout(800);
    step(`[${scheme}] Konto-Menü-Link`, (await page.locator('[data-ifed=account]').count()) === 1);
    await page.keyboard.press('Escape');

    await page.click('nav#sidebar a[href="/albums"]');
    await page.waitForURL(/\/albums$/);
    await page.waitForTimeout(1500);
    step(`[${scheme}] Alben: Verbinden-Button`, (await page.locator('[data-ifed=connect-btn]').count()) === 1);
    const chips = await page.locator('[data-ifed=card-chip]').count();
    step(`[${scheme}] Alben: Chip auf föderierten Karten`, chips >= 1, String(chips));
    await shot(page, `${scheme}-2-albums`);

    if (scheme === 'light') {
      await page.locator('[data-ifed=connect-btn]').click();
      step('[light] Modal öffnet', (await page.locator('[data-ifed=modal]').count()) === 1);
      step('[light] Modal: Videos-Schalter', (await page.locator('#ifed-import-videos').count()) === 1);
      await shot(page, `${scheme}-3-modal`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      step('[light] Modal: Esc schließt', (await page.locator('[data-ifed=modal]').count()) === 0);
    }

    // ein föderiertes Album, dessen Freigabe Downloads erlaubt (sonst gibt es kein Original vom Freund)
    const href = await page.evaluate(async () => {
      const links = await (await fetch('/federation/api/links')).json();
      const l = links.find((x) => x.allowDownload && x.assetCount > 0) || links[0];
      return l ? '/albums/' + l.albumId : null;
    });
    if (href) {
      await page.click(`a[href="${href}"]`);
      await page.waitForURL(new RegExp(href + '$'));
      await page.waitForTimeout(2000);
      const banner = page.locator('[data-ifed=banner]');
      step(`[${scheme}] Album: Banner`, (await banner.count()) === 1, (await banner.innerText().catch(() => '')).replace(/\s+/g, ' '));
      await shot(page, `${scheme}-4-album`);
      await page.locator('#virtual-timeline a[href*="/photos/"]').first().click();
      await page.waitForURL(/\/photos\/[0-9a-f-]{36}/, { timeout: 15000 });
      await page.waitForTimeout(2500);
      step(`[${scheme}] Viewer: Badge/Chip`, (await page.locator('[data-ifed=asset-float], [data-ifed=asset-badge]').count()) >= 1);
      await page.keyboard.press('i');
      await page.waitForTimeout(1500);
      step(`[${scheme}] Viewer: Badge im Info-Panel`, (await page.locator('[data-ifed=asset-badge]').count()) === 1);
      await shot(page, `${scheme}-5-viewer`);
      const diag = await page.evaluate(() => window.__immichFederation.diagnose());
      const viewerKeys = Object.entries(diag).filter(([k]) => k.startsWith('viewer:'));
      step(`[${scheme}] diagnose() im Viewer`, viewerKeys.length > 0 && viewerKeys.every(([, v]) => v === true), Object.fromEntries(viewerKeys));
      for (let i = 0; i < 6 && (await page.locator('#immich-asset-viewer video').count()) > 0; i++) {
        await page.keyboard.press('ArrowRight');
        await page.waitForTimeout(1500);
      }
      fedResponses.length = 0;
      await page.mouse.dblclick(500, 450);
      await page.waitForTimeout(4000);
      step(`[${scheme}] Zoom lädt Original vom Freund`, fedResponses.length > 0, fedResponses.slice(0, 4));
      await page.keyboard.press('Escape');
    }

    for (const p of ['/folders', '/tags']) {
      await page.goto(G + p, { waitUntil: 'networkidle' });
      await page.waitForTimeout(1200);
      step(`[${scheme}] ${p}: kein Sidebar-Eintrag im Explorer`, (await page.locator('[data-ifed=sidebar]').count()) === 0);
    }

    await page.goto(G + '/federation/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);
    const cards = await page.locator('article.link').count();
    step(`[${scheme}] /federation/ listet Links`, cards >= 1, String(cards));
    await shot(page, `${scheme}-6-federation`);
    step(`[${scheme}] keine Konsolenfehler`, errors.filter((e) => !/favicon/.test(e)).length === 0, errors.slice(0, 5));
    await ctx.close();
  }
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`${results.length - failed.length}/${results.length} bestanden`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
