const form = document.querySelector('#demo-form');
const steps = [document.querySelector('#step-1'), document.querySelector('#step-2')];
const interests = [...form.querySelectorAll('[name="interests"]')];

function validateInterests() {
  interests[0].setCustomValidity(interests.some(input => input.checked) ? '' : '请至少选择一项感兴趣的应用。');
}

function validateStep(index) {
  if (index === 1) validateInterests();
  return [...steps[index].querySelectorAll('input, select, textarea')].every(input => input.reportValidity());
}

function showStep(index) {
  steps.forEach((step, current) => {
    step.hidden = current !== index;
    step.disabled = current !== index;
  });
  document.querySelector('#step-label').textContent = `第 ${index + 1} 页 / 共 2 页 · ${index ? '使用场景与偏好' : '个人与项目资料'}`;
  document.querySelector('#step-progress').value = index + 1;
  steps[index].querySelector('legend').focus({ preventScroll: true });
  document.querySelector('#demo-progress').scrollIntoView({ block: 'start' });
}

document.querySelector('#next-page').addEventListener('click', () => {
  if (validateStep(0)) showStep(1);
});
document.querySelector('#previous-page').addEventListener('click', () => showStep(0));
interests.forEach(input => input.addEventListener('change', validateInterests));

form.addEventListener('submit', event => {
  event.preventDefault();
  if (!steps[0].hidden) {
    if (validateStep(0)) showStep(1);
    return;
  }
  if (!validateStep(1)) return;
  const result = document.querySelector('#demo-result');
  result.replaceChildren();
  for (const [label, value] of [
    ['姓名', form.elements.name.value],
    ['项目', form.elements.company.value],
    ['邮箱', form.elements.email.value],
    ['状态', '本地模拟完成'],
  ]) {
    const term = document.createElement('dt');
    const detail = document.createElement('dd');
    term.textContent = label;
    detail.textContent = value;
    result.append(term, detail);
  }
  form.hidden = true;
  document.querySelector('#demo-progress').hidden = true;
  document.querySelector('#demo-complete').hidden = false;
  document.documentElement.dataset.jevComplete = 'true';
  document.querySelector('#complete-heading').focus();
});

document.querySelector('#restart-demo').addEventListener('click', () => {
  form.reset();
  interests[0].setCustomValidity('');
  form.hidden = false;
  document.querySelector('#demo-progress').hidden = false;
  document.querySelector('#demo-complete').hidden = true;
  delete document.documentElement.dataset.jevComplete;
  showStep(0);
});
