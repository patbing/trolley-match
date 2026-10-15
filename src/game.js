// Game state machine: player-first, Jev-second. DOM-free, injected fetch.
//
// Flow per round: player commits a choice ('pull'|'hold') -> Jev is called
// live via /alpha/decisions with a typed-choice question -> reveal both +
// plain outcome -> agreement tallied (agreement with Jev, never a moral
// score). The swap-pair round calls Jev twice (orders A and B, disclosed)
// with identical facts and compares semantic actions.
//
// Replay safety: each (round, order) call has a ledger entry. A result — ok
// or failed — is cached; concurrent requests share one in-flight promise so
// a double-click can never duplicate a billable call; retry is an explicit
// caller action ({ force: true }) for failed entries only. Player choices are
// stored separately and are never cleared by call failures, aborts, or
// reconnects. Terminal kinds (auth/budget/forbidden) latch: no new calls
// until the caller resets after reconnect.

import { callDecision, JEV_ORDER_A, JEV_ORDER_B } from './jev.js';

export const GAME_ROUND_COUNT = 5;

function keyOf(roundIndex, order) {
  return `${roundIndex}:${order}`;
}

// Orders Jev must answer for a round: both for the swap lab, else just A.
export function ordersFor(scenario) {
  if (scenario && scenario.swapPair === true) return [JEV_ORDER_A, JEV_ORDER_B];
  return [JEV_ORDER_A];
}

export function isTerminalKind(kind) {
  return kind === 'auth' || kind === 'budget' || kind === 'forbidden';
}

export function createGame({
  scenarios,
  fetchImpl,
  timeoutMs,
  setTimeoutFn,
  clearTimeoutFn,
  model,
} = {}) {
  if (!Array.isArray(scenarios) || scenarios.length === 0) {
    throw new Error('game: scenarios are required');
  }
  const player = scenarios.map(() => null); // 'pull'|'hold'|null, never cleared by failures
  const results = new Map(); // keyOf -> last result object (ok or failed)
  const inFlight = new Map(); // keyOf -> shared promise
  let gen = 0; // bumped by abort(); late results from older gens are stale
  let stoppedKind = null; // latched terminal failure (first kind wins)
  const usage = { requests: 0, succeeded: 0, failed: 0 };
  const callOpts = { timeoutMs, setTimeoutFn, clearTimeoutFn, model };

  function getScenario(i) {
    return scenarios[i] || null;
  }

  function playerChoice(i) {
    return player[i] === 'pull' || player[i] === 'hold' ? player[i] : null;
  }

  // Commit (or re-commit) the player's choice for a round. Always allowed —
  // changing your mind after the reveal only updates the agreement tally,
  // never triggers a new call.
  function commitPlayer(roundIndex, action) {
    if (!Number.isInteger(roundIndex) || roundIndex < 0 || roundIndex >= scenarios.length) {
      return { ok: false, kind: 'bad-index' };
    }
    if (action !== 'pull' && action !== 'hold') {
      return { ok: false, kind: 'bad-action' };
    }
    player[roundIndex] = action;
    return { ok: true, choice: action };
  }

  function lastResult(roundIndex, order) {
    return results.get(keyOf(roundIndex, order)) || null;
  }

  function roundComplete(roundIndex) {
    const sc = scenarios[roundIndex];
    if (!sc) return false;
    return ordersFor(sc).every((o) => {
      const r = results.get(keyOf(roundIndex, o));
      return !!r && r.ok === true;
    });
  }

  async function requestJev({ roundIndex, order = JEV_ORDER_A, key, signal, force = false } = {}) {
    const sc = scenarios[roundIndex];
    if (!sc) return { ok: false, kind: 'bad-index' };
    const k = keyOf(roundIndex, order);
    const cached = results.get(k);
    if (cached && cached.ok && !force) {
      return { ...cached, fromCache: true };
    }
    if (cached && !cached.ok && !force) {
      return { ...cached, fromCache: true };
    }
    if (stoppedKind) return { ok: false, kind: stoppedKind, blocked: true };
    if (typeof key !== 'string' || key.length === 0) {
      return { ok: false, kind: 'no-key' };
    }
    if (signal && signal.aborted) return { ok: false, kind: 'aborted' };
    const inflight = inFlight.get(k);
    if (inflight) return inflight;
    const myGen = gen;
    const opts = { ...callOpts };
    const run = (async () => {
      usage.requests += 1;
      const res = await callDecision({
        fetchImpl,
        scenario: sc,
        order,
        key,
        signal,
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts.setTimeoutFn ? { setTimeoutFn: opts.setTimeoutFn } : {}),
        ...(opts.clearTimeoutFn ? { clearTimeoutFn: opts.clearTimeoutFn } : {}),
        ...(opts.model ? { model: opts.model } : {}),
      });
      if (gen !== myGen) return { ok: false, kind: 'aborted', stale: true };
      if (signal && signal.aborted) return { ok: false, kind: 'aborted' };
      if (res.ok) usage.succeeded += 1;
      else usage.failed += 1;
      const stored = { ...res, roundIndex, order, scenarioId: sc.id };
      results.set(k, stored);
      if (!res.ok && isTerminalKind(res.kind) && !stoppedKind) {
        stoppedKind = res.kind; // no auto retry, no further requests
      }
      return stored;
    })();
    inFlight.set(k, run);
    try {
      return await run;
    } finally {
      if (inFlight.get(k) === run) inFlight.delete(k);
    }
  }

  // Convenience: request every Jev order a round needs (1 normally, 2 for
  // the swap lab). Sequential — not parallel — so a terminal failure on the
  // first call blocks the second before it can spend.
  async function requestRound({ roundIndex, key, signal } = {}) {
    const sc = scenarios[roundIndex];
    if (!sc) return { ok: false, kind: 'bad-index' };
    const out = [];
    for (const order of ordersFor(sc)) {
      const r = await requestJev({ roundIndex, order, key, signal });
      out.push(r);
      if (!r.ok && isTerminalKind(r.kind)) break;
    }
    const failed = out.filter((r) => !r.ok);
    if (failed.length === 0) return { ok: true, results: out };
    return { ok: false, kind: failed[0].kind, results: out };
  }

  function abort() {
    gen += 1; // stale-guard only; cached results and player choices survive
    inFlight.clear();
  }

  // Clear the terminal latch after a reconnect. Cached results and player
  // choices are preserved — the player resumes, never restarts.
  function clearTerminal() {
    stoppedKind = null;
  }

  function terminalKind() {
    return stoppedKind;
  }

  function getUsage() {
    return { ...usage };
  }

  // Agreement with Jev over all successfully mapped Jev calls. Rounds the
  // player has not answered yet are excluded (no choice to compare). This is
  // an agreement score — Jev is the comparison subject, not the answer key.
  function scoreAgreement() {
    let agreed = 0;
    let total = 0;
    const perRound = scenarios.map((sc, i) => {
      const choice = playerChoice(i);
      const calls = ordersFor(sc).map((o) => results.get(keyOf(i, o)));
      const decided = calls.filter((r) => r && r.ok);
      if (!choice || decided.length === 0) {
        return { roundIndex: i, scenarioId: sc.id, choice, agreed: null, decided: decided.length };
      }
      let roundAgreed = 0;
      for (const r of decided) {
        total += 1;
        if (r.action === choice) {
          agreed += 1;
          roundAgreed += 1;
        }
      }
      return {
        roundIndex: i,
        scenarioId: sc.id,
        choice,
        agreed: roundAgreed === decided.length,
        agreedCalls: roundAgreed,
        decided: decided.length,
      };
    });
    // Swap-lab consistency: do Jev's two orders agree with each other?
    let swapConsistent = null;
    scenarios.forEach((sc, i) => {
      if (sc.swapPair === true) {
        const a = results.get(keyOf(i, JEV_ORDER_A));
        const b = results.get(keyOf(i, JEV_ORDER_B));
        if (a && a.ok && b && b.ok) {
          swapConsistent = { roundIndex: i, consistent: a.action === b.action };
        }
      }
    });
    return { agreed, total, perRound, swapConsistent };
  }

  function runComplete() {
    return scenarios.every((_, i) => roundComplete(i));
  }

  return {
    get size() { return scenarios.length; },
    getScenario,
    playerChoice,
    commitPlayer,
    lastResult,
    roundComplete,
    requestJev,
    requestRound,
    abort,
    clearTerminal,
    terminalKind,
    getUsage,
    scoreAgreement,
    runComplete,
  };
}
