// main.js shell tests: persist/restore round-trip, stale-render guard,
// double-click single billable call, retry routing from the failed state,
// token-expiry gating, and the storage-unavailable fallback warning.
//
// main.js is browser wiring, so this suite installs a minimal fake DOM
// (button parsing from innerHTML, click dispatch, sessionStorage, location)
// BEFORE dynamically importing it, then drives the real UI code paths with a
// scripted fetch mock. Zero network.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JEV_ENDPOINT } from '../../src/jev.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const scenarioDoc = JSON.parse(readFileSync(join(root, 'data', 'scenarios.v1.json'), 'utf8'));

// ---------- minimal fake DOM ----------

function makeButton(attrs) {
  const listeners = {};
  const btn = {
    _attrs: attrs,
    disabled: Object.prototype.hasOwnProperty.call(attrs, 'disabled'),
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this._attrs, name) ? this._attrs[name] : null;
    },
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    removeEventListener() { /* not needed by the shell */ },
    // Fires regardless of `disabled`: models the worst case (a tap already
    // queued before the loading render disables the button).
    click() {
      for (const fn of (listeners.click || []).slice()) fn.call(btn);
    },
  };
  return btn;
}

function parseButtons(html) {
  const out = [];
  const re = /<button\b([^>]*)>([\s\S]*?)<\/button>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = {};
    const are = /([\w-]+)(?:="([^"]*)")?/g;
    let a;
    while ((a = are.exec(m[1])) !== null) attrs[a[1]] = a[2] === undefined ? '' : a[2];
    out.push(makeButton(attrs));
  }
  return out;
}

function classList(attrs) {
  return String(attrs.class || '').split(/\s+/).filter(Boolean);
}

function makeHeading() {
  return {
    _tabbed: false,
    hasAttribute(name) { return name === 'tabindex' ? this._tabbed : false; },
    setAttribute() { this._tabbed = true; },
    focus() { /* no-op */ },
  };
}

function makeApp() {
  let buttons = [];
  let heading = null;
  const app = {
    _html: '',
    set innerHTML(h) {
      this._html = String(h);
      buttons = parseButtons(this._html);
      heading = /<h[12]\b[^>]*\bdata-focus\b/i.test(this._html) ? makeHeading() : null;
    },
    get innerHTML() { return this._html; },
    querySelectorAll(sel) {
      if (sel === '.choice') {
        return buttons.filter((b) => classList(b._attrs).includes('choice'));
      }
      const act = /^\[data-act="([^"]+)"\]$/.exec(sel);
      if (act) return buttons.filter((b) => b._attrs['data-act'] === act[1]);
      if (sel === '[data-focus]') return heading ? [heading] : [];
      return [];
    },
    querySelector(sel) {
      const all = this.querySelectorAll(sel);
      return all.length > 0 ? all[0] : null;
    },
  };
  return app;
}

function makeSession() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => m.clear(),
  };
}

// ---------- scripted fetch ----------

let jevMode = 'ok'; // 'ok' | 'net-fail' | 'http401' | 'gate'
let jevChoice = 'divert'; // pullKey of round 0 (baseline-5v1)
let jevCalls = 0;
let gateRelease = null;

function okJevPayload() {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      answers: { decision: { choice: jevChoice } },
      usage: { input_tokens: 10, output_tokens: 2 },
      model: 'jev',
    }),
  };
}

// ---------- module under test (imported after globals exist) ----------

let app;
let hooks;
let realSession;

const tick = () => new Promise((r) => setImmediate(r));
async function settle(n = 40) {
  for (let k = 0; k < n; k += 1) await tick();
}

function choiceButtons() {
  return app.querySelectorAll('.choice');
}

before(async () => {
  app = makeApp();
  realSession = makeSession();
  globalThis.document = { getElementById: (id) => (id === 'app' ? app : null) };
  globalThis.sessionStorage = realSession;
  globalThis.location = { search: '', pathname: '/', hash: '', href: '' };
  globalThis.history = { replaceState() {} };
  globalThis.fetch = async (url) => {
    if (String(url).includes('scenarios')) {
      return { ok: true, status: 200, json: async () => scenarioDoc };
    }
    if (url === JEV_ENDPOINT) {
      jevCalls += 1;
      if (jevMode === 'net-fail') throw new TypeError('down');
      if (jevMode === 'http401') return { ok: false, status: 401, json: async () => ({}) };
      if (jevMode === 'gate') await new Promise((res) => { gateRelease = res; });
      return okJevPayload();
    }
    throw new Error('unexpected fetch ' + url);
  };
  ({ __trolleyTestHooks: hooks } = await import('../../src/main.js'));
  await settle(); // let boot() finish (scenarios load + intro render)
  hooks.saveKey('sk_test', Date.now() + 3600 * 1000);
});

test('shell: persist/restore round-trip resumes the run after a redirect', async () => {
  jevMode = 'ok';
  hooks.freshGame();
  hooks.clearSaved();
  hooks.showRound(0, 'choose');
  choiceButtons()[0].click(); // commit pull -> runRound
  await settle();
  assert.ok(app.innerHTML.includes('You chose:'), 'reveal renders after the live call');
  const savedRaw = realSession.getItem('trolley-match:progress:v1');
  assert.ok(savedRaw, 'progress persisted to tab storage during the run');
  const saved = JSON.parse(savedRaw);
  assert.equal(saved.snap.player[0], 'pull');
  assert.equal(saved.snap.okResults.length, 1);
  // Simulate the full-page OAuth redirect: memory gone, storage intact.
  hooks.freshGame();
  assert.equal(hooks.state().progress.snap.player[0], 'pull');
  const res = hooks.restoreSaved();
  assert.deepEqual([res.choices, res.answers], [1, 1]);
  assert.equal(hooks.state().roundIndex, 0);
});

test('shell: rapid double-click fires exactly one billable Jev call', async () => {
  jevMode = 'ok';
  jevCalls = 0;
  hooks.freshGame();
  hooks.clearSaved();
  hooks.showRound(0, 'choose');
  const btn = choiceButtons()[0];
  btn.click();
  btn.click(); // second tap lands while the first run is in flight
  await settle();
  assert.equal(jevCalls, 1);
  assert.ok(app.innerHTML.includes('You chose:'), 'single run still reaches reveal');
});

test('shell: retry button on a failed round refetches only the failed call', async () => {
  jevMode = 'net-fail';
  hooks.freshGame();
  hooks.clearSaved();
  hooks.showRound(0, 'choose');
  choiceButtons()[0].click();
  await settle();
  assert.ok(app.innerHTML.includes('Retry failed call(s)'), 'failed screen renders');
  const beforeCalls = jevCalls;
  jevMode = 'ok';
  const retry = app.querySelector('[data-act="retry"]');
  assert.ok(retry, 'retry button is the single retry path on failed screens');
  retry.click(); // failed-state retry goes through the Retry button (retryRound)
  assert.ok(app.innerHTML.includes('Retrying the failed'),
    'retry button takes the retry path, not a fresh run');
  await settle();
  assert.equal(jevCalls, beforeCalls + 1, 'exactly one refetch for the failed call');
  assert.ok(app.innerHTML.includes('Agreement:'), 'retry reaches reveal with agreement');
});

test('shell: stale late promise never repaints over intro/disconnect', async () => {
  jevMode = 'gate';
  gateRelease = null;
  hooks.freshGame();
  hooks.clearSaved();
  hooks.showRound(0, 'choose');
  choiceButtons()[0].click(); // runRound starts, fetch hangs at the gate
  await settle(10);
  assert.ok(app.innerHTML.includes('Asking Jev live'), 'loading renders while gated');
  const disc = app.querySelector('[data-act="disconnect"]');
  assert.ok(disc, 'disconnect available during the run');
  disc.click(); // player leaves mid-call -> intro (also bumps the UI generation)
  await settle(5);
  assert.ok(app.innerHTML.includes('Connect with Pollinations'),
    'disconnect lands back on intro (key cleared by design)');
  gateRelease(); // the abandoned call finally resolves
  jevMode = 'ok';
  await settle();
  assert.ok(app.innerHTML.includes('Connect with Pollinations'),
    'late promise did not repaint');
  assert.ok(!app.innerHTML.includes('Round 1 of'), 'no round screen leaked over intro');
  assert.equal(hooks.state().busy, false, 'busy flag released by the stale return');
  hooks.saveKey('sk_test', Date.now() + 3600 * 1000); // disconnect cleared it
});

test('shell: expired token gates connected display and round calls', async () => {
  hooks.saveKey('sk_old', Date.now() - 1000);
  hooks.showIntro();
  assert.ok(app.innerHTML.includes('Connect with Pollinations'), 'reconnect offered');
  assert.ok(app.innerHTML.includes('expired'), 'expiry reason shown');
  assert.ok(!app.innerHTML.includes('Start the run'), 'no start without a usable key');
  // A choice tap with an expired key routes to the reconnect terminal
  // without spending a call.
  jevCalls = 0;
  hooks.freshGame();
  hooks.showRound(0, 'choose');
  choiceButtons()[0].click();
  await settle();
  assert.equal(jevCalls, 0, 'no Jev call fires on an expired key');
  assert.ok(app.innerHTML.includes('Reconnect with Pollinations'), 'terminal offers reconnect');
  hooks.saveKey('sk_test', Date.now() + 3600 * 1000);
  hooks.showIntro();
  assert.ok(app.innerHTML.includes('Start the run'), 'usable key restores start');
});

test('shell: without tab storage the terminal warns that reconnect resets the run', async () => {
  jevMode = 'http401';
  delete globalThis.sessionStorage; // persist infeasible -> fallback warning path
  try {
    hooks.freshGame();
    hooks.showRound(0, 'choose');
    choiceButtons()[0].click();
    await settle();
    assert.ok(app.innerHTML.includes('reset this run'),
      'terminal warns that reconnect resets the run when storage is unavailable');
  } finally {
    globalThis.sessionStorage = realSession;
    jevMode = 'ok';
    hooks.saveKey('sk_test', Date.now() + 3600 * 1000);
  }
});

test('shell: tampered progress (unrestorable entries) falls back to intro, not resume', async () => {
  jevMode = 'ok';
  hooks.freshGame();
  hooks.clearSaved();
  // Raw storage claims one answer, but the entry is foreign — restore validates
  // field-by-field and counts zero. Boot judges on restored counts, so intro.
  realSession.setItem('trolley-match:progress:v1', JSON.stringify({
    roundIndex: 0,
    snap: { v: 1, player: [null, null, null, null, null], okResults: [{}] },
  }));
  hooks.freshGame(); // wipe memory, keep storage: the redirect round-trip
  assert.equal(hooks.state().progress.snap.okResults.length, 1, 'raw storage claims an answer');
  const res = hooks.restoreSaved();
  assert.deepEqual([res.choices, res.answers], [0, 0], 'nothing restorable');
  const wouldResume = !!res && (res.choices + res.answers) > 0; // boot's gate
  assert.equal(wouldResume, false, 'boot gate stays on intro for tampered data');
  hooks.showIntro(); // boot's else branch
  assert.ok(app.innerHTML.includes('Trolley Match'), 'intro renders');
  assert.ok(!app.innerHTML.includes('Round 1 of'), 'no round screen resumed');
  assert.ok(!app.innerHTML.includes('Resumed where you left off'), 'no fake resume notice');
  hooks.clearSaved();
});
