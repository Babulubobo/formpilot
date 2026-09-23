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
