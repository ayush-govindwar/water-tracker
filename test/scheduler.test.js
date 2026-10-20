'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Scheduler, sanitize, inActiveHours, MIN } = require('../src/scheduler');

const H = 60 * MIN;
const at = (y, mo, d, h = 12, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

function make(t0 = at(2026, 3, 10, 12), opts = {}) {
  const data = new Map();
  const store = { get: (k, d) => (data.has(k) ? data.get(k) : d), set: (k, v) => data.set(k, v) };
  const clock = { t: t0 };
  const log = { shows: 0, exits: [] };
  const s = new Scheduler({
    store,
    now: () => clock.t,
    idleSeconds: () => opts.idle ?? 0,
    onShow: () => log.shows++,
    onExit: (k) => log.exits.push(k),
  });
  return { s, store, clock, log, data };
}

test('first start schedules one interval out, nothing shown yet', () => {
  const { s, clock, log, store } = make();
  s.start();
  assert.equal(log.shows, 0);
  assert.equal(store.get('dueAt'), clock.t + 30 * MIN);
});

test('fires when due, only once while showing', () => {
  const { s, clock, log } = make();
  s.start();
  clock.t += 30 * MIN;
  for (let i = 0; i < 10; i++) s.tick();
  assert.equal(log.shows, 1);
});

test('drink: count++, resets to interval, exits "drank"', () => {
  const { s, clock, log, store } = make();
  s.start();
  clock.t += 30 * MIN;
  s.tick();
  s.drink();
  assert.equal(store.get('count'), 1);
  assert.equal(store.get('dueAt'), clock.t + 30 * MIN);
  assert.deepEqual(log.exits, ['drank']);
  s.drink(); // double click: ignored
  assert.equal(store.get('count'), 1);
});

test('snooze re-fires in exactly 5 min, no count', () => {
  const { s, clock, log, store } = make();
  s.start();
  clock.t += 30 * MIN;
  s.tick();
  s.snooze();
  assert.equal(store.get('count'), 0);
  clock.t += 5 * MIN - 1;
  s.tick();
  assert.equal(log.shows, 1);
  clock.t += 1;
  s.tick();
  assert.equal(log.shows, 2);
});

test('2h sleep then many ticks/resumes: one reminder, not four', () => {
  const { s, clock, log } = make();
  s.start();
  clock.t += 2 * H;
  for (let i = 0; i < 20; i++) s.tick();
  assert.equal(log.shows, 1);
  s.drink();
  clock.t += 29 * MIN;
  s.tick();
  assert.equal(log.shows, 1);
});

test('idle suppresses, fires once user returns', () => {
  const o = { idle: 600 };
  const { s, clock, log } = make(undefined, o);
  s.start();
  clock.t += 40 * MIN;
  s.tick();
  assert.equal(log.shows, 0);
  o.idle = 3;
  s.tick();
  assert.equal(log.shows, 1);
});

test('locked screen suppresses', () => {
  const { s, clock, log } = make();
  s.start();
  clock.t += 40 * MIN;
  s.locked = true;
  s.tick();
  assert.equal(log.shows, 0);
  s.locked = false;
  s.tick();
  assert.equal(log.shows, 1);
});

test('outside active hours waits for the window, fires once', () => {
  const { s, clock, log } = make(at(2026, 3, 10, 21, 50));
  s.start();
  clock.t = at(2026, 3, 10, 23, 0);
  s.tick();
  assert.equal(log.shows, 0);
  clock.t = at(2026, 3, 11, 9, 0);
  s.tick();
  s.tick();
  assert.equal(log.shows, 1);
});

test('active hours: normal, wrap-midnight, equal=always', () => {
  assert.ok(inActiveHours(at(2026, 1, 1, 9, 0), '09:00', '22:00'));
  assert.ok(!inActiveHours(at(2026, 1, 1, 22, 0), '09:00', '22:00'));
  assert.ok(inActiveHours(at(2026, 1, 1, 23, 0), '22:00', '06:00'));
  assert.ok(inActiveHours(at(2026, 1, 1, 5, 59), '22:00', '06:00'));
  assert.ok(!inActiveHours(at(2026, 1, 1, 12, 0), '22:00', '06:00'));
  assert.ok(inActiveHours(at(2026, 1, 1, 3, 0), '00:00', '00:00'));
});

test('day rollover: goal met next day -> streak grows, count resets', () => {
  const { s, clock, store } = make(at(2026, 3, 10, 12));
  s.start();
  store.set('count', 8);
  clock.t = at(2026, 3, 11, 10);
  s.rollover();
  assert.equal(store.get('count'), 0);
  assert.equal(store.get('streak'), 1);
  store.set('count', 8);
  clock.t = at(2026, 3, 12, 10);
  s.rollover();
  assert.equal(store.get('streak'), 2);
  assert.equal(s.status().streak, 2);
  store.set('count', 8);
  assert.equal(s.status().streak, 3); // today's goal counts live
});

test('day rollover: goal missed or day skipped -> streak resets', () => {
  const a = make(at(2026, 3, 10, 12));
  a.s.start();
  a.store.set('streak', 4);
  a.store.set('count', 7);
  a.clock.t = at(2026, 3, 11, 9);
  a.s.rollover();
  assert.equal(a.store.get('streak'), 0);

  const b = make(at(2026, 3, 10, 12));
  b.s.start();
  b.store.set('streak', 4);
  b.store.set('count', 8);
  b.clock.t = at(2026, 3, 13, 9); // app off for 2 days
  b.s.rollover();
  assert.equal(b.store.get('streak'), 0);
});

test('rollover across DST change still sees consecutive days', () => {
  const { s, clock, store } = make(at(2026, 3, 28, 12)); // EU/US DST edges fall near here
  s.start();
  store.set('count', 8);
  clock.t = at(2026, 3, 29, 12);
  s.rollover();
  assert.equal(store.get('streak'), 1);
});

test('clock moving backwards does not wipe the day', () => {
  const { s, clock, store } = make(at(2026, 3, 10, 12));
  s.start();
  store.set('count', 3);
  clock.t = at(2026, 3, 9, 12);
  s.tick();
  assert.equal(store.get('count'), 3);
});

test('remind() shows now, then snooze works', () => {
  const { s, log } = make();
  s.start();
  s.remind();
  s.remind();
  assert.equal(log.shows, 1);
  s.snooze();
  assert.deepEqual(log.exits, ['snooze']);
});

test('sanitize clamps junk from the renderer', () => {
  const r = sanitize({ intervalMin: -5, snoozeMin: 'abc', goal: 9999, activeStart: '25:99', activeEnd: '07:30', autostart: 'yes', idleMin: 3.6 });
  assert.equal(r.intervalMin, 1);
  assert.equal(r.snoozeMin, 5);
  assert.equal(r.goal, 50);
  assert.equal(r.activeStart, '09:00');
  assert.equal(r.activeEnd, '07:30');
  assert.equal(r.autostart, false);
  assert.equal(r.idleMin, 4);
});
