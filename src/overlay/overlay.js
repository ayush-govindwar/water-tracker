'use strict';
const FPS = 12;
const CELL_W = 96;
const FILES = { peek: 'peek-in', loop: 'drink-loop', 'exit-drank': 'exit-drank', 'exit-snooze': 'exit-snooze' };
const MESSAGES = ['Time for water!', 'Sip break!', 'Hydrate, human.', 'Water o’clock.'];

const app = document.getElementById('app');
const char = document.getElementById('char');
const drinkBtn = document.getElementById('drink');
const snoozeBtn = document.getElementById('snooze');
let sheets = null; // state -> { url, n } once real art is loaded; null = placeholder box

function loadSheets(base) {
  return Promise.all(
    Object.entries(FILES).map(
      ([state, file]) =>
        new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve([state, { url: img.src, n: Math.max(2, Math.round(img.naturalWidth / CELL_W)) }]);
          img.onerror = reject;
          img.src = `${base}${file}.png`;
        })
    )
  ).then((e) => Object.fromEntries(e), () => null);
}

function setState(state) {
  if (sheets) {
    const sheet = sheets[state === 'hidden' ? 'peek' : state];
    char.style.setProperty('--img', `url("${sheet.url}")`);
    char.style.setProperty('--n', sheet.n);
    char.style.setProperty('--fps', FPS);
  }
  char.style.animation = 'none'; // force restart when the same animation name repeats (exit -> peek)
  void char.offsetWidth;
  char.style.animation = '';
  app.dataset.state = state;
}

function end() {
  const s = app.dataset.state;
  if (s === 'peek') setState('loop');
  else if (s.startsWith('exit')) window.api.exitDone();
}
char.addEventListener('animationend', (e) => e.animationName !== 'bob' && end());
char.addEventListener('transitionend', (e) => e.propertyName === 'transform' && end());

window.api.onShow(async (d) => {
  sheets = d.spriteBase ? await loadSheets(d.spriteBase) : null;
  char.className = sheets ? 'sprite' : 'placeholder';
  document.getElementById('msg').textContent = MESSAGES[Math.floor(Math.random() * MESSAGES.length)];
  document.getElementById('stats').textContent = `${d.count}/${d.goal} today · ${d.streak}-day streak`;
  snoozeBtn.textContent = `Snooze ${d.snoozeMin}m`;
  drinkBtn.disabled = snoozeBtn.disabled = false;
  setState('peek');
});

window.api.onExit((kind) => {
  drinkBtn.disabled = snoozeBtn.disabled = true;
  setState(`exit-${kind}`);
});

drinkBtn.addEventListener('click', () => window.api.respond('drink'));
snoozeBtn.addEventListener('click', () => window.api.respond('snooze'));
