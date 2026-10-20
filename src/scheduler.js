'use strict';
// Pure logic: no electron imports, clock/idle/store injected. Tested in test/scheduler.test.js.

const MIN = 60000;

const DEFAULTS = {
  intervalMin: 30,
  snoozeMin: 5,
  goal: 8,
  activeStart: '09:00',
  activeEnd: '22:00',
  idleMin: 5, // 0 = never suppress on idle
  autostart: false,
  love: true, // surprise heart, twice a day
};

// Surprise hearts: one at 11:11, one at a random minute, both inside 09:00-17:00 local.
const LOVE = { start: 9 * 60, end: 17 * 60, fixed: 11 * 60 + 11, gap: 30, grace: 15 }; // minutes; grace = how late we may still show

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
// UTC midnights on both sides, so DST never makes a day 23/25 hours.
const dayGap = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);
const minuteOfDay = (t) => {
  const d = new Date(t);
  return d.getHours() * 60 + d.getMinutes();
};
const toMin = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

// start == end means "always active"; start > end wraps midnight (e.g. 22:00-06:00).
function inActiveHours(t, start, end) {
  const m = minuteOfDay(t);
  const a = toMin(start);
  const b = toMin(end);
  if (a === b) return true;
  return a < b ? m >= a && m < b : m >= a || m < b;
}

// Settings come from a renderer: clamp/validate everything.
function sanitize(input, base = DEFAULTS) {
  const out = { ...DEFAULTS, ...base };
  const num = (k, lo, hi) => {
    const v = Number(input?.[k]);
    if (Number.isFinite(v)) out[k] = Math.min(hi, Math.max(lo, Math.round(v)));
  };
  num('intervalMin', 1, 480);
  num('snoozeMin', 1, 120);
  num('goal', 1, 50);
  num('idleMin', 0, 240);
  for (const k of ['activeStart', 'activeEnd']) {
    if (typeof input?.[k] === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(input[k])) out[k] = input[k];
  }
  for (const k of ['autostart', 'love']) if (typeof input?.[k] === 'boolean') out[k] = input[k];
  return out;
}

class Scheduler {
  // store: { get(key, default?), set(key, value) } (electron-store compatible)
  constructor({ store, now = Date.now, idleSeconds = () => 0, random = Math.random, onShow, onExit, onLove = () => {}, onChange = () => {} }) {
    Object.assign(this, { store, now, idleSeconds, random, onShow, onExit, onLove, onChange });
    this.state = 'waiting'; // 'waiting' | 'showing' (water reminder up) | 'loving' (heart up)
    this.locked = false;
  }

  get settings() {
    return sanitize(this.store.get('settings'), DEFAULTS);
  }

  start() {
    this.rollover();
    if (!this.store.get('dueAt')) this.store.set('dueAt', this.now() + this.settings.intervalMin * MIN);
    this.tick();
  }

  // Called on a timer AND on resume/unlock. Safe to call any number of times:
  // a single persisted dueAt means a 2h sleep yields one reminder, not one per missed interval.
  tick() {
    this.rollover();
    if (this.state !== 'waiting') return;
    const t = this.now();
    if (t < this.store.get('pausedUntil', 0)) return;
    const s = this.settings;
    const idle = s.idleMin > 0 && this.idleSeconds() >= s.idleMin * 60;
    const blocked = this.locked || idle;
    if (t >= this.store.get('dueAt', 0) && !blocked && inActiveHours(t, s.activeStart, s.activeEnd)) return this.show();
    if (s.love) this.tickLove(t, blocked); // water has priority: it only gets here when water isn't showing
  }

  // Plan today's two hearts once (persisted, so a restart doesn't re-roll), then fire each inside its grace window.
  tickLove(t, blocked) {
    const today = dayKey(t);
    const m = minuteOfDay(t);
    if (this.store.get('loveDay') !== today) {
      const times = [LOVE.fixed];
      const lo = Math.max(LOVE.start, m);
      for (let i = 0; i < 20 && lo < LOVE.end && times.length < 2; i++) {
        const r = lo + Math.floor(this.random() * (LOVE.end - lo));
        if (Math.abs(r - LOVE.fixed) >= LOVE.gap) times.push(r);
      }
      this.store.set('loveDay', today);
      this.store.set('love', times.map((at) => ({ at, done: false })));
    }
    const plan = this.store.get('love', []);
    const i = plan.findIndex((e) => !e.done && m >= e.at);
    if (i < 0) return;
    const late = m >= plan[i].at + LOVE.grace;
    if (blocked && !late) return; // try again next tick until grace runs out
    this.store.set('love', plan.map((e, j) => (j === i ? { ...e, done: true } : e)));
    if (late) return; // missed it (app was off/asleep): skip silently rather than surprise at an odd time
    this.state = 'loving';
    this.onLove();
  }

  endLove() {
    if (this.state === 'loving') this.state = 'waiting';
  }

  show() {
    if (this.state !== 'waiting') return;
    this.state = 'showing';
    this.onShow();
  }

  // "Remind me now" from the tray.
  remind() {
    this.rollover();
    this.show();
  }

  drink() {
    if (this.state !== 'showing') return;
    this.rollover();
    const count = this.store.get('count', 0) + 1;
    this.store.set('count', count);
    this.finish(count === this.settings.goal ? 'goal' : 'happy', this.settings.intervalMin);
  }

  snooze() {
    if (this.state !== 'showing') return;
    this.finish('sulk', this.settings.snoozeMin);
  }

  // Tray "Undo last drink": mis-click insurance.
  undo() {
    this.rollover();
    this.store.set('count', Math.max(0, this.store.get('count', 0) - 1));
    this.onChange();
  }

  // Tray "Pause for 1 hour" / "Resume". Pausing pushes the next reminder to the end of the pause.
  pause(minutes) {
    const until = this.now() + minutes * MIN;
    this.store.set('pausedUntil', until);
    this.store.set('dueAt', Math.max(this.store.get('dueAt', 0), until));
    this.onChange();
  }

  resume() {
    this.store.set('pausedUntil', 0);
    this.onChange();
  }

  finish(kind, minutes) {
    this.state = 'waiting';
    this.store.set('dueAt', this.now() + minutes * MIN);
    this.onExit(kind);
    this.onChange();
  }

  // New local day: score yesterday into the streak, zero the count.
  rollover() {
    const today = dayKey(this.now());
    const day = this.store.get('day');
    if (day === today) return;
    if (day && today < day) return; // clock went backwards (tz change): keep counting on the old day
    let streak = this.store.get('streak', 0);
    if (day) {
      const met = this.store.get('count', 0) >= this.settings.goal;
      streak = met && dayGap(day, today) === 1 ? streak + 1 : 0;
    }
    this.store.set('day', today);
    this.store.set('count', 0);
    this.store.set('streak', streak);
    this.onChange();
  }

  status() {
    const { goal } = this.settings;
    const count = this.store.get('count', 0);
    const pausedUntil = this.store.get('pausedUntil', 0);
    return { count, goal, streak: this.store.get('streak', 0) + (count >= goal ? 1 : 0), pausedUntil: pausedUntil > this.now() ? pausedUntil : 0 };
  }
}

module.exports = { Scheduler, DEFAULTS, LOVE, sanitize, inActiveHours, dayKey, dayGap, MIN };
