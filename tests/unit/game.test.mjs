// game.js tests: agreement scoring, replay safety (no duplicate billable
// calls), failure preservation of player choices, terminal latch + resume.
// All fetch is injected fakes — zero network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, ordersFor, isTerminalKind } from '../../src/game.js';

const JEV_Q = 'decision';

function sc(id, swap = false) {
  return {
    id,
    facts: `facts ${id}`,
    actionA: { label: 'Pull', text: 'pull text', effect: 'pull' },
    actionB: { label: 'Hold', text: 'hold text', effect: 'hold' },
    jev: { pullKey: 'go', holdKey: 'stop', instructions: 'Decide.' },
    swapPair: swap,
  };
}

function choiceFetch(plan) {
  // plan: array of {choice} or {status} consumed in order; counts calls.
  let calls = 0;
  const impl = async () => {
    const step = plan[Math.min(calls, plan.length - 1)];
    calls += 1;
    if (step && step.status) return { ok: false, status: step.status, json: async () => ({}) };
    return {
      ok: true, status: 200,
      json: async () => ({ answers: { [JEV_Q]: { choice: step.choice } } }),
    };
  };
  impl.calls = () => calls;
  return impl;
}

test('ordersFor: swap lab needs both orders, normal rounds one', () => {
  assert.deepEqual(ordersFor(sc('a')), ['A']);
  assert.deepEqual(ordersFor(sc('b', true)), ['A', 'B']);
  assert.equal(isTerminalKind('auth'), true);
  assert.equal(isTerminalKind('budget'), true);
  assert.equal(isTerminalKind('forbidden'), true);
  assert.equal(isTerminalKind('retryable'), false);
});

test('happy path: commit, live call, reveal, agreement tallied', async () => {
  const fetchImpl = choiceFetch([{ choice: 'go' }, { choice: 'go' }]);
  const g = createGame({ scenarios: [sc('r1'), sc('r2')], fetchImpl });
  assert.equal(g.commitPlayer(0, 'pull').ok, true);
  assert.equal(g.commitPlayer(1, 'hold').ok, true);
  // Player choice recorded before any call.
  assert.equal(g.playerChoice(0), 'pull');
  const r1 = await g.requestRound({ roundIndex: 0, key: 'sk_x' });
  assert.equal(r1.ok, true);
  assert.equal(g.lastResult(0, 'A').action, 'pull');
  assert.equal(g.roundComplete(0), true);
  await g.requestRound({ roundIndex: 1, key: 'sk_x' });
  const s = g.scoreAgreement();
  assert.deepEqual([s.agreed, s.total], [1, 2]); // r1 agree, r2 disagree
  assert.deepEqual(s.perRound.map((p) => p.agreed), [true, false]);
  assert.equal(g.runComplete(), true);
  assert.deepEqual(g.getUsage(), { requests: 2, succeeded: 2, failed: 0 });
});

test('replay safety: concurrent + cached requests never duplicate a call', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    await gate;
    return { ok: true, status: 200, json: async () => ({ answers: { [JEV_Q]: { choice: 'go' } } }) };
  };
  const g = createGame({ scenarios: [sc('r1')], fetchImpl });
  g.commitPlayer(0, 'pull');
  const p1 = g.requestJev({ roundIndex: 0, key: 'sk_x' });
  const p2 = g.requestJev({ roundIndex: 0, key: 'sk_x' }); // double-click
  release();
  const [a, b] = await Promise.all([p1, p2]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(calls, 1);
  // Cached: a later request costs nothing.
  const c = await g.requestJev({ roundIndex: 0, key: 'sk_x' });
  assert.equal(c.fromCache, true);
  assert.equal(calls, 1);
});

test('failure preserves player choice; explicit retry refetches once', async () => {
  let mode = 'fail';
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (mode === 'fail') throw new TypeError('down');
    return { ok: true, status: 200, json: async () => ({ answers: { [JEV_Q]: { choice: 'stop' } } }) };
  };
  const g = createGame({ scenarios: [sc('r1')], fetchImpl });
  g.commitPlayer(0, 'hold');
  const bad = await g.requestJev({ roundIndex: 0, key: 'sk_x' });
  assert.equal(bad.ok, false);
  assert.equal(g.playerChoice(0), 'hold'); // choice survives the failure
  assert.equal(g.roundComplete(0), false);
  // Failed entries are cached too: no silent refetch.
  await g.requestJev({ roundIndex: 0, key: 'sk_x' });
  assert.equal(calls, 1);
  // Explicit user retry spends exactly one more call and commits.
  mode = 'ok';
  const good = await g.requestJev({ roundIndex: 0, key: 'sk_x', force: true });
  assert.equal(good.ok, true);
  assert.equal(calls, 2);
  assert.equal(g.scoreAgreement().agreed, 1);
});

test('terminal latch: 401 blocks further calls until reconnect; choices survive', async () => {
  const fetchImpl = choiceFetch([{ status: 401 }]);
  const g = createGame({ scenarios: [sc('r1'), sc('r2')], fetchImpl });
  g.commitPlayer(0, 'pull');
  g.commitPlayer(1, 'pull');
  const r = await g.requestJev({ roundIndex: 0, key: 'sk_old' });
  assert.deepEqual([r.ok, r.kind], [false, 'auth']);
  assert.equal(g.terminalKind(), 'auth');
  const blocked = await g.requestJev({ roundIndex: 1, key: 'sk_old' });
  assert.deepEqual([blocked.ok, blocked.blocked], [false, true]);
  assert.equal(g.playerChoice(0), 'pull');
  assert.equal(g.playerChoice(1), 'pull');
  // Reconnect clears the latch; resume costs nothing extra for cached state.
  g.clearTerminal();
  assert.equal(g.terminalKind(), null);
});

test('abort: in-flight loss caches nothing; choices survive', async () => {
  const hanging = () => new Promise(() => {});
  const g = createGame({ scenarios: [sc('r1')], fetchImpl: hanging });
  g.commitPlayer(0, 'pull');
  const c = new AbortController();
  const p = g.requestJev({ roundIndex: 0, key: 'sk_x', signal: c.signal });
  c.abort();
  assert.equal((await p).kind, 'aborted');
  assert.equal(g.lastResult(0, 'A'), null);
  assert.equal(g.playerChoice(0), 'pull');
  g.abort(); // generation bump is safe to call any time
});

test('swap lab: two disclosed calls, semantic comparison, per-call scoring', async () => {
  const fetchImpl = choiceFetch([{ choice: 'go' }, { choice: 'stop' }]);
  const g = createGame({ scenarios: [sc('lab', true)], fetchImpl });
  g.commitPlayer(0, 'pull');
  const r = await g.requestRound({ roundIndex: 0, key: 'sk_x' });
  assert.equal(r.ok, true);
  assert.equal(r.results.length, 2); // both orders disclosed
  assert.equal(fetchImpl.calls(), 2);
  assert.deepEqual([g.lastResult(0, 'A').action, g.lastResult(0, 'B').action], ['pull', 'hold']);
  const s = g.scoreAgreement();
  assert.deepEqual([s.agreed, s.total], [1, 2]); // player matches A only
  assert.deepEqual(s.swapConsistent, { roundIndex: 0, consistent: false });
});

test('swap lab: terminal on first order blocks the second before it spends', async () => {
  const fetchImpl = choiceFetch([{ status: 402 }]);
  const g = createGame({ scenarios: [sc('lab', true)], fetchImpl });
  g.commitPlayer(0, 'pull');
  const r = await g.requestRound({ roundIndex: 0, key: 'sk_x' });
  assert.equal(r.ok, false);
  assert.equal(r.results.length, 1); // second call never sent
  assert.equal(fetchImpl.calls(), 1);
  assert.equal(g.terminalKind(), 'budget');
});

test('score excludes unanswered rounds and unmapped Jev answers', async () => {
  const fetchImpl = choiceFetch([{ choice: 'go' }, { choice: 'weird' }]);
  const g = createGame({ scenarios: [sc('r1'), sc('r2')], fetchImpl });
  g.commitPlayer(0, 'pull'); // r2 unanswered
  await g.requestRound({ roundIndex: 0, key: 'sk_x' });
  const bad = await g.requestRound({ roundIndex: 1, key: 'sk_x' });
  assert.equal(bad.ok, false); // unmapped choice surfaces, not guessed
  const s = g.scoreAgreement();
  assert.deepEqual([s.agreed, s.total], [1, 1]);
});

test('validation: bad indexes and actions rejected', () => {
  const g = createGame({ scenarios: [sc('r1')], fetchImpl: async () => { throw new Error('must not be called'); } });
  assert.equal(g.commitPlayer(9, 'pull').ok, false);
  assert.equal(g.commitPlayer(0, 'maybe').ok, false);
  assert.equal(g.getScenario(9), null);
});
