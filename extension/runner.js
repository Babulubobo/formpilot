import { t, raw } from './i18n.js';

function checkStop(signal) { signal?.throwIfAborted(); }
const signature = page => JSON.stringify([page.documentId, page.url, page.fields.map(f => [f.id, f.label, f.type, f.options])]);
const fieldKey = (page, field) => `${page.documentId || page.url}:${field.id}`;
const isBlank = field => field.value === '' || field.value == null;
const completionMessage = page => page.demo
  ? t('本地演示已完成，未向外部提交。', 'The local demo is complete. Nothing was submitted externally.')
  : t('测验已完成，请在网页查看成绩。', 'The quiz is complete. Check your score on the webpage.');

export async function runForm({ scan, apply, click, plan, signal, autoNext, autoSubmit,
  onEvent = () => {}, onPage = () => {}, onField = () => {}, wait = ms => new Promise(r => setTimeout(r, ms)) }) {
  let page = await scan();
  const origin = new URL(page.url).origin;
  const visited = new Set();
  const handled = new Map();
  const unansweredReasons = new Map();
  const answers = new Map();
  const remember = (page, field, value, source) => {
    answers.set(fieldKey(page, field), {
      question: field.label, value: field.options?.find(o => o.id === value)?.label ?? value, source,
    });
  };
  let filled = 0;
  let startedQuiz = false;
  const finish = (status, message) => ({ status, message, filled });
  for (let round = 0; round < 20; round++) {
    checkStop(signal);
    if (new URL(page.url).origin !== origin) return finish('needs-review', t('页面跳转到其他网站，请重新识别并开始。', 'The page moved to another website. Scan it again to restart.'));
    onPage(page);
    if (page.completed) return finish('complete', completionMessage(page));
    if (page.structureCandidates?.length) return finish('needs-review', t('有 {count} 个区域的题干或选项仍未识别完整，已停止答题。', 'Prompts or options remain incomplete in {count} regions. Answering has stopped.', { count: page.structureCandidates.length }));
    if (!page.fields.length) {
      const starts = page.buttons.filter(button => button.kind === 'start');
      if (page.quiz && !startedQuiz && starts.length === 1) {
        startedQuiz = true;
        onEvent(t('正在打开测验题目…', 'Opening the quiz questions…'));
        checkStop(signal);
        const result = await click(starts[0].id);
        if (!result.ok) return finish('needs-review', result.error || t('测验未能开始，请在网页中检查。', 'The quiz could not start. Check the webpage.'));
        for (let attempt = 0; attempt < 20; attempt++) {
          checkStop(signal);
          await wait(250);
          checkStop(signal);
          page = await scan();
          if (page.fields.length || page.completed || new URL(page.url).origin !== origin) break;
        }
        continue;
      }
      return finish('needs-review', page.notice || t('没有找到可填写字段，请检查当前页面。', 'No fillable fields were found. Please check the current page.'));
    }
    for (const field of page.fields) {
      const key = fieldKey(page, field);
      if (!answers.has(key) && field.value !== '' && field.value != null && field.value !== false) {
        remember(page, field, field.value, t('页面已有内容，来源未验证', 'Existing page content; source unverified'));
      }
    }
    const before = signature(page);
    const pending = page.fields.filter(f => !handled.has(fieldKey(page, f))
      && (f.type === 'checkbox' ? !f.value : f.value === '' || f.value == null));
    if (pending.length) {
      onEvent(t('正在处理 {count} 个字段…', 'Processing {count} fields…', { count: pending.length }));
      const actions = await plan({ ...page, fields: pending, previousAnswers: [...answers.values()] });
      checkStop(signal);
      // Check live state after network calls; never apply an old plan to a new document.
      const current = await scan();
      if (signature(current) !== before) return finish('needs-review', t('判断期间页面发生变化，请重新开始。', 'The page changed while planning. Please restart.'));
      for (const field of pending) {
        checkStop(signal);
        const livePage = await scan();
        checkStop(signal);
        if (new URL(livePage.url).origin !== origin || livePage.documentId !== page.documentId) return finish('needs-review', t('页面发生变化，已停止填写。', 'The page changed. Filling has stopped.'));
        const live = livePage.fields.find(f => f.id === field.id);
        if (!live || live.label !== field.label || live.type !== field.type || JSON.stringify(live.options) !== JSON.stringify(field.options)) return finish('needs-review', t('字段发生变化，已停止填写。', 'A field changed. Filling has stopped.'));
        const action = actions.find(a => a.fieldId === field.id);
        const key = fieldKey(page, field);
        handled.set(key, false);
        if (!action || action.skipped) {
          const reason = action?.reason || t('没有可用答案', 'No answer is available');
          unansweredReasons.set(key, reason);
          onField(field, { skipped: true, reason });
          onEvent(t('未作答：{label} · {reason}', 'Unanswered: {label} · {reason}', { label: raw(field.label), reason }));
          continue;
        }
        // Preserve a value entered by the user while the model was answering.
        if (live.value !== field.value) {
          remember(page, live, live.value, t('页面已修改，来源未验证', 'Page content changed; source unverified'));
          onField(field, { skipped: true, reason: t('保留刚刚修改的内容', 'Kept the recently edited content') });
          continue;
        }
        const result = await apply(field.id, action.value);
        checkStop(signal);
        if (!result.ok) {
          onField(field, { skipped: true, reason: result.error || t('填写失败', 'Could not fill the field') });
          return finish('needs-review', t('有字段未通过填写检查，请查看执行结果。', 'A field did not pass the filling check. Please review the results.'));
        }
        filled++;
        handled.set(key, true);
        remember(page, field, action.value, action.source || t('模型答案', 'AI answer'));
        onField(field, action);
      }
    }
    page = await scan();
    checkStop(signal);
    if (new URL(page.url).origin !== origin) return finish('needs-review', t('页面跳转到其他网站，已停止。', 'The page moved to another website. Execution has stopped.'));
    if (signature(page) !== before) continue; // Conditional fields appeared; inspect them first.
    const errors = page.validity?.errors || [];
    if (errors.length) return finish('needs-review', t('还需补充或修改：{labels}', 'Please complete or correct: {labels}', { labels: errors.map(e => raw(e.label)) }));
    // Older quizzes often omit required, so browser validity alone allows empty submissions.
    const unansweredChoices = page.fields.filter(f => ['radio', 'select'].includes(f.type) && isBlank(f));
    if (unansweredChoices.length) return finish('needs-review', t('选项尚未作答，已停止自动翻页：{fields}', 'Some choices are unanswered. Automatic navigation stopped: {fields}', { fields: unansweredChoices.map(f =>
      t('{label}（{reason}）', '{label} ({reason})', { label: raw(f.label), reason: unansweredReasons.get(fieldKey(page, f)) || t('网页未保留选中结果，请重新扫描。', 'The page did not retain the selection. Please scan again.') })) }));
    const hasAnswer = page.fields.some(f => f.type === 'checkbox'
      ? f.value || handled.get(fieldKey(page, f)) : !isBlank(f));
    if (!hasAnswer) return finish('needs-review', t('本页没有可用答案，已停止自动翻页。请查看各字段的原因。', 'No answers are available on this page. Automatic navigation stopped. Please review the reasons for each field.'));
    const candidates = page.buttons.filter(b => b.kind === 'next');
    const targets = candidates.length ? candidates : page.buttons.filter(b => b.kind === 'submit');
    if (targets.length !== 1) return finish('filled', t('本页填写完成，请检查页面并继续。', 'This page is filled. Please review it and continue.'));
    const target = targets[0];
    if (target.kind === 'next' && !autoNext) return finish('filled', t('本页填写完成，等待你翻页。', 'This page is filled. Go to the next page when ready.'));
    if (target.kind === 'submit' && !autoSubmit) return finish('ready', t('填写完成，等待你检查并提交。', 'Filling is complete. Please review and submit.'));
    if (visited.has(before)) return finish('needs-review', t('页面没有继续前进，已停止重复点击。', 'The page has not advanced. Repeated clicks have stopped.'));
    visited.add(before);
    onEvent(target.kind === 'next' ? t('正在进入下一页…', 'Opening the next page…') : t('正在提交…', 'Submitting…'));
    checkStop(signal);
    const clicked = await click(target.id);
    if (!clicked.ok) return finish('needs-review', clicked.error || t('按钮点击失败', 'Could not click the button'));
    let changed = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      checkStop(signal);
      await wait(250);
      checkStop(signal);
      try { page = await scan(); } catch (error) { if (attempt === 19) throw error; else continue; }
      if (page.completed) return finish('complete', completionMessage(page));
      if (signature(page) !== before) { changed = true; break; }
      if (page.validity?.errors?.length) return finish('needs-review', t('页面提示填写有误，请检查后继续。', 'The page reported invalid answers. Please review them before continuing.'));
    }
    // Generic pages don't offer reliable proof of acceptance. Never report success from a click.
    if (target.kind === 'submit') return finish('submitted', t('已点击提交，请在网站上核对是否提交成功。', 'Submit was clicked. Please confirm on the website whether it succeeded.'));
    if (!changed) return finish('needs-review', t('点击后页面没有变化，请检查网页。', 'The page did not change after the click. Please check the website.'));
  }
  return finish('needs-review', t('达到本次运行的 20 轮上限，请检查页面后继续。', 'This run reached the limit of 20 rounds. Please check the page before continuing.'));
}
