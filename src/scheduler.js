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
};

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
// UTC midnights on both sides, so DST never makes a day 23/25 hours.
const dayGap = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);
const toMin = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

// start == end means "always active"; start > end wraps midnight (e.g. 22:00-06:00).
function inActiveHours(t, start, end) {
  const d = new Date(t);
  const m = d.getHours() * 60 + d.getMinutes();
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
  if (typeof input?.autostart === 'boolean') out.autostart = input.autostart;
  return out;
}

class Scheduler {
  // store: { get(key, default?), set(key, value) } (electron-store compatible)
  constructor({ store, now = Date.now, idleSeconds = () => 0, onShow, onExit, onChange = () => {} }) {
    Object.assign(this, { store, now, idleSeconds, onShow, onExit, onChange });
    this.state = 'waiting'; // 'waiting' | 'showing'
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
    if (this.state === 'showing') return;
    const t = this.now();
    if (t < this.store.get('dueAt', 0)) return;
    const s = this.settings;
    if (this.locked) return;
    if (!inActiveHours(t, s.activeStart, s.activeEnd)) return;
    if (s.idleMin > 0 && this.idleSeconds() >= s.idleMin * 60) return;
    this.show();
  }

  show() {
    if (this.state === 'showing') return;
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
    this.store.set('count', this.store.get('count', 0) + 1);
    this.finish('drank', this.settings.intervalMin);
  }

  snooze() {
    if (this.state !== 'showing') return;
    this.finish('snooze', this.settings.snoozeMin);
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
    return { count, goal, streak: this.store.get('streak', 0) + (count >= goal ? 1 : 0) };
  }
}

module.exports = { Scheduler, DEFAULTS, sanitize, inActiveHours, dayKey, dayGap, MIN };
