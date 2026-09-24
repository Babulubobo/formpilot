import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveStructure } from '../extension/brain.js';
import { runForm } from '../extension/runner.js';

const regions = [{ id: 'field-1', revision: 4, custom: true, currentLabel: 'unknown',
  prompts: [{ id: 'p', text: 'Which is a fruit?' }],
  options: [{ id: 'a', texts: [{ id: 'a-text', text: 'Pear' }] }, { id: 'b', texts: [{ id: 'b-text', text: 'Chair' }] }],
}];
const choice = (choice, confidence = 0.99) => ({ type: 'choice', choice, confidence });
const settings = { typesafeKey: 'test-structure-key' };
const run = answers => resolveStructure(regions, settings, { fetchImpl: async () => ({ ok: true, json: async () => ({ answers }) }) });

test('structure identification batches prompt and label bindings; returns only source IDs and revisions', async () => {
  let calls = 0;
  const result = await resolveStructure(regions, settings, { fetchImpl: async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    const request = JSON.parse(init.body);
    assert.deepEqual(request.state, { regions });
    assert.deepEqual(Object.keys(request.questions), ['s0', 's0o0', 's0o1']);
    assert.match(request.questions.s0o0.instructions, /not the correct quiz answer/);
    assert.equal(request.questions.s0o0.criteria['a-text'], 'Pear');
    return { ok: true, json: async () => ({ answers: { s0: choice('p'), s0o0: choice('a-text'), s0o1: choice('b-text') } }) };
  } });
  assert.equal(calls, 1);
  assert.deepEqual(result, [{ id: 'field-1', revision: 4, prompt: 'p', options: [{ id: 'a', textId: 'a-text' }, { id: 'b', textId: 'b-text' }] }]);
});

test('structural guesses, missing answers and fabricated IDs never become actionable bindings', async () => {
  const valid = { s0: choice('p'), s0o0: choice('a-text'), s0o1: choice('b-text') };
  for (const invalid of [choice('none'), choice('invented'), choice('p', 0.84), choice('p', '0.99'), choice('p', 1.1), { type: 'noul', choice: 'p', confidence: 1 }, undefined]) {
    assert.deepEqual(await run({ ...valid, s0: invalid }), []);
  }
  assert.deepEqual(await run({ ...valid, s0o1: choice('a-text') }), []);
  assert.deepEqual(await run({ ...valid, s0o1: undefined }), []);
  assert.deepEqual(await run({ s0: choice('ignore') }), [{ id: 'field-1', revision: 4, ignore: true }]);
  const native = [{ ...regions[0], custom: false }];
  assert.deepEqual(await resolveStructure(native, settings, { fetchImpl: async () => ({ ok: true, json: async () => ({ answers: { s0: choice('ignore') } }) }) }), []);
});

test('runner refuses to answer or navigate when structural quality is unresolved', async () => {
  const result = await runForm({ scan: async () => ({ url: 'https://example.com/quiz', fields: [], buttons: [], structureCandidates: regions }),
    plan: async () => assert.fail('Bad scan must not reach answer generation'),
    apply: async () => assert.fail('Bad scan must not be filled'), click: async () => assert.fail('Bad scan must not navigate'),
  });
  assert.equal(result.status, 'needs-review');
  assert.equal(result.filled, 0);
  assert.match(result.message, /题干或选项/);
});

test('failed structural decisions report the gate that blocked them without exposing credentials', async () => {
  const events = [];
  const result = await resolveStructure(regions, settings, { onEvent: message => events.push(message),
    fetchImpl: async () => ({ ok: true, json: async () => ({ answers: { s0: choice('p', 0.62) } }) }),
  });
  assert.deepEqual(result, []);
  assert.match(events.join('\n'), /0\.620.*0\.85/);
  assert.ok(!events.join('\n').includes(settings.typesafeKey));
  await assert.rejects(resolveStructure(regions, settings, {
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
  }), /TypeSafe/);
});

test('low structural confidence escalates only unresolved regions to DeepSeek and preserves source bindings', async () => {
  const tools = { ...regions[0], id: 'tools', currentLabel: 'Article tools' };
  const confident = { ...regions[0], id: 'confident' };
  const calls = [];
  const result = await resolveStructure([...regions, tools, confident], { ...settings, deepseekKey: 'test-deepseek', deepseekModel: 'deepseek-pro' }, {
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push(url);
      if (url.includes('typesafe')) return { ok: true, json: async () => ({ answers: {
        s0: choice('p', 0.52), s1: choice('ignore', 0.61), s2: choice('p'), s2o0: choice('a-text'), s2o1: choice('b-text'),
      } }) };
      assert.equal(init.headers.Authorization, 'Bearer test-deepseek');
      assert.equal(body.model, 'deepseek-pro');
      assert.deepEqual(JSON.parse(body.messages[1].content).regions.map(region => region.id), ['field-1', 'tools']);
      return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ regions: [
        { id: 'field-1', revision: -1, prompt: 'p', options: [{ id: 'b', textId: 'b-text' }, { id: 'a', textId: 'a-text' }] },
        { id: 'tools', ignore: true }, { id: 'invented', ignore: true },
      ] }) } }] }) };
    },
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(result.map(region => region.id), ['confident', 'field-1', 'tools']);
  assert.deepEqual(result[1], { id: 'field-1', revision: 4, prompt: 'p', options: [{ id: 'a', textId: 'a-text' }, { id: 'b', textId: 'b-text' }] });
  assert.deepEqual(result[2], { id: 'tools', revision: 4, ignore: true });
});

test('DeepSeek structural fallback rejects foreign IDs, partial or duplicate bindings and attempts to ignore native fields', async () => {
  const valid = { id: 'field-1', prompt: 'p', options: [{ id: 'a', textId: 'a-text' }, { id: 'b', textId: 'b-text' }] };
  const runReview = (reviewed, finish = 'stop') => resolveStructure([{ ...regions[0], custom: false }], { ...settings, deepseekKey: 'test-deepseek' }, {
    fetchImpl: async url => ({ ok: true, json: async () => url.includes('typesafe') ? { answers: { s0: choice('p', 0.3) } }
      : { choices: [{ finish_reason: finish, message: { content: JSON.stringify({ regions: reviewed }) } }] } }),
  });
  for (const reviewed of [[], [null], [valid, valid], [{ ...valid, prompt: 'invented' }],
    [{ ...valid, options: valid.options.slice(0, 1) }], [{ ...valid, options: [valid.options[0], valid.options[0]] }],
    [{ ...valid, options: [{ id: 'a', textId: 'b-text' }, valid.options[1]] }], [{ id: 'field-1', ignore: true }]]) {
    assert.deepEqual(await runReview(reviewed), []);
  }
  await assert.rejects(runReview([valid], 'length'), /DeepSeek/);
});
