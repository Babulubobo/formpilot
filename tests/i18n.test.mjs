import test from 'node:test';
import assert from 'node:assert/strict';
import { t, translate, setLanguage, getLanguage, pageMessage, raw } from '../extension/i18n.js';

test('language changes re-render existing nested messages and preserve question text', () => {
  setLanguage('zh-TW');
  assert.equal(getLanguage(), 'zh-CN');
  const question = '题目 {value} / Question';
  const reason = t('没有可用答案', 'No answer is available');
  const literalAnswer = t('AI · {value}', 'AI · {value}', { value: raw(reason) });
  const entry = t('{label}（{reason}）', '{label} ({reason})', { label: question, reason });
  const original = t('请检查：{fields}', 'Please review: {fields}', { fields: [entry, 'Other question'] });
  const notice = pageMessage('当前仅支持主页面，不读取 iframe 内的表单。 自定义控件与多选下拉框需要手动填写。');
  setLanguage('en-US');
  assert.equal(getLanguage(), 'en');
  assert.equal(translate(literalAnswer), 'AI · 没有可用答案', 'actual answers must not be translated even when they match UI messages');
  const english = translate(original);
  assert.equal(english, `Please review: ${question} (No answer is available); Other question`);
  assert.doesNotMatch(translate(notice), /\p{Script=Han}/u);
  assert.equal(pageMessage('答案超过 20 字符上限。'), 'The answer exceeds the 20-character limit.');
  assert.equal(pageMessage('Website validation text'), 'Website validation text');
  setLanguage('zh-CN');
  assert.equal(translate(english), original);
});
