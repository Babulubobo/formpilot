(() => {
  if (window.__jevFormBridge) return;
  window.__jevFormBridge = true;
  const bridgeVersion = chrome.runtime.getManifest?.().version || 'test';

  const ids = new WeakMap();
  let sequence = 0;
  let fields = new Map();
  let buttons = new Map();
  const structures = new Map();
  const confirmedGroups = new Map();
  const expanded = new Set();
  let pending = new Map();
  let revision = 0;
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
    if (['hidden', 'collapse'].includes(style.visibility) || style.display === 'none' || !node.getClientRects().length) return false;
    for (let ancestor = node; ancestor; ancestor = ancestor.parentElement) {
      const ancestorStyle = ancestor === node ? style : getComputedStyle(ancestor);
      if (ancestorStyle.opacity === '0') return false;
      // Closed fixed drawers cannot be reached by scrolling the document.
      // Ordinary fields below the fold must remain discoverable.
      if (ancestorStyle.position === 'fixed') {
        const rect = ancestor.getBoundingClientRect();
        const viewport = document.documentElement;
        // A reserved scrollbar gutter can sit inside innerWidth/clientWidth.
        const right = Math.min(innerWidth, viewport.clientWidth, viewport.getBoundingClientRect().right);
        if (rect.width > 0 && rect.height > 0 && (rect.right <= 0 || rect.bottom <= 0
          || rect.left >= right || rect.top >= Math.min(innerHeight, viewport.clientHeight))) return false;
      }
    }
    return true;
  };
  const editable = (node) => (visible(node) || node.matches('input[type="radio"], input[type="checkbox"]')
    && !node.closest('[hidden], [inert], [aria-hidden="true"]') && [...node.labels].some(visible))
    && !node.matches(':disabled, [aria-disabled="true"]') && !node.readOnly;
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
  const choiceLabel = (node) => {
    // Options may put the input in one cell/wrapper and its text in the next.
    // Only climb through wrappers containing this one control.
    for (let current = node, depth = 0; current && depth < 3; current = current.parentElement, depth++) {
      if (current !== node && (current.matches('body, form, fieldset') || current.querySelectorAll('input, select, textarea').length !== 1)) break;
      const label = adjacentLabel(current);
      if (label) return label;
    }
    return '';
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
      (['radio', 'checkbox'].includes(node.type) ? choiceLabel(node) : '') ||
      clean(node.getAttribute('placeholder')) || legendFor(node) || clean(node.name) || '未命名字段';
  };
  const groupLabel = (node, nodes) => {
    const group = node.closest('[role="radiogroup"]');
    return (group && explicitLabel(group)) || legendFor(node) || headingFor(node, nodes) || labelFor(node);
  };
  const kindFor = (node) => {
    if (node.matches('[role="radio"]')) return 'radio';
    if (node.tagName === 'TEXTAREA') return 'textarea';
    if (node.tagName === 'SELECT') return node.multiple ? null : 'select';
    return ['text', 'email', 'tel', 'url', 'number', 'date', 'radio', 'checkbox'].includes(node.type) ? node.type : null;
  };
  const optionsFor = (nodes) => nodes.map((node) => ({
    id: idFor(node),
    label: node.tagName === 'OPTION' ? clean(node.label || node.textContent)
      : node.matches('[role="radio"]') && node.tagName !== 'INPUT' ? explicitLabel(node) || sourceText(node) : labelFor(node),
  }));
  const valueFor = ({ node, type, nodes, quiz, custom, optionIds }) => {
    if (type === 'checkbox') return node.checked;
    if (type === 'radio') {
      const checked = nodes.find((option) => quiz ? option.matches('.correct, .incorrect') : custom
        ? option.matches('[aria-checked="true"], [aria-pressed="true"], [data-selected="true"], .selected, .active') : option.checked);
      return checked ? optionIds?.[nodes.indexOf(checked)] || idFor(checked) : '';
    }
    if (type === 'select') return node.value && node.selectedOptions.length ? idFor(node.selectedOptions[0]) : '';
    return node.value;
  };

  const interactive = 'input, select, textarea, button, a[href], [role="link"], [role="radio"], [role="button"]';
  const nonQuestion = 'nav, header, footer, [role="navigation"], [role="search"], [role="toolbar"]';
  const commonParent = nodes => {
    let parent = nodes[0].parentElement;
    while (parent && !nodes.every(node => parent.contains(node))) parent = parent.parentElement;
    return parent || document.body;
  };
  const explicitLabel = node => clean(node.getAttribute('aria-label')) || clean((node.getAttribute('aria-labelledby') || '').split(/\s+/)
    .map(id => visibleText(document.getElementById(id))).join(' '));
  const buttonLabel = node => clean(node.getAttribute('aria-label')) || clean(node.innerText || node.value || node.textContent);
  const buttonKind = node => {
    // Toggle/radio semantics take priority: "Next" can itself be an answer.
    if (!node.matches('button, input[type="submit"], input[type="button"], a, [role="button"]')
      || node.matches('[role="radio"], [aria-pressed], [aria-checked]')) return 'other';
    const label = buttonLabel(node).replace(/^[\s←→‹›«»]+|[\s←→‹›«»]+$/g, '');
    if (/^(next(?:\s+(?:step|page|question))?|continue|下一(?:步|页|题)|继续)$/i.test(label)) return 'next';
    if (/^(prev(?:ious)?(?:\s+(?:step|page|question))?|back|上一(?:步|页|题)|返回|后退)$/i.test(label)) return 'previous';
    if (node.type === 'submit' && node.form || /^(submit(?:\s+(?:application|form|response|quiz|test|answers))?|send(?:\s+(?:application|response))?|提交(?:申请|表单|问卷|测验|测试|答案)?|发送|完成(?:测验|测试|考试)?|finish(?:\s+(?:quiz|test|exam))?)[.!！。\s]*$/i.test(label)) return 'submit';
    if (/^(check(?:\s+answers?)?|检查(?:答案)?|核对答案)$/i.test(label)) return 'check';
    return 'other';
  };
  const sourceText = node => node.nodeType === Node.TEXT_NODE
    ? visible(node.parentElement) ? clean(node.textContent) : ''
    : visible(node) ? (node.innerText || '').trim().slice(0, 2000) : '';
  const pathFor = node => {
    const path = [];
    for (; node.parentNode; node = node.parentNode) path.unshift([...node.parentNode.childNodes].indexOf(node));
    return path;
  };
  const atPath = path => path.reduce((node, index) => node?.childNodes[index], document);
  const layoutOf = node => node && [node.nodeName, node.getAttribute?.('class'), node.getAttribute?.('role'),
    node.getAttribute?.('type'), node.getAttribute?.('aria-label'), node.getAttribute?.('aria-labelledby'),
    [...(node.children || [])].map(layoutOf)];
  const suspicious = (text, node) => !text || text === '未命名字段' || text === node.name || text === node.id || /^(?:chk|opt|input|field|radio)[\w-]*\d+$/i.test(text);

  function inlinePrompt(node) {
    if (!node.matches('input:not([type=radio]):not([type=checkbox]),textarea,select')) return null;
    let anchor = node;
    while (anchor.parentElement?.matches('span,label') && anchor.parentElement.querySelectorAll('input,textarea,select').length === 1) anchor = anchor.parentElement;
    const boundary = part => part.nodeType === Node.ELEMENT_NODE && (part.matches('br,hr') || !['inline', 'inline-block', 'contents'].includes(getComputedStyle(part).display));
    const parts = [anchor];
    for (let part = anchor.previousSibling; part && !boundary(part) && parts.length < 40; part = part.previousSibling) parts.unshift(part);
    for (let part = anchor.nextSibling; part && !boundary(part) && parts.length < 80; part = part.nextSibling) parts.push(part);
    const read = part => {
      if (part === node) return ' [THIS BLANK] ';
      if (part.nodeType === Node.TEXT_NODE) return part.textContent;
      if (part.nodeType !== Node.ELEMENT_NODE || !visible(part) || part.matches('script,style,button')) return '';
      if (part.matches('input,select,textarea')) return ' [OTHER BLANK] ';
      return [...part.childNodes].map(read).join('');
    };
    const text = clean(parts.map(read).join(''));
    return text.replace(/\[(?:THIS|OTHER) BLANK\]/g, '').trim() ? { node: anchor, text, prompt: true } : null;
  }

  function structureFor(field, entry) {
    const { nodes } = entry;
    const wide = expanded.has(field.id);
    let root = commonParent(nodes);
    // Keep evidence local to one group; expanded scans add surrounding text,
    // but never source candidates from another question's controls.
    for (let i = 0; i < (wide ? 3 : 1) && root.parentElement && root.parentElement !== document.body; i++) {
      const others = [...root.parentElement.querySelectorAll(interactive)]
        .filter(node => editable(node) && node.type !== 'hidden' && !nodes.includes(node));
      if (others.length) break;
      root = root.parentElement;
    }
    const sources = new Map();
    const inline = inlinePrompt(entry.node);
    if (inline) sources.set(`${field.id}-prompt`, inline);
    const add = node => {
      if (!node || node.closest?.('script,style,noscript,' + nonQuestion)) return;
      const text = sourceText(node);
      if (text && sources.size < (wide ? 120 : 60)) sources.set(idFor(node), { node, text });
    };
    const collect = parent => {
      if (!parent || !visible(parent) || parent.closest(nonQuestion)) return;
      for (const node of [parent, ...parent.querySelectorAll('h1,h2,h3,h4,legend,p,pre,code,label,span,div,td,li,strong')]) {
        if (!node.querySelector(interactive) && !node.closest('button,a,[role="radio"],[role="button"]')) add(node);
        else for (const child of node.childNodes) if (child.nodeType === Node.TEXT_NODE) add(child);
      }
    };
    collect(root);
    for (let current = commonParent(nodes), depth = 0; current && depth < (wide ? 5 : 3); current = current.parentElement, depth++) {
      let count = 0;
      for (let previous = current.previousElementSibling; previous && count < (wide ? 4 : 1); previous = previous.previousElementSibling, count++) {
        if (previous.querySelector(interactive) || previous.matches(interactive)) break;
        collect(previous);
      }
    }
    nodes.forEach(node => {
      for (const label of node.labels || []) add(label);
      for (const id of (node.getAttribute('aria-labelledby') || '').split(/\s+/)) if (id) add(document.getElementById(id));
      if (entry.custom) {
        add(node);
        node.querySelectorAll('span,p,code,label,strong').forEach(add);
      }
    });
    const position = (source, target) => {
      const rect = (source.nodeType === Node.TEXT_NODE ? source.parentElement : source).getBoundingClientRect();
      const base = target.getBoundingClientRect();
      return { dx: Math.round(rect.x - base.x), dy: Math.round(rect.y - base.y) };
    };
    const uniqueTexts = texts => [...new Map(texts.map(text => [clean(text.text), text])).values()];
    const texts = [...sources].filter(([, source]) => source.prompt || !nodes.some(node => node.contains(source.node) || source.node.contains(node)))
      .map(([id, { node, text }]) => ({ id, text, ...position(node, nodes[0]) }));
    const options = field.options ? field.options.map((option, index) => ({ id: option.id, currentLabel: option.label,
      texts: entry.type === 'select' ? [{ id: option.id, text: option.label, dx: 0, dy: 0 }]
        : uniqueTexts([...sources].filter(([, source]) => entry.custom ? nodes[index].contains(source.node)
          || [...(nodes[index].labels || [])].some(label => label.contains(source.node))
          || (nodes[index].getAttribute('aria-labelledby') || '').split(/\s+/).some(id => id && document.getElementById(id)?.contains(source.node))
          : !nodes.some((node, i) => i !== index && (node.contains(source.node) || source.node.contains(node))))
          .map(([id, source]) => ({ id, text: source.text, ...position(source.node, nodes[index] || nodes[0]) }))
          .sort((a, b) => Math.abs(a.dy) * 3 + Math.abs(a.dx) - Math.abs(b.dy) * 3 - Math.abs(b.dx))).slice(0, wide ? 16 : 8),
    })) : [];
    const candidate = { id: field.id, custom: Boolean(entry.custom && !entry.node.matches('[role="radio"]')), currentLabel: field.label,
      prompts: uniqueTexts(texts).slice(0, wide ? 32 : 16), options };
    // Text and element identities determine freshness; scrolling/hovering must
    // not invalidate cached associations or trigger another API call.
    const key = JSON.stringify(candidate, (name, value) => ['dx', 'dy'].includes(name) ? undefined : value);
    let cached = structures.get(field.id);
    if (!cached || cached.key !== key) {
      cached = { key, revision: ++revision };
      structures.set(field.id, cached);
    }
    candidate.revision = cached.revision;
    cached.sources = sources;
    pending.set(field.id, candidate);
    return { candidate, cached };
  }

  function resolveStructures(resolutions) {
    scan(); // Rebuild evidence immediately before accepting a model result.
    for (const resolution of resolutions) {
      const candidate = pending.get(resolution.id);
      if (!candidate || candidate.revision !== resolution.revision) throw new Error('识别期间页面结构发生变化，请重新开始。');
      if (resolution.ignore && candidate.custom) {
        structures.get(candidate.id).resolved = { ignore: true };
        continue;
      }
      const prompt = candidate.prompts.find(text => text.id === resolution.prompt)?.text;
      const options = candidate.options.map(option => ({ id: option.id,
        label: option.texts.find(text => text.id === resolution.options?.find(value => value.id === option.id)?.textId)?.text }));
      if (!prompt || options.some(option => !option.label || clean(option.label) === clean(prompt))
        || (options.length && new Set(options.map(option => clean(option.label))).size !== options.length)) continue;
      const cached = structures.get(candidate.id);
      cached.resolved = { label: prompt, options };
      if (candidate.custom) {
        const { nodes } = fields.get(candidate.id);
        const root = commonParent(nodes);
        const bindings = [resolution.prompt, ...resolution.options.map(option => option.textId)].map(id => cached.sources.get(id));
        const layoutRoot = commonParent([bindings[0].node, ...nodes]);
        // ponytail: reuse exact local layouts in this document only. A changed
        // layout or missing text goes back to model-based structural identification.
        const template = layoutRoot !== document.body && !root.contains(bindings[0].node)
          && bindings.slice(1).every((source, index) => nodes[index].contains(source.node))
          ? { path: pathFor(layoutRoot), shape: JSON.stringify(layoutOf(layoutRoot)) } : null;
        // Keep preceding visible context too, so a changed question number or
        // heading gives an otherwise identical question a fresh identity.
        bindings.push(...[...cached.sources.values()].filter(source => !source.node.contains(root)
          && (root.compareDocumentPosition(source.node) & Node.DOCUMENT_POSITION_PRECEDING)));
        confirmedGroups.set(JSON.stringify(pathFor(root)), { id: candidate.id, ...cached.resolved, template,
          nodes: nodes.map(pathFor), anchors: bindings.map(source => ({ path: pathFor(source.node), text: source.text })) });
      }
    }
    return { ok: true };
  }

  function scan() {
    fields = new Map();
    buttons = new Map();
    pending = new Map();
    const demo = ['localhost', '127.0.0.1'].includes(location.hostname) && document.documentElement.dataset.jevDemo === 'true';
    // jQuery Quiz (used by Runoob) renders choices as links, not native radios.
    const quiz = document.querySelector('#quiz.quiz-container');
    const bixTest = document.querySelector('#testContent.test-content:has(.bix-tbl-options input[type="radio"])');
    const scope = quiz || bixTest?.closest('.ques-wrapper') || document;
    const scanned = [];
    const errors = [];
    const visited = new Set();
    const allControls = Array.from((bixTest || scope).querySelectorAll(bixTest ? '.bix-tbl-options input[type="radio"]' : 'input, textarea, select, [role="radio"]'));
    // Quizzes lock graded radio groups. Keep their visible answers readable so
    // checking an answer does not make the question disappear from the runner.
    const lockedAnswers = allControls.filter(node => node.matches('input[type="radio"]:disabled') && node.checked && visible(node));
    const controls = allControls.filter(node => (editable(node) || node.matches('input[type="radio"]:disabled') && visible(node)
      && lockedAnswers.some(answer => answer === node || node.name && answer.name === node.name && answer.form === node.form))
      && !searchField(node) && !node.closest(nonQuestion));
    for (const node of controls) {
      if (visited.has(node)) continue;
      const type = kindFor(node);
      if (!type) continue;
      const custom = node.matches('[role="radio"]') && node.tagName !== 'INPUT';
      const group = node.closest('[role="radiogroup"]') || node.parentElement;
      const nodes = type === 'radio'
        ? controls.filter((other) => custom ? other.matches('[role="radio"]') && group.contains(other)
          : other.type === 'radio' && (node.name ? other.name === node.name && other.form === node.form : other === node))
        : [node];
      nodes.forEach((item) => visited.add(item));
      const entry = { node, type, nodes, custom };
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
      if (node.validity && !node.validity.valid || (field.required && (field.value === '' || field.value === false))) {
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

    if (!quiz && !bixTest) {
      // Repeated clickable siblings are only candidates. A semantic decision
      // must confirm they form a question before any of them can be clicked.
      const used = new Set([...fields.values()].flatMap(entry => entry.nodes));
      const clickSelector = 'button, [role="button"], a[href="#"], a:not([href]), [onclick], [tabindex], div, li, span';
      const clicks = [...scope.querySelectorAll(clickSelector)]
        .filter(node => editable(node) && !node.closest(nonQuestion) && !used.has(node) && buttonKind(node) === 'other'
          && !node.closest('[role="link"], [role="heading"], a[href]:not([href=""]):not([href="#"]):not([href^="javascript:"])')
          && !node.querySelector(interactive) && (node.matches('button,[role="button"],a,[onclick]')
            || getComputedStyle(node).cursor === 'pointer' && getComputedStyle(node.parentElement).cursor !== 'pointer'));
      const groups = new Set();
      for (const click of clicks) {
        for (let parent = click.parentElement, depth = 0; parent && parent !== document.body && depth < 3; parent = parent.parentElement, depth++) {
          const nodes = clicks.filter(node => parent.contains(node));
          if (nodes.length < 2) continue;
          if (nodes.length > 12 || parent.querySelector('input,select,textarea,[role="radio"]') || nodes.some(node => used.has(node))) break;
          const rows = [...parent.children].filter(child => nodes.some(node => child === node || child.contains(node)));
          if (rows.length !== nodes.length || groups.has(parent)) break;
          groups.add(parent);
          nodes.forEach(node => used.add(node));
          const key = JSON.stringify(pathFor(commonParent(nodes)));
          let confirmed = confirmedGroups.get(key);
          if (confirmed && (confirmed.nodes.length !== nodes.length || confirmed.nodes.some((path, i) => atPath(path) !== nodes[i])
            || confirmed.anchors.some(({ path, text }) => { const node = atPath(path); return !node || sourceText(node) !== text; }))) {
            const texts = confirmed.anchors.map(({ path }) => { const node = atPath(path); return node ? sourceText(node) : ''; });
            const labels = texts.slice(1, nodes.length + 1);
            const reusable = confirmed.template && confirmed.nodes.length === nodes.length
              && confirmed.nodes.every((path, i) => atPath(path) === nodes[i])
              && JSON.stringify(layoutOf(atPath(confirmed.template.path))) === confirmed.template.shape
              && texts.every(Boolean) && !suspicious(texts[0], nodes[0])
              && labels.every((label, i) => !suspicious(label, nodes[i]) && clean(label) !== clean(texts[0]))
              && new Set(labels.map(clean)).size === nodes.length;
            ids.delete(nodes[0]);
            if (reusable) {
              confirmed = { ...confirmed, id: idFor(nodes[0]), label: texts[0],
                options: nodes.map((node, i) => ({ id: idFor(node), label: labels[i] })),
                anchors: confirmed.anchors.map((anchor, i) => ({ ...anchor, text: texts[i] })) };
              confirmedGroups.set(key, confirmed);
            } else {
              confirmedGroups.delete(key);
              confirmed = null;
            }
          }
          const id = confirmed?.id || idFor(nodes[0]);
          const options = confirmed?.options || nodes.map(node => ({ id: idFor(node), label: sourceText(node) }));
          const entry = { node: nodes[0], nodes, type: 'radio', custom: true, confirmed: Boolean(confirmed),
            optionIds: options.map(option => option.id) };
          fields.set(id, entry);
          scanned.push({ id, label: confirmed?.label || groupLabel(nodes[0], nodes), type: 'radio', required: false,
            value: valueFor(entry), group: '', description: '', options });
          break;
        }
      }
    }

    scanned.sort((a, b) => fields.get(a.id).node.compareDocumentPosition(fields.get(b.id).node) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
    const candidates = [];
    const promptCounts = new Map();
    for (const field of scanned) if (field.type === 'radio') promptCounts.set(field.label, (promptCounts.get(field.label) || 0) + 1);
    for (let index = scanned.length - 1; index >= 0; index--) {
      const field = scanned[index], entry = fields.get(field.id);
      const labels = field.options?.map(option => option.label) || [];
      const issues = [];
      if (suspicious(field.label, entry.node)) issues.push('missing_prompt');
      if (field.type === 'radio' && (labels.includes(field.label) || promptCounts.get(field.label) > 1)) issues.push('ambiguous_prompt');
      if (field.options && (new Set(labels).size !== labels.length || labels.some((label, i) => suspicious(label, entry.nodes[i] || entry.node)))) issues.push('unreadable_options');
      if (entry.custom && !entry.node.matches('[role="radio"]')) issues.push('custom_choices');
      if (!issues.length || entry.quiz || entry.confirmed) continue;
      const { candidate, cached } = structureFor(field, entry);
      if (cached.resolved?.ignore) {
        scanned.splice(index, 1);
        fields.delete(field.id);
      } else if (cached.resolved) {
        field.label = cached.resolved.label;
        if (field.options) field.options = cached.resolved.options;
      } else {
        entry.unresolved = true;
        field.scanIssues = issues;
        candidates.push(candidate);
      }
    }

    for (const field of scanned) fields.get(field.id).snapshot = field;

    const scannedButtons = [];
    for (const node of scope.querySelectorAll(bixTest ? '#btnStartTest, #btnSubmitTest' : 'button, input[type="submit"], input[type="button"], [role="button"], #quiz-start-btn, #quiz-next-btn, #quiz-finish-btn')) {
      if (!editable(node)) continue;
      if ([...fields.values()].some(entry => entry.custom && entry.nodes.includes(node))) continue;
      const label = buttonLabel(node);
      if (!label) continue;
      // ponytail: explicit text covers ordinary forms; custom workflows need their own adapter.
      const kind = (quiz && node.id === 'quiz-start-btn') || (bixTest && node.id === 'btnStartTest') ? 'start'
        : quiz && node.id === 'quiz-next-btn' ? 'next'
        : (quiz && node.id === 'quiz-finish-btn') || (bixTest && node.id === 'btnSubmitTest') ? 'submit'
        : buttonKind(node);
      const id = idFor(node);
      buttons.set(id, node);
      scannedButtons.push({ id, label, kind });
    }
    const notices = [];
    if (scannedButtons.some(button => button.kind === 'start')) notices.push('已识别测验入口，开始填写后会先打开题目。');
    else if (!quiz && !bixTest && !scanned.length && Array.from(document.querySelectorAll('input')).some(node => editable(node) && searchField(node))) notices.push('已忽略站内搜索框，当前未识别到题目或表单。请确认测验已开始。');
    if (Array.from(document.querySelectorAll('iframe')).some(visible)) notices.push('当前仅支持主页面，不读取 iframe 内的表单。');
    if (document.querySelector('[role="combobox"]:not(select), [role="textbox"]:not(input):not(textarea), [role="checkbox"]:not(input), select[multiple]')) notices.push('自定义控件与多选下拉框需要手动填写。');
    return {
      bridgeVersion, url: location.href, title: document.title, context: quiz ? clean(quiz.querySelector('h1')?.innerText) : bixTest ? visibleText(document.querySelector('h1')) : contextFor(scanned), fields: scanned, buttons: scannedButtons,
      demo, quiz: Boolean(quiz || bixTest), completed: demo && document.documentElement.dataset.jevComplete === 'true' ||
        Boolean(bixTest && visibleText(document.querySelector('#testResultStats'))) ||
        Boolean(quiz?.classList.contains('quiz-results-state') && quiz.querySelector('#quiz-results-screen') && visible(quiz.querySelector('#quiz-results-screen'))),
      validity: { valid: errors.length === 0, errors },
      structureCandidates: candidates.reverse(),
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
    if (entry.unresolved) throw new Error('题干或选项尚未识别完整，未执行填写。');
    const { node, type, nodes } = entry;
    if (type === 'checkbox') {
      if (typeof value !== 'boolean') throw new Error('复选框的值必须是布尔值。');
      if (node.checked !== value) node.click();
    } else if (type === 'radio') {
      const option = nodes.find((item, index) => (entry.optionIds?.[index] || idFor(item)) === value);
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
    if (!node.isConnected && !entry.custom) throw new Error('页面更新了字段，请重新扫描确认填写结果。');
    let actual = valueFor(entry);
    if (entry.custom) {
      const current = scan().fields.find(field => field.id === fieldId);
      if (!current || current.scanIssues?.length || current.label !== entry.snapshot.label
        || JSON.stringify(current.options) !== JSON.stringify(entry.snapshot.options)) {
        throw new Error('页面更新了字段，请重新扫描确认填写结果。');
      }
      actual = current.value;
    }
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
    if (message.type === 'JEV_RESOLVE_STRUCTURE') {
      try { sendResponse(resolveStructures(message.resolutions)); } catch (error) { sendResponse({ ok: false, error: error.message }); }
      return false;
    }
    if (message.type === 'JEV_EXPAND_SCAN') {
      for (const id of message.ids || []) expanded.add(id);
      sendResponse({ ok: true });
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
