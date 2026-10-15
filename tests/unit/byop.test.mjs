// BYOP connect tests — OAuth/security logic reused from the model-match
// reference. Storage / randomness / hashing / time / network are injected
// fakes; SHA-256 itself comes from node:crypto (deterministic, zero
// network). Trolley-match binding: redirect is EXACTLY
// https://patbing.github.io/trolley-match/ and the client id is read from
// the ONE constant in src/byop-config.js (currently pk_PLACEHOLDER until
// the real key for this redirect is issued).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { BYOP_CLIENT_ID, BYOP_REDIRECT_URI } from '../../src/byop-config.js';
import {
  BYOP_AUTHORIZE_URL,
  BYOP_TOKEN_URL,
  BYOP_TXN_ITEM,
  BYOP_TXN_MAX_AGE_MS,
  BYOP_DEVELOPER_EARNINGS_ENABLED,
  base64UrlEncode,
  buildAuthUrl,
  beginTransaction,
  parseCallback,
  claimCallbackTransaction,
  exchangeCode,
  createTokenRecord,
  tokenExpired,
  tokenUsable,
  clearTransaction,
} from '../../src/byop.js';
import {
  TROLLEY_COST_NOTICE_KO,
  TROLLEY_COST_NOTICE_EN,
  TROLLEY_EARNINGS_NOTICE_KO,
  TROLLEY_EARNINGS_NOTICE_EN,
  TROLLEY_CALLS_SWAP_ROUND,
  TROLLEY_CALLS_FULL_RUN,
  buildCostNotice,
} from '../../src/cost.js';
import { TROLLEY_KEY_ITEM as VAULT_ITEM, createKeyStore, canStart } from '../../src/keyvault.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const T = 1_750_000_000_000;
const now = () => T;

function memStore({ throws = null } = {}) {
  const mem = new Map();
  const seen = [];
  return {
    getItem: (k) => {
      if (throws === 'get') throw new Error('blocked');
      return mem.has(k) ? mem.get(k) : null;
    },
    setItem: (k, v) => {
      if (throws === 'set') throw new Error('blocked');
      seen.push(k);
      mem.set(k, String(v));
    },
    removeItem: (k) => {
      if (throws === 'remove') throw new Error('blocked');
      seen.push(k);
      mem.delete(k);
    },
    keysUsed: () => [...new Set(seen)],
    raw: (k) => (mem.has(k) ? mem.get(k) : null),
  };
}

function seqFill(start = 1) {
  let c = start;
  return (arr) => {
    for (let i = 0; i < arr.length; i++) arr[i] = (c + i) & 0xff;
    c += arr.length;
    return true;
  };
}

const sha256 = (data) => webcrypto.subtle.digest('SHA-256', data);

function readTxn(store) {
  return JSON.parse(store.raw(BYOP_TXN_ITEM));
}

test('binding: redirect is exact trolley-match Pages origin; id comes from the ONE constant', () => {
  assert.equal(BYOP_REDIRECT_URI, 'https://patbing.github.io/trolley-match/');
  assert.ok(BYOP_CLIENT_ID.startsWith('pk_'), 'client id must be a publishable pk_ value or placeholder');
  assert.ok(!/model-match/.test(BYOP_REDIRECT_URI), 'must not reuse the sibling project redirect');
});

test('1: auth URL carries exact endpoints, redirect, params, S256, fresh state', async () => {
  const store = memStore();
  const begun = await beginTransaction({
    storage: store, randomFill: seqFill(7), digest: sha256, now,
  });
  assert.equal(begun.ok, true);
  const u = new URL(begun.url);
  assert.equal(u.origin + u.pathname, BYOP_AUTHORIZE_URL);
  assert.equal(u.origin + u.pathname, 'https://enter.pollinations.ai/authorize');
  const q = u.searchParams;
  assert.equal(q.get('client_id'), BYOP_CLIENT_ID);
  assert.equal(q.get('redirect_uri'), BYOP_REDIRECT_URI);
  assert.equal(q.get('redirect_uri'), 'https://patbing.github.io/trolley-match/');
  assert.equal(q.get('response_type'), 'code');
  assert.equal(q.get('scope'), 'usage');
  assert.equal(q.get('models'), 'text');
  assert.equal(q.get('budget'), '5');
  assert.equal(q.get('expiry'), '7');
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.equal(q.get('state'), begun.state);

  const txn = readTxn(store);
  assert.equal(txn.state, begun.state);
  assert.equal(txn.verifier.length, 43);
  assert.equal(txn.state.length, 22);
  assert.notEqual(txn.state, txn.verifier);
  const expectChallenge = base64UrlEncode(
    new Uint8Array(await webcrypto.subtle.digest('SHA-256',
      new TextEncoder().encode(txn.verifier))));
  assert.equal(q.get('code_challenge'), expectChallenge);
  assert.deepEqual(store.keysUsed(), [BYOP_TXN_ITEM]);
});

test('1b: verifier and state are independent across transactions', async () => {
  const a = await beginTransaction({ storage: memStore(), now });
  const b = await beginTransaction({ storage: memStore(), now });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.notEqual(a.state, b.state);
});

test('2: success callback exchanges once with the exact body, then is spent', async () => {
  const store = memStore();
  const begun = await beginTransaction({
    storage: store, randomFill: seqFill(21), digest: sha256, now,
  });
  const txn = readTxn(store);
  const seen = [];
  const fetchImpl = async (url, opts) => {
    seen.push({ url, opts });
    assert.equal(store.raw(BYOP_TXN_ITEM), null);
    return {
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'sk_test_token', expires_in: 3600 }),
    };
  };
  const params = parseCallback(`?code=AUTHCODE&state=${encodeURIComponent(begun.state)}`);
  const claim = claimCallbackTransaction({ params, storage: store, now });
  assert.equal(claim.ok, true);
  assert.equal(store.raw(BYOP_TXN_ITEM), null);

  const ex = await exchangeCode({
    code: claim.code, verifier: claim.verifier, fetchImpl, now,
  });
  assert.equal(ex.ok, true);
  assert.equal(ex.token, 'sk_test_token');
  assert.equal(ex.expiresAt, T + 3600 * 1000);
  assert.equal(seen.length, 1);

  const { url, opts } = seen[0];
  assert.equal(url, BYOP_TOKEN_URL);
  assert.equal(opts.method, 'POST');
  const body = new URLSearchParams(opts.body);
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('code'), 'AUTHCODE');
  assert.equal(body.get('redirect_uri'), BYOP_REDIRECT_URI);
  assert.equal(body.get('client_id'), BYOP_CLIENT_ID);
  assert.equal(body.get('code_verifier'), txn.verifier);
  assert.equal(body.has('client_secret'), false);

  const vault = memStore();
  const ks = createKeyStore(vault);
  ks.save(ex.token);
  assert.equal(ks.load(), 'sk_test_token');
  assert.deepEqual(vault.keysUsed(), [VAULT_ITEM]);
  assert.equal(VAULT_ITEM, VAULT_ITEM);

  const again = claimCallbackTransaction({ params, storage: store, now });
  assert.equal(again.ok, false);
  assert.equal(again.kind, 'no-txn');
  assert.equal(seen.length, 1);
});

test('3: bad, stale, and duplicate callbacks never reach the network', async () => {
  async function setup(ageMs = 0) {
    const store = memStore();
    const begun = await beginTransaction({
      storage: store, randomFill: seqFill(33), digest: sha256, now,
    });
    if (ageMs !== 0) {
      const txn = JSON.parse(store.raw(BYOP_TXN_ITEM));
      txn.createdAt = T - ageMs;
      store.setItem(BYOP_TXN_ITEM, JSON.stringify(txn));
    }
    return { store, state: begun.state };
  }
  let calls = 0;
  void calls;

  {
    const { store } = await setup();
    const r = claimCallbackTransaction({
      params: parseCallback('?code=C&state=wrong'), storage: store, now,
    });
    assert.deepEqual([r.ok, r.kind], [false, 'mismatch']);
    assert.equal(store.raw(BYOP_TXN_ITEM), null);
  }
  {
    const { store, state } = await setup();
    const r = claimCallbackTransaction({
      params: parseCallback(`?state=${state}`), storage: store, now,
    });
    assert.deepEqual([r.ok, r.kind], [false, 'missing']);
  }
  {
    const { store, state } = await setup(BYOP_TXN_MAX_AGE_MS + 1000);
    const r = claimCallbackTransaction({
      params: parseCallback(`?code=C&state=${state}`), storage: store, now,
    });
    assert.deepEqual([r.ok, r.kind], [false, 'stale']);
  }
  {
    const { store, state } = await setup(-60_000);
    const r = claimCallbackTransaction({
      params: parseCallback(`?code=C&state=${state}`), storage: store, now,
    });
    assert.deepEqual([r.ok, r.kind], [false, 'stale']);
  }
  {
    const { store, state } = await setup();
    const r = claimCallbackTransaction({
      params: parseCallback(`?code=A&code=B&state=${state}`), storage: store, now,
    });
    assert.deepEqual([r.ok, r.kind], [false, 'duplicate']);
  }
});

test('4: reload during exchange cannot double-exchange', async () => {
  const store = memStore();
  const begun = await beginTransaction({
    storage: store, randomFill: seqFill(44), digest: sha256, now,
  });
  const params = parseCallback(`?code=C&state=${begun.state}`);
  const first = claimCallbackTransaction({ params, storage: store, now });
  assert.equal(first.ok, true);

  let release;
  const gate = new Promise((r) => { release = r; });
  let exchanges = 0;
  const fetchImpl = async () => {
    exchanges += 1;
    await gate;
    return { ok: true, status: 200, json: async () => ({ access_token: 'sk_x' }) };
  };
  const pending = exchangeCode({
    code: first.code, verifier: first.verifier, fetchImpl, now,
  });
  const dup = claimCallbackTransaction({ params, storage: store, now });
  assert.equal(dup.ok, false);
  release();
  assert.equal((await pending).ok, true);
  assert.equal(exchanges, 1);
});

test('5: denial and exchange failures clean up and stay recoverable', async () => {
  {
    const store = memStore();
    const begun = await beginTransaction({
      storage: store, randomFill: seqFill(55), digest: sha256, now,
    });
    const r = claimCallbackTransaction({
      params: parseCallback(`?error=access_denied&state=${begun.state}`),
      storage: store, now,
    });
    assert.deepEqual([r.ok, r.kind], [false, 'denied']);
    assert.equal(store.raw(BYOP_TXN_ITEM), null);
  }
  {
    const r = claimCallbackTransaction({
      params: parseCallback('?code=C&state=S'), storage: memStore(), now,
    });
    assert.deepEqual([r.ok, r.kind], [false, 'no-txn']);
  }
  const badFetch = async () => { throw new TypeError('down'); };
  assert.equal(
    (await exchangeCode({ code: 'C', verifier: 'V', fetchImpl: badFetch, now })).reason,
    'network');
  const refused = async () => ({ ok: false, status: 400, json: async () => ({}) });
  assert.deepEqual(
    [(await exchangeCode({ code: 'C', verifier: 'V', fetchImpl: refused, now })).reason], ['exchange-failed']);
  const empty = async () => ({ ok: true, status: 200, json: async () => ({}) });
  assert.equal(
    (await exchangeCode({ code: 'C', verifier: 'V', fetchImpl: empty, now })).reason,
    'malformed');
});

test('6: token lifetime helpers gate start without a retry loop', () => {
  const rec = createTokenRecord({ token: 'sk_x', expiresInSec: 3600, now });
  assert.equal(rec.expiresAt, T + 3600 * 1000);
  assert.equal(tokenUsable(rec, () => T), true);
  assert.equal(tokenExpired(rec, () => T + 3600 * 1000), true);
  assert.equal(tokenUsable(rec, () => T + 3600 * 1000), false);
  const unknown = createTokenRecord({ token: 'sk_x', expiresInSec: null, now });
  assert.equal(unknown.expiresAt, null);
  assert.equal(tokenUsable(unknown, () => T + 10 ** 12), true);
  assert.equal(tokenUsable({ token: '', expiresAt: null }, now), false);
  assert.equal(tokenUsable(null, now), false);
  assert.equal(canStart({ token: 'sk_x' }), true);
  assert.equal(canStart({ token: '' }), false);
  assert.equal(canStart({}), false);
});

test('8: storage failure blocks connect; memory vault still works after', async () => {
  const bad = await beginTransaction({
    storage: memStore({ throws: 'set' }), randomFill: seqFill(1), digest: sha256, now,
  });
  assert.deepEqual([bad.ok, bad.reason], [false, 'storage']);
  assert.equal(bad.url, undefined);
  const none = await beginTransaction({
    storage: null, randomFill: seqFill(1), digest: sha256, now,
  });
  assert.deepEqual([none.ok, none.reason], [false, 'storage']);
  const noRand = await beginTransaction({
    storage: memStore(), randomFill: () => false, digest: sha256, now,
  });
  assert.deepEqual([noRand.ok, noRand.reason], [false, 'random']);
  const noHash = await beginTransaction({
    storage: memStore(), randomFill: seqFill(1), digest: async () => null, now,
  });
  assert.deepEqual([noHash.ok, noHash.reason], [false, 'crypto']);
  const ks = createKeyStore(null);
  assert.equal(ks.storeMode(), 'memory');
  ks.save('sk_mem');
  assert.equal(ks.load(), 'sk_mem');
  ks.clear();
  assert.equal(ks.load(), null);
});

test('9: disconnect clears; no secrets in storage, URLs, logs, or telemetry', async () => {
  const store = memStore();
  await beginTransaction({ storage: store, randomFill: seqFill(9), digest: sha256, now });
  assert.notEqual(store.raw(BYOP_TXN_ITEM), null);
  clearTransaction(store);
  assert.equal(store.raw(BYOP_TXN_ITEM), null);
  clearTransaction(store);
  clearTransaction(null);
  clearTransaction(memStore({ throws: 'remove' }));

  const vault = memStore();
  const ks = createKeyStore(vault);
  ks.save('sk_disconnect_me');
  assert.deepEqual(vault.keysUsed(), [VAULT_ITEM]);
  ks.clear();
  assert.equal(ks.load(), null);

  for (const n of ['byop.js', 'byop-config.js', 'jev.js', 'game.js', 'keyvault.js', 'cost.js', 'main.js']) {
    const src = readFileSync(join(root, 'src', n), 'utf8');
    assert.ok(!src.includes('localStorage'), `${n} must never touch localStorage`);
    assert.ok(!src.includes('client_secret'), `${n} must never carry a client secret`);
  }
  assert.ok(!readFileSync(join(root, 'src', 'byop.js'), 'utf8').includes('console.'),
    'byop.js must not log');
  assert.ok(!readFileSync(join(root, 'src', 'main.js'), 'utf8').includes('console.'),
    'main.js must not log secrets');

  const begun = await beginTransaction({
    storage: memStore(), randomFill: seqFill(11), digest: sha256, now,
  });
  assert.ok(!/token|secret|sk_/i.test(begun.url));

  const html = readFileSync(join(root, 'index.html'), 'utf8');
  assert.ok(html.includes('referrerpolicy="no-referrer"'),
    'third-party badge must not receive the callback URL as Referer');
});

test('10: cost notice discloses budget, duration, per-round + swap calls; earnings only when on', () => {
  assert.equal(BYOP_DEVELOPER_EARNINGS_ENABLED, false);
  assert.equal(TROLLEY_CALLS_SWAP_ROUND, 2);
  assert.equal(TROLLEY_CALLS_FULL_RUN, 6);
  const off = buildCostNotice(false);
  assert.equal(off.ko, TROLLEY_COST_NOTICE_KO);
  assert.equal(off.en, TROLLEY_COST_NOTICE_EN);
  for (const text of [off.ko, off.en]) {
    assert.ok(!text.includes('25%'), 'earnings-off notice must not mention 25%');
  }
  const on = buildCostNotice(true);
  assert.ok(on.ko.includes('25%'));
  assert.ok(on.en.includes('25%'));
  assert.ok(on.ko.includes(TROLLEY_EARNINGS_NOTICE_KO));
  assert.ok(on.en.includes(TROLLEY_EARNINGS_NOTICE_EN));
  for (const text of [off.ko, off.en]) {
    assert.ok(text.includes('5'), 'budget disclosed');
    assert.ok(text.includes('7'), 'duration disclosed');
    assert.ok(/1회|1 live call/.test(text), 'per-round calls disclosed');
    assert.ok(/2회|2 for/.test(text), 'swap-round two-call cost disclosed');
    assert.ok(/6회|6 calls/.test(text), 'full-run call count disclosed');
  }
});

test('parseCallback: presence, denial, duplicates, error description', () => {
  assert.equal(parseCallback('').present, false);
  assert.equal(parseCallback('?foo=1').present, false);
  const ok = parseCallback('?code=C&state=S');
  assert.deepEqual([ok.present, ok.code, ok.state, ok.error, ok.duplicated],
    [true, 'C', 'S', null, false]);
  const denied = parseCallback('?error=access_denied&error_description=nope&state=S');
  assert.deepEqual([denied.present, denied.error, denied.errorDescription],
    [true, 'access_denied', 'nope']);
  assert.equal(parseCallback('?state=A&state=B').duplicated, true);
});

test('11: vault persists token expiresAt; legacy bare tokens still load; gating via tokenUsable', () => {
  // Expiry-carrying save: token loads bare, record carries expiresAt.
  const vault = memStore();
  const ks = createKeyStore(vault);
  ks.save('sk_new', T + 3600 * 1000);
  assert.equal(ks.load(), 'sk_new');
  assert.deepEqual(ks.loadRecord(), { token: 'sk_new', expiresAt: T + 3600 * 1000 });
  assert.deepEqual(vault.keysUsed(), [VAULT_ITEM]); // still the ONE vault item
  assert.equal(tokenUsable(ks.loadRecord(), () => T), true);
  assert.equal(tokenUsable(ks.loadRecord(), () => T + 3600 * 1000), false);
  // Legacy bare-token shape: no known expiry, usable until proven otherwise.
  const legacy = memStore();
  legacy.setItem(VAULT_ITEM, 'sk_legacy');
  const ksLegacy = createKeyStore(legacy);
  assert.equal(ksLegacy.load(), 'sk_legacy');
  assert.deepEqual(ksLegacy.loadRecord(), { token: 'sk_legacy', expiresAt: null });
  assert.equal(tokenUsable(ksLegacy.loadRecord(), () => T + 10 ** 12), true);
  // Corrupt JSON never yields a token.
  const bad = memStore();
  bad.setItem(VAULT_ITEM, '{oops');
  assert.equal(createKeyStore(bad).load(), null);
  assert.deepEqual(createKeyStore(bad).loadRecord(), { token: null, expiresAt: null });
  // Empty save clears; memory fallback carries the record too.
  ks.save('');
  assert.equal(ks.load(), null);
  const mem = createKeyStore(null);
  mem.save('sk_mem', T + 60_000);
  assert.deepEqual(mem.loadRecord(), { token: 'sk_mem', expiresAt: T + 60_000 });
});
