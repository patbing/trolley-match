// jev.js tests: prompt building (incl. order-swap semantics), decision
// mapping, abort/timeout, and HTTP failure kinds. All fetch is injected
// fakes — zero network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  JEV_ENDPOINT,
  JEV_MODEL,
  JEV_QUESTION_KEY,
  JEV_ORDER_A,
  JEV_ORDER_B,
  buildDecisionRequest,
  authorizeRequest,
  isAllowedJevUrl,
  parseDecision,
  errorKindForStatus,
  callDecision,
} from '../../src/jev.js';

const SC = {
  id: 'spur-order-lab',
  facts: 'SHARED FACTS.',
  actionA: { label: 'Throw the switch', text: 'Send the car onto the spur.', effect: 'pull' },
  actionB: { label: 'Hold', text: 'Let the car continue.', effect: 'hold' },
  jev: { pullKey: 'divert', holdKey: 'stay', instructions: 'Decide.' },
};

function okFetch(choice, { status = 200, confidence } = {}) {
  return async () => ({
    ok: true,
    status,
    json: async () => ({
      answers: { [JEV_QUESTION_KEY]: { choice, ...(confidence !== undefined ? { confidence } : {}) } },
      usage: { input_tokens: 10, output_tokens: 2 },
      model: 'jev',
    }),
  });
}

test('prompt: order A and B share identical facts, only presentation order differs', () => {
  const a = buildDecisionRequest(SC, { order: JEV_ORDER_A });
  const b = buildDecisionRequest(SC, { order: JEV_ORDER_B });
  assert.equal(a.url, JEV_ENDPOINT);
  assert.equal(b.url, JEV_ENDPOINT);
  // Same facts prefix in both states.
  assert.ok(a.prompt.state.startsWith('SHARED FACTS.'));
  assert.ok(b.prompt.state.startsWith('SHARED FACTS.'));
  // Action lines swapped, nothing else changed.
  assert.ok(a.prompt.state.includes('- Throw the switch: Send the car onto the spur.\n- Hold: Let the car continue.'));
  assert.ok(b.prompt.state.includes('- Hold: Let the car continue.\n- Throw the switch: Send the car onto the spur.'));
  // Criteria keys: same key->description binding, insertion order swapped.
  const ka = Object.keys(a.prompt.questions[JEV_QUESTION_KEY].criteria);
  const kb = Object.keys(b.prompt.questions[JEV_QUESTION_KEY].criteria);
  assert.deepEqual(ka, ['divert', 'stay']);
  assert.deepEqual(kb, ['stay', 'divert']);
  assert.equal(a.prompt.questions[JEV_QUESTION_KEY].criteria.divert,
    b.prompt.questions[JEV_QUESTION_KEY].criteria.divert);
  assert.equal(a.prompt.questions[JEV_QUESTION_KEY].criteria.stay,
    b.prompt.questions[JEV_QUESTION_KEY].criteria.stay);
  assert.equal(a.prompt.questions[JEV_QUESTION_KEY].type, 'choice');
  assert.equal(a.meta.pullKey, 'divert');
  assert.equal(a.meta.holdKey, 'stay');
});

test('mapping: choice maps by semantic key in both orders, never by index', () => {
  // Same returned choice string in both orders -> same semantic action.
  for (const order of [JEV_ORDER_A, JEV_ORDER_B]) {
    buildDecisionRequest(SC, { order }); // must not throw
    assert.deepEqual(parseDecision({ answers: { [JEV_QUESTION_KEY]: { choice: 'stay' } } }, SC),
      { ok: true, action: 'hold', choice: 'stay', confidence: null });
    const withConf = parseDecision(
      { answers: { [JEV_QUESTION_KEY]: { choice: 'divert', confidence: 0.81 } } }, SC);
    assert.deepEqual([withConf.ok, withConf.action, withConf.confidence], [true, 'pull', 0.81]);
  }
  // Unknown choice is an honest failure, not a guess.
  assert.deepEqual(parseDecision({ answers: { [JEV_QUESTION_KEY]: { choice: 'maybe' } } }, SC),
    { ok: false, kind: 'unmapped', choice: 'maybe' });
  assert.deepEqual(parseDecision({ answers: {} }, SC).kind, 'unmapped');
  assert.deepEqual(parseDecision(null, SC).kind, 'unmapped');
});

test('request: key travels only in the Authorization header', async () => {
  const seen = [];
  const fetchImpl = async (url, opts) => {
    seen.push({ url, opts });
    return okFetch('divert')();
  };
  const r = await callDecision({ fetchImpl, scenario: SC, key: 'sk_live' });
  assert.equal(r.ok, true);
  assert.equal(r.action, 'pull');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, JEV_ENDPOINT);
  assert.equal(seen[0].opts.method, 'POST');
  assert.equal(seen[0].opts.headers.Authorization, 'Bearer sk_live');
  assert.ok(!seen[0].url.includes('sk_live'));
  assert.ok(!seen[0].opts.body.includes('sk_live'));
  assert.deepEqual(r.usage, { input_tokens: 10, output_tokens: 2 });
  // The un-authorized builder carries a placeholder, never a real key.
  const built = buildDecisionRequest(SC);
  assert.ok(!built.options.headers.Authorization.includes('sk_live'));
  assert.ok(!JSON.stringify(built.prompt).includes('sk_live'));
});

test('failures: 401/402/403/429/retryable/network map to reconnect-safe kinds', async () => {
  const statusFetch = (status, json) => async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: json || (async () => ({})),
  });
  assert.equal((await callDecision({
    fetchImpl: statusFetch(401), scenario: SC, key: 'k',
  })).kind, 'auth');
  assert.equal((await callDecision({
    fetchImpl: statusFetch(402), scenario: SC, key: 'k',
  })).kind, 'budget');
  const f = await callDecision({
    fetchImpl: statusFetch(403, async () => ({ error: { message: 'model restricted here' } })),
    scenario: SC, key: 'k',
  });
  assert.deepEqual([f.kind, f.detail], ['forbidden', 'model restricted here']);
  assert.equal((await callDecision({
    fetchImpl: statusFetch(429), scenario: SC, key: 'k',
  })).kind, 'retryable');
  assert.equal((await callDecision({
    fetchImpl: statusFetch(500), scenario: SC, key: 'k',
  })).kind, 'retryable');
  assert.equal((await callDecision({
    fetchImpl: async () => { throw new TypeError('down'); }, scenario: SC, key: 'k',
  })).kind, 'network');
  assert.equal((await callDecision({
    fetchImpl: okFetch('maybe'), scenario: SC, key: 'k',
  })).kind, 'unmapped');
  assert.equal((await callDecision({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad'); } }),
    scenario: SC, key: 'k',
  })).kind, 'retryable');
  assert.equal((await callDecision({ fetchImpl: okFetch('divert'), scenario: SC, key: '' })).kind, 'no-key');
  assert.deepEqual([errorKindForStatus(401), errorKindForStatus(402),
    errorKindForStatus(403), errorKindForStatus(429), errorKindForStatus(500)],
  ['auth', 'budget', 'forbidden', 'rate', 'retryable']);
  assert.equal(isAllowedJevUrl(JEV_ENDPOINT), true);
  assert.equal(isAllowedJevUrl('https://evil.example/'), false);
});

test('abort: pre-aborted caller never sends; mid-flight abort wins over hang', async () => {
  let sent = 0;
  const hanging = () => new Promise(() => { sent += 1; });
  const c1 = new AbortController();
  c1.abort();
  assert.equal((await callDecision({
    fetchImpl: hanging, scenario: SC, key: 'k', signal: c1.signal,
  })).kind, 'aborted');
  assert.equal(sent, 0);

  const c2 = new AbortController();
  const p = callDecision({ fetchImpl: hanging, scenario: SC, key: 'k', signal: c2.signal });
  c2.abort();
  assert.equal((await p).kind, 'aborted');
});

test('timeout: a hung fetch loses the race to the internal timer', async () => {
  const hanging = () => new Promise(() => {});
  const r = await callDecision({
    fetchImpl: hanging, scenario: SC, key: 'k', timeoutMs: 10,
  });
  assert.equal(r.kind, 'timeout');
});

test('authorizeRequest: rejects missing key and wrong endpoint use', () => {
  const built = buildDecisionRequest(SC);
  assert.throws(() => authorizeRequest(built, ''), /key/);
  assert.throws(() => authorizeRequest(null, 'k'), /built/);
  assert.throws(() => buildDecisionRequest(null), /scenario/);
  assert.throws(() => buildDecisionRequest({ ...SC, jev: { pullKey: 'x', holdKey: 'x' } }), /differ/);
  assert.equal(JEV_MODEL, 'jev');
});
