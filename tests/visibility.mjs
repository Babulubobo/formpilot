import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href : 'playwright');
const browser = await chromium.launch({ headless: true, channel: 'chromium',
  ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}),
});
try {
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><section style="position:fixed;right:0;top:0;transform:translateX(100%);width:300px" id="drawer">
    <h2>Saved items</h2><div><button>Bookmarks</button><button>History</button></div></section>
    <section style="opacity:0"><label>Hidden field<input></label></section>
    <section style="position:fixed;bottom:0;transform:translateY(100%);height:100px"><label>Closed bottom drawer<input></label></section>
    <div style="height:2000px"></div><label>Visible below fold<input></label>`);
  await page.evaluate(() => { window.chrome = { runtime: { onMessage: { addListener(fn) { window.bridge = fn; } } } }; });
  await page.addScriptTag({ path: fileURLToPath(new URL('../extension/content.js', import.meta.url)) });
  const scan = () => page.evaluate(() => new Promise(resolve => window.bridge({ type: 'JEV_SCAN' }, {}, resolve)));
  const closed = await scan();
  assert.deepEqual(closed.fields.map(field => field.label), ['Visible below fold']);
  assert.equal(closed.structureCandidates.length, 0);
  await page.addStyleTag({ content: 'html { scrollbar-gutter: stable; }' });
  assert.deepEqual((await scan()).fields.map(field => field.label), ['Visible below fold'], 'Reserved scrollbar space must not expose a closed drawer');
  await page.locator('#drawer').evaluate(node => node.style.transform = 'none');
  assert.equal((await scan()).structureCandidates.length, 1, 'Opening the drawer makes its controls discoverable');
  console.log('PASS: closed fixed drawers and transparent ancestors are ignored; scrollable below-fold fields remain visible.');
} finally { await browser.close(); }
