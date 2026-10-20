'use strict';
const LOVE_MS = 5000;
const FADE_MS = 600;
const MAX_CUPS = 12;
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const SAY = {
  invite: ['Your turn!', 'Sip with me?', 'Drink up!', 'Hydrate with me!', 'One glass, go!'],
  happy: ['Yay! 💧', 'Proud of you!', 'Good job!', 'That’s my human!'],
  goal: ['Goal reached! 🎉'],
  sulk: ['Hmph… 5 min!', 'Fine… later.', 'I’ll be back!'],
  love: ['love you ♥'],
};
function greeting({ streak }) {
  if (streak >= 2 && Math.random() < 0.5) return `${streak}-day streak! 🔥`;
  const h = new Date().getHours();
  if (h < 11) return pick(['Good morning!', 'Morning sip?']);
  if (h >= 18) return pick(['Evening sip?', 'Still hydrating?']);
  return pick(['Hi! 👋', 'Water break!', 'Psst… water!']);
}

const $ = (id) => document.getElementById(id);
const app = $('app');
const rig = $('rig');
const drinkBtn = $('drink');
const snoozeBtn = $('snooze');
let info = { count: 0, goal: 8, streak: 0 };

function setState(state, text) {
  if (text) $('sayText').textContent = text;
  app.classList.remove('giggle');
  app.dataset.state = state;
}

function renderCard({ count, goal, snoozeMin }) {
  $('count').textContent = `${count} of ${goal} today`;
  snoozeBtn.textContent = `Snooze ${snoozeMin} min`;
  const cups = $('cups');
  cups.textContent = '';
  for (let i = 0; i < Math.min(goal, MAX_CUPS); i++) {
    const c = document.createElement('span');
    c.className = i < count ? 'cup full' : 'cup';
    cups.append(c);
  }
}

// One element (#rig) owns each state's timeline; its animationend drives the state machine.
rig.addEventListener('animationend', (e) => {
  if (e.target !== rig) return;
  if (e.animationName === 'walk-in') setState('loop', pick(SAY.invite));
  else if (e.animationName === 'walk-out') window.api.exitDone();
});

window.api.onShow((d) => {
  info = d;
  renderCard(d);
  drinkBtn.disabled = snoozeBtn.disabled = false;
  setState('peek', greeting(d));
});

window.api.onExit((kind) => {
  drinkBtn.disabled = snoozeBtn.disabled = true;
  if (kind !== 'sulk') {
    const cup = $('cups').children[info.count];
    if (cup) cup.className = 'cup full new';
    $('count').textContent = `${info.count + 1} of ${info.goal} today`;
  }
  setState(`exit-${kind}`, pick(SAY[kind]));
});

window.api.onLove(({ variant }) => {
  app.dataset.v = variant;
  setState('love', pick(SAY.love));
  setTimeout(() => app.dataset.state === 'love' && setState('love-out'), LOVE_MS);
  setTimeout(() => app.dataset.state === 'love-out' && window.api.exitDone('love'), LOVE_MS + FADE_MS);
});

drinkBtn.addEventListener('click', () => window.api.respond('drink'));
snoozeBtn.addEventListener('click', () => window.api.respond('snooze'));

// Tap her while she waits: giggle.
$('bob').addEventListener('click', () => {
  if (app.dataset.state !== 'loop') return;
  app.classList.remove('giggle');
  void app.offsetWidth;
  app.classList.add('giggle');
  setTimeout(() => app.classList.remove('giggle'), 600);
});

// Click-through: the window is 300x340 but only the card and her painted shapes take the mouse.
let interactive = false;
document.addEventListener('mousemove', (e) => {
  const hit = !!e.target.closest?.('#card, #bob');
  if (hit !== interactive) window.api.setInteractive((interactive = hit));
});
document.addEventListener('mouseleave', () => interactive && window.api.setInteractive((interactive = false)));

// Confetti pieces for "goal reached" (static DOM, animated only in that state).
const COLORS = ['#E0AE44', '#6DBFDC', '#E89A86', '#2E6E8E', '#F7F2E6', '#ff7d9c'];
for (let i = 0; i < 28; i++) {
  const p = document.createElement('i');
  p.style.cssText = `left:${Math.random() * 100}%;background:${COLORS[i % COLORS.length]};--dx:${Math.round(Math.random() * 80 - 40)}px;--rot:${Math.round(Math.random() * 720 - 360)}deg;--delay:${(Math.random() * 0.6).toFixed(2)}s`;
  $('confetti').append(p);
}
