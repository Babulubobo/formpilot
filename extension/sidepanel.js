import { DEMO_PROFILE, demoPlan, livePlan } from './brain.js';
import { runForm } from './runner.js';
import { getLanguage, setLanguage, t, translate, pageMessage, raw } from './i18n.js';

const $ = id => document.getElementById(id);
const profileKeys = ['name', 'email', 'company', 'role', 'website', 'country', 'bio'];
const apiKeyNames = ['typesafeKey', 'deepseekKey'];
const systemTheme = matchMedia('(prefers-color-scheme: dark)');
let themePreference = 'system';
let task;
let snapshot;
let targetTab;
let targetWindow;
let documentId;
let pendingAccess;
const rows = new Map();

function updateTheme(value) {
  themePreference = ['light', 'dark', 'system'].includes(value) ? value : 'system';
  document.documentElement.dataset.theme = themePreference === 'system'
    ? (systemTheme.matches ? 'dark' : 'light') : themePreference;
  for (const button of $('theme').querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button.value === themePreference));
  }
}

function localize() {
  const locale = getLanguage() === 'en' ? 'en' : 'zh';
  document.documentElement.lang = getLanguage();
  for (const button of $('language').querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.value === getLanguage()));
  for (const element of document.querySelectorAll('[data-zh]')) {
    // Dynamic page titles and results belong to the page, not the interface.
    if (element.id === 'mode-hint') continue;
    if (element.textContent === element.dataset.zh || element.textContent === element.dataset.en) {
      element.textContent = element.dataset[locale];
    }
  }
  for (const attribute of ['placeholder', 'aria-label', 'title', 'empty']) {
    for (const element of document.querySelectorAll(`[data-${attribute}-zh]`)) {
      element.setAttribute(attribute === 'empty' ? 'data-empty' : attribute,
        element.getAttribute(`data-${attribute}-${locale}`));
    }
  }
  for (const element of document.querySelectorAll('#status, #log li, .field-row small, #field-count, #elapsed')) {
    element.textContent = translate(element.textContent);
  }
  if ($('page-title').dataset.fallback === 'true') $('page-title').textContent = translate($('page-title').textContent);
  updateMode();
}

function status(message, state = '') {
  $('status').textContent = message;
  $('status').className = state;
}
function updateActions(focused = document.activeElement) {
  $('start-btn').hidden = Boolean(task || pendingAccess);
  $('stop-btn').hidden = !task;
  $('authorize-btn').hidden = !pendingAccess || Boolean(task);
  $('run-hint').hidden = !task;
  if (['start-btn', 'stop-btn', 'authorize-btn'].includes(focused?.id) && focused.hidden) {
    ['start-btn', 'stop-btn', 'authorize-btn'].map($).find(button => !button.hidden && !button.disabled)?.focus();
  }
}
function log(message) {
  const item = document.createElement('li');
  item.textContent = message;
  $('log').append(item);
  $('results-section').hidden = false;
  if ($('log').children.length > 40) $('log').firstChild.remove();
}
function setBusy(busy) {
  const focused = document.activeElement;
  $('start-btn').setAttribute('aria-busy', String(busy));
  for (const id of ['scan-btn', 'start-btn', 'authorize-btn', 'demo-btn', 'save-btn', 'mode', 'auto-next', 'auto-submit', 'language']) $(id).disabled = busy;
  for (const input of document.querySelectorAll('#profile-form input, #profile-form textarea, #settings-form input, #settings-form select')) input.disabled = busy;
  $('stop-btn').disabled = !busy;
  $('progress').hidden = !task && $('progress').value === 0;
  updateActions(focused);
}
function readInputs() {
  return {
    profile: Object.fromEntries(profileKeys.map(key => [key, $(`profile-${key}`).value.trim()])),
    mode: $('mode').value,
    deepseekModel: $('deepseek-model').value || 'deepseek-flash',
    autoNext: $('auto-next').checked, autoSubmit: $('auto-submit').checked,
    typesafeKey: $('typesafe-key').value.trim(), deepseekKey: $('deepseek-key').value.trim(),
  };
}
async function save() {
  const { typesafeKey, deepseekKey, autoSubmit, ...preferences } = readInputs();
  await chrome.storage.local.set({ preferences, typesafeKey, deepseekKey });
  return { ...preferences, typesafeKey, deepseekKey, autoSubmit };
}
function updateMode() {
  $('mode-hint').textContent = $('mode').value === 'demo'
    ? t('演示规则，不调用 AI；仅支持配套的本地演示页。', 'Local rules only, without AI. Works on the included demo page.')
    : t('AI 理解题目与选项，生成答案并填写；题目与选填资料会发给模型服务。', 'AI reads questions and options, generates answers and fills the form. Questions and optional reference details are sent to the model services.');
  updatePolicy();
}
function updatePolicy() {
  const navigation = $('auto-next').checked ? t('自动翻页', 'Auto-advance') : t('手动翻页', 'Manual navigation');
  const submission = $('auto-submit').checked ? t('允许最终提交', 'Submission allowed') : t('提交前暂停', 'Pause before submit');
  const policy = t('{navigation} · {submission}', '{navigation} · {submission}', { navigation, submission });
  $('run-policy').textContent = $('mode').value === 'demo' ? t('本地演示 · {policy}', 'Local demo · {policy}', { policy }) : policy;
  $('run-policy').classList.toggle('submit-enabled', $('auto-submit').checked);
}
async function selectTarget() {
  clearAccessRequest();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id == null) throw new Error(t('当前窗口没有可操作的标签页。请在这个窗口打开目标网页。', 'No available tab in this window. Open the target webpage here.'));
  if (!tab.url) throw new Error(t('无法读取当前标签页地址。请在扩展管理页刷新 FormPilot，并重新打开侧栏。', 'Cannot read the tab address. Reload FormPilot on the extensions page and reopen the sidebar.'));
  if (!/^https?:\/\//.test(tab.url)) throw new Error(t('当前是浏览器内部页或本地文件。请切换到 http:// 或 https:// 网页再扫描。', 'This is a browser internal page or a local file. Switch to an http:// or https:// webpage and scan again.'));
  const url = new URL(tab.url);
  if (url.hostname === 'chromewebstore.google.com' || (url.hostname === 'chrome.google.com' && url.pathname.startsWith('/webstore'))) {
    throw new Error(t('Chrome 不允许扩展操作应用商店页面。请切换到要填写的网页。', 'Chrome blocks extensions on the Web Store. Switch to the form you want to fill.'));
  }
  targetTab = tab.id;
  targetWindow = tab.windowId;
  $('page-title').textContent = tab.title || t('当前网页', 'Current webpage');
  $('page-title').dataset.fallback = String(!tab.title);
  $('page-url').textContent = `${url.host}${url.pathname}`;
  return tab;
}
function clearAccessRequest() {
  pendingAccess = null;
  updateActions();
}
async function scan() {
  let results;
  try {
    results = await chrome.scripting.executeScript({ target: { tabId: targetTab }, files: ['content.js'] });
  } catch (error) {
    if (!/Cannot access|permission/i.test(error.message)) throw error;
    const tab = await chrome.tabs.get(targetTab);
    if (!/^https?:\/\//.test(tab.url || '')) throw error;
    const url = new URL(tab.url);
    pendingAccess = { tabId: tab.id, origin: url.origin, pattern: `${url.protocol}//${url.hostname}/*` };
    updateActions();
    throw new Error(t('尚未获得 {host} 的访问权限。请点击「授权此网站并扫描」。', 'Access to {host} is needed. Click “Allow site & scan”.', { host: raw(url.host) }));
  }
  documentId = results[0].documentId;
  const page = await chrome.tabs.sendMessage(targetTab, { type: 'JEV_SCAN' }, { documentId });
  if (page?.error) throw new Error(pageMessage(page.error));
  if (!page || !Array.isArray(page.fields)) throw new Error(t('网页没有返回可识别的表单。', 'The webpage did not return a recognizable form.'));
  snapshot = { ...page, notice: pageMessage(page.notice), documentId };
  return snapshot;
}
async function send(message) {
  const result = await chrome.tabs.sendMessage(targetTab, message, { documentId });
  return result?.error ? { ...result, error: pageMessage(result.error) } : result;
}
function render(page) {
  $('page-title').textContent = page.title || t('未命名页面', 'Untitled page');
  $('page-title').dataset.fallback = String(!page.title);
  const url = new URL(page.url);
  $('page-url').textContent = `${url.host}${url.pathname}`;
  $('field-count').textContent = t('当前页 {count} 个字段', '{count} fields on this page', { count: page.fields.length });
  for (const field of page.fields) {
    const key = `${page.documentId || page.url}:${field.id}`;
    if (rows.has(key)) continue;
    if (!rows.size) $('fields').replaceChildren();
    const row = document.createElement('div');
    row.className = 'field-row';
    const label = document.createElement('strong');
    label.textContent = field.label;
    const detail = document.createElement('small');
    detail.textContent = field.value && field.type !== 'checkbox' ? t('保留已有内容', 'Keeping existing content') : t('等待填写', 'Waiting to fill');
    row.append(label, detail);
    $('fields').append(row);
    rows.set(key, { row, detail });
  }
  $('progress').max = Math.max(rows.size, 1);
  $('run-metrics').hidden = false;
  $('progress').hidden = !task && $('progress').value === 0;
  $('results-section').hidden = !rows.size && !$('log').children.length;
}
function resultRow(field, action) {
  const key = `${snapshot.documentId || snapshot.url}:${field.id}`;
  const target = rows.get(key);
  if (!target) return;
  target.row.classList.add(action.skipped ? 'error' : 'success');
  const value = field.options?.find(o => o.id === action.value)?.label
    ?? (typeof action.value === 'boolean' ? action.value ? t('已勾选', 'Checked') : t('不勾选', 'Unchecked') : action.value);
  target.detail.textContent = action.skipped ? action.reason : t('{source} · {value}', '{source} · {value}', {
    source: action.source, value: typeof action.value === 'boolean' ? value : raw(String(value).slice(0, 100)),
  });
  $('progress').value = [...rows.values()].filter(r => r.row.classList.contains('success') || r.row.classList.contains('error')).length;
}
function resetResults() {
  rows.clear();
  $('fields').replaceChildren();
  $('log').replaceChildren();
  $('progress').value = 0;
  $('elapsed').textContent = '—';
  $('run-metrics').hidden = true;
  $('progress').hidden = !task;
  $('results-section').hidden = true;
}
function errorMessage(error) {
  if (error.name === 'AbortError') return t('已停止。已填内容保留，再次开始会跳过已有内容。', 'Stopped. Filled answers are kept and will be skipped when you start again.');
  if (error.name === 'TimeoutError') return t('模型请求超时，请稍后重试。', 'The model request timed out. Please try again.');
  if (/Cannot access|permission|Cannot find|Receiving end|Could not establish|No tab|No document/i.test(error.message)) {
    return t('页面访问失败或页面已发生变化。请重新扫描；缺少权限时，侧栏会显示网站授权按钮。', 'The page is unavailable or has changed. Scan again; an authorization button will appear if site access is needed.');
  }
  return error.message || t('执行失败，请重试。', 'The task failed. Please try again.');
}

async function scanPage(expected) {
  setBusy(true);
  status(t('正在扫描页面…', 'Scanning the page…'));
  try {
    const tab = await selectTarget();
    if (expected && (tab.id !== expected.tabId || new URL(tab.url).origin !== expected.origin)) {
      throw new Error(t('当前页面已切换。网站已获授权，请回到目标网页后重新扫描。', 'The active page changed. Site access is granted; return to the target page and scan again.'));
    }
    resetResults();
    const page = await scan();
    render(page);
    status(page.notice || (page.fields.length ? t('识别到 {count} 个字段，可以开始填写。', 'Found {count} fields. Ready to fill.', { count: page.fields.length }) : t('没有识别到可填写字段。', 'No fillable fields found.')));
  } catch (error) { status(errorMessage(error), 'error'); }
  finally { setBusy(false); }
}

async function authorizeSite() {
  const requested = pendingAccess;
  if (!requested) return;
  setBusy(true);
  try {
    // Keep this call in the button gesture, before any asynchronous work.
    const granted = await chrome.permissions.request({ origins: [requested.pattern] });
    if (!granted) {
      status(t('网站授权未获允许，未读取或填写页面。可以再次点击授权按钮。', 'Site access was declined. The page was not read or filled. You can try the authorization button again.'), 'error');
      return;
    }
    await scanPage(requested);
  } catch (error) { status(errorMessage(error), 'error'); }
  finally { setBusy(false); }
}

async function begin() {
  if (task) return;
  const controller = new AbortController();
  task = controller;
  setBusy(true);
  $('preferences-details').open = false;
  resetResults();
  let focusOnFinish;
  const started = performance.now();
  const updateElapsed = () => { $('elapsed').textContent = t('{seconds} 秒', '{seconds} s', { seconds: ((performance.now() - started) / 1000).toFixed(1) }); };
  const ticker = setInterval(updateElapsed, 100);
  try {
    const settings = await save();
    updatePolicy();
    if (settings.mode === 'live' && !settings.typesafeKey) {
      $('preferences-details').open = true;
      focusOnFinish = $('typesafe-key');
      throw new Error(t('请在模型连接设置中填写 TypeSafe API Key。', 'Enter your TypeSafe API key in Model setup.'));
    }
    await selectTarget();
    status(settings.mode === 'demo' ? t('正在运行本地演示…', 'Running the local demo…') : t('正在填写…', 'Filling the form…'));
    log(settings.mode === 'demo' ? t('演示规则：本次不会调用 AI。', 'Local demo: no AI calls.') : t('真实模式：将调用 TypeSafe / DeepSeek。', 'AI mode: using TypeSafe / DeepSeek.'));
    const result = await runForm({
      scan, apply: (fieldId, value) => send({ type: 'JEV_APPLY', fieldId, value }),
      click: buttonId => send({ type: 'JEV_CLICK', buttonId }),
      plan: page => settings.mode === 'demo' ? demoPlan(page, settings.profile)
        : livePlan(page, settings.profile, settings, { signal: controller.signal, onEvent: log }),
      signal: controller.signal, autoNext: settings.autoNext, autoSubmit: settings.autoSubmit,
      onEvent: log, onPage: render, onField: resultRow,
    });
    status(result.message, result.status === 'needs-review' ? 'error' : 'success');
    log(t('本次已处理 {count} 个字段。{message}', 'Processed {count} fields. {message}', { count: result.filled, message: result.message }));
    await chrome.storage.local.set({ lastRun: { status: result.status, filled: result.filled, at: Date.now() } });
  } catch (error) {
    status(errorMessage(error), error.name === 'AbortError' ? '' : 'error');
    log(errorMessage(error));
  } finally {
    clearInterval(ticker);
    updateElapsed();
    task = null;
    setBusy(false);
    focusOnFinish?.focus();
  }
}

async function init() {
  updateTheme('system');
  systemTheme.addEventListener('change', () => {
    if (themePreference === 'system') updateTheme('system');
  });
  setLanguage(navigator.language);
  localize();
  if (!globalThis.chrome?.storage?.local) {
    status(t('请在 Chrome 中加载 extension 文件夹后使用。', 'Load the extension folder in Chrome to use FormPilot.'), 'error');
    $('scan-btn').disabled = $('start-btn').disabled = $('save-btn').disabled = true;
    return;
  }
  $('extension-version').textContent = `v${chrome.runtime.getManifest().version}`;
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  const [{ preferences, language, theme, ...keys }, legacyKeys] = await Promise.all([
    chrome.storage.local.get(['preferences', 'language', 'theme', ...apiKeyNames]), chrome.storage.session.get(apiKeyNames),
  ]);
  const migratedKeys = {};
  for (const key of apiKeyNames) {
    // An explicitly cleared local key must never be restored from an old session.
    if (!Object.hasOwn(keys, key) && typeof legacyKeys[key] === 'string') migratedKeys[key] = legacyKeys[key];
  }
  if (Object.keys(migratedKeys).length) await chrome.storage.local.set(migratedKeys);
  Object.assign(keys, migratedKeys);
  await chrome.storage.session.remove(apiKeyNames);
  if (preferences) {
    for (const key of profileKeys) $(`profile-${key}`).value = preferences.profile?.[key] || '';
    $('mode').value = preferences.mode === 'demo' ? 'demo' : 'live';
    $('deepseek-model').value = preferences.deepseekModel || 'deepseek-flash';
    if (!$('deepseek-model').value) $('deepseek-model').value = 'deepseek-flash';
    $('auto-next').checked = preferences.autoNext ?? true;
  }
  $('typesafe-key').value = keys.typesafeKey || '';
  $('deepseek-key').value = keys.deepseekKey || '';
  updateTheme(theme);
  setLanguage(language || navigator.language);
  localize();
  $('theme').addEventListener('click', async event => {
    const button = event.target.closest('button');
    if (!button || button.value === themePreference) return;
    updateTheme(button.value);
    try { await chrome.storage.local.set({ theme: themePreference }); }
    catch (error) { status(errorMessage(error), 'error'); }
  });
  $('language').addEventListener('click', async event => {
    const button = event.target.closest('button');
    if (!button || $('language').disabled || button.value === getLanguage()) return;
    setLanguage(button.value);
    localize();
    try { await chrome.storage.local.set({ language: getLanguage() }); }
    catch (error) { status(errorMessage(error), 'error'); }
  });
  $('mode').addEventListener('change', updateMode);
  for (const id of ['auto-next', 'auto-submit']) $(id).addEventListener('change', updatePolicy);
  $('demo-btn').addEventListener('click', () => {
    for (const key of profileKeys) $(`profile-${key}`).value = DEMO_PROFILE[key];
    status(t('已载入虚构资料。点击「开始填写」后按当前模式运行。', 'Fictional details loaded. Click “Fill form” to use the selected mode.'));
  });
  for (const id of ['settings-form', 'profile-form']) $(id).addEventListener('submit', async event => {
    event.preventDefault();
    try { await save(); status(t('资料与设置已保存。', 'Details and settings saved.'), 'success'); }
    catch (error) { status(errorMessage(error), 'error'); }
  });
  $('scan-btn').addEventListener('click', () => scanPage());
  $('authorize-btn').addEventListener('click', authorizeSite);
  $('start-btn').addEventListener('click', begin);
  $('stop-btn').addEventListener('click', () => task?.abort());
  chrome.tabs.onActivated.addListener(info => {
    if (info.windowId !== targetWindow || info.tabId === targetTab) return;
    clearAccessRequest();
    if (task) task.abort();
  });
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (tabId === targetTab && change.url) clearAccessRequest();
  });
  window.addEventListener('pagehide', () => task?.abort());
}
init().catch(error => status(errorMessage(error), 'error'));
