import test from 'node:test';
import assert from 'node:assert/strict';
import { demoPlan, livePlan, DEMO_PROFILE } from '../extension/brain.js';
import { runForm } from '../extension/runner.js';

const settings = { typesafeKey: 'test-typesafe-secret', deepseekKey: 'test-deepseek-secret' };
const field = (id, extras = {}) => ({ id, label: id, type: 'text', required: false, value: '', ...extras });
const page = (fields, extras = {}) => ({
  url: 'http://localhost:5173/demo', title: 'Test form', fields, buttons: [],
  demo: true, completed: false, validity: { valid: true, errors: [] }, ...extras,
});
const answer = (choice, confidence = 0.99) => ({ type: 'choice', choice, confidence });
const jsonResponse = (body) => ({ ok: true, status: 200, json: async () => body });
const snapshot = (state) => structuredClone(state);
const noWait = async () => {};

test('demo planning requires the demo marker and returns actual option IDs', () => {
  assert.throws(() => demoPlan(page([], { demo: false }), DEMO_PROFILE), /演示模式/);
  const result = demoPlan(page([
    field('name', { demoKey: 'name' }),
    field('country', { type: 'select', demoKey: 'country', options: [{ id: 'option-cn', label: '中国' }] }),
    field('unknown', { demoKey: 'unknown' }),
  ]), DEMO_PROFILE);
  assert.equal(result[0].value, DEMO_PROFILE.name);
  assert.equal(result[1].value, 'option-cn');
  assert.equal(result[2].skipped, true);
});

test('TypeSafe choice answers reject unknown keys, wrong types and invalid confidence', async () => {
  const fields = Array.from({ length: 7 }, (_, index) => field(`field-${index}`));
  fields.push(field('country', { type: 'select', options: [{ id: 'option-cn', label: '中国' }] }));
  fields.push(field('newsletter', { type: 'checkbox', value: false }));
  const choices = [answer('name'), answer('name', 0.79), answer('invented'),
    answer('name', '0.99'), { type: 'boolean', choice: 'name', confidence: 0.99 },
    answer('name', 1.01), answer('skip'), answer('c0'), answer('unchecked')];
  let calls = 0;
  const result = await livePlan(page(fields), DEMO_PROFILE, settings, {
    fetchImpl: async (url, init) => {
      calls++;
      if (url === 'https://api.deepseek.com/chat/completions') {
        const request = JSON.parse(init.body);
        assert.deepEqual(JSON.parse(request.messages[1].content).fields.map(item => item.id), ['field-1', 'field-6']);
        return jsonResponse({ choices: [{ finish_reason: 'stop', message: {
          content: JSON.stringify({ answers: { 'field-1': null, 'field-6': null } }),
        } }] });
      }
      assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
      const request = JSON.parse(init.body);
      assert.equal(request.model, 'jev-latest');
      assert.equal(Object.keys(request.questions).length, fields.length);
      assert.ok(Object.values(request.questions).every(q => q.type === 'choice'));
      return jsonResponse({ answers: Object.fromEntries(choices.map((value, index) => [`q${index}`, value])) });
    },
  });
  assert.equal(calls, 2);
  assert.equal(result[0].value, DEMO_PROFILE.name);
  assert.ok(result.slice(1, 7).every(item => item.skipped && !Object.hasOwn(item, 'value')));
  assert.equal(result[7].value, 'option-cn');
  assert.equal(result[8].value, false);
});

test('one JEV batch and one DeepSeek batch fill supported facts and skip missing facts', async () => {
  const calls = [];
  const fields = [field('name'), field('email'), field('intro', { type: 'textarea' }),
    field('unprovided-experience', { type: 'textarea' }), field('unknown-fact')];
  const result = await livePlan(page(fields), DEMO_PROFILE, settings, {
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url, body });
      if (calls.length === 1) return jsonResponse({ answers: {
        q0: answer('name'), q1: answer('email'), q2: answer('write'), q3: answer('write'), q4: answer('personal'),
      } });
      return jsonResponse({ choices: [{ finish_reason: 'stop', message: {
        content: JSON.stringify({ answers: { intro: '在 Seed Studio 开发浏览器自动化工具。', 'unprovided-experience': null } }),
      } }] });
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'https://api.deepseek.com/chat/completions');
  assert.deepEqual(JSON.parse(calls[1].body.messages[1].content).fields.map(f => f.id), ['intro', 'unprovided-experience']);
  assert.equal(result[0].value, DEMO_PROFILE.name);
  assert.equal(result[1].value, DEMO_PROFILE.email);
  assert.equal(result[2].source, 'DeepSeek');
  assert.ok(result.slice(3).every(item => item.skipped && !Object.hasOwn(item, 'value')));
});

test('empty profiles still route knowledge and drafting to DeepSeek while missing personal facts stay blank', async () => {
  const fields = [
    field('knowledge', { label: '解释浏览器 DOM 的作用', type: 'textarea' }),
    field('proposal', { label: '根据页面要求提出一个自动填表方案', type: 'textarea' }),
    field('personal-email', { label: '你的联系邮箱', type: 'email' }),
  ];
  const current = page(fields, {
    title: '自动化方案练习',
    context: '用原生浏览器控件完成两页表单，并在操作后检查页面状态。',
    previousAnswers: [{ label: '限制条件', value: '只操作原生表单控件' }],
  });
  const calls = [];
  const result = await livePlan(current, {}, settings, {
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url, body });
      if (url.includes('typesafe')) {
        return jsonResponse({ answers: { q0: answer('write'), q1: answer('write'), q2: answer('personal') } });
      }
      return jsonResponse({ choices: [{ finish_reason: 'stop', message: {
        content: JSON.stringify({ answers: {
          knowledge: 'DOM 将文档表示为可读取和操作的节点树。',
          proposal: '读取原生控件、填写内容、验证当前页面，再进入下一页。',
        } }),
      } }] });
    },
  });
  assert.equal(calls.length, 2);
  const jevState = calls[0].body.state;
  const writerState = JSON.parse(calls[1].body.messages[1].content);
  for (const state of [jevState, writerState]) {
    assert.deepEqual(state.profile, {});
    assert.deepEqual(state.page, { title: current.title, context: current.context });
    assert.deepEqual(state.previousAnswers, current.previousAnswers);
  }
  assert.ok(Object.hasOwn(calls[0].body.questions.q0.criteria, 'write'));
  assert.ok(Object.hasOwn(calls[0].body.questions.q2.criteria, 'personal'));
  assert.deepEqual(writerState.fields.map(item => item.id), ['knowledge', 'proposal']);
  assert.equal(result[0].value, 'DOM 将文档表示为可读取和操作的节点树。');
  assert.equal(result[1].value, '读取原生控件、填写内容、验证当前页面，再进入下一页。');
  assert.ok(result.slice(0, 2).every(item => item.source === 'DeepSeek'));
  assert.equal(result[2].skipped, true);
  assert.equal(Object.hasOwn(result[2], 'value'), false);
});

test('uncertain text and closed choices share a DeepSeek second pass while checkbox consent stays guarded', async () => {
  const fields = [
    field('uncertain-skip', { type: 'textarea' }),
    field('uncertain-write'),
    field('confident-skip', { type: 'textarea' }),
    field('uncertain-option', { type: 'select', options: [{ id: 'actual-option', label: '选项 A' }] }),
    field('checked-option', { type: 'checkbox', value: false }),
    field('uncertain-checkbox', { type: 'checkbox', value: false }),
  ];
  let calls = 0;
  const result = await livePlan(page(fields), {}, settings, {
    fetchImpl: async (url, init) => {
      calls++;
      if (url.includes('typesafe')) return jsonResponse({ answers: {
        q0: answer('skip', 0.45), q1: answer('write', 0.79),
        q2: answer('skip'), q3: answer('c0', 0.79), q4: answer('checked'), q5: answer('checked', 0.79),
      } });
      const body = JSON.parse(init.body);
      assert.deepEqual(JSON.parse(body.messages[1].content).fields.map(item => item.id), ['uncertain-skip', 'uncertain-write', 'confident-skip', 'uncertain-option']);
      return jsonResponse({ choices: [{ finish_reason: 'stop', message: {
        content: JSON.stringify({ answers: {
          'uncertain-skip': 'A supported answer', 'uncertain-write': null, 'confident-skip': 'Another supported answer', 'uncertain-option': 'actual-option',
        } }),
      } }] });
    },
  });
  assert.equal(calls, 2);
  assert.equal(result[0].value, 'A supported answer');
  assert.equal(result[0].source, 'DeepSeek');
  assert.ok([result[1], result[5]].every(item => item.skipped && !Object.hasOwn(item, 'value')));
  assert.equal(result[2].value, 'Another supported answer');
  assert.equal(result[3].value, 'actual-option');
  assert.equal(result[3].source, 'DeepSeek');
  assert.equal(result[4].value, true);
  assert.equal(result[4].source, '智能判断');
});

test('closed choices with an empty profile use actual option IDs and reject invented options', async () => {
  const options = [{ id: 'option-markup', label: 'HTML' }, { id: 'option-script', label: 'JavaScript' }];
  const fields = [
    field('knowledge-choice', { label: '哪种语言可以操作浏览器 DOM？', type: 'radio', options }),
    field('invented-choice', { type: 'select', options }),
  ];
  let calls = 0;
  const result = await livePlan(page(fields), {}, settings, {
    fetchImpl: async (url, init) => {
      calls++;
      assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
      const body = JSON.parse(init.body);
      assert.deepEqual(body.state.profile, {});
      assert.equal(body.questions.q0.criteria.c1, options[1].label);
      return jsonResponse({ answers: { q0: answer('c1'), q1: answer('invented-option') } });
    },
  });
  assert.equal(calls, 1);
  assert.equal(result[0].value, 'option-script');
  assert.equal(result[0].source, '智能判断');
  assert.equal(result[1].skipped, true);
  assert.equal(Object.hasOwn(result[1], 'value'), false);
});

test('low-confidence and skipped closed choices receive one shared DeepSeek pass with text', async () => {
  const options = [{ id: 'option-a', label: 'First answer' }, { id: 'option-b', label: 'Second answer' }];
  const fields = [
    field('uncertain-radio', { type: 'radio', options }),
    field('skipped-select', { type: 'select', options }),
    field('explanation', { type: 'textarea' }),
    field('personal-choice', { type: 'select', options }),
    field('invalid-jev-choice', { type: 'radio', options }),
  ];
  const calls = [];
  const events = [];
  const result = await livePlan(page(fields), {}, settings, {
    onEvent: message => events.push(message),
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      if (url.includes('typesafe')) return jsonResponse({ answers: {
        q0: answer('c0', 0.79), q1: answer('skip'), q2: answer('write'),
        q3: answer('personal'), q4: answer('c42'),
      } });
      return jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ answers: {
        'uncertain-radio': 'option-b', 'skipped-select': 'option-a', explanation: 'A reasoned answer.',
      } }) } }] });
    },
  });
  assert.equal(calls.length, 2);
  const firstPass = calls[0].body;
  assert.deepEqual(firstPass.state.fields[0].options, options, 'all options must reach the first judgment model');
  assert.equal(firstPass.questions.q0.criteria.c0, options[0].label);
  assert.equal(Object.hasOwn(firstPass.questions.q0.criteria, 'write'), false);
  assert.match(firstPass.questions.q0.instructions, /这是选择题/);
  assert.match(firstPass.questions.q2.instructions, /这是文本题/);
  const secondPass = JSON.parse(calls[1].body.messages[1].content);
  assert.deepEqual(secondPass.fields.map(item => item.id), ['uncertain-radio', 'skipped-select', 'explanation']);
  assert.deepEqual(secondPass.fields[0].options, options);
  assert.deepEqual(result.slice(0, 3).map(item => item.value), ['option-b', 'option-a', 'A reasoned answer.']);
  assert.ok(result.slice(0, 3).every(item => item.source === 'DeepSeek'));
  assert.ok(result.slice(3).every(item => item.skipped && !Object.hasOwn(item, 'value')));
  assert.ok(events.some(message => /DeepSeek/.test(message) && /选择题/.test(message)), 'the log must identify the choice-question second pass');
  assert.ok(events.some(message => /uncertain-radio/.test(message) && /choice=c0/.test(message) && /0\.79/.test(message) && /低于阈值 0\.8/.test(message)));
  assert.ok(events.some(message => /skipped-select/.test(message) && /choice=skip/.test(message) && /初次判断未选出答案/.test(message)));
});

test('DeepSeek closed-choice answers reject invented IDs, labels, raw values and numbers', async () => {
  const options = [{ id: 'existing-option', label: 'A real answer' }];
  const invalidAnswers = ['invented-option', 'A real answer', '1', 1];
  const fields = invalidAnswers.map((_, index) => field(`choice-${index}`, { type: index % 2 ? 'select' : 'radio', options }));
  let calls = 0;
  const result = await livePlan(page(fields), {}, settings, {
    fetchImpl: async url => {
      calls++;
      if (url.includes('typesafe')) return jsonResponse({ answers: Object.fromEntries(fields.map((_, index) => [`q${index}`, answer('skip')])) });
      return jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ answers:
        Object.fromEntries(fields.map((item, index) => [item.id, invalidAnswers[index]])),
      }) } }] });
    },
  });
  assert.equal(calls, 2, 'valid JEV skip decisions must reach the second pass');
  assert.ok(result.every(item => item.skipped && !Object.hasOwn(item, 'value')));
});

test('choice second passes without a DeepSeek key explain the missing setting and make no extra request', async () => {
  const options = [{ id: 'existing-option', label: 'A real answer' }];
  let calls = 0;
  const result = await livePlan(page([
    field('radio', { type: 'radio', options }), field('select', { type: 'select', options }),
  ]), {}, { ...settings, deepseekKey: '' }, {
    fetchImpl: async url => {
      calls++;
      assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
      return jsonResponse({ answers: { q0: answer('c0', 0.79), q1: answer('skip') } });
    },
  });
  assert.equal(calls, 1);
  assert.ok(result.every(item => item.skipped && /DeepSeek/.test(item.reason) && /Key/.test(item.reason)));
});

test('unanswered second-pass choices and text expose their supplied reasons', async () => {
  const reasons = { radio: '给定选项均无法匹配题意。', text: '题目缺少必要的上下文。' };
  const result = await livePlan(page([
    field('radio', { type: 'radio', options: [{ id: 'existing-option', label: 'A real answer' }] }),
    field('text', { type: 'textarea' }),
  ]), {}, settings, {
    fetchImpl: async url => url.includes('typesafe')
      ? jsonResponse({ answers: { q0: answer('skip'), q1: answer('write') } })
      : jsonResponse({ choices: [{ finish_reason: 'stop', message: {
        content: JSON.stringify({ answers: { radio: null, text: null }, reasons }),
      } }] }),
  });
  assert.ok(result.every(item => item.skipped && !Object.hasOwn(item, 'value')));
  assert.deepEqual(result.map(item => item.reason), [reasons.radio, reasons.text]);
});

test('API errors do not expose response text or credentials', async () => {
  const sensitive = `upstream body contains ${settings.typesafeKey}`;
  for (const status of [401, 429, 500]) {
    let readBody = false;
    await assert.rejects(livePlan(page([field('name')]), DEMO_PROFILE, settings, {
      fetchImpl: async () => ({ ok: false, status, json: async () => { readBody = true; return sensitive; } }),
    }), error => error.message.includes(String(status)) && !error.message.includes(settings.typesafeKey));
    assert.equal(readBody, false);
  }
  await assert.rejects(livePlan(page([field('name')]), DEMO_PROFILE, settings, {
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError(sensitive); } }),
  }), error => !error.message.includes(settings.typesafeKey) && !error.message.includes('upstream body'));
});

test('runner preserves existing answers and changes made while the model is thinking', async () => {
  const state = page([field('existing', { value: 'Keep this' }), field('concurrent'), field('blank')]);
  const applied = [];
  let plannedIds;
  const result = await runForm({
    scan: async () => snapshot(state),
    plan: async current => {
      plannedIds = current.fields.map(f => f.id);
      state.fields[1].value = 'User typed this';
      return current.fields.map(f => ({ fieldId: f.id, value: 'Model answer' }));
    },
    apply: async (id, value) => {
      applied.push(id);
      state.fields.find(f => f.id === id).value = value;
      return { ok: true, value };
    },
    click: async () => assert.fail('No navigation button is available'), wait: noWait,
  });
  assert.deepEqual(plannedIds, ['concurrent', 'blank']);
  assert.deepEqual(applied, ['blank']);
  assert.equal(state.fields[0].value, 'Keep this');
  assert.equal(state.fields[1].value, 'User typed this');
  assert.equal(result.filled, 1);
});

test('unanswered required fields prevent the runner from clicking next', async () => {
  const state = page([field('required', { required: true })], {
    buttons: [{ id: 'next', label: 'Next', kind: 'next' }],
    validity: { valid: false, errors: [{ fieldId: 'required', label: 'Required answer', message: 'Missing' }] },
  });
  const result = await runForm({
    scan: async () => snapshot(state), plan: async () => [{ fieldId: 'required', skipped: true, reason: 'Unknown' }],
    apply: async () => assert.fail('Skipped fields must not be filled'),
    click: async () => assert.fail('Invalid forms must not advance'), autoNext: true, wait: noWait,
  });
  assert.equal(result.status, 'needs-review');
  assert.match(result.message, /Required answer/);
});

test('submission is disabled unless explicitly enabled', async () => {
  const state = page([field('name', { value: 'Already filled' })], {
    buttons: [{ id: 'submit', label: 'Submit', kind: 'submit' }],
  });
  const result = await runForm({
    scan: async () => snapshot(state), plan: async () => assert.fail('No fields need planning'),
    apply: async () => assert.fail('No fields need filling'),
    click: async () => assert.fail('Submission requires explicit opt-in'), autoNext: true, wait: noWait,
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.filled, 0);
});

test('runner processes multiple pages and observes demo completion after submission', async () => {
  const states = [
    page([field('first')], { buttons: [{ id: 'next', label: 'Next', kind: 'next' }] }),
    page([field('second')], { buttons: [{ id: 'submit', label: 'Submit', kind: 'submit' }] }),
    page([], { completed: true }),
  ];
  let index = 0;
  const clicked = [];
  const result = await runForm({
    scan: async () => snapshot(states[index]),
    plan: async current => current.fields.map(f => ({ fieldId: f.id, value: `Answer for ${f.id}` })),
    apply: async (id, value) => {
      states[index].fields.find(f => f.id === id).value = value;
      return { ok: true, value };
    },
    click: async id => { clicked.push(id); index++; return { ok: true }; },
    autoNext: true, autoSubmit: true, wait: noWait,
  });
  assert.equal(result.status, 'complete');
  assert.equal(result.filled, 2);
  assert.deepEqual(clicked, ['next', 'submit']);
});

test('same-URL documents with reused field IDs are each planned and answered before advancing', async () => {
  const options = [{ id: 'option-one', label: 'First answer' }, { id: 'option-two', label: 'Second answer' }];
  const states = ['document-one', 'document-two'].map(documentId => page([
    field('jev-1', { label: 'Quiz question', type: 'radio', options }),
  ], { documentId, buttons: [{ id: 'next', label: '下一题', kind: 'next' }] }));
  states.push(page([], { documentId: 'document-complete', completed: true }));
  let index = 0;
  const plannedDocuments = [];
  const result = await runForm({
    scan: async () => snapshot(states[index]),
    plan: async current => {
      plannedDocuments.push(current.documentId);
      return [{ fieldId: 'jev-1', value: 'option-two', source: 'test' }];
    },
    apply: async (id, value) => {
      states[index].fields.find(item => item.id === id).value = value;
      return { ok: true, value };
    },
    click: async () => {
      assert.equal(states[index].fields[0].value, 'option-two', 'every document must have an actual answer before its next button is clicked');
      index++;
      return { ok: true };
    },
    autoNext: true, wait: noWait,
  });
  assert.deepEqual(plannedDocuments, ['document-one', 'document-two']);
  assert.equal(result.filled, 2);
  assert.equal(result.status, 'complete');
});

test('non-required radio questions cannot advance when skipped, omitted, rejected or not actually selected', async () => {
  for (const outcome of ['skipped', 'omitted', 'rejected', 'not-persisted']) {
    const state = page([field('jev-1', {
      type: 'radio', required: false, options: [{ id: 'option-one', label: 'A real option' }],
    })], { documentId: 'quiz-document', buttons: [{ id: 'next', label: '下一题', kind: 'next' }] });
    const result = await runForm({
      scan: async () => snapshot(state),
      plan: async () => outcome === 'omitted' ? [] : [{ fieldId: 'jev-1',
        ...(outcome === 'skipped' ? { skipped: true, reason: 'Cannot answer' } : { value: 'option-one' }),
      }],
      apply: async () => outcome === 'rejected' ? { ok: false, error: 'Option rejected' }
        : { ok: true, value: 'option-one' }, // DOM did not retain the choice.
      click: async () => assert.fail(`${outcome} radio answer must not advance an optional quiz question`),
      autoNext: true, wait: noWait,
    });
    assert.equal(result.status, 'needs-review', outcome);
    if (outcome === 'skipped') assert.match(result.message, /Cannot answer/);
  }
});

test('a completely skipped optional page cannot be navigated or submitted', async () => {
  for (const kind of ['next', 'submit']) {
    const state = page([field('short-answer', { type: 'textarea' }), field('unknown-email', { type: 'email' })], {
      buttons: [{ id: 'continue', label: kind, kind }],
    });
    const result = await runForm({
      scan: async () => snapshot(state),
      plan: async current => current.fields.map(item => ({ fieldId: item.id, skipped: true, reason: 'No answer' })),
      apply: async () => assert.fail('A skipped answer must not be applied'),
      click: async () => assert.fail(`An unanswered optional page must not ${kind}`),
      autoNext: true, autoSubmit: true, wait: noWait,
    });
    assert.equal(result.status, 'needs-review');
    assert.equal(result.filled, 0);
  }
});

test('abort after planning or first write prevents subsequent writes and clicks', async () => {
  for (const abortDuring of ['plan', 'apply']) {
    const controller = new AbortController();
    const state = page([field('first'), field('second')]);
    const applied = [];
    await assert.rejects(runForm({
      scan: async () => snapshot(state),
      plan: async current => {
        if (abortDuring === 'plan') controller.abort();
        return current.fields.map(f => ({ fieldId: f.id, value: 'Answer' }));
      },
      apply: async id => { applied.push(id); controller.abort(); return { ok: true }; },
      click: async () => assert.fail('Aborted tasks must not click'),
      signal: controller.signal, autoNext: true, autoSubmit: true, wait: noWait,
    }), { name: 'AbortError' });
    assert.deepEqual(applied, abortDuring === 'plan' ? [] : ['first']);
  }
});

test('a next button that makes no progress is clicked only once', async () => {
  const state = page([field('name', { value: 'Filled' })], {
    buttons: [{ id: 'next', label: 'Next', kind: 'next' }],
  });
  let clicked = 0;
  const result = await runForm({
    scan: async () => snapshot(state), plan: async () => assert.fail('No planning needed'),
    apply: async () => assert.fail('No filling needed'),
    click: async () => { clicked++; return { ok: true }; },
    autoNext: true, wait: noWait,
  });
  assert.equal(clicked, 1);
  assert.equal(result.status, 'needs-review');
});
