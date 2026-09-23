(() => {
  if (window.__jevFormBridge) return;
  window.__jevFormBridge = true;

  const ids = new WeakMap();
  let sequence = 0;
  let fields = new Map();
  let buttons = new Map();
  const idFor = (node) => {
    if (!ids.has(node)) ids.set(node, `jev-${++sequence}`);
    return ids.get(node);
  };
  const clean = (text) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, 600);
  const labelText = (label) => {
    const copy = label.cloneNode(true);
    copy.querySelectorAll('input, select, textarea, button').forEach((node) => node.remove());
    return copy.textContent;
  };
  const visible = (node) => {
    if (!node.isConnected || node.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    const style = getComputedStyle(node);
    return !['hidden', 'collapse'].includes(style.visibility) && style.display !== 'none' && style.opacity !== '0' && node.getClientRects().length > 0;
  };
  const editable = (node) => visible(node) && !node.matches(':disabled, [aria-disabled="true"]') && !node.readOnly;
  const searchField = (node) => node.matches('input[type="search"]') || node.closest('search, [role="search"]') ||
    (node.tagName === 'INPUT' && (/^(s|search)$/i.test(node.name) || /^(search(?: articles?)?|搜索(?:文章)?)[\s.…]*$/i.test(node.getAttribute('aria-label') || node.placeholder || '')));
  const excludedText = 'nav, footer, [role="navigation"], [role="contentinfo"], script, style, noscript, input, select, textarea, button, option, output, [contenteditable]';
  const visibleText = (node) => {
    if (!node || !visible(node) || node.closest(excludedText)) return '';
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    const parts = [];
    let text;
    while ((text = walker.nextNode())) {
      const parent = text.parentElement;
      if (parent && !parent.closest(excludedText) && visible(parent)) parts.push(text.textContent);
    }
    return clean(parts.join(' '));
  };
  const descriptionFor = (node) => clean([...new Set([
    ...(node.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean)
      .map(id => visibleText(document.getElementById(id))),
    node.getAttribute('title') || '',
  ].filter(Boolean))].join(' '));
  const contextFor = (scanned) => {
    // A question heading often sits just before its form, inside the same section.
    const scope = document.querySelector('main, [role="main"]') || document.querySelector('form')?.parentElement || document.body;
    const seen = new Set(scanned.flatMap(field => [field.label, field.group, field.description]));
    const parts = [];
    let length = 0;
    for (const node of scope.querySelectorAll('h1, h2, h3, p, legend')) {
      if (node.closest('label')) continue;
      const text = visibleText(node);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      parts.push(text);
      length += text.length + 1;
      if (length >= 5000) break;
    }
    return parts.join('\n').slice(0, 5000);
  };
  const legendFor = (node) => {
    const fieldset = node.closest('fieldset');
    return clean(fieldset && Array.from(fieldset.children).find((child) => child.tagName === 'LEGEND')?.textContent);
  };
  const adjacentLabel = (node) => {
    const parts = [];
    for (let sibling = node.nextSibling; sibling; sibling = sibling.nextSibling) {
      if (sibling.nodeType === Node.ELEMENT_NODE) {
        if (sibling.matches('br, input, select, textarea, button') || sibling.querySelector('input, select, textarea, button')) break;
        parts.push(visibleText(sibling));
      } else if (sibling.nodeType === Node.TEXT_NODE) parts.push(sibling.textContent);
      if (parts.join(' ').length >= 600) break;
    }
    return clean(parts.join(' '));
  };
  const headingFor = (node, groupNodes) => {
    // Stay near the field; never cross another question's controls looking for a heading.
    const hasOtherFields = (element) => [element, ...element.querySelectorAll('input, select, textarea')]
      .some(control => control.matches('input, select, textarea') && kindFor(control) && editable(control) && !groupNodes.includes(control));
    for (let current = node, depth = 0; current && current !== document.body && depth < 6; current = current.parentElement, depth++) {
      if (hasOtherFields(current)) return '';
      // Ignore text inside a single option's wrapper; look where all group options share a parent.
      if (!groupNodes.every(option => current.parentElement?.contains(option))) continue;
      for (let sibling = current.previousSibling; sibling; sibling = sibling.previousSibling) {
        if (sibling.nodeType === Node.TEXT_NODE) {
          const text = visible(current.parentElement) && !current.parentElement.closest(excludedText) ? clean(sibling.textContent) : '';
          if (text) return text;
          continue;
        }
        if (sibling.nodeType !== Node.ELEMENT_NODE) continue;
        if (sibling.matches('nav, footer') || hasOtherFields(sibling)) return '';
        if (sibling.matches('input, select, textarea, form, fieldset') || sibling.querySelector('input, select, textarea')) continue;
        const heading = sibling.matches('h1, h2, h3, legend') ? sibling : sibling.querySelector('h1, h2, h3, legend');
        const text = visibleText(heading || (sibling.matches('p, div, strong, b, span') ? sibling : null));
        if (text) return text;
      }
    }
    return '';
  };
  const labelFor = (node) => {
    const labelledBy = node.getAttribute('aria-labelledby');
    if (labelledBy) {
      const label = clean(labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' '));
      if (label) return label;
    }
    return clean(node.getAttribute('aria-label')) ||
      clean(Array.from(node.labels || []).map(labelText).join(' ')) ||
      (['radio', 'checkbox'].includes(node.type) ? adjacentLabel(node) : '') ||
      clean(node.getAttribute('placeholder')) || legendFor(node) || clean(node.name) || '未命名字段';
  };
  const groupLabel = (node, nodes) => legendFor(node) || headingFor(node, nodes) || labelFor(node);
  const kindFor = (node) => {
    if (node.tagName === 'TEXTAREA') return 'textarea';
    if (node.tagName === 'SELECT') return node.multiple ? null : 'select';
    return ['text', 'email', 'tel', 'url', 'number', 'date', 'radio', 'checkbox'].includes(node.type) ? node.type : null;
  };
  const optionsFor = (nodes) => nodes.map((node) => ({
    id: idFor(node),
    label: node.tagName === 'OPTION' ? clean(node.label || node.textContent) : labelFor(node),
  }));
  const valueFor = ({ node, type, nodes, quiz }) => {
    if (type === 'checkbox') return node.checked;
    if (type === 'radio') {
      const checked = nodes.find((option) => quiz ? option.matches('.correct, .incorrect') : option.checked);
      return checked ? idFor(checked) : '';
    }
    if (type === 'select') return node.value && node.selectedOptions.length ? idFor(node.selectedOptions[0]) : '';
    return node.value;
  };

  function scan() {
    fields = new Map();
    buttons = new Map();
    const demo = ['localhost', '127.0.0.1'].includes(location.hostname) && document.documentElement.dataset.jevDemo === 'true';
    // jQuery Quiz (used by Runoob) renders choices as links, not native radios.
    const quiz = document.querySelector('#quiz.quiz-container');
    const scope = quiz || document;
    const scanned = [];
    const errors = [];
    const visited = new Set();
    const controls = Array.from(scope.querySelectorAll('input, textarea, select')).filter(node => editable(node) && !searchField(node));
    for (const node of controls) {
      if (visited.has(node)) continue;
      const type = kindFor(node);
      if (!type) continue;
      const nodes = type === 'radio'
        ? controls.filter((other) => other.type === 'radio' && (node.name ? other.name === node.name && other.form === node.form : other === node))
        : [node];
      nodes.forEach((item) => visited.add(item));
      const entry = { node, type, nodes };
      const id = idFor(node);
      fields.set(id, entry);
      const field = {
        id,
        label: type === 'radio' ? groupLabel(node, nodes) : labelFor(node),
        type,
        required: nodes.some((item) => item.required || item.getAttribute('aria-required') === 'true'),
        value: valueFor(entry),
        group: legendFor(node),
        description: descriptionFor(node),
        ...(demo && node.dataset.demoKey ? { demoKey: node.dataset.demoKey } : {}),
      };
      if (type === 'select') field.options = optionsFor(Array.from(node.options).filter((option) => option.value && !option.disabled && !option.parentElement?.disabled && !option.hidden));
      if (type === 'radio') field.options = optionsFor(nodes);
      const constraints = {};
      if (node.maxLength >= 0) constraints.maxLength = node.maxLength;
      for (const key of ['min', 'max', 'pattern']) if (node.getAttribute(key)) constraints[key] = node.getAttribute(key);
      if (Object.keys(constraints).length) field.constraints = constraints;
      scanned.push(field);
      if (!node.validity.valid || (field.required && (field.value === '' || field.value === false))) {
        errors.push({ fieldId: id, label: field.label, message: node.validationMessage || '请填写必填项。' });
      }
    }

    if (quiz) {
      for (const node of quiz.querySelectorAll('.question-container')) {
        if (!visible(node)) continue;
        const answers = node.querySelector(':scope > .answers');
        const nodes = Array.from(answers?.querySelectorAll('a[data-index]') || []).filter(editable);
        if (!nodes.length) continue;
        // Read only the visible prompt, including preformatted code. Never read
        // the site's question JSON, hidden questions or answer explanations.
        const label = Array.from(node.childNodes).filter(part => part !== answers).map(part =>
          part.nodeType === Node.TEXT_NODE ? part.textContent : part.nodeType === Node.ELEMENT_NODE && visible(part) ? part.innerText : '').join('\n').trim().slice(0, 4000);
        if (!label) continue;
        const id = idFor(node);
        const entry = { node, nodes, type: 'radio', quiz: true };
        fields.set(id, entry);
        scanned.push({ id, label, type: 'radio', required: true, value: valueFor(entry),
          options: nodes.map(option => ({ id: idFor(option), label: clean(option.innerText) })),
          group: clean(quiz.querySelector('h1')?.innerText), description: '',
        });
      }
    }

    const scannedButtons = [];
    for (const node of scope.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"], #quiz-start-btn, #quiz-next-btn, #quiz-finish-btn')) {
      if (!editable(node)) continue;
      const label = clean(node.getAttribute('aria-label')) || clean(node.innerText || node.value || node.textContent);
      if (!label) continue;
      // ponytail: explicit text covers ordinary forms; custom workflows need their own adapter.
      const kind = quiz && node.id === 'quiz-start-btn' ? 'start'
        : quiz && node.id === 'quiz-next-btn' ? 'next'
        : quiz && node.id === 'quiz-finish-btn' ? 'submit'
        : /^(next(?:\s+(?:step|page|question))?|continue|下一(?:步|页|题)|继续)[\s→›»]*$/i.test(label) ? 'next'
        : node.type === 'submit' || /^(submit(?:\s+(?:application|form|response))?|send(?:\s+(?:application|response))?|提交(?:申请|表单|问卷)?|发送|完成|finish)[.!！。\s]*$/i.test(label) ? 'submit' : 'other';
      const id = idFor(node);
      buttons.set(id, node);
      scannedButtons.push({ id, label, kind });
    }
    const notices = [];
    if (scannedButtons.some(button => button.kind === 'start')) notices.push('已识别测验入口，开始填写后会先打开题目。');
    else if (!quiz && !scanned.length && Array.from(document.querySelectorAll('input')).some(node => editable(node) && searchField(node))) notices.push('已忽略站内搜索框，当前未识别到题目或表单。请确认测验已开始。');
    if (Array.from(document.querySelectorAll('iframe')).some(visible)) notices.push('当前仅支持主页面，不读取 iframe 内的表单。');
    if (document.querySelector('[role="combobox"]:not(select), [role="textbox"]:not(input):not(textarea), [role="radio"]:not(input), [role="checkbox"]:not(input), select[multiple]')) notices.push('自定义控件与多选下拉框需要手动填写。');
    return {
      url: location.href, title: document.title, context: quiz ? clean(quiz.querySelector('h1')?.innerText) : contextFor(scanned), fields: scanned, buttons: scannedButtons,
      demo, quiz: Boolean(quiz), completed: demo && document.documentElement.dataset.jevComplete === 'true' ||
        Boolean(quiz?.classList.contains('quiz-results-state') && quiz.querySelector('#quiz-results-screen') && visible(quiz.querySelector('#quiz-results-screen'))),
      validity: { valid: errors.length === 0, errors },
      ...(notices.length ? { notice: notices.join(' ') } : {}),
    };
  }

  function setNative(node, property, value) {
    const prototype = node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype
      : node.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, property).set.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function apply(fieldId, value) {
    const entry = fields.get(fieldId);
    if (!entry || !editable(entry.node)) throw new Error('字段已变化或不可编辑，请重新扫描。');
    const { node, type, nodes } = entry;
    if (type === 'checkbox') {
      if (typeof value !== 'boolean') throw new Error('复选框的值必须是布尔值。');
      if (node.checked !== value) node.click();
    } else if (type === 'radio') {
      const option = nodes.find((item) => idFor(item) === value);
      if (!option || !editable(option)) throw new Error('选项已变化或不可选择。');
      if (valueFor(entry) !== value) option.click();
    } else if (type === 'select') {
      const option = Array.from(node.options).find((item) => idFor(item) === value);
      if (!option || option.disabled || option.parentElement?.disabled || option.hidden) throw new Error('选项已变化或不可选择。');
      setNative(node, 'selectedIndex', option.index);
    } else {
      if (typeof value !== 'string') throw new Error('文本字段的值必须是字符串。');
      if (node.maxLength >= 0 && value.length > node.maxLength) throw new Error(`答案超过 ${node.maxLength} 字符上限。`);
      setNative(node, 'value', value);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (!node.isConnected) throw new Error('页面更新了字段，请重新扫描确认填写结果。');
    const actual = valueFor(entry);
    if (actual !== value) throw new Error('网页未保留填写结果，请重新扫描。');
    if (entry.quiz) {
      // Runoob fades this area in; advancing during that animation can leave
      // the next question's controls hidden in jQuery's animation queue.
      const controls = node.closest('#quiz').querySelector('#quiz-controls');
      for (let attempt = 0; controls && attempt < 40; attempt++) {
        if (visible(controls) && getComputedStyle(controls).opacity === '1') break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (controls && (!visible(controls) || getComputedStyle(controls).opacity !== '1')) throw new Error('选项已记录，但测验操作区尚未就绪，请稍后继续。');
    }
    if (node.validity && !node.validity.valid) throw new Error(node.validationMessage || '填写结果未通过网页校验。');
    return { ok: true, value: actual };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'JEV_SCAN') {
      try { sendResponse(scan()); } catch (error) { sendResponse({ error: error.message }); }
      return false;
    }
    if (message.type === 'JEV_APPLY') {
      apply(message.fieldId, message.value).then(sendResponse, (error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message.type === 'JEV_CLICK') {
      const node = buttons.get(message.buttonId);
      if (!node || !editable(node)) sendResponse({ ok: false, error: '按钮已变化或不可点击，请重新扫描。' });
      else {
        node.click();
        sendResponse({ ok: true });
      }
      return false;
    }
    return false;
  });
})();
