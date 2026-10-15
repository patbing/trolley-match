// Jev live-call client: POST /alpha/decisions. DOM-free, injected fetch.
//
// API-CONTRACT NOTE (code-derived from this repo's own tooling + live-verified
// 2026-10-12 by the sibling project, NOT re-verified from this browser app):
//   endpoint  POST https://gen.pollinations.ai/alpha/decisions
//   auth      Authorization: Bearer <sk_> (BYOP-issued, budget-capped)
//   body      { model, state, questions: { <key>: { type, instructions,
//             criteria: { <choiceKey>: <description> } } } }
//   response  { answers: { <key>: { choice, confidence, ... } },
//               usage: { input_tokens, output_tokens }, model }
//   cost      ~= $0.00002 per call for the default `jev` alias (Oct 2026;
//             billed to the player's own Pollen, never to the developer).
// The /alpha/ prefix means the schema can change — parse defensively and
// surface unmapped choices honestly instead of guessing.

export const JEV_ENDPOINT = 'https://gen.pollinations.ai/alpha/decisions';
export const JEV_MODEL = 'jev';
export const JEV_TIMEOUT_MS = 60000;
export const JEV_QUESTION_KEY = 'decision';

// Orders for the swap lab. 'A' presents actionA first, 'B' presents actionB
// first. Facts are byte-identical in both — only presentation order changes.
export const JEV_ORDER_A = 'A';
export const JEV_ORDER_B = 'B';

function actionByEffect(scenario, effect) {
  if (!scenario) return null;
  for (const slot of ['actionA', 'actionB']) {
    const a = scenario[slot];
    if (a && a.effect === effect) return a;
  }
  return null;
}

// Build one typed-choice decision request for a scenario. The criteria
// descriptions are derived from the scenario's own action texts, bound to the
// semantic pull/hold keys — so the returned choice maps by meaning, never by
// option index. Returns the fetch args plus the exact prompt for the
// inspector (show the user exactly what Jev saw).
export function buildDecisionRequest(scenario, { order = JEV_ORDER_A, model = JEV_MODEL } = {}) {
  if (!scenario || typeof scenario !== 'object') throw new Error('jev: scenario is required');
  const pull = actionByEffect(scenario, 'pull');
  const hold = actionByEffect(scenario, 'hold');
  if (!pull || !hold) throw new Error('jev: scenario needs one pull and one hold action');
  const pullKey = scenario.jev && scenario.jev.pullKey;
  const holdKey = scenario.jev && scenario.jev.holdKey;
  if (typeof pullKey !== 'string' || !pullKey || typeof holdKey !== 'string' || !holdKey) {
    throw new Error('jev: scenario needs distinct pullKey/holdKey');
  }
  if (pullKey === holdKey) throw new Error('jev: pullKey and holdKey must differ');
  const instructions = (scenario.jev && scenario.jev.instructions) || 'Decide what to do.';
  const facts = typeof scenario.facts === 'string' ? scenario.facts : '';
  const lineFor = (a) => `- ${a.label}: ${a.text}`;
  const first = order === JEV_ORDER_B ? hold : pull;
  const second = order === JEV_ORDER_B ? pull : hold;
  const state = `${facts}\n\nThe available actions are:\n${lineFor(first)}\n${lineFor(second)}`;
  // Criteria insertion order follows presentation order (JSON preserves it).
  // Descriptions are keyed by semantic action, so swapping order never
  // changes what each key means.
  const firstKey = first === pull ? pullKey : holdKey;
  const secondKey = second === pull ? pullKey : holdKey;
  const questions = {
    [JEV_QUESTION_KEY]: {
      type: 'choice',
      instructions,
      criteria: {
        [firstKey]: first === pull ? pull.text : hold.text,
        [secondKey]: second === pull ? pull.text : hold.text,
      },
    },
  };
  const body = { model, state, questions };
  return {
    url: JEV_ENDPOINT,
    options: {
      method: 'POST',
      headers: {
        Authorization: 'Bearer REPLACE_WITH_KEY',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
    prompt: { model, state, questions },
    meta: { scenarioId: scenario.id, order, pullKey, holdKey, firstKey, secondKey },
  };
}

// Fill the Authorization header with the real key at send time. The request
// builder above never sees the key, so prompts/options logged or inspected
// never carry it.
export function authorizeRequest(built, key, extra = {}) {
  if (!built || !built.options) throw new Error('jev: built request is required');
  if (typeof key !== 'string' || key.length === 0) throw new Error('jev: key is required');
  return {
    url: built.url,
    options: {
      ...built.options,
      headers: {
        ...built.options.headers,
        Authorization: 'Bearer ' + key,
      },
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      redirect: 'error',
      ...extra,
    },
  };
}

export function isAllowedJevUrl(url) {
  return url === JEV_ENDPOINT;
}

// Map a decisions response to a semantic player action. The choice string is
// compared against the scenario's pull/hold keys — never against an option
// index. Anything else (missing answers, unknown choice) is an honest
// failure the UI surfaces, not a guess.
export function parseDecision(payload, scenario) {
  if (!scenario || !scenario.jev) return { ok: false, kind: 'unmapped', choice: null };
  const { pullKey, holdKey } = scenario.jev;
  const ans = payload && typeof payload === 'object'
    ? payload.answers && payload.answers[JEV_QUESTION_KEY]
    : null;
  const choice = ans && typeof ans.choice === 'string' ? ans.choice : null;
  if (choice === pullKey) {
    return { ok: true, action: 'pull', choice, confidence: confidenceOf(ans) };
  }
  if (choice === holdKey) {
    return { ok: true, action: 'hold', choice, confidence: confidenceOf(ans) };
  }
  return { ok: false, kind: 'unmapped', choice };
}

function confidenceOf(ans) {
  const c = ans && ans.confidence;
  return typeof c === 'number' && Number.isFinite(c) ? c : null;
}

export function errorKindForStatus(status) {
  if (status === 401) return 'auth';
  if (status === 402) return 'budget'; // spending/budget failure: stop, no retry
  if (status === 403) return 'forbidden'; // permissions restriction: reconnect path
  if (status === 429) return 'rate';
  return 'retryable';
}

// Best-effort provider error detail for 403 responses. Strings only,
// truncated — the returned object never contains the key.
async function providerDetailOf(res) {
  try {
    const payload = res && typeof res.json === 'function' ? await res.json() : null;
    const err = payload && payload.error;
    const text = typeof err === 'string' ? err
      : err && typeof err.message === 'string' ? err.message
      : err && typeof err.code === 'string' ? err.code
      : (payload && typeof payload.message === 'string' ? payload.message : null);
    if (typeof text !== 'string' || text.trim().length === 0) return null;
    return text.trim().slice(0, 200);
  } catch (_) {
    return null;
  }
}

// One scenario, one order, one attempt. NEVER retries internally — retry is an
// explicit user action at the round level. Returned objects never contain
// the key. Caller abort and an internal timeout both win over a hung fetch
// via Promise.race (a fetch that ignores its signal still loses).
export async function callDecision({
  fetchImpl,
  scenario,
  order = JEV_ORDER_A,
  model = JEV_MODEL,
  key,
  signal,
  timeoutMs = JEV_TIMEOUT_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}) {
  if (typeof key !== 'string' || key.length === 0) {
    return { ok: false, kind: 'no-key' };
  }
  if (typeof fetchImpl !== 'function') {
    return { ok: false, kind: 'missing-fetch' };
  }
  let built;
  try {
    built = buildDecisionRequest(scenario, { order, model });
  } catch (_) {
    return { ok: false, kind: 'bad-scenario' };
  }
  if (!isAllowedJevUrl(built.url)) {
    return { ok: false, kind: 'misdirect' };
  }
  const { url, options: reqOptions } = authorizeRequest(built, key);
  const ctrl = new AbortController();
  let timedOut = false;
  const onParentAbort = () => {
    try { ctrl.abort(signal && signal.reason !== undefined ? signal.reason : undefined); } catch (_) { /* ignore */ }
  };
  if (signal) {
    if (signal.aborted) {
      return { ok: false, kind: 'aborted' };
    }
    signal.addEventListener('abort', onParentAbort, { once: true });
  }
  const timer = setTimeoutFn(() => {
    timedOut = true;
    try { ctrl.abort(new Error('jev-timeout')); } catch (_) { /* ignore */ }
  }, timeoutMs);
  let onCtrlAbort = null;
  const abortFired = new Promise((_, reject) => {
    onCtrlAbort = () => {
      const e = new Error('jev-aborted');
      e.name = 'AbortError';
      reject(e);
    };
    ctrl.signal.addEventListener('abort', onCtrlAbort, { once: true });
  });
  // Silences unhandled-rejection noise when the fetch itself wins the race.
  abortFired.catch(() => {});
  try {
    const res = await Promise.race([
      fetchImpl(url, { ...reqOptions, signal: ctrl.signal }),
      abortFired,
    ]);
    if (signal && signal.aborted) return { ok: false, kind: 'aborted' };
    if (ctrl.signal.aborted) {
      return { ok: false, kind: timedOut ? 'timeout' : 'aborted' };
    }
    const status = res ? res.status : 0;
    if (status === 401) return { ok: false, kind: 'auth', status };
    if (status === 402) return { ok: false, kind: 'budget', status };
    if (status === 403) {
      return {
        ok: false, kind: 'forbidden', status,
        detail: await providerDetailOf(res),
      };
    }
    if (status === 429) return { ok: false, kind: 'retryable', status, rate: true };
    if (!res || !res.ok) return { ok: false, kind: 'retryable', status };
    let payload = null;
    try {
      payload = await res.json();
    } catch (_) {
      return { ok: false, kind: 'retryable', status };
    }
    const parsed = parseDecision(payload, scenario);
    if (!parsed.ok) {
      return { ok: false, kind: parsed.kind, status, choice: parsed.choice };
    }
    const out = {
      ok: true,
      action: parsed.action,
      choice: parsed.choice,
      confidence: parsed.confidence,
      order,
      scenarioId: scenario.id,
      status,
    };
    if (payload && payload.usage && typeof payload.usage === 'object') {
      out.usage = payload.usage;
    }
    return out;
  } catch (err) {
    if (signal && signal.aborted) return { ok: false, kind: 'aborted' };
    if (timedOut) return { ok: false, kind: 'timeout' };
    if (ctrl.signal.aborted) return { ok: false, kind: 'aborted' };
    if (err && err.name === 'TimeoutError') return { ok: false, kind: 'timeout' };
    return { ok: false, kind: 'network' };
  } finally {
    try { clearTimeoutFn(timer); } catch (_) { /* ignore */ }
    if (signal) {
      try { signal.removeEventListener('abort', onParentAbort); } catch (_) { /* ignore */ }
    }
    if (onCtrlAbort) {
      try { ctrl.signal.removeEventListener('abort', onCtrlAbort); } catch (_) { /* ignore */ }
    }
  }
}
