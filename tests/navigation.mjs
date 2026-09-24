import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runForm } from '../extension/runner.js';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href : 'playwright');
const browser = await chromium.launch({ headless: true, channel: 'chromium',
  ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}),
});
try {
  for (const [previous, next, submit] of [['上一题', '下一题', '提交'], ['Previous question', 'Next question', 'Submit']]) {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><style>.option{cursor:pointer}</style><section>
      <div><h2>Choose a tag.</h2><div><div class="option">&lt;a&gt;</div><div class="option">&lt;link&gt;</div></div></div>
      <div><button id="previous" hidden>${previous}</button><button id="next">${next}</button></div></section>`);
    await page.evaluate(() => { window.chrome = { runtime: { onMessage: { addListener(fn) { window.bridge = fn; } } } }; });
    await page.addScriptTag({ path: fileURLToPath(new URL('../extension/content.js', import.meta.url)) });
    const scan = () => page.evaluate(() => new Promise(resolve => window.bridge({ type: 'JEV_SCAN' }, {}, resolve)));
    assert.equal((await scan()).fields.length, 1);
    await page.locator('#previous').evaluate(node => node.hidden = false);
    await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', `<section>
      <div><span role="heading" tabindex="0">Explore topics</span></div>
      <div role="link" tabindex="0" style="cursor:pointer">Topic one</div>
      <div role="link" tabindex="0" style="cursor:pointer">Topic two</div></section>
      <section><a href="/one" tabindex="0">Related page one</a><a href="/two" tabindex="0">Related page two</a></section>`));
    const second = await scan();
    assert.equal(second.fields.length, 1, 'Revealing Previous must not invent another question');
    assert.deepEqual(second.fields[0].options.map(option => option.label), ['<a>', '<link>']);
    assert.equal(second.structureCandidates.length, 1, 'Navigation must never reach semantic structure identification');
    assert.equal(second.buttons.find(button => button.label === next)?.kind, 'next');
    await page.locator('#next').evaluate((node, label) => node.textContent = label, submit);
    const last = await scan();
    assert.equal(last.fields.length, 1);
    assert.equal(last.buttons.find(button => button.label === submit)?.kind, 'submit');
    await page.locator('#next').evaluate((node, label) => {
      const link = document.createElement('a');
      link.setAttribute('role', 'button'); link.href = '#'; link.textContent = label; node.replaceWith(link);
    }, next);
    assert.equal((await scan()).buttons.find(button => button.label === next)?.kind, 'next');
    await page.evaluate(([previous, next]) => {
      const group = document.createElement('fieldset');
      group.innerHTML = '<legend>Choose a label.</legend><button aria-pressed="false"></button><button aria-pressed="false"></button>';
      [...group.querySelectorAll('button')].forEach((button, index) => button.textContent = [previous, next][index]);
      document.body.append(group);
    }, [previous, next]);
    const toggleQuestion = (await scan()).fields.find(field => field.label === 'Choose a label.');
    assert.deepEqual(toggleQuestion.options.map(option => option.label), [previous, next], 'Explicit toggle answers retain navigation words as valid option text');
    await page.close();
  }
  console.log('PASS: Chinese and English previous/next/submit controls stay out of question candidates across pages; no model calls.');
  for (const [check, next, finish] of [['检查', '下一题', '完成测验'], ['Check answer', 'Next question', 'Finish quiz']]) {
    const page = await browser.newPage();
    await page.route('https://quiz.test/', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html>
      ${[0, 1].map(index => `<section ${index ? 'hidden' : ''}><fieldset><legend>Question ${index + 1}?</legend>
        <label><input type="radio" name="q${index}">First option</label>
        <label><input type="radio" name="q${index}">Second option</label></fieldset>
        <button type="button" class="check">${check}</button><button type="button" class="next" hidden>${index ? finish : next}</button></section>`).join('')}
      <fieldset disabled><legend>Unavailable question</legend><label><input type="radio" name="unavailable">Unavailable option</label></fieldset>
      <script>window.clicks = [];
      document.querySelectorAll('.check').forEach(button => button.onclick = () => {
        clicks.push('check'); button.hidden = true;
        button.parentElement.querySelectorAll('input').forEach(input => input.disabled = true);
        setTimeout(() => button.nextElementSibling.hidden = false, 30);
      });
      document.querySelectorAll('.next').forEach((button, index) => button.onclick = () => {
        clicks.push(index ? 'submit' : 'next');
        if (!index) { button.parentElement.hidden = true; button.parentElement.nextElementSibling.hidden = false; }
      });</script>` }));
    await page.goto('https://quiz.test/');
    await page.evaluate(() => { window.chrome = { runtime: { onMessage: { addListener(fn) { window.bridge = fn; } } } }; });
    await page.addScriptTag({ path: fileURLToPath(new URL('../extension/content.js', import.meta.url)) });
    const send = message => page.evaluate(message => new Promise(resolve => window.bridge(message, {}, resolve)), message);
    const planned = [];
    const run = autoNext => runForm({
      scan: () => send({ type: 'JEV_SCAN' }),
      plan: async current => {
        assert.equal(current.fields.length, 1, 'Disabled unanswered groups must stay excluded');
        planned.push(current.fields[0].label);
        return [{ fieldId: current.fields[0].id, value: current.fields[0].options[0].id }];
      },
      apply: (fieldId, value) => send({ type: 'JEV_APPLY', fieldId, value }),
      click: buttonId => send({ type: 'JEV_CLICK', buttonId }),
      autoNext, autoSubmit: false, wait: () => page.waitForTimeout(20),
    });
    assert.equal((await run(false)).status, 'filled');
    assert.deepEqual(await page.evaluate(() => clicks), [], 'Manual mode must not check or navigate');
    const result = await run(true);
    assert.equal(result.status, 'ready', JSON.stringify({ result, snapshot: await send({ type: 'JEV_SCAN' }), clicks: await page.evaluate(() => clicks) }));
    assert.deepEqual(planned, ['Question 1?', 'Question 2?']);
    assert.deepEqual(await page.evaluate(() => clicks), ['check', 'next', 'check']);
    const final = await send({ type: 'JEV_SCAN' });
    assert.equal(final.fields.length, 1);
    assert.deepEqual(final.fields[0].options.map(option => option.label), ['First option', 'Second option']);
    assert.equal(final.fields[0].value, final.fields[0].options[0].id, 'Graded disabled radios retain their answer');
    assert.equal((await run(true)).status, 'ready', 'Resuming a graded question still pauses before final submission');
    assert.deepEqual(planned, ['Question 1?', 'Question 2?'], 'Locked answers must not be planned again');
    assert.deepEqual(await page.evaluate(() => clicks), ['check', 'next', 'check']);
    await page.close();
  }
  console.log('PASS: Chinese and English check → locked answer → next works; final submission and manual navigation pause; no model calls.');
  const page = await browser.newPage();
  await page.setContent('<!doctype html><section id="question"></section>');
  await page.evaluate(() => {
    window.chrome = { runtime: { onMessage: { addListener(fn) { window.bridge = fn; } } } };
    window.draw = (index, bad = '', selected = -1) => {
      const labels = index ? ['Cat', 'Dog'] : ['Red', 'Blue'];
      if (bad === 'duplicates') labels[1] = labels[0];
      if (bad === 'count') labels.push('Bird');
      document.querySelector('#question').innerHTML = `<p>Question ${index + 1}</p><h2>${index ? 'Choose an animal' : 'Choose a colour'}</h2><div>
        ${labels.map((label, i) => `<div class="choice${i === selected ? ' selected' : ''}" style="cursor:pointer"><b>${i + 1}</b>
          <span class="label" ${bad === 'hidden' ? 'hidden' : ''}>${bad === 'layout' ? `<em>${label}</em>` : bad === 'missing' ? '' : label}</span>
          ${selected >= 0 ? '<span>Feedback decoration</span>' : ''}</div>`).join('')}</div>`;
      document.querySelectorAll('.choice').forEach((node, i) => node.onclick = () => draw(index, bad, i));
    };
    draw(0);
  });
  await page.addScriptTag({ path: fileURLToPath(new URL('../extension/content.js', import.meta.url)) });
  const send = message => page.evaluate(message => new Promise(resolve => window.bridge(message, {}, resolve)), message);
  const scan = () => send({ type: 'JEV_SCAN' });
  const confirm = async () => {
    const initial = await scan();
    assert.equal(initial.structureCandidates.length, 1);
    const candidate = initial.structureCandidates[0];
    const prompt = candidate.prompts.find(source => source.text === 'Choose a colour');
    assert.ok(prompt);
    assert.equal((await send({ type: 'JEV_RESOLVE_STRUCTURE', resolutions: [{ id: candidate.id, revision: candidate.revision,
      prompt: prompt.id, options: candidate.options.map((option, index) => ({ id: option.id,
        textId: option.texts.find(source => source.text === ['Red', 'Blue'][index]).id })),
    }] })).ok, true);
    return scan();
  };
  const first = await confirm();
  await page.evaluate(() => draw(1));
  const second = await scan();
  assert.equal(second.structureCandidates.length, 0, 'Reuse confirmed bindings when only question text changes');
  assert.equal(second.fields[0].label, 'Choose an animal');
  assert.deepEqual(second.fields[0].options.map(option => option.label), ['Cat', 'Dog']);
  assert.notEqual(second.fields[0].id, first.fields[0].id);
  assert.equal((await send({ type: 'JEV_APPLY', fieldId: second.fields[0].id, value: second.fields[0].options[0].id })).ok, true);
  const graded = await scan();
  assert.equal(graded.fields[0].id, second.fields[0].id, 'Grading redraws preserve the question identity');
  assert.equal(graded.fields[0].value, second.fields[0].options[0].id);
  assert.deepEqual(graded.fields[0].options.map(option => option.label), ['Cat', 'Dog'], 'Feedback must not enter cached labels');
  await page.evaluate(() => draw(2));
  const repeated = await scan();
  assert.equal(repeated.structureCandidates.length, 0);
  assert.notEqual(repeated.fields[0].id, second.fields[0].id, 'A new progress number identifies even an identical question');
  assert.equal(repeated.fields[0].value, '');
  await page.evaluate(() => {
    document.querySelector('#question p').textContent = 'Question 4';
    document.querySelector('#question h2').textContent = 'Choose a shape';
    document.querySelectorAll('.label').forEach((node, i) => node.textContent = ['Circle', 'Square'][i]);
  });
  const mutated = await scan();
  assert.equal(mutated.structureCandidates.length, 0);
  assert.notEqual(mutated.fields[0].id, repeated.fields[0].id, 'In-place text updates also need a new question identity');
  assert.equal(mutated.fields[0].label, 'Choose a shape');
  assert.deepEqual(mutated.fields[0].options.map(option => option.label), ['Circle', 'Square']);
  for (const bad of ['layout', 'missing', 'duplicates', 'count', 'hidden']) {
    // Invalidate the previous template, then confirm a fresh baseline.
    await page.evaluate(() => draw(0, 'layout'));
    await scan();
    await page.evaluate(() => draw(0));
    await confirm();
    await page.evaluate(bad => draw(1, bad), bad);
    const changed = await scan();
    assert.equal(changed.structureCandidates.length, 1, `${bad} must return to structural identification`);
    assert.equal((await send({ type: 'JEV_APPLY', fieldId: changed.fields[0].id, value: changed.fields[0].options[0].id })).ok, false);
  }
  await page.close();
  console.log('PASS: confirmed layouts read fresh questions and option text without another structure call; grading keeps identity; changed layouts or incomplete labels require identification.');
} finally { await browser.close(); }
