import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DEMO_PROFILE, demoPlan } from '../extension/brain.js';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href : 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = await mkdtemp(resolve(tmpdir(), 'jev-browser-test-'));
const extension = resolve(scratch, 'extension');
await cp(resolve(root, 'extension'), extension, { recursive: true });
const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8'));
const demoUrl = 'http://127.0.0.1:4173/demo/';
const launchProfile = (name, locale = 'zh-CN') => chromium.launchPersistentContext(resolve(scratch, name), {
  headless: true, channel: 'chromium', locale,
  ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}),
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
let server;
let context;
try {
  const running = await fetch(demoUrl, { signal: AbortSignal.timeout(1500) }).catch(() => null);
  if (running) {
    assert.equal(running.ok && await running.text() === await readFile(resolve(root, 'demo/index.html'), 'utf8'),
      true, 'Port 4173 is already serving content other than this project\'s demo');
  } else {
    server = spawn(process.execPath, ['scripts/serve.mjs'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    const serverReady = await Promise.race([
      once(server.stdout, 'data').then(() => true),
      once(server, 'exit').then(() => false),
    ]);
    if (!serverReady) throw new Error('Cannot start fixture server on port 4173');
  }
  // First load the unmodified production manifest. Pre-granting localhost here
  // would hide the exact missing-host-permission regression this test exercises.
  assert.ok(manifest.permissions.includes('tabs'));
  assert.ok(manifest.permissions.includes('activeTab'));
  assert.deepEqual(manifest.optional_host_permissions, ['http://*/*', 'https://*/*']);
  assert.ok(!manifest.host_permissions.some(origin => /127\.0\.0\.1|localhost|<all_urls>/.test(origin)));
  assert.equal(manifest.default_locale, 'en');
  const nameMessage = manifest.name.match(/^__MSG_(.+)__$/)?.[1];
  assert.ok(nameMessage, 'the extension name must use Chrome locale messages');
  for (const locale of ['en', 'zh_CN']) {
    const messages = JSON.parse(await readFile(resolve(extension, '_locales', locale, 'messages.json'), 'utf8'));
    assert.match(messages[nameMessage].message, /FormPilot/);
    assert.doesNotMatch(messages[nameMessage].message, /JEV|PoC/i);
  }
  context = await launchProfile('unprivileged-profile');
  const accessWorker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
  const accessId = new URL(accessWorker.url()).host;
  await accessWorker.evaluate(() => chrome.storage.local.set({ preferences: {
    profile: { name: '权限回归' }, mode: 'demo', deepseekModel: 'deepseek-flash', autoNext: true,
  } }));
  const accessPanel = await context.newPage();
  const accessErrors = [];
  accessPanel.on('pageerror', error => accessErrors.push(error.message));
  await accessPanel.goto(`chrome-extension://${accessId}/sidepanel.html`);
  await accessPanel.waitForFunction(() => document.querySelector('#profile-name').value === '权限回归');
  assert.equal(await accessPanel.locator('#extension-version').textContent(), `v${manifest.version}`);
  assert.match(await accessPanel.title(), /FormPilot/);
  assert.doesNotMatch(await accessPanel.title(), /JEV|PoC/i);
  assert.match(await accessPanel.locator('.app-header').textContent(), /FormPilot/);
  assert.doesNotMatch(await accessPanel.locator('.app-header').textContent(), /JEV|PoC/i);
  assert.equal(await accessPanel.locator('#language').evaluate(node => node.tagName), 'FIELDSET');
  assert.deepEqual(await accessPanel.locator('#language button[type="button"]').evaluateAll(nodes => nodes.map(node => node.value).sort()), ['en', 'zh-CN']);
  assert.equal(await accessPanel.locator('#language button[aria-pressed="true"]').evaluate(node => node.value), 'zh-CN', 'Chinese browser locales should default to Chinese');
  assert.equal(await accessPanel.locator('#preferences-details').evaluate(node => node.open), false);
  for (const id of ['settings-form', 'profile-form', 'results-section', 'run-metrics', 'progress', 'run-hint', 'stop-btn', 'authorize-btn']) {
    assert.equal(await accessPanel.locator(`#${id}`).isVisible(), false, `${id} should stay out of the idle view`);
  }
  assert.equal(await accessPanel.locator('#start-btn').isVisible(), true);
  assert.equal(await accessPanel.locator('.action-row .primary:visible').count(), 1);
  assert.equal(await accessPanel.locator('#scan-btn').isVisible(), true);
  assert.equal(await accessPanel.locator('#scan-btn').evaluate(node => node.classList.contains('primary')), false);
  assert.match(await accessPanel.locator('#run-policy').textContent(), /提交前暂停/);
  await mkdir(resolve(root, 'test-results'), { recursive: true });
  for (const [language, width] of [['zh-CN', 320], ['en', 375]]) {
    await accessPanel.locator(`#language button[value="${language}"]`).click();
    await accessPanel.waitForFunction(value => document.documentElement.lang === value, language);
    await accessPanel.setViewportSize({ width, height: 700 });
    assert.equal(await accessPanel.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await accessPanel.screenshot({ path: resolve(root, `test-results/focused-sidebar-${language === 'en' ? 'en' : 'zh'}.png`) });
  }
  assert.match(await accessPanel.locator('#run-policy').textContent(), /submit/i);
  assert.doesNotMatch(await accessPanel.locator('#run-policy').textContent(), /[\u3400-\u9fff]/);
  await accessPanel.locator('#language button[value="zh-CN"]').click();
  const accessDemo = await context.newPage();
  await accessDemo.goto(demoUrl);
  await accessDemo.bringToFront();
  assert.equal(await accessWorker.evaluate(() => chrome.permissions.contains({ origins: ['http://127.0.0.1/*'] })), false);
  await accessPanel.evaluate(() => {
    const executeScript = chrome.scripting.executeScript.bind(chrome.scripting);
    window.permissionProbe = { injections: [], failures: [], requests: [] };
    chrome.scripting.executeScript = async options => {
      permissionProbe.injections.push(options.target.tabId);
      try { return await executeScript(options); }
      catch (error) { permissionProbe.failures.push(error.message); throw error; }
    };
    document.querySelector('#scan-btn').click();
  });
  await accessPanel.locator('#authorize-btn').waitFor({ state: 'visible' });
  await accessPanel.waitForFunction(() => !document.querySelector('#scan-btn').disabled);
  assert.equal(await accessPanel.locator('#start-btn').isVisible(), false, 'authorization should replace the primary fill action');
  assert.equal(await accessPanel.locator('#stop-btn').isVisible(), false);
  assert.equal(await accessPanel.locator('.action-row #authorize-btn').count(), 1);
  assert.match(await accessPanel.locator('#page-url').textContent(), /127\.0\.0\.1:4173\/demo\//);
  assert.equal(await accessPanel.locator('#page-title').textContent(), await accessDemo.title());
  assert.equal(await accessPanel.locator('.field-row').count(), 0);
  const failedScan = await accessPanel.evaluate(() => permissionProbe);
  assert.equal(failedScan.injections.length, 1);
  assert.equal(failedScan.failures.length, 1, 'the first scan must fail at the real Chrome scripting boundary');
  assert.match(failedScan.failures[0], /permission|Cannot access/i);

  // Native permission bubbles are not available through this headless toolbar.
  // Mock only their answer; all target tab queries and the initial denial above
  // remain real Chrome APIs. Declining must never trigger another injection.
  await accessPanel.evaluate(() => {
    chrome.permissions.request = async request => {
      permissionProbe.requests.push(request);
      return false;
    };
    document.querySelector('#authorize-btn').click();
  });
  await accessPanel.waitForFunction(() => permissionProbe.requests.length === 1 && !document.querySelector('#authorize-btn').disabled);
  assert.deepEqual(await accessPanel.evaluate(() => permissionProbe.requests), [{ origins: ['http://127.0.0.1/*'] }]);
  assert.equal(await accessPanel.evaluate(() => permissionProbe.injections.length), 1);
  assert.match(await accessPanel.locator('#status').textContent(), /授权未获允许/);
  assert.equal(await accessPanel.locator('#authorize-btn').isVisible(), true);

  // Simulate accepting the permission bubble after the user switches to another
  // tab on the same origin. The tab identity check must stop the stale request.
  await accessPanel.evaluate(() => {
    chrome.permissions.request = request => {
      permissionProbe.requests.push(request);
      return new Promise(resolve => { permissionProbe.resolve = resolve; });
    };
    document.querySelector('#authorize-btn').click();
  });
  await accessPanel.waitForFunction(() => typeof permissionProbe.resolve === 'function');
  const switchedTab = await context.newPage();
  await switchedTab.goto(demoUrl);
  await switchedTab.bringToFront();
  await accessPanel.evaluate(() => permissionProbe.resolve(true));
  await accessPanel.waitForFunction(() => !document.querySelector('#scan-btn').disabled);
  assert.equal(await accessPanel.evaluate(() => permissionProbe.injections.length), 1, 'approval for a stale tab must not inject');
  assert.match(await accessPanel.locator('#status').textContent(), /切换|变化|改变|重新/);

  await switchedTab.goto('chrome://version/');
  await switchedTab.bringToFront();
  await accessPanel.evaluate(() => document.querySelector('#scan-btn').click());
  await accessPanel.waitForFunction(() => !document.querySelector('#scan-btn').disabled && /浏览器内部页/.test(document.querySelector('#status').textContent));
  assert.equal(await accessPanel.locator('#authorize-btn').isVisible(), false);
  assert.equal(await accessPanel.locator('#start-btn').isVisible(), true);
  assert.equal(await accessPanel.evaluate(() => permissionProbe.injections.length), 1, 'internal pages must not be injected');
  assert.deepEqual(accessErrors, []);
  console.log(`PASS: unmodified manifest reproduces missing permission; target URL and authorization action remain available; denied or stale-tab approval cannot inject; internal pages are rejected; version ${manifest.version} is visible`);

  const persistedKeys = { typesafeKey: 'test-typesafe-persistent', deepseekKey: 'test-deepseek-persistent' };
  await accessPanel.locator('#preferences-details > summary').click();
  assert.equal(await accessPanel.locator('#connection-section #settings-form').isVisible(), true);
  assert.equal(await accessPanel.locator('#behavior-section #mode').isVisible(), true);
  const defaultPolicy = await accessPanel.locator('#run-policy').textContent();
  await accessPanel.locator('#auto-next').uncheck();
  await accessPanel.locator('#auto-submit').check();
  assert.notEqual(await accessPanel.locator('#run-policy').textContent(), defaultPolicy, 'the policy summary should reflect edited behavior settings immediately');
  await accessPanel.locator('#auto-next').check();
  await accessPanel.locator('#auto-submit').uncheck();
  assert.equal(await accessPanel.locator('#run-policy').textContent(), defaultPolicy);
  await accessPanel.locator('#typesafe-key').fill(persistedKeys.typesafeKey);
  await accessPanel.locator('#deepseek-key').fill(persistedKeys.deepseekKey);
  await accessPanel.locator('#preferences-details #save-btn').click();
  await accessPanel.waitForFunction(() => document.querySelector('#status').textContent.includes('资料与设置已保存'));
  await accessPanel.evaluate(() => chrome.storage.session.clear());
  await accessPanel.reload();
  await accessPanel.waitForFunction(() => document.querySelector('#profile-name').value === '权限回归');
  assert.equal(await accessPanel.locator('#typesafe-key').inputValue(), persistedKeys.typesafeKey,
    'saved TypeSafe keys must survive session storage loss and a sidebar reload');
  assert.equal(await accessPanel.locator('#deepseek-key').inputValue(), persistedKeys.deepseekKey);
  const savedSettings = await accessPanel.evaluate(() => chrome.storage.local.get(['preferences', 'typesafeKey', 'deepseekKey']));
  assert.deepEqual({ typesafeKey: savedSettings.typesafeKey, deepseekKey: savedSettings.deepseekKey }, persistedKeys);
  assert.equal(Object.hasOwn(savedSettings.preferences, 'typesafeKey'), false);
  assert.equal(Object.hasOwn(savedSettings.preferences, 'deepseekKey'), false);

  await accessPanel.locator('#language button[value="en"]').focus();
  await accessPanel.locator('#language button[value="en"]').press('Enter');
  await accessPanel.waitForFunction(() => document.documentElement.lang === 'en'
    && document.querySelector('#scan-btn').textContent === document.querySelector('#scan-btn').dataset.en);
  assert.match(await accessPanel.locator('#status').textContent(), /ready/i);
  assert.match(await accessPanel.locator('#connection-section h2').textContent(), /model|connection/i);
  assert.equal(await accessPanel.locator('#save-btn').textContent(), await accessPanel.locator('#save-btn').getAttribute('data-en'));
  assert.equal(await accessPanel.evaluate(async () => (await chrome.storage.local.get('language')).language), 'en',
    'language changes must be saved immediately without clicking Save');
  assert.equal(await accessPanel.locator('#profile-name').inputValue(), '权限回归');
  assert.equal(await accessPanel.locator('#typesafe-key').inputValue(), persistedKeys.typesafeKey);
  assert.equal(await accessPanel.locator('#deepseek-key').inputValue(), persistedKeys.deepseekKey);
  await switchedTab.bringToFront();
  await accessPanel.evaluate(() => document.querySelector('#scan-btn').click());
  await accessPanel.waitForFunction(() => !document.querySelector('#scan-btn').disabled
    && document.querySelector('#status').classList.contains('error')
    && /internal|browser/i.test(document.querySelector('#status').textContent));
  assert.doesNotMatch(await accessPanel.locator('#status').textContent(), /[\u3400-\u9fff]/,
    'errors generated after switching language must be localized');
  await accessPanel.reload();
  await accessPanel.waitForFunction(() => document.querySelector('#profile-name').value === '权限回归'
    && document.querySelector('#language button[aria-pressed="true"]')?.value === 'en');
  assert.equal(await accessPanel.locator('#scan-btn').textContent(), await accessPanel.locator('#scan-btn').getAttribute('data-en'));
  assert.equal(await accessPanel.locator('#typesafe-key').inputValue(), persistedKeys.typesafeKey);
  assert.equal(await accessPanel.locator('#deepseek-key').inputValue(), persistedKeys.deepseekKey);

  await mkdir(resolve(root, 'test-results'), { recursive: true });
  for (const language of ['en', 'zh-CN']) {
    await accessPanel.locator(`#language button[value="${language}"]`).click();
    await accessPanel.waitForFunction(value => document.documentElement.lang === value, language);
    await accessPanel.evaluate(() => document.querySelectorAll('details').forEach(node => { node.open = true; }));
    for (const width of [320, 375, 414]) {
      await accessPanel.setViewportSize({ width, height: 1000 });
      assert.equal(await accessPanel.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true,
        `${language} sidebar overflows at ${width}px with settings expanded`);
      assert.deepEqual(await accessPanel.locator('button, input, select, textarea, summary').evaluateAll(nodes => nodes.filter(node => {
        if (!node.getClientRects().length) return false;
        const rect = node.getBoundingClientRect();
        return rect.left < -1 || rect.right > innerWidth + 1;
      }).map(node => node.id || node.tagName)), [], `${language} controls extend beyond ${width}px`);
      if ((language === 'en' && width === 375) || (language === 'zh-CN' && width === 320)) {
        await accessPanel.screenshot({ path: resolve(root, `test-results/sidepanel-${language === 'en' ? 'en' : 'zh'}-${width}.png`), fullPage: true });
        await accessPanel.evaluate(() => scrollTo(0, 0));
        await accessPanel.screenshot({ path: resolve(root, `test-results/language-switch-${language === 'en' ? 'en' : 'zh'}.png`),
          clip: { x: 0, y: 0, width, height: 650 } });
      }
    }
  }
  assert.equal(await accessPanel.locator('#language button[aria-pressed="true"]').evaluate(node => node.value), 'zh-CN');
  assert.equal(await accessPanel.locator('#scan-btn').textContent(), await accessPanel.locator('#scan-btn').getAttribute('data-zh'));
  assert.equal(await accessPanel.evaluate(async () => (await chrome.storage.local.get('language')).language), 'zh-CN');
  assert.deepEqual(accessErrors, []);
  console.log('PASS: FormPilot branding and Chrome locales; language buttons support Enter and persist independently without changing profiles or fake keys; English controls, status and errors; expanded sidebars fit 320/375/414px in both languages');

  // Theme is an independent preference: system changes must only affect the
  // system selection, while explicit choices survive reloads and preserve data.
  assert.equal(await accessPanel.locator('#theme').evaluate(node => node.tagName), 'FIELDSET');
  assert.deepEqual(await accessPanel.locator('#theme button').evaluateAll(nodes => nodes.map(node => node.value).sort()), ['dark', 'light', 'system']);
  assert.equal(await accessPanel.locator('#theme button[aria-pressed="true"]').evaluate(node => node.value), 'system');
  await accessPanel.emulateMedia({ colorScheme: 'dark' });
  await accessPanel.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  const darkBackground = await accessPanel.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await accessPanel.emulateMedia({ colorScheme: 'light' });
  await accessPanel.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  assert.notEqual(await accessPanel.evaluate(() => getComputedStyle(document.body).backgroundColor), darkBackground,
    'changing the resolved theme must change the rendered background');
  await accessPanel.locator('#theme button[value="dark"]').click();
  await accessPanel.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  assert.equal(await accessPanel.evaluate(async () => (await chrome.storage.local.get('theme')).theme), 'dark');
  await accessPanel.emulateMedia({ colorScheme: 'dark' });
  await accessPanel.emulateMedia({ colorScheme: 'light' });
  assert.equal(await accessPanel.locator('html').getAttribute('data-theme'), 'dark', 'manual dark must override a light system theme');
  await accessPanel.reload();
  await accessPanel.waitForFunction(() => document.querySelector('#profile-name').value === '权限回归'
    && document.documentElement.dataset.theme === 'dark'
    && document.querySelector('#theme button[aria-pressed="true"]')?.value === 'dark');
  await accessPanel.locator('#preferences-details > summary').click();
  await accessPanel.emulateMedia({ colorScheme: 'dark' });
  await accessPanel.locator('#theme button[value="light"]').click();
  await accessPanel.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await accessPanel.emulateMedia({ colorScheme: 'light' });
  await accessPanel.emulateMedia({ colorScheme: 'dark' });
  assert.equal(await accessPanel.locator('html').getAttribute('data-theme'), 'light', 'manual light must override a dark system theme');
  assert.equal(await accessPanel.evaluate(async () => (await chrome.storage.local.get('theme')).theme), 'light');
  await accessPanel.locator('#theme button[value="system"]').click();
  await accessPanel.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await accessPanel.emulateMedia({ colorScheme: 'light' });
  await accessPanel.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  assert.equal(await accessPanel.evaluate(async () => (await chrome.storage.local.get('theme')).theme), 'system');
  assert.deepEqual(await accessPanel.evaluate(() => chrome.storage.local.get(['preferences', 'typesafeKey', 'deepseekKey'])), savedSettings,
    'theme changes must preserve saved profiles, behavior and API keys');

  for (const [theme, language] of [['light', 'zh-CN'], ['dark', 'zh-CN'], ['dark', 'en']]) {
    await accessPanel.locator(`#theme button[value="${theme}"]`).click();
    await accessPanel.locator(`#language button[value="${language}"]`).click();
    await accessPanel.waitForFunction(({ theme, language }) => document.documentElement.dataset.theme === theme
      && document.documentElement.lang === language, { theme, language });
    await accessPanel.evaluate(() => document.querySelectorAll('details').forEach(node => { node.open = true; }));
    for (const width of [320, 375, 414, 768]) {
      await accessPanel.setViewportSize({ width, height: 900 });
      assert.equal(await accessPanel.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true,
        `${theme} ${language} sidebar overflows at ${width}px`);
      assert.deepEqual(await accessPanel.locator('#theme button').evaluateAll(nodes => nodes.filter(node => {
        const rect = node.getBoundingClientRect();
        return rect.left < -1 || rect.right > innerWidth + 1;
      }).map(node => node.value)), [], 'theme buttons must fit inside the sidebar');
    }
    await accessPanel.setViewportSize({ width: language === 'en' ? 375 : 320, height: 900 });
    await accessPanel.locator('#profile-details').evaluate(node => { node.open = false; });
    await accessPanel.evaluate(() => scrollTo(0, 0));
    await accessPanel.screenshot({ path: resolve(root, `test-results/theme-${theme}-${language === 'en' ? 'en' : 'zh'}.png`), fullPage: true });
  }
  await accessPanel.locator('#theme button[value="system"]').click();
  await accessPanel.locator('#language button[value="zh-CN"]').click();
  await accessPanel.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  assert.deepEqual(accessErrors, []);
  console.log('PASS: system theme follows OS changes; manual light/dark override the OS and persist independently; returning to system restores following; light/dark localized settings fit 320/375/414/768px');
  await context.close();

  // Restart the browser itself with the same disposable profile, not just the
  // sidebar page. No user profile or actual credential is involved in this test.
  context = await launchProfile('unprivileged-profile');
  const restartedWorker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
  assert.equal(new URL(restartedWorker.url()).host, accessId);
  const persistencePanel = await context.newPage();
  persistencePanel.on('pageerror', error => accessErrors.push(error.message));
  await persistencePanel.goto(`chrome-extension://${accessId}/sidepanel.html`);
  await persistencePanel.waitForFunction(() => document.querySelector('#profile-name').value === '权限回归');
  assert.equal(await persistencePanel.locator('#typesafe-key').inputValue(), persistedKeys.typesafeKey);
  assert.equal(await persistencePanel.locator('#deepseek-key').inputValue(), persistedKeys.deepseekKey);
  const legacyKeys = { typesafeKey: 'test-typesafe-legacy', deepseekKey: 'test-deepseek-legacy' };
  for (const { local, expected, label } of [
    { local: persistedKeys, expected: persistedKeys, label: 'local keys take precedence over stale session keys' },
    { local: { typesafeKey: '' }, expected: { typesafeKey: '', deepseekKey: legacyKeys.deepseekKey }, label: 'an explicitly cleared key stays empty while an absent key can migrate' },
    { local: {}, expected: legacyKeys, label: 'both legacy session keys migrate when local keys are absent' },
  ]) {
    await persistencePanel.evaluate(async ({ local, legacyKeys }) => {
      await chrome.storage.local.remove(['typesafeKey', 'deepseekKey']);
      await chrome.storage.local.set(local);
      await chrome.storage.session.set({ ...legacyKeys, unrelatedSessionValue: 'preserve-this' });
    }, { local, legacyKeys });
    await persistencePanel.reload();
    await persistencePanel.waitForFunction(() => document.querySelector('#profile-name').value === '权限回归');
    assert.equal(await persistencePanel.locator('#typesafe-key').inputValue(), expected.typesafeKey, label);
    assert.equal(await persistencePanel.locator('#deepseek-key').inputValue(), expected.deepseekKey, label);
    assert.deepEqual(await persistencePanel.evaluate(() => chrome.storage.local.get(['typesafeKey', 'deepseekKey'])), expected, label);
    assert.deepEqual(await persistencePanel.evaluate(() => chrome.storage.session.get(['typesafeKey', 'deepseekKey', 'unrelatedSessionValue'])),
      { unrelatedSessionValue: 'preserve-this' }, 'migration must remove only the two legacy keys');
  }
  assert.deepEqual(accessErrors, []);
  console.log('PASS: fake API keys survive session clearing, sidebar reload and a real browser restart; local values including empty strings take precedence; legacy keys migrate and are removed from session storage');
  await context.close();

  context = await launchProfile('english-first-run-profile', 'en-US');
  const englishWorker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
  const englishPanel = await context.newPage();
  await englishPanel.goto(`chrome-extension://${new URL(englishWorker.url()).host}/sidepanel.html`);
  await englishPanel.waitForFunction(() => document.querySelector('#language button[aria-pressed="true"]')?.value === 'en'
    && document.querySelector('#scan-btn').textContent === document.querySelector('#scan-btn').dataset.en);
  assert.equal(await englishPanel.evaluate(() => navigator.language), 'en-US');
  assert.match(await englishPanel.locator('#status').textContent(), /ready/i);
  await englishPanel.locator('#start-btn').click();
  await englishPanel.waitForFunction(() => !document.querySelector('#start-btn').disabled
    && document.activeElement?.id === 'typesafe-key');
  assert.equal(await englishPanel.locator('#preferences-details').evaluate(node => node.open), true,
    'starting without a key should reveal the hidden model setup');
  assert.match(await englishPanel.locator('#status').textContent(), /TypeSafe API key/);
  assert.equal(await englishPanel.locator('#start-btn').isVisible(), true);
  assert.equal(await englishPanel.locator('#stop-btn').isVisible(), false);
  console.log('PASS: a fresh non-Chinese browser profile defaults to English; starting without a key reveals settings and focuses the missing key');
  await context.close();

  // Existing DOM/model regressions use a separate disposable profile with only
  // the fixture host pre-granted. They still perform real content injection.
  manifest.host_permissions.push('http://127.0.0.1/*');
  await writeFile(resolve(extension, 'manifest.json'), JSON.stringify(manifest));
  context = await launchProfile('authorized-profile');
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = new URL(worker.url()).host;
  await worker.evaluate(() => chrome.storage.local.set({
    preferences: { profile: { name: '旧资料' }, mode: 'demo', deepseekModel: 'unsupported-legacy-model', autoNext: true },
    typesafeKey: 'test-content-access-typesafe', deepseekKey: 'test-content-access-deepseek',
  }));
  const panel = await context.newPage();
  const errors = [];
  panel.on('pageerror', error => errors.push(error.message));
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.waitForFunction(() => document.querySelector('#profile-name').value === '旧资料');
  assert.equal(await panel.locator('#deepseek-model').evaluate(node => node.tagName), 'SELECT');
  assert.deepEqual(await panel.locator('#deepseek-model option').evaluateAll(nodes => nodes.map(node => node.value)),
    ['deepseek-flash', 'deepseek-v4-pro']);
  assert.equal(await panel.locator('#deepseek-model').inputValue(), 'deepseek-flash', 'unsupported saved models must fall back to Flash');
  assert.equal(await panel.locator('#profile-form input, #profile-form textarea').evaluateAll(nodes => {
    nodes.forEach(node => { node.value = ''; });
    return nodes.every(node => !node.required);
  }), true, 'all profile fields must remain optional');
  const demo = await context.newPage();
  demo.on('pageerror', error => errors.push(error.message));
  await demo.goto(demoUrl);
  await demo.bringToFront();
  // Cover the recovery path with an actual granted permission and actual second
  // injection. Only the first scripting attempt is forced to look unprivileged.
  await panel.evaluate(() => {
    const executeScript = chrome.scripting.executeScript.bind(chrome.scripting);
    const requestPermission = chrome.permissions.request.bind(chrome.permissions);
    window.authorizedProbe = { attempts: 0, requests: [], executeScript, requestPermission };
    chrome.scripting.executeScript = options => {
      if (++authorizedProbe.attempts === 1) return Promise.reject(new Error('Cannot access contents of the page. Extension manifest must request permission.'));
      return executeScript(options);
    };
    chrome.permissions.request = options => {
      authorizedProbe.requests.push(options);
      return requestPermission(options);
    };
    document.querySelector('#scan-btn').click();
  });
  await panel.locator('#authorize-btn').waitFor({ state: 'visible' });
  await panel.waitForFunction(() => !document.querySelector('#authorize-btn').disabled);
  await panel.evaluate(() => document.querySelector('#authorize-btn').click());
  await panel.waitForFunction(() => document.querySelector('#field-count').textContent.includes('7 个字段')
    && !document.querySelector('#scan-btn').disabled);
  assert.deepEqual(await panel.evaluate(() => authorizedProbe.requests), [{ origins: ['http://127.0.0.1/*'] }]);
  assert.equal(await panel.evaluate(() => authorizedProbe.attempts), 2);
  assert.equal(await panel.locator('#authorize-btn').isVisible(), false);
  assert.equal(await panel.locator('#start-btn').isVisible(), true);
  assert.equal(await panel.locator('#results-section').isVisible(), true);
  assert.equal(await panel.locator('#run-metrics').isVisible(), true);
  await panel.evaluate(() => {
    chrome.scripting.executeScript = authorizedProbe.executeScript;
    chrome.permissions.request = authorizedProbe.requestPermission;
  });
  const contentStorageAccess = await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async () => {
        try {
          await chrome.storage.local.get(['typesafeKey', 'deepseekKey']);
          return { allowed: true };
        } catch (error) { return { allowed: false, reason: error.message }; }
      },
    });
    return injection.result;
  });
  assert.equal(contentStorageAccess.allowed, false, 'the content-script context must not be allowed to read persisted API keys');
  console.log('PASS: accepting an already granted site permission resumes scanning with a real content-script injection');
  console.log('PASS: trusted extension contexts retain API-key access while content-script storage access is rejected');
  await panel.evaluate(() => document.querySelector('#start-btn').click());
  await panel.waitForFunction(() => document.querySelector('#status').textContent.includes('还需补充或修改')
    && !document.querySelector('#demo-btn').disabled);
  assert.match(await panel.locator('#field-count').textContent(), /7 个字段/);
  assert.equal(await panel.locator('.field-row').count(), 7, 'blank profiles must reach the real page scan');
  assert.equal(await demo.locator('#name').inputValue(), '');
  assert.equal(await demo.locator('#step-1').isVisible(), true);
  assert.doesNotMatch(await panel.locator('#status').textContent(), /请先填写你的资料/);
  await panel.locator('#language button[value="en"]').click();
  await panel.waitForFunction(() => document.documentElement.lang === 'en');
  assert.doesNotMatch(await panel.locator('#status').textContent(), /还需补充或修改/);
  assert.doesNotMatch(await panel.locator('#log').textContent(), /演示规则|正在处理|本次已处理|还需补充或修改/);
  assert.ok((await panel.locator('.field-row small').allTextContents()).every(text => text.trim() && !/[\u3400-\u9fff]/.test(text)),
    'existing skipped-field reasons must change language along with the controls');
  await panel.locator('#language button[value="zh-CN"]').click();
  await panel.waitForFunction(() => document.documentElement.lang === 'zh-CN');
  await panel.locator('#preferences-details > summary').click();
  await panel.locator('#profile-details > summary').click();
  await panel.locator('#demo-btn').click();
  await panel.locator('#save-btn').click();
  await panel.waitForFunction(() => document.querySelector('#status').textContent.includes('资料与设置已保存'));
  await panel.reload();
  await panel.waitForFunction(() => document.querySelector('#profile-name').value === '林澈');
  await demo.bringToFront();
  await panel.evaluate(() => document.querySelector('#scan-btn').click());
  await panel.waitForFunction(() => document.querySelector('#field-count').textContent.includes('7 个字段'));
  await panel.evaluate(() => document.querySelector('#start-btn').click());
  await panel.waitForFunction(() => document.querySelector('#status').textContent.includes('等待你检查并提交'), { timeout: 20000 });
  assert.equal(await demo.locator('#name').inputValue(), DEMO_PROFILE.name);
  assert.equal(await demo.locator('#email').inputValue(), DEMO_PROFILE.email);
  assert.equal(await demo.locator('input[name="stage"]:checked').inputValue(), 'prototype');
  assert.deepEqual(await demo.locator('[name="interests"]:checked').evaluateAll(nodes => nodes.map(n => n.value)), ['browser', 'workflow']);
  assert.equal(await demo.locator('[name="newsletter"]:checked').inputValue(), 'no');
  assert.equal(await demo.locator('#demo-complete').isVisible(), false);
  await mkdir(resolve(root, 'test-results'), { recursive: true });
  for (const width of [320, 375, 414, 768]) {
    for (const page of [panel, demo]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `overflow at ${width}px`);
    }
  }
  await panel.setViewportSize({ width: 390, height: 1100 });
  await panel.screenshot({ path: resolve(root, 'test-results/sidepanel.png'), fullPage: true });
  await demo.bringToFront();
  await panel.evaluate(() => { document.querySelector('#auto-submit').checked = true; document.querySelector('#start-btn').click(); });
  await demo.waitForFunction(() => document.documentElement.dataset.jevComplete === 'true');
  await panel.waitForFunction(() => document.querySelector('#status').textContent.includes('本地演示已完成'));
  await demo.setViewportSize({ width: 1100, height: 850 });
  await demo.screenshot({ path: resolve(root, 'test-results/demo-complete.png') });
  console.log('PASS: model dropdown and legacy fallback, blank optional profile reaches scan, persisted profile, 2-page DOM fill, 16 questions, default submission gate, local submit, responsive widths');

  await panel.evaluate(() => {
    document.querySelector('#deepseek-model').value = 'deepseek-v4-pro';
    document.querySelector('#save-btn').click();
  });
  await panel.waitForFunction(() => document.querySelector('#status').textContent.includes('资料与设置已保存'));
  await panel.reload();
  await panel.waitForFunction(() => document.querySelector('#profile-name').value === '林澈');
  assert.equal(await panel.locator('#deepseek-model').inputValue(), 'deepseek-v4-pro');
  assert.equal(await panel.evaluate(async () => (await chrome.storage.local.get('preferences')).preferences.deepseekModel), 'deepseek-v4-pro');

  let jevCalls = 0;
  let textCalls = 0;
  await context.route('https://api.typesafe.ai/**', async route => {
    jevCalls++;
    const body = route.request().postDataJSON();
    const fields = body.state.fields;
    const plan = demoPlan({ demo: true, fields }, body.state.profile);
    const answers = {};
    for (const [index, field] of fields.entries()) {
      const action = plan.find(p => p.fieldId === field.id);
      const choice = field.options ? `c${field.options.findIndex(o => o.id === action.value)}`
        : field.type === 'checkbox' ? action.value ? 'checked' : 'unchecked'
        : Object.hasOwn(DEMO_PROFILE, field.demoKey) ? field.demoKey : 'write';
      answers[`q${index}`] = { type: 'choice', choice, confidence: 1, probabilities: { [choice]: 1 } };
    }
    await route.fulfill({ json: { answers } });
  });
  await context.route('https://api.deepseek.com/**', async route => {
    textCalls++;
    const body = route.request().postDataJSON();
    assert.equal(body.thinking.type, 'disabled');
    assert.equal(body.model, 'deepseek-v4-pro');
    const input = JSON.parse(body.messages[1].content);
    const answers = Object.fromEntries(demoPlan({ demo: true, fields: input.fields }, input.profile).map(p => [p.fieldId, p.value]));
    await route.fulfill({ json: { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ answers }) } }] } });
  });
  await demo.reload();
  await demo.bringToFront();
  await panel.evaluate(() => {
    const realFetch = window.fetch.bind(window);
    window.cancelProbe = { realFetch, requests: 0, aborted: false };
    window.fetch = (url, options) => {
      if (!String(url).startsWith('https://api.typesafe.ai/')) return realFetch(url, options);
      cancelProbe.requests++;
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => {
        cancelProbe.aborted = true;
        reject(new DOMException('Cancelled test request', 'AbortError'));
      }, { once: true }));
    };
    document.querySelector('#mode').value = 'live';
    document.querySelector('#typesafe-key').value = 'test-key-never-sent';
    document.querySelector('#deepseek-key').value = 'test-key-never-sent';
    document.querySelector('#auto-submit').checked = true;
    document.querySelector('#start-btn').click();
  });
  await panel.waitForFunction(() => cancelProbe.requests === 1);
  assert.equal(await panel.locator('#start-btn').isVisible(), false);
  assert.equal(await panel.locator('#stop-btn').isVisible(), true);
  assert.equal(await panel.locator('#run-hint').isVisible(), true);
  assert.equal(await panel.locator('#run-metrics').isVisible(), true);
  assert.equal(await panel.locator('#progress').isVisible(), true);
  await panel.locator('#stop-btn').click();
  await panel.waitForFunction(() => cancelProbe.aborted && !document.querySelector('#start-btn').disabled);
  assert.equal(await panel.locator('#start-btn').isVisible(), true);
  assert.equal(await panel.locator('#stop-btn').isVisible(), false);
  assert.equal(await panel.locator('#run-hint').isVisible(), false);
  assert.equal(await demo.locator('#name').inputValue(), '', 'cancelling a pending judgment must leave the form untouched');
  await panel.evaluate(() => { window.fetch = cancelProbe.realFetch; });
  await demo.bringToFront();
  await panel.evaluate(() => document.querySelector('#start-btn').click());
  await demo.waitForFunction(() => document.documentElement.dataset.jevComplete === 'true', { timeout: 20000 });
  await panel.waitForFunction(() => document.querySelector('#status').textContent.includes('本地演示已完成'));
  assert.equal(jevCalls, 2);
  assert.equal(textCalls, 1);
  assert.deepEqual(errors, []);
  console.log('PASS: running tasks replace Start with Stop; cancelling a pending judgment restores Start without writes; persisted Pro model used by mocked providers (2 JEV batches + 1 text batch); no real API calls');

  await context.unroute('https://api.typesafe.ai/**');
  await context.unroute('https://api.deepseek.com/**');
  let knowledgeJevCalls = 0;
  let knowledgeTextCalls = 0;
  // Mock answers verify the empty-profile browser flow, not live model quality.
  const knowledgeAnswers = [
    { label: /HTTP 404/, value: 'HTTP 404 表示服务器找不到请求的资源，常见原因是链接地址写错或页面已被移除。' },
    { label: /三步自动填表方案/, value: '第一步，JEV 读取页面状态并选择要执行的动作；第二步，LLM 根据题目生成文字；第三步，浏览器执行器填写内容、点击按钮并检查结果。' },
    { label: /为什么想试用自动化平台/, value: '我希望探索用自动化平台减少重复填写，计划先用测试问卷验证页面理解、文字生成和浏览器执行的配合，再评估适合的使用场景。' },
  ];
  await context.route('https://api.typesafe.ai/**', async route => {
    knowledgeJevCalls++;
    const body = route.request().postDataJSON();
    assert.match(body.state.page.context, /项目要求：用JEV选择动作，LLM生成文字，浏览器执行/);
    assert.ok(Object.values(body.state.profile).every(value => value === ''));
    assert.equal(body.state.fields.length, 5);
    const answers = {};
    for (const [index, field] of body.state.fields.entries()) {
      let choice;
      if (knowledgeAnswers.some(item => item.label.test(field.label))) {
        assert.equal(field.type, 'textarea');
        assert.ok(field.description, 'question descriptions must reach JEV');
        choice = 'write';
      } else if (field.type === 'select') {
        const optionIndex = field.options.findIndex(option => option.label === '浏览器执行器');
        assert.ok(optionIndex >= 0);
        choice = `c${optionIndex}`;
      } else {
        assert.equal(field.type, 'email');
        assert.match(field.label, /你的邮箱/);
        choice = 'personal';
      }
      assert.ok(Object.hasOwn(body.questions[`q${index}`].criteria, choice));
      answers[`q${index}`] = { type: 'choice', choice, confidence: 1 };
    }
    await route.fulfill({ json: { answers } });
  });
  await context.route('https://api.deepseek.com/**', async route => {
    knowledgeTextCalls++;
    const body = route.request().postDataJSON();
    const input = JSON.parse(body.messages[1].content);
    assert.ok(Object.values(input.profile).every(value => value === ''));
    assert.match(input.page.context, /项目要求/);
    assert.equal(input.fields.length, 3, 'personal-fact fields must not reach text generation');
    const answers = {};
    for (const field of input.fields) {
      assert.equal(field.type, 'textarea');
      assert.ok(field.description, 'question descriptions must reach DeepSeek');
      const mock = knowledgeAnswers.find(item => item.label.test(field.label));
      assert.ok(mock, `Unexpected generation field: ${field.label}`);
      answers[field.id] = mock.value;
    }
    await route.fulfill({ json: { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ answers }) } }] } });
  });
  await panel.waitForFunction(() => !document.querySelector('#demo-btn').disabled);
  await panel.evaluate(() => {
    document.querySelector('#mode').value = 'live';
    document.querySelector('#demo-btn').click();
  });
  assert.equal(await panel.locator('#mode').inputValue(), 'live', 'loading a sample profile must preserve real model mode');
  await panel.locator('#profile-form input, #profile-form textarea').evaluateAll(nodes => {
    nodes.forEach(node => { node.value = ''; });
  });
  await demo.goto('http://127.0.0.1:4173/demo/knowledge.html');
  assert.equal(await demo.evaluate(() => document.documentElement.dataset.jevDemo), undefined);
  await demo.bringToFront();
  await panel.evaluate(() => {
    document.querySelector('#mode').value = 'live';
    document.querySelector('#typesafe-key').value = 'test-key-never-sent';
    document.querySelector('#deepseek-key').value = 'test-key-never-sent';
    document.querySelector('#auto-submit').checked = false;
    document.querySelector('#start-btn').click();
  });
  await panel.waitForFunction(() => document.querySelector('#status').textContent.includes('本页填写完成')
    && !document.querySelector('#start-btn').disabled, { timeout: 20000 });
  for (const [index, id] of ['knowledge', 'proposal', 'reason'].entries()) {
    assert.equal(await demo.locator(`#${id}`).inputValue(), knowledgeAnswers[index].value);
  }
  assert.equal(await demo.locator('#context-choice').inputValue(), 'browser');
  assert.equal(await demo.locator('#unknown-email').inputValue(), '');
  assert.equal(await panel.evaluate(async () => (await chrome.storage.local.get('lastRun')).lastRun.status), 'filled');
  assert.equal(knowledgeJevCalls, 1);
  assert.equal(knowledgeTextCalls, 1);
  assert.deepEqual(errors, []);
  console.log('PASS: empty profile answers knowledge, proposal and future-plan questions with mocked models; page context routes the selection; unknown personal email stays blank');

  await context.unroute('https://api.typesafe.ai/**');
  await context.unroute('https://api.deepseek.com/**');
  // Reproduce the published W3School HTML quiz structure locally: radios have
  // adjacent text but no labels/required flags, and the question is outside the
  // form. Replaying the same question in two new documents at one URL isolates
  // reused DOM IDs without depending on the public site's state or availability.
  // Source: https://www.w3school.com.cn/quiz/quiz.asp?quiz=html
  const quizUrl = 'http://127.0.0.1:4173/quiz/quiz.asp?quiz=html';
  const quizOptions = [
    '超文本标记语言（Hyper Text Markup Language）',
    '家庭工具标记语言（Home Tool Markup Language）',
    '超链接和文本标记语言（Hyperlinks and Text Markup Language）',
  ];
  const quizFixture = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>HTML 测验</title><body>
    <div id="maincontent"><h1>HTML 测验</h1><div class="quiz_question">
    <h2>1&nbsp;.&nbsp;HTML 指的是？</h2>
    <form action="/quiz/quiz.asp?quiz=html" method="post">
    <input type="hidden" name="qNumber" value="1">
    <ul style="list-style:none">
    ${quizOptions.map((label, index) => `<li><input type="radio" value="${index + 1}" name="answer">${label}</li>`).join('\n')}
    </ul><p><input type="submit" value="下一题"></p></form>
    <p>开始时间：本地结构回放</p></div></div></body></html>`;
  const quizPosts = [];
  const quizModelInputs = [];
  await context.route(quizUrl, async route => {
    if (route.request().method() === 'POST') {
      quizPosts.push(Object.fromEntries(new URLSearchParams(route.request().postData())));
    }
    await route.fulfill({ contentType: 'text/html; charset=utf-8', body: quizPosts.length < 2 ? quizFixture
      : '<!doctype html><html><meta charset="utf-8"><title>Replay finished</title><body><p id="quiz-recorded">已记录两份表单答案</p></body></html>' });
  });
  await context.route('https://api.typesafe.ai/**', async route => {
    const input = route.request().postDataJSON();
    quizModelInputs.push(input);
    await route.fulfill({ json: { answers: { q0: { type: 'choice', choice: 'c0', confidence: 1 } } } });
  });
  await context.route('https://api.deepseek.com/**', async route => {
    await route.abort();
    assert.fail('A closed quiz choice must not call the text-generation provider');
  });
  await demo.goto(quizUrl);
  await demo.bringToFront();
  const quizPage = await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const [injection] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    return chrome.tabs.sendMessage(tab.id, { type: 'JEV_SCAN' }, { documentId: injection.documentId });
  });
  assert.equal(quizPage.fields.length, 1);
  assert.equal(quizPage.fields[0].type, 'radio');
  assert.equal(quizPage.fields[0].required, false);
  assert.match(quizPage.fields[0].label, /HTML 指的是？/);
  assert.deepEqual(quizPage.fields[0].options.map(option => option.label), quizOptions);
  assert.equal(quizPage.buttons.find(button => button.label === '下一题')?.kind, 'next');
  await panel.evaluate(() => {
    document.querySelector('#mode').value = 'live';
    document.querySelector('#auto-next').checked = true;
    document.querySelector('#auto-submit').checked = false;
    document.querySelector('#start-btn').click();
  });
  await demo.locator('#quiz-recorded').waitFor({ state: 'visible', timeout: 15000 });
  await panel.waitForFunction(() => !document.querySelector('#start-btn').disabled);
  assert.deepEqual(quizPosts, [{ qNumber: '1', answer: '1' }, { qNumber: '1', answer: '1' }],
    'the selected native radio value must be present in both real browser form submissions');
  assert.equal(quizModelInputs.length, 2, 'each same-URL document must receive a separate planning call');
  for (const input of quizModelInputs) {
    assert.equal(input.state.fields.length, 1);
    assert.match(input.state.fields[0].label, /HTML 指的是？/);
    assert.deepEqual(input.state.fields[0].options.map(option => option.label), quizOptions);
  }
  assert.equal(quizModelInputs[0].state.fields[0].id, quizModelInputs[1].state.fields[0].id,
    'the fixture must reproduce field-ID reuse after same-URL document navigation');
  assert.deepEqual(errors, []);
  console.log('PASS: W3School quiz structure exposes its real question and option labels; native answers reach form POST; repeated field IDs at the same URL are answered in each new document');

  await context.unroute('https://api.typesafe.ai/**');
  await context.unroute('https://api.deepseek.com/**');
  // A multi-question quiz may use ordinary div/p text rather than headings.
  // These short, original questions reproduce that DOM pattern without copying
  // the public UsingEnglish quiz; live HTML verification may be blocked by its CDN.
  const grammarUrl = 'http://127.0.0.1:4173/quiz/present-simple.html';
  const grammarQuestions = [
    { label: 'Q1 - Our robot ____ at nine.', options: ['starts', 'start', 'starting'], tag: 'div' },
    { label: 'Q2 - These helpers ____ every day.', options: ['work', 'works', 'working'], tag: 'p' },
    { label: 'Q3 - That lamp ____ brightly.', options: ['shines', 'shine'], tag: 'span', inline: true },
    { label: 'Q4 - Two clocks ____ together.', options: ['tick', 'ticks'], inline: true },
  ];
  const grammarFixture = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Grammar structure regression</title><body>
    <main><h2>Present Simple Quiz</h2><form>
    ${grammarQuestions.map((question, index) => {
      const prompt = question.tag ? `<${question.tag}><strong>${question.label}</strong></${question.tag}>` : question.label;
      const options = question.options.map((label, option) => {
        const control = `<label><span>${label}</span><input type="radio" name="q${index}" value="${option}"></label>`;
        return question.inline ? control : `<div>${control}</div>`;
      }).join('');
      return question.inline ? `${prompt}${options}<br>` : `<div class="quiz-question">${prompt}<div class="answers">${options}</div></div>`;
    }).join('')}
    <button type="button">Check answers</button></form></main></body></html>`;
  const grammarInputs = [];
  await context.route(grammarUrl, route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: grammarFixture }));
  await context.route('https://api.typesafe.ai/**', async route => {
    grammarInputs.push(route.request().postDataJSON());
    await route.fulfill({ json: { answers: Object.fromEntries(grammarQuestions.map((_, index) =>
      [`q${index}`, { type: 'choice', choice: 'c0', confidence: 1 }])) } });
  });
  await context.route('https://api.deepseek.com/**', async route => {
    await route.abort();
    assert.fail('Distinct, confident quiz choices should not call DeepSeek');
  });
  await demo.goto(grammarUrl);
  await demo.bringToFront();
  const grammarScan = await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const [injection] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    return chrome.tabs.sendMessage(tab.id, { type: 'JEV_SCAN' }, { documentId: injection.documentId });
  });
  assert.deepEqual(grammarScan.fields.map(field => ({ label: field.label, options: field.options.map(option => option.label) })),
    grammarQuestions.map(({ label, options }) => ({ label, options })), 'each radio group must have its own nearby question and only its own choices');
  assert.equal(new Set(grammarScan.fields.map(field => field.label)).size, grammarQuestions.length);
  await panel.evaluate(() => document.querySelector('#start-btn').click());
  await panel.waitForFunction(() => document.querySelector('#status').textContent.includes('本页填写完成')
    && !document.querySelector('#start-btn').disabled, null, { timeout: 15000 });
  assert.equal(grammarInputs.length, 1, 'all distinct questions should be sent in one judgment batch');
  assert.deepEqual(grammarInputs[0].state.fields.map(field => ({ label: field.label, options: field.options.map(option => option.label) })),
    grammarQuestions.map(({ label, options }) => ({ label, options })));
  assert.equal(grammarInputs[0].state.page.title, 'Grammar structure regression');
  assert.match(grammarInputs[0].state.page.context, /Present Simple Quiz/);
  assert.deepEqual(await demo.locator('form').evaluate(form => Object.fromEntries(new FormData(form))), { q0: '0', q1: '0', q2: '0', q3: '0' });
  assert.deepEqual(errors, []);
  console.log('PASS: adjacent div/p question text stays paired with each radio group in the scan and model state; confident choices fill native answers without a text-model fallback');

  await context.unroute('https://api.typesafe.ai/**');
  await context.unroute('https://api.deepseek.com/**');
  // Reproduce the user's JavaScript question without claiming that mocked
  // provider answers establish the historical quiz's factual correctness.
  const jsQuizUrl = 'http://127.0.0.1:4173/quiz/quiz.asp?quiz=javascript';
  const jsQuizOptions = [
    '两种。for循环和while循环。',
    '四种。for循环、while循环、do...while循环以及loop...until循环。',
    '一种。for循环。',
  ];
  const jsQuizFixture = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>JavaScript 测验</title><body>
    <div id="maincontent"><h1>JavaScript 测验</h1><div class="quiz_question">
    <h2>11&nbsp;.&nbsp;在JavaScript中有多少种不同类型的循环？</h2>
    <form action="/quiz/quiz.asp?quiz=javascript" method="post">
    <input type="hidden" name="qNumber" value="11"><ul style="list-style:none">
    ${jsQuizOptions.map((label, index) => `<li><input type="radio" value="${index + 1}" name="answer">${label}</li>`).join('\n')}
    </ul><p><input type="submit" value="下一题"></p></form></div></div></body></html>`;
  const jsQuizPosts = [];
  const jsJevInputs = [];
  const jsDeepSeekInputs = [];
  await context.route(jsQuizUrl, async route => {
    if (route.request().method() === 'POST') {
      jsQuizPosts.push(Object.fromEntries(new URLSearchParams(route.request().postData())));
    }
    await route.fulfill({ contentType: 'text/html; charset=utf-8', body: jsQuizPosts.length ?
      '<!doctype html><html><meta charset="utf-8"><title>Replay finished</title><body><p id="js-quiz-recorded">第11题答案已记录</p></body></html>' : jsQuizFixture });
  });
  await context.route('https://api.typesafe.ai/**', async route => {
    jsJevInputs.push(route.request().postDataJSON());
    await route.fulfill({ json: { answers: { q0: { type: 'choice', choice: 'skip', confidence: 0.99 } } } });
  });
  await context.route('https://api.deepseek.com/**', async route => {
    const body = route.request().postDataJSON();
    const input = JSON.parse(body.messages[1].content);
    jsDeepSeekInputs.push(input);
    const choiceField = input.fields[0];
    const answers = { [choiceField.id]: choiceField.options[0].id };
    await route.fulfill({ json: { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ answers }) } }] } });
  });
  await demo.goto(jsQuizUrl);
  await demo.bringToFront();
  await panel.evaluate(() => {
    document.querySelector('#auto-next').checked = false;
    document.querySelector('#start-btn').click();
  });
  await panel.waitForFunction(() => document.querySelector('#status').textContent.includes('等待你翻页')
    && !document.querySelector('#start-btn').disabled, null, { timeout: 15000 });
  assert.equal(jsJevInputs.length, 1);
  assert.equal(jsDeepSeekInputs.length, 1, 'a valid JEV skip must receive exactly one independent choice pass');
  for (const input of [jsJevInputs[0].state, jsDeepSeekInputs[0]]) {
    assert.equal(input.fields.length, 1);
    assert.match(input.fields[0].label, /在JavaScript中有多少种不同类型的循环/);
    assert.deepEqual(input.fields[0].options.map(option => option.label), jsQuizOptions);
  }
  assert.equal(await demo.locator('input[name="answer"]:checked').inputValue(), '1');
  assert.equal(await demo.locator('form').evaluate(form => new FormData(form).get('answer')), '1');
  assert.equal(jsQuizPosts.length, 0, 'the choice should be present before navigation is allowed');
  assert.match(await panel.locator('#log').textContent(), /DeepSeek[^\n]*选择题/);
  await panel.evaluate(() => {
    document.querySelector('#auto-next').checked = true;
    document.querySelector('#start-btn').click();
  });
  await demo.locator('#js-quiz-recorded').waitFor({ state: 'visible', timeout: 15000 });
  await panel.waitForFunction(() => !document.querySelector('#start-btn').disabled);
  assert.deepEqual(jsQuizPosts, [{ qNumber: '11', answer: '1' }]);
  assert.equal(jsJevInputs.length, 1, 'continuing an answered question must preserve the selected option');
  assert.equal(jsDeepSeekInputs.length, 1);
  assert.deepEqual(errors, []);
  console.log('PASS: JavaScript question 11 recovers from JEV skip with one DeepSeek option-ID answer; native checked state and FormData agree, then the answer is posted on continue');
} finally {
  await context?.close();
  server?.kill();
  await rm(scratch, { recursive: true, force: true });
}
