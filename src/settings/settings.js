'use strict';
const form = document.getElementById('f');
const saved = document.getElementById('saved');
let timer;

function render({ settings, status }) {
  for (const [k, v] of Object.entries(settings)) {
    const el = form.elements[k];
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = v;
    else el.value = v;
  }
  document.getElementById('status').textContent = `Today: ${status.count}/${status.goal} · streak ${status.streak} day${status.streak === 1 ? '' : 's'}`;
}

form.addEventListener('change', async () => {
  if (!form.checkValidity()) return;
  const next = {};
  for (const el of form.elements) if (el.name) next[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  render(await window.api.saveSettings(next)); // main clamps; show the canonical values back
  saved.textContent = 'Saved';
  clearTimeout(timer);
  timer = setTimeout(() => (saved.textContent = ''), 1500);
});

window.api.getSettings().then(render);
