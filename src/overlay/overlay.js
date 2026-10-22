'use strict';
// She is a frame-by-frame cut-out of the source videos in art/ (assets/her/<clip>.webp, made by scripts/video-to-sprites.js).
// Clips: her (walkIn, idle, drink), happy (cheers after a drink), sulk (sad, then walks off), heart (walks in, finger hearts).
// Every clip is scaled to the same height and floor; the player keeps her in place between clips and crossfades the seams.
const MAX_CUPS = 12;
const WALK_OUT_FROM = 9; // first walk-in frame where she's fully inside the video (mirrored = walking right)
const HEARTS_FROM = 34; // heart clip frame where the finger hearts start
const FADE_MS = 200; // crossfade between clips
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const SAY = {
  invite: ['Your turn!', 'Now you! 💧', 'Sip with me?', 'Drink up!', 'One glass, go!'],
  happy: ['Yay! 💧', 'Proud of you!', 'Good job!', 'That’s my human!'],
  goal: ['Goal reached! 🎉'],
  sulk: ['Okay… 5 more min', 'Aww… later then', 'I’ll wait…'],
  love: ['love you ♥'],
  giggle: ['Hehe!', 'Hi!', 'Drink!'],
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
const canvas = $('her');
const ctx = canvas.getContext('2d');
const drinkBtn = $('drink');
const snoozeBtn = $('snooze');
let meta = null;
let info = { count: 0, goal: 8, streak: 0 };

// ---------------- clips ----------------
const sheets = {}; // clip -> decoded Image
const loading = {};
// Each clip is its own image, decoded only when needed (the whole overlay renderer is destroyed when idle).
function loadClip(name) {
  return (loading[name] ??= new Promise((res) => {
    const im = new Image();
    im.src = `../../assets/her/${name}.webp`;
    im.decode().then(() => res((sheets[name] = im)), () => res(null));
  }));
}
function init(m) {
  if (meta) return;
  meta = m;
  const r = window.devicePixelRatio || 1;
  canvas.width = Math.round(canvas.clientWidth * r);
  canvas.height = Math.round(canvas.clientHeight * r);
}

// ---------------- frame player ----------------
const range = ([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const rev = (seg) => range(seg).reverse();
let clip = null;
let raf = 0;
let cur = { clip: 'her', f: 0, mirror: false, dx: 0 }; // last drawn pose, so the next clip can continue from it
let fade = null; // { pose, t0 } previous pose fading out
let tapAt = -1;

const dpr = () => canvas.width / canvas.clientWidth;
const scale = () => canvas.height / meta.cellH; // backing px per atlas px
// Cells are right-aligned to the canvas (= the screen edge) and shifted by dx CSS px.
const cellLeft = (p) => canvas.width - meta.clips[p.clip].cellW * scale() + (p.dx || 0) * dpr();
// Her body's centre x in CSS px inside the canvas.
function bodyX(p) {
  const c = meta.clips[p.clip];
  return (cellLeft(p) + (p.mirror ? c.cellW - c.centers[p.f] : c.centers[p.f]) * scale()) / dpr();
}
// dx that puts frame f of a clip exactly where she stands now.
const align = (name, f, mirror = false) => bodyX(cur) - bodyX({ clip: name, f, mirror, dx: 0 });

function paint(p, alpha) {
  const im = sheets[p.clip];
  if (!im || alpha <= 0) return;
  const c = meta.clips[p.clip], S = scale(), H = canvas.height, r = dpr();
  const w = c.cellW * S, x = cellLeft(p), px = bodyX(p) * r;
  ctx.setTransform(1, 0, 0, 1, 0, (p.dy || 0) * r);
  ctx.globalAlpha = alpha;
  ctx.translate(px, H); // squash/stretch around her feet
  ctx.scale(p.sx ?? 1, p.sy ?? 1);
  ctx.translate(-px, -H);
  if (p.mirror) {
    ctx.translate(2 * x + w, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(im, (p.f % c.cols) * (c.cellW + meta.gap), Math.floor(p.f / c.cols) * (meta.cellH + meta.gap), c.cellW, meta.cellH, x, 0, w, H);
}

function render(p, now) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (tapAt >= 0) {
    const t = (now - tapAt) / 1000;
    if (t < 0.45) p.dy = (p.dy || 0) - 12 * Math.sin((Math.PI * t) / 0.45);
  }
  const a = fade ? Math.min(1, (now - fade.t0) / FADE_MS) : 1;
  if (a < 1) paint(fade.pose, 1 - a);
  else fade = null;
  paint(p, a * (p.alpha ?? 1));
  cur = p;
}

// c: { clip, frames, fps, loop?, mirror?, fade?, motion?(t) -> {dx,dy,sx,sy,alpha}, onFrame?(i, wrapped), onEnd? }
function play(c) {
  const now = performance.now();
  if (c.fade) fade = { pose: cur, t0: now };
  clip = { ...c, t0: now, last: -1 };
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(step);
}
function stop() {
  clip = null;
  cancelAnimationFrame(raf);
}
function step(now) {
  if (!clip) return;
  const c = clip;
  const t = (now - c.t0) / 1000;
  let i = Math.floor(t * c.fps);
  const n = c.frames.length;
  const pose = (k) => ({ clip: c.clip, f: c.frames[k], mirror: !!c.mirror, dx: 0, ...c.motion?.(t) });
  if (i >= n && !c.loop) {
    render(pose(n - 1), now);
    clip = null;
    c.onEnd?.();
    return;
  }
  i %= n;
  if (i !== c.last) c.onFrame?.(i, i < c.last);
  c.last = i;
  render(pose(i), now);
  raf = requestAnimationFrame(step);
}

// ---------------- states ----------------
let sayTimer;
function say(text, ms) {
  clearTimeout(sayTimer);
  if (!text) return app.classList.remove('talk');
  $('sayText').textContent = text;
  app.classList.add('talk');
  if (ms) sayTimer = setTimeout(() => app.classList.remove('talk'), ms);
}
function setState(s) {
  app.dataset.state = s;
  app.classList.remove('yay', 'love', 'goal');
}

// Stand, drink, lower the tumbler, then turn to you: "Your turn!". Built so every boundary is a continuous frame.
function drinkLoop() {
  setState('loop');
  const { idle, drink } = meta.clips.her.segments;
  const parts = [range(idle), range(drink), rev(drink), rev(idle)];
  const ends = parts.map((p, k) => parts.slice(0, k + 1).flat().length);
  let first = true;
  play({
    clip: 'her',
    frames: parts.flat(),
    fps: 12,
    loop: true,
    onFrame(i, wrapped) {
      if (wrapped) first = false;
      if (i === 0 && first) say(greeting(info), 2600);
      if (i === ends[0]) say(null); // starts drinking
      if (i === ends[2]) say(pick(SAY.invite)); // tumbler back down
      if (i === ends[2] + 30) say(null);
    },
  });
}

// Mirrored walk-in frames = walking off to the right; offset so she continues from where she stands.
function walkOut({ fps, speed, onEnd }) {
  const base = align('her', WALK_OUT_FROM, true);
  const frames = range([WALK_OUT_FROM, meta.clips.her.segments.walkIn[1]]), dur = frames.length / fps;
  play({
    clip: 'her',
    frames,
    fps,
    mirror: true,
    fade: true,
    motion: (t) => ({ dx: base + speed * t, alpha: Math.min(1, (dur - t) / 0.25) }),
    onEnd,
  });
}

async function exit(kind) {
  const done = () => window.api.exitDone();
  setState(`exit-${kind}`);
  say(pick(SAY[kind]), kind === 'sulk' ? 2600 : 1800);
  if (kind === 'sulk') {
    // Her own video: sad, turns, walks off the right edge. Ease her back onto the video's framing before she leaves.
    await loadClip('sulk');
    const frames = range(meta.clips.sulk.segments.sulk), dur = frames.length / 12;
    const d0 = align('sulk', 0);
    play({
      clip: 'sulk',
      frames,
      fps: 12,
      fade: true,
      motion: (t) => {
        const e = Math.min(1, t / 1.5);
        return { dx: d0 * (1 - e * e * (3 - 2 * e)), alpha: Math.min(1, (dur - t) / 0.3) };
      },
      onEnd: done,
    });
  } else {
    app.classList.add('yay');
    if (kind === 'goal') app.classList.add('goal');
    await loadClip('happy');
    const dx = align('happy', 0);
    play({ clip: 'happy', frames: range(meta.clips.happy.segments.happy), fps: 12, fade: true, motion: () => ({ dx }), onEnd: () => walkOut({ fps: 12, speed: 130, onEnd: done }) });
  }
}

// Her heart video as is (walks in, finger hearts), then she lingers and fades.
function love() {
  setState('love');
  say(null);
  fade = null;
  const frames = range(meta.clips.heart.segments.heart), dur = frames.length / 12;
  play({
    clip: 'heart',
    frames: [...frames, ...Array(18).fill(frames[frames.length - 1])], // + 1.5s hold
    fps: 12,
    motion: (t) => ({ alpha: Math.min(1, (dur + 1.5 - t) / 0.6) }),
    onFrame(i) {
      if (i === HEARTS_FROM) {
        app.classList.add('love');
        say(pick(SAY.love));
      }
    },
    onEnd: () => {
      say(null);
      window.api.exitDone('love');
    },
  });
}

// ---------------- card ----------------
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

// ---------------- wiring ----------------
window.api.onShow(async (d) => {
  info = d;
  init(d.atlas);
  loadClip('happy'); // exits, decoded while she drinks
  loadClip('sulk');
  await loadClip('her');
  renderCard(d);
  drinkBtn.disabled = snoozeBtn.disabled = false;
  setState('peek');
  say(null);
  fade = null;
  play({ clip: 'her', frames: range(meta.clips.her.segments.walkIn), fps: 12, onEnd: drinkLoop });
});

window.api.onExit((kind) => {
  drinkBtn.disabled = snoozeBtn.disabled = true;
  if (kind !== 'sulk') {
    const cup = $('cups').children[info.count];
    if (cup) cup.className = 'cup full new';
    $('count').textContent = `${info.count + 1} of ${info.goal} today`;
  }
  exit(kind);
});

window.api.onLove(async (d) => {
  init(d.atlas);
  await loadClip('heart');
  love();
});

drinkBtn.addEventListener('click', () => window.api.respond('drink'));
snoozeBtn.addEventListener('click', () => window.api.respond('snooze'));

// Hit-testing: only the card and her body take the mouse; the rest of the window clicks through.
function overHer(e) {
  if (!meta || app.dataset.state !== 'loop') return false;
  const r = canvas.getBoundingClientRect();
  return Math.abs(e.clientX - (r.left + bodyX(cur))) < 38 && e.clientY > r.top + 8 && e.clientY < r.bottom;
}
let interactive = false;
document.addEventListener('mousemove', (e) => {
  const hit = !!e.target.closest?.('#card') || overHer(e);
  if (hit !== interactive) window.api.setInteractive((interactive = hit));
});
document.addEventListener('mouseleave', () => interactive && window.api.setInteractive((interactive = false)));
document.addEventListener('mousedown', (e) => {
  if (!overHer(e)) return;
  tapAt = performance.now();
  say(pick(SAY.giggle), 900);
});

const COLORS = ['#f2c14e', '#6dbfdc', '#ff7d9c', '#2e6e8e', '#fbf7f2', '#c58bf2'];
for (let i = 0; i < 30; i++) {
  const p = document.createElement('i');
  p.style.cssText = `left:${Math.random() * 100}%;background:${COLORS[i % COLORS.length]};--dx:${Math.round(Math.random() * 80 - 40)}px;--rot:${Math.round(Math.random() * 720 - 360)}deg;--delay:${(Math.random() * 0.6).toFixed(2)}s`;
  $('confetti').append(p);
}

// for tests / previews
window.__her = { get state() { return app.dataset.state; }, get frame() { return cur.f; }, get clip() { return cur.clip; }, stop };
