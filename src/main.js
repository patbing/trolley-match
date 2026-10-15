// Trolley Match app shell: intro, BYOP connect, round flow, reveal, result.
// This is the ONLY module that touches the DOM. Game rules, Jev requests,
// OAuth math, key storage, and cost text live in the DOM-free modules and
// are exercised by the mocked test suite. This file is browser wiring only.
//
// Secrets: the BYOP-issued token lives only in the session tab-storage vault
// (see keyvault.js) or an in-memory fallback. It travels solely in the
// Authorization header of the Jev call (see jev.js authorizeRequest) and is
// never written into prompts, URLs, or inspected text.

import { createGame, ordersFor, isTerminalKind } from './game.js';
import { buildDecisionRequest, JEV_ORDER_A, JEV_ORDER_B } from './jev.js';
import { buildCostNotice } from './cost.js';
import { createKeyStore } from './keyvault.js';
import {
  beginTransaction,
  parseCallback,
  claimCallbackTransaction,
  exchangeCode,
  clearTransaction,
  defaultByopStore,
  tokenUsable,
} from './byop.js';

const app = document.getElementById('app');
const keyStore = createKeyStore();
const notice = buildCostNotice();

let scenarios = [];
let game = null;
let roundIndex = 0;
let aborter = null;
let callbackDone = false;
let introStatus = '';
// UI generation: bumped on every screen navigation (intro/round/result and
// disconnect). Async round flows capture it around each await and bail out
// when stale, so a late promise can never repaint over a screen the player
// has already left (e.g. intro or disconnect after an OAuth redirect hop).
let uiGen = 0;
// Round-call busy flag: runRound/retryRound entry guard so a rapid
// double-click on a choice (or retry) can never fire two billable Jev calls.
// This is a UI-layer guard on top of the game-layer in-flight dedup.
let callBusy = false;

// In-run progress persistence: player selections + successful Jev answers,
// so a mid-run full-page OAuth redirect resumes where the player was.
// When tab storage is unavailable there is no fallback that survives the
// redirect — terminal screens then warn that reconnect resets the run.
const PROGRESS_ITEM = 'trolley-match:progress:v1';

// ---------- small helpers ----------

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// The exact prompt object Jev receives for one (scenario, order) call.
// Built by the key-free request builder, so it can never carry the token.
function promptJson(scenario, order) {
  try {
    return JSON.stringify(buildDecisionRequest(scenario, { order }).prompt, null, 2);
  } catch (_) {
    return '(prompt unavailable)';
  }
}

function actionOf(scenario, effect) {
  for (const slot of ['actionA', 'actionB']) {
    if (scenario[slot] && scenario[slot].effect === effect) return scenario[slot];
  }
  return null;
}

function orderLabel(order, swap) {
  if (!swap) return '';
  return order === JEV_ORDER_A ? ' (order A: act-first shown first)' : ' (order B: hold-first shown first)';
}

function focusHeading() {
  const h = app.querySelector('[data-focus]');
  if (h) {
    if (!h.hasAttribute('tabindex')) h.setAttribute('tabindex', '-1');
    try { h.focus({ preventScroll: true }); } catch (_) { /* ignore */ }
  }
}

function currentKey() {
  return keyStore.load();
}

// Full key record (token + expiresAt) for expiry gating.
function currentRecord() {
  try {
    return keyStore.loadRecord();
  } catch (_) {
    return { token: currentKey(), expiresAt: null };
  }
}

// The usable token string, or null when missing/expired. Round flows gate on
// this (not on the bare non-empty check), so an expired key routes to the
// reconnect terminal instead of firing doomed calls.
function usableKey() {
  const rec = currentRecord();
  try {
    if (tokenUsable(rec, Date.now)) return rec.token;
  } catch (_) { /* fall through */ }
  return null;
}

function connected() {
  return usableKey() !== null;
}

// ---------- run-progress persistence (sessionStorage) ----------

function progressStore() {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : null;
  } catch (_) {
    return null; // storage access blocked
  }
}

function progressAvailable() {
  return progressStore() !== null;
}

// Best-effort write of { roundIndex, snap } after every in-run change.
// Never throws; a failed write just means the redirect-resume is lost.
function saveProgress() {
  try {
    const store = progressStore();
    if (!store || !game) return false;
    store.setItem(PROGRESS_ITEM, JSON.stringify({ roundIndex, snap: game.snapshot() }));
    return true;
  } catch (_) {
    return false;
  }
}

function readSavedProgress() {
  try {
    const store = progressStore();
    if (!store) return null;
    const raw = store.getItem(PROGRESS_ITEM);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.snap) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

// Rehydrate in-memory game state from tab storage. Returns { choices,
// answers } on success, null when nothing usable was saved. Shared by boot()
// and the test hooks — the single restore path.
function restoreSavedProgress() {
  if (!game) return null;
  const saved = readSavedProgress();
  if (!saved) return null;
  let res = null;
  try {
    res = game.restore(saved.snap);
  } catch (_) {
    return null;
  }
  if (!res || !res.ok) return null;
  if (Number.isInteger(saved.roundIndex) && saved.roundIndex >= 0 &&
      saved.roundIndex < scenarios.length) {
    roundIndex = saved.roundIndex;
  } else {
    roundIndex = firstIncompleteRound();
  }
  return res;
}

function clearSavedProgress() {
  try {
    const store = progressStore();
    if (store) store.removeItem(PROGRESS_ITEM);
  } catch (_) { /* ignore */ }
}

// First round with no complete answer — the resume point after a redirect.
function firstIncompleteRound() {
  if (!game) return 0;
  for (let i = 0; i < scenarios.length; i += 1) {
    try {
      if (!game.roundComplete(i)) return i;
    } catch (_) { /* treat as incomplete */ return i; }
  }
  return 0;
}

function abortInFlight() {
  if (aborter) {
    try { aborter.abort(); } catch (_) { /* ignore */ }
    aborter = null;
  }
  if (game) {
    try { game.abort(); } catch (_) { /* ignore */ }
  }
}

// Drop credentials: vault token plus any pending OAuth transaction.
// Player choices and cached Jev answers stay in the in-memory game.
function disconnect() {
  uiGen += 1; // invalidate any in-flight round flow (stale-render guard)
  // NOTE: navigation intentionally leaves callBusy set — one tap right after Back/Next/Disconnect is swallowed until the stale runLoop settles in its finally (self-recovers; clearing here would race the finally).
  abortInFlight();
  try { keyStore.clear(); } catch (_) { /* ignore */ }
  try { clearTransaction(defaultByopStore()); } catch (_) { /* ignore */ }
}

function costBlock() {
  return '<section class="cost" aria-label="Cost notice">' +
    '<p lang="ko">' + esc(notice.ko) + '</p>' +
    '<p>' + esc(notice.en) + '</p>' +
    '</section>';
}

// ---------- OAuth ----------

// Capture callback params and scrub them from the URL immediately (also on
// denial / malformed callbacks), before any further work.
function captureCallback() {
  let search = '';
  try {
    search = location.search || '';
  } catch (_) {
    return null;
  }
  const params = parseCallback(search);
  if (!params.present) return null;
  try {
    history.replaceState(null, '', location.pathname + (location.hash || ''));
  } catch (_) { /* params stay single-use via the consumed transaction */ }
  return params;
}

function recoverableMessage(kind) {
  switch (kind) {
    case 'denied':
      return 'The Pollinations connection was not approved. Nothing was spent — you can try connecting again.';
    case 'mismatch':
      return 'The connection reply did not match this tab. Nothing was spent — try connecting again.';
    case 'stale':
      return 'The connection reply arrived too late. Nothing was spent — try connecting again.';
    case 'duplicate':
      return 'The connection reply was malformed. Nothing was spent — try connecting again.';
    case 'no-txn':
      return 'The connection data is gone (already used or the tab reloaded). Try connecting again.';
    case 'storage':
      return 'Tab storage is unavailable, so the connection cannot be verified. Try a normal tab with storage enabled.';
    default:
      return 'The Pollinations connection did not complete. Nothing was spent — try connecting again.';
  }
}

// Same-page callback: capture, validate, consume, exchange, vault — once.
async function finishCallback(params) {
  if (callbackDone) return;
  callbackDone = true;
  const claim = claimCallbackTransaction({ params, storage: defaultByopStore(), now: Date.now });
  if (!claim.ok) {
    introStatus = recoverableMessage(claim.kind);
    showIntro();
    return;
  }
  introStatus = 'Finishing the connection…';
  showIntro();
  const ex = await exchangeCode({
    code: claim.code,
    verifier: claim.verifier,
    fetchImpl: (url, opts) => fetch(url, opts),
    now: Date.now,
  });
  if (!ex.ok) {
    introStatus = 'The connection exchange failed. Nothing was spent — try connecting again.';
    showIntro();
    return;
  }
  keyStore.save(ex.token, ex.expiresAt !== undefined ? ex.expiresAt : null);
  if (game) {
    try { game.clearTerminal(); } catch (_) { /* ignore */ }
  }
  introStatus = 'Connected. Your budget-capped key is held in this tab only.';
  // Resume where the player was: choices and answered rounds are intact.
  if (scenarios.length > 0 && game && roundIndex < scenarios.length) {
    showRound(roundIndex);
  } else {
    showIntro();
  }
}

async function connect() {
  introStatus = 'Opening the Pollinations approval page…';
  showIntro();
  const begun = await beginTransaction({ now: Date.now });
  if (!begun.ok) {
    introStatus = 'Could not start the connection (' + begun.reason +
      '). No browser step was taken — try again or check tab storage.';
    showIntro();
    return;
  }
  location.href = begun.url;
}

// ---------- screens ----------

function showIntro() {
  uiGen += 1;
  abortInFlight();
  const rec = currentRecord();
  const isConnected = connected();
  const hadToken = !!(rec && rec.token);
  let body = '<h1 data-focus>Trolley Match</h1>' +
    '<p class="lede">You decide, then Jev decides. Five trolley scenarios, ' +
    'one live decision model, and a head-to-head on whether you agree.</p>' +
    '<ol class="how">' +
    '<li>You read the facts and commit to an action <em>first</em>.</li>' +
    '<li>Jev — the live Pollinations decision model — answers the same facts.</li>' +
    '<li>Both answers are revealed with a plain-language outcome and your agreement score.</li>' +
    '<li>One round is an order-swap lab: Jev answers twice (2 disclosed calls) ' +
    'to test whether presentation order changes the answer.</li>' +
    '</ol>' +
    '<p class="fair">We track <strong>agreement</strong>, not moral correctness. ' +
    'Jev is the comparison subject, not the answer key. A stable swap-lab result ' +
    'is informative — not a broken demo.</p>' +
    costBlock();
  if (introStatus) {
    body += '<p class="status" role="status">' + esc(introStatus) + '</p>';
  }
  if (isConnected) {
    body += '<div class="row">' +
      '<button type="button" data-act="start">Start the run</button>' +
      '<button type="button" data-act="disconnect" class="ghost">Disconnect</button>' +
      '</div>' +
      '<p class="hint">Connected in this tab. Disconnect removes the key from this tab.</p>';
  } else {
    body += '<div class="row">' +
      '<button type="button" data-act="connect">Connect with Pollinations</button>' +
      '</div>';
    if (hadToken) {
      body += '<p class="status" role="status">Your connection key expired or was rejected. ' +
        'Reconnect to resume — your saved run is kept in this tab.</p>';
    }
    body += '<p class="hint">Connect issues a budget-capped key for this tab only. ' +
      'Starting the run without connecting is not possible — every Jev answer is a live call.</p>';
  }
  body += '<p class="attrib">Scenarios are original wording adapted from trolley-bench themes. ' +
    'Made with <a href="https://pollinations.ai">pollinations.ai</a>.</p>';
  app.innerHTML = body;
  bindIntro();
  focusHeading();
}

function bindIntro() {
  const start = app.querySelector('[data-act="start"]');
  if (start) start.addEventListener('click', () => {
    introStatus = '';
    roundIndex = 0;
    showRound(0);
  });
  const conn = app.querySelector('[data-act="connect"]');
  if (conn) conn.addEventListener('click', () => { void connect(); });
  const disc = app.querySelector('[data-act="disconnect"]');
  if (disc) disc.addEventListener('click', () => {
    disconnect();
    introStatus = 'Disconnected. The tab key was removed.';
    showIntro();
  });
}

function progressDots() {
  return scenarios.map((sc, i) => {
    const cls = game && game.roundComplete(i) ? 'done' : (i === roundIndex ? 'now' : '');
    return '<span class="dot ' + cls + '" aria-label="round ' + (i + 1) +
      (game && game.roundComplete(i) ? ', answered' : '') + '"></span>';
  }).join('');
}

// Round screen. phase: 'choose' | 'loading' | 'reveal' | 'failed' | 'terminal'
function showRound(i, phase, detail) {
  uiGen += 1;
  roundIndex = i;
  const sc = scenarios[i];
  if (!sc) {
    showResult();
    return;
  }
  phase = phase || 'choose';
  detail = detail || {};
  const swap = sc.swapPair === true;
  const choice = game.playerChoice(i);
  const orders = ordersFor(sc);

  let body = '<p class="crumb">Round ' + (i + 1) + ' of ' + scenarios.length + '</p>' +
    '<div class="dots" aria-label="progress">' + progressDots() + '</div>' +
    '<h2 data-focus>' + esc(sc.title) + '</h2>' +
    (swap ? '<p class="lab">Order-swap lab — Jev answers twice (2 live calls, disclosed). ' +
      'Same facts both times; only the presentation order is swapped. ' +
      'This tests whether order changes the answer.</p>' : '') +
    '<section class="facts" aria-label="Scenario facts"><p>' + esc(sc.facts) + '</p></section>';

  if (phase === 'choose') {
    body += choiceButtons(sc, i, false);
  } else if (phase === 'loading') {
    body += choiceButtons(sc, i, true) +
      '<p class="status" role="status">' + esc(detail.message || 'Asking Jev live…') + '</p>' +
      '<div class="row"><button type="button" data-act="cancel">Cancel this call</button></div>' +
      '<p class="hint">Cancelling stops the wait. An already-sent request may still cost. ' +
      'Your choice is kept — nothing is re-sent unless you retry.</p>';
  } else {
    // reveal / failed / terminal: choices stay visible, re-pick allowed after reveal
    body += choiceButtons(sc, i, phase !== 'reveal');
    body += revealBlock(sc, i, orders, swap, phase, detail);
  }

  body += inspectorBlock(sc, orders, swap);
  body += navBlock(i, phase);
  app.innerHTML = body;
  bindRound(i, phase);
  focusHeading();
}

function choiceButtons(sc, i, disabled) {
  const slots = ['actionA', 'actionB'];
  let out = '<div class="choices" role="group" aria-label="Your decision">';
  for (const slot of slots) {
    const a = sc[slot];
    const picked = game.playerChoice(i) === a.effect;
    out += '<button type="button" class="choice' + (picked ? ' picked' : '') + '"' +
      ' data-effect="' + esc(a.effect) + '"' + (disabled ? ' disabled' : '') + '>' +
      '<strong>' + esc(a.label) + '</strong><span>' + esc(a.text) + '</span></button>';
  }
  return out + '</div>';
}

function revealBlock(sc, i, orders, swap, phase, detail) {
  const choice = game.playerChoice(i);
  let out = '';
  if (choice) {
    const mine = actionOf(sc, choice);
    out += '<section class="reveal" aria-label="Your choice"><h3>You chose: ' +
      esc(mine.label) + '</h3><p>' + esc(mine.text) + '</p></section>';
  }
  for (const order of orders) {
    const r = game.lastResult(i, order);
    if (r && r.ok) {
      const ja = actionOf(sc, r.action);
      out += '<section class="reveal jev" aria-label="Jev answer"><h3>Jev (live)' +
        esc(orderLabel(order, swap)) + ': ' + esc(ja.label) + '</h3>' +
        '<p>' + esc(ja.text) + '</p>' +
        (r.confidence != null ? '<p class="conf">Reported confidence: ' + esc(String(r.confidence)) + '</p>' : '') +
        '</section>';
    } else if (r && !r.ok) {
      out += failureLine(r);
    }
  }
  if (phase === 'reveal') {
    out += agreementLine(sc, i, swap);
  } else if (phase === 'failed' || phase === 'terminal') {
    out += '<p class="status" role="alert">' + esc(detail.message || 'The Jev call failed.') + '</p>';
    if (phase === 'failed') {
      out += '<div class="row"><button type="button" data-act="retry">Retry failed call(s)</button></div>' +
        '<p class="hint">Retry sends only the calls that failed — answered calls are never re-sent.</p>';
    } else {
      out += reconnectBlock(detail);
    }
  }
  return out;
}

function failureLine(r) {
  const kind = r.kind || 'retryable';
  const texts = {
    aborted: 'The call was cancelled.',
    timeout: 'The call timed out.',
    network: 'The network failed.',
    rate: 'Jev is rate-limited right now.',
    retryable: 'The call failed.',
    'no-key': 'There is no connection key in this tab.',
    unmapped: 'Jev returned an answer that matches neither action — shown honestly, not guessed.',
  };
  return '<p class="fail" role="alert">Jev call failed: ' +
    esc(texts[kind] || texts.retryable) + '</p>';
}

function agreementLine(sc, i, swap) {
  const s = game.scoreAgreement();
  const per = s.perRound[i];
  let out = '';
  if (per && per.agreed != null) {
    out += per.agreed
      ? '<p class="agree" role="status">Agreement: you and Jev chose the same action.</p>'
      : '<p class="split" role="status">Split: you and Jev chose different actions.</p>';
  }
  if (swap && s.swapConsistent && s.swapConsistent.roundIndex === i) {
    out += s.swapConsistent.consistent
      ? '<p class="agree" role="status">Swap lab: Jev chose the same action in both orders — stable.</p>'
      : '<p class="split" role="status">Swap lab: Jev changed its answer between the two orders.</p>';
  }
  const decided = ordersFor(sc).map((o) => game.lastResult(i, o)).filter((r) => r && r.ok);
  if (decided.length > 0) {
    out += '<p class="tally">Run agreement so far: ' + s.agreed + ' of ' + s.total + ' answered calls.</p>';
  }
  return out;
}

function reconnectBlock(detail) {
  const kind = detail.kind || '';
  let msg = '';
  if (kind === 'budget') {
    msg = 'The Pollen budget is exhausted. The run stops here — no further calls, no automatic retry. ' +
      'Your choices and answered rounds are kept below.';
  } else if (kind === 'auth') {
    msg = 'The connection key was rejected (expired or revoked). The tab key was removed. ' +
      'Reconnect to resume — your choices and answered rounds are kept, and answered calls are never re-sent.';
  } else if (kind === 'forbidden') {
    msg = 'The connection is not permitted for this call' +
      (detail.detail ? ': ' + detail.detail : '') +
      '. Reconnect to resume — your choices and answered rounds are kept.';
  } else {
    msg = 'The connection needs attention. Reconnect to resume — your choices are kept.';
  }
  // Fallback warning (persist infeasible): without tab storage the in-run
  // progress cannot survive the full-page reconnect redirect, so say so.
  let warn = '';
  if (!progressAvailable()) {
    warn = '<p class="status" role="alert">Note: tab storage is unavailable in this ' +
      'browser context, so reconnecting will reset this run — answered rounds cannot be restored.</p>';
  }
  return '<p class="status" role="alert">' + esc(msg) + '</p>' + warn +
    '<div class="row"><button type="button" data-act="connect">Reconnect with Pollinations</button>' +
    '<button type="button" data-act="disconnect" class="ghost">Disconnect</button></div>';
}

function inspectorBlock(sc, orders, swap) {
  let out = '<div class="inspectors">';
  for (const order of orders) {
    const title = swap
      ? (order === JEV_ORDER_A ? 'Exact prompt sent to Jev — order A' : 'Exact prompt sent to Jev — order B')
      : 'Exact prompt sent to Jev';
    out += '<details class="inspector"><summary>' + esc(title) + '</summary>' +
      '<pre>' + esc(promptJson(sc, order)) + '</pre></details>';
  }
  return out + '</div>';
}

function navBlock(i, phase) {
  let out = '<nav class="nav" aria-label="Round navigation"><div class="row">';
  if (i > 0) out += '<button type="button" data-act="back">Back</button>';
  if (phase === 'reveal') {
    out += (i + 1 < scenarios.length)
      ? '<button type="button" data-act="next">Next round</button>'
      : '<button type="button" data-act="finish">See results</button>';
  }
  if (connected()) {
    out += '<button type="button" data-act="disconnect" class="ghost">Disconnect</button>';
  }
  return out + '</div></nav>';
}

// True when the round holds at least one FAILED Jev answer (retryable work
// exists). Drives the single Cancel binding: cancelling a retry lands back
// on the failed screen, cancelling a first attempt lands on choose.
function hasFailedCall(i) {
  if (!game || !scenarios[i]) return false;
  try {
    return ordersFor(scenarios[i]).some((o) => {
      const r = game.lastResult(i, o);
      return !!r && r.ok === false;
    });
  } catch (_) {
    return false;
  }
}

function bindRound(i, phase) {
  app.querySelectorAll('.choice').forEach((btn) => {
    btn.addEventListener('click', () => {
      const effect = btn.getAttribute('data-effect');
      if (effect !== 'pull' && effect !== 'hold') return;
      game.commitPlayer(i, effect);
      saveProgress();
      // Failed screens keep choices disabled — the Retry button is the single
      // retry path (retryRound); a choice tap always starts runRound.
      void runRound(i);
    });
  });
  // The ONLY Cancel binding: every loading render goes through showRound ->
  // bindRound, so no caller may add its own Cancel listener (that double
  // binding fired twice and confused the stale-render guard).
  const cancel = app.querySelector('[data-act="cancel"]');
  if (cancel) cancel.addEventListener('click', () => {
    abortInFlight();
    if (game.roundComplete(i)) {
      showRound(i, 'reveal');
    } else if (hasFailedCall(i)) {
      showRound(i, 'failed', {});
    } else {
      showRound(i, 'choose');
    }
  });
  const retry = app.querySelector('[data-act="retry"]');
  if (retry) retry.addEventListener('click', () => { void retryRound(i); });
  const back = app.querySelector('[data-act="back"]');
  if (back) back.addEventListener('click', () => {
    abortInFlight();
    showRound(i - 1, game.roundComplete(i - 1) ? 'reveal' : 'choose');
  });
  const next = app.querySelector('[data-act="next"]');
  if (next) next.addEventListener('click', () => {
    showRound(i + 1, game.roundComplete(i + 1) ? 'reveal' : 'choose');
  });
  const finish = app.querySelector('[data-act="finish"]');
  if (finish) finish.addEventListener('click', () => { showResult(); });
  const conn = app.querySelector('[data-act="connect"]');
  if (conn) conn.addEventListener('click', () => { void connect(); });
  const disc = app.querySelector('[data-act="disconnect"]');
  if (disc) disc.addEventListener('click', () => {
    disconnect();
    introStatus = 'Disconnected. The tab key was removed.';
    showIntro();
  });
}

// Ask Jev for every order this round needs, sequentially so a terminal
// failure on the first call blocks the second before it can spend.
//
// Guards: (a) callBusy entry guard — a rapid double-click lands here twice
// but only the first run proceeds, so two billable Jev calls can never fire
// from one gesture (on top of the game-layer in-flight dedup); (b) uiGen
// stale-render guard — captured after each loading render, checked after
// each await, so a late promise never repaints over a screen the player has
// left. aborter is nulled in the finally on EVERY exit path.
async function runRound(i) {
  if (callBusy) return; // a run is already in flight — ignore the extra tap
  callBusy = true;
  try {
    const sc = scenarios[i];
    if (!sc) {
      showRound(i, 'choose');
      return;
    }
    const orders = ordersFor(sc);
    const swap = sc.swapPair === true;
    abortInFlight();
    aborter = new AbortController();
    const key = usableKey();
    if (!key) {
      showRound(i, 'terminal', { kind: 'no-key', message: 'There is no connection key in this tab.' });
      return;
    }
    for (let k = 0; k < orders.length; k += 1) {
      const order = orders[k];
      const progress = swap
        ? 'Asking Jev live — call ' + (k + 1) + ' of ' + orders.length +
          ' (' + (order === JEV_ORDER_A ? 'order A' : 'order B') + ')…'
        : 'Asking Jev live…';
      showRound(i, 'loading', { message: progress });
      app.querySelectorAll('.choice').forEach((b) => { b.disabled = true; });
      const myUi = uiGen; // loading render generation; navigation past it stales us
      const r = await game.requestJev({
        roundIndex: i, order, key, signal: aborter ? aborter.signal : undefined,
      });
      if (myUi !== uiGen) {
        saveProgress(); // keep the answered cache durable even when leaving
        return; // player navigated away — leave their screen alone
      }
      if (!r.ok && (r.kind === 'aborted' || r.stale)) {
        showRound(i, game.roundComplete(i) ? 'reveal' : 'choose');
        return;
      }
      if (!r.ok && isTerminalKind(r.kind)) {
        if (r.kind === 'auth' || r.kind === 'forbidden') {
          try { keyStore.clear(); } catch (_) { /* ignore */ }
        }
        showRound(i, 'terminal', { kind: r.kind, detail: r.detail || null });
        return;
      }
      if (!r.ok) {
        showRound(i, 'failed', { kind: r.kind });
        return;
      }
      saveProgress(); // successful answer is durable for the redirect-resume
    }
    saveProgress();
    showRound(i, 'reveal');
  } finally {
    aborter = null;
    callBusy = false;
  }
}

// Retry only the orders that have no successful answer. Successes are
// cached, so they are never re-sent and never billed twice. Same guards as
// runRound: busy entry guard, uiGen stale-render guard, finally-nulled
// aborter, and the single Cancel binding via showRound/bindRound.
async function retryRound(i) {
  if (callBusy) return; // a run is already in flight — ignore the extra tap
  callBusy = true;
  try {
    const sc = scenarios[i];
    if (!sc) {
      showRound(i, 'choose');
      return;
    }
    const pending = ordersFor(sc).filter((o) => {
      const r = game.lastResult(i, o);
      return !(r && r.ok);
    });
    if (pending.length === 0) {
      showRound(i, 'reveal');
      return;
    }
    abortInFlight();
    aborter = new AbortController();
    const key = usableKey();
    if (!key) {
      showRound(i, 'terminal', { kind: 'no-key', message: 'There is no connection key in this tab.' });
      return;
    }
    for (const order of pending) {
      showRound(i, 'loading', { message: 'Retrying the failed Jev call…' });
      const myUi = uiGen;
      const r = await game.requestJev({
        roundIndex: i, order, key,
        signal: aborter ? aborter.signal : undefined, force: true,
      });
      if (myUi !== uiGen) {
        saveProgress(); // keep the answered cache durable even when leaving
        return; // player navigated away — leave their screen alone
      }
      if (!r.ok && (r.kind === 'aborted' || r.stale)) {
        showRound(i, 'failed', {});
        return;
      }
      if (!r.ok && isTerminalKind(r.kind)) {
        if (r.kind === 'auth' || r.kind === 'forbidden') {
          try { keyStore.clear(); } catch (_) { /* ignore */ }
        }
        showRound(i, 'terminal', { kind: r.kind, detail: r.detail || null });
        return;
      }
      if (!r.ok) {
        showRound(i, 'failed', { kind: r.kind });
        return;
      }
      saveProgress();
    }
    saveProgress();
    showRound(i, 'reveal');
  } finally {
    aborter = null;
    callBusy = false;
  }
}

function showResult() {
  uiGen += 1;
  abortInFlight();
  const s = game.scoreAgreement();
  let body = '<h1 data-focus>Your results</h1>' +
    '<p class="lede">Agreement with Jev: <strong>' + s.agreed + ' of ' + s.total +
    '</strong> answered calls.</p>' +
    '<p class="fair">Agreement, not correctness — Jev is the comparison subject, not the answer key.</p>' +
    '<ol class="rounds">';
  scenarios.forEach((sc, i) => {
    const per = s.perRound[i];
    const mine = per && per.choice ? actionOf(sc, per.choice).label : 'no choice';
    const verdict = !per || per.agreed == null ? 'unanswered'
      : (per.agreed ? 'agree' : 'split');
    body += '<li><strong>' + esc(sc.title) + '</strong> — you: ' + esc(mine) +
      ' — <span class="' + verdict + '">' + verdict + '</span></li>';
  });
  body += '</ol>';
  if (s.swapConsistent) {
    body += s.swapConsistent.consistent
      ? '<p class="agree">Swap lab: Jev was stable across both orders.</p>'
      : '<p class="split">Swap lab: Jev changed its answer between the two orders.</p>';
  }
  const usage = game.getUsage();
  body += '<p class="hint">Live Jev calls this run: ' + usage.requests +
    ' sent, ' + usage.succeeded + ' answered.</p>';
  body += '<div class="row">' +
    '<button type="button" data-act="again">Play again (new live calls)</button>' +
    '<button type="button" data-act="review">Review rounds</button>' +
    '<button type="button" data-act="disconnect" class="ghost">Disconnect</button>' +
    '</div>';
  app.innerHTML = body;
  app.querySelector('[data-act="again"]').addEventListener('click', () => {
    game = createGame({ scenarios, fetchImpl: (url, opts) => fetch(url, opts) });
    roundIndex = 0;
    clearSavedProgress(); // a fresh run starts with no resume state
    showRound(0);
  });
  app.querySelector('[data-act="review"]').addEventListener('click', () => {
    showRound(0, game.roundComplete(0) ? 'reveal' : 'choose');
  });
  app.querySelector('[data-act="disconnect"]').addEventListener('click', () => {
    disconnect();
    introStatus = 'Disconnected. The tab key was removed.';
    showIntro();
  });
  focusHeading();
}

// ---------- boot ----------

async function boot() {
  const params = captureCallback();
  let res = null;
  try {
    res = await fetch('data/scenarios.v1.json', { cache: 'no-store' });
  } catch (_) {
    res = null;
  }
  if (!res || !res.ok) {
    app.innerHTML = '<h1 data-focus>Trolley Match</h1>' +
      '<p class="status" role="alert">Could not load the scenario file. ' +
      'Check your connection and reload.</p>';
    focusHeading();
    return;
  }
  let doc = null;
  try {
    doc = await res.json();
  } catch (_) {
    doc = null;
  }
  scenarios = (doc && Array.isArray(doc.scenarios)) ? doc.scenarios : [];
  if (scenarios.length === 0) {
    app.innerHTML = '<h1 data-focus>Trolley Match</h1>' +
      '<p class="status" role="alert">The scenario file is empty. Reload to try again.</p>';
    focusHeading();
    return;
  }
  game = createGame({ scenarios, fetchImpl: (url, opts) => fetch(url, opts) });
  // Mid-run resume: a full-page OAuth redirect lands back here with the
  // in-memory game gone but the tab-storage progress intact. Rehydrate first
  // so the callback path (and the plain reload path) continue the run.
  // Resume is judged on RESTORED counts, not raw storage length — tampered or
  // foreign entries (e.g. okResults:[{}]) restore to zero and fall to intro.
  const restored = restoreSavedProgress();
  if (params) {
    await finishCallback(params);
  } else if (restored && (restored.choices + restored.answers) > 0) {
    introStatus = 'Resumed where you left off — answered calls are never re-sent.';
    showRound(roundIndex, game.roundComplete(roundIndex) ? 'reveal' : 'choose');
  } else {
    showIntro();
  }
}

void boot();

// Test hooks for the node fake-DOM suite (tests/unit/main-shell.test.mjs).
// Production code never touches these: they expose the same restore/intro
// paths boot() uses so the suite can drive a "redirect" without reloading.
export const __trolleyTestHooks = {
  // Fresh in-memory run (same scenarios); tab storage is left untouched so a
  // test can persist, wipe memory, then restore — the redirect round-trip.
  freshGame() {
    abortInFlight();
    callBusy = false;
    game = createGame({ scenarios, fetchImpl: (url, opts) => fetch(url, opts) });
    roundIndex = 0;
  },
  restoreSaved() {
    return restoreSavedProgress();
  },
  clearSaved() {
    clearSavedProgress();
  },
  showIntro() {
    showIntro();
  },
  showRound(i, phase) {
    showRound(i, phase);
  },
  saveKey(token, expiresAt) {
    keyStore.save(token, expiresAt);
  },
  clearKey() {
    try { keyStore.clear(); } catch (_) { /* ignore */ }
  },
  state() {
    return {
      roundIndex,
      uiGen,
      busy: callBusy,
      connected: connected(),
      progress: readSavedProgress(),
    };
  },
};
