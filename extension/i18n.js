let language = 'zh-CN';
const messages = new Map();

export const getLanguage = () => language;
export const setLanguage = value => { language = /^zh\b/i.test(value || '') ? 'zh-CN' : 'en'; };
export const raw = value => ({ raw: String(value ?? '') });

// Keep message templates so an existing status or log can change language too.
const capture = value => Array.isArray(value) ? value.map(capture) : messages.get(value) || value;
function format(value, locale) {
  if (Array.isArray(value)) return value.map(item => format(item, locale)).join(locale === 'en' ? '; ' : '、');
  if (!value || typeof value !== 'object') return String(value ?? '');
  if (Object.hasOwn(value, 'raw')) return value.raw;
  return value[locale === 'en' ? 'en' : 'zh'].replace(/\{(\w+)\}/g,
    (_, key) => format(value.params[key], locale));
}

export function t(zh, en, params = {}) {
  const message = { zh, en, params: Object.fromEntries(Object.entries(params).map(([key, value]) => [key, capture(value)])) };
  const chinese = format(message, 'zh-CN');
  const english = format(message, 'en');
  messages.set(chinese, message);
  messages.set(english, message);
  return language === 'en' ? english : chinese;
}

export const translate = value => messages.has(value) ? format(messages.get(value), language) : value;

// The injected script is not an ES module. Translate its own messages here;
// native browser validation messages and webpage text are kept as received.
const pageMessages = [
  ['当前仅支持主页面，不读取 iframe 内的表单。', 'Only the main page is supported; forms inside iframes are not read.'],
  ['自定义控件与多选下拉框需要手动填写。', 'Custom controls and multi-select lists need to be filled manually.'],
  ['字段已变化或不可编辑，请重新扫描。', 'The field changed or is not editable. Scan again.'],
  ['复选框的值必须是布尔值。', 'A checkbox value must be true or false.'],
  ['选项已变化或不可选择。', 'The option changed or is not selectable.'],
  ['文本字段的值必须是字符串。', 'A text field value must be a string.'],
  ['页面更新了字段，请重新扫描确认填写结果。', 'The page replaced the field. Scan again to check the result.'],
  ['网页未保留填写结果，请重新扫描。', 'The page did not keep the answer. Scan again.'],
  ['填写结果未通过网页校验。', 'The answer did not pass page validation.'],
  ['按钮已变化或不可点击，请重新扫描。', 'The button changed or cannot be clicked. Scan again.'],
];

export function pageMessage(value) {
  if (!value) return value;
  const limit = /^答案超过 (\d+) 字符上限。$/.exec(value);
  if (limit) return t('答案超过 {limit} 字符上限。', 'The answer exceeds the {limit}-character limit.', { limit: limit[1] });
  // A scan can combine multiple notices, each from this fixed list.
  let english = value;
  for (const [zh, en] of pageMessages) english = english.replaceAll(zh, en);
  return english === value ? value : t(value, english);
}
