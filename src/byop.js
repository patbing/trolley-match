// BYOP (Bring Your Own Pollen) OAuth connect — browser-only PKCE flow.
//
// DOM-free: no document/window access. Storage, randomness, hashing, time,
// and network are injected so tests run with fakes and zero network.
//
// Binding (Sol CONDITIONAL GO 2026-10-16):
//   client_id  from ./byop-config.js (publishable, public by design;
//              currently 'pk_PLACEHOLDER' until the real key for the
//              trolley-match redirect is issued)
//   redirect   https://patbing.github.io/trolley-match/ (EXACT, both steps)
//   authorize  https://enter.pollinations.ai/authorize
//   token      POST https://enter.pollinations.ai/api/oauth/token (urlencoded,
//              browser fetch allowed)
//   params     response_type=code, scope=usage, models=text, budget=5,
//              expiry=7, S256 PKCE, independent random state
// No client secret anywhere. The token never enters URLs, logs, or
// persistent browser storage — it lives only in the key vault
// (session tab-storage item or post-exchange memory fallback;
// see keyvault.js createKeyStore).
//
// Security logic copied from the model-match reference implementation
// (src/byop.js) — same guarantees, new storage namespace. Do not reinvent.

import { BYOP_CLIENT_ID, BYOP_REDIRECT_URI } from './byop-config.js';

export { BYOP_CLIENT_ID, BYOP_REDIRECT_URI };
export const BYOP_AUTHORIZE_URL = 'https://enter.pollinations.ai/authorize';
export const BYOP_TOKEN_URL = 'https://enter.pollinations.ai/api/oauth/token';
export const BYOP_RESPONSE_TYPE = 'code';
export const BYOP_SCOPE = 'usage';
export const BYOP_MODELS = 'text';
export const BYOP_BUDGET = '5';
export const BYOP_EXPIRY = '7';
// The ONE new sessionStorage item for the pending transaction. Nothing else
// in this module touches any storage.
export const BYOP_TXN_ITEM = 'trolley-match:byop-txn:v1';
// Short-lived: the transaction only needs to survive the redirect hop.
export const BYOP_TXN_MAX_AGE_MS = 10 * 60 * 1000;
// Developer earnings are an explicit opt-in only — never silently enabled.
// This flag drives the cost disclosure (see cost.js buildCostNotice).
export const BYOP_DEVELOPER_EARNINGS_ENABLED = false;

const B64URL =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

// Manual base64url (no padding): keeps this module free of btoa/atob so it
// runs identically in browsers and plain node.
export function base64UrlEncode(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  let out = '';
  let i = 0;
  for (; i + 2 < buf.length; i += 3) {
    const n = (buf[i] << 16) | (buf[i + 1] << 8) | buf[i + 2];
    out += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63] +
      B64URL[(n >> 6) & 63] + B64URL[n & 63];
  }
  const rem = buf.length - i;
  if (rem === 1) {
    const n = buf[i] << 16;
    out += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63];
  } else if (rem === 2) {
    const n = (buf[i] << 16) | (buf[i + 1] << 8);
    out += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63] +
      B64URL[(n >> 6) & 63];
  }
  return out;
}

export function defaultByopStore() {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : null;
  } catch (_) {
    return null; // storage access blocked
  }
}

// Fill `arr` in place with cryptographic randomness. Returns true on
// success, false when unavailable. Injectable: tests pass a deterministic
// filler; callers treat false as fatal (no Math.random fallback — the
// verifier and state must both be high-entropy).
export function defaultRandomFill(arr) {
  try {
    const c = globalThis.crypto;
    if (c && typeof c.getRandomValues === 'function') {
      c.getRandomValues(arr);
      return true;
    }
  } catch (_) { /* fall through */ }
  return false;
}

// SHA-256 over bytes, resolving to an ArrayBuffer. Injectable for tests.
export async function defaultDigest(data) {
  try {
    const c = globalThis.crypto;
    const subtle = c && (c.subtle || (c.webcrypto && c.webcrypto.subtle));
    if (subtle && typeof subtle.digest === 'function') {
      return await subtle.digest('SHA-256', data);
    }
  } catch (_) { /* fall through */ }
  return null;
}

function utf8Bytes(str) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
  const out = [];
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return new Uint8Array(out);
}

// Authorization URL. Takes caller-generated state + S256 challenge so the
// transaction (and its storage) stays in beginTransaction.
export function buildAuthUrl({ state, challenge }) {
  if (typeof state !== 'string' || state.length === 0) {
    throw new Error('byop: state is required');
  }
  if (typeof challenge !== 'string' || challenge.length === 0) {
    throw new Error('byop: S256 challenge is required');
  }
  const u = new URL(BYOP_AUTHORIZE_URL);
  u.searchParams.set('client_id', BYOP_CLIENT_ID);
  u.searchParams.set('redirect_uri', BYOP_REDIRECT_URI);
  u.searchParams.set('response_type', BYOP_RESPONSE_TYPE);
  u.searchParams.set('scope', BYOP_SCOPE);
  u.searchParams.set('models', BYOP_MODELS);
  u.searchParams.set('budget', BYOP_BUDGET);
  u.searchParams.set('expiry', BYOP_EXPIRY);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('state', state);
  return u.toString();
}

// Start a login: generate an independent verifier + state pair, persist the
// pending transaction (storage is verified by write+readback BEFORE the
// caller navigates), and return the authorization URL. On any failure the
// caller must NOT navigate — an in-memory verifier cannot survive the
// full-page redirect, so storage failure is a safe, explained stop.
export async function beginTransaction({
  storage = undefined,
  randomFill = defaultRandomFill,
  digest = defaultDigest,
  now = Date.now,
} = {}) {
  const store = storage === undefined ? defaultByopStore() : storage;
  if (!store) return { ok: false, reason: 'storage' };
  const vBytes = new Uint8Array(32);
  const sBytes = new Uint8Array(16);
  let rndOk = false;
  try {
    rndOk = randomFill(vBytes) !== false && randomFill(sBytes) !== false;
  } catch (_) {
    rndOk = false;
  }
  if (!rndOk) return { ok: false, reason: 'random' };
  const verifier = base64UrlEncode(vBytes);
  const state = base64UrlEncode(sBytes);
  if (!verifier || !state || verifier === state) {
    return { ok: false, reason: 'random' };
  }
  let challenge = null;
  try {
    const sum = await digest(utf8Bytes(verifier));
    if (sum) challenge = base64UrlEncode(new Uint8Array(sum));
  } catch (_) {
    challenge = null;
  }
  if (!challenge) return { ok: false, reason: 'crypto' };
  let url = null;
  try {
    url = buildAuthUrl({ state, challenge });
  } catch (_) {
    return { ok: false, reason: 'url' };
  }
  const txn = {
    v: 1,
    verifier,
    state,
    createdAt: now(),
    action: 'start-trolley',
  };
  try {
    const raw = JSON.stringify(txn);
    store.setItem(BYOP_TXN_ITEM, raw);
    if (store.getItem(BYOP_TXN_ITEM) !== raw) {
      try { store.removeItem(BYOP_TXN_ITEM); } catch (_) { /* ignore */ }
      return { ok: false, reason: 'storage' };
    }
  } catch (_) {
    return { ok: false, reason: 'storage' };
  }
  return { ok: true, url, state };
}

// Parse a callback query string (with or without leading '?'). Duplicate
// code/state/error parameters mark the callback malformed.
export function parseCallback(search) {
  const q = typeof search === 'string' && search.startsWith('?')
    ? search.slice(1)
    : (search || '');
  let sp;
  try {
    sp = new URLSearchParams(q);
  } catch (_) {
    return {
      present: false, duplicated: false, code: null, state: null,
      error: null, errorDescription: null,
    };
  }
  const codes = sp.getAll('code');
  const states = sp.getAll('state');
  const errors = sp.getAll('error');
  return {
    present: codes.length > 0 || states.length > 0 || errors.length > 0,
    duplicated: codes.length > 1 || states.length > 1 || errors.length > 1,
    code: codes.length > 0 ? codes[0] : null,
    state: states.length > 0 ? states[0] : null,
    error: errors.length > 0 ? errors[0] : null,
    errorDescription: sp.get('error_description'),
  };
}

// Validate a captured callback against the pending transaction and consume
// the transaction (delete) BEFORE the caller exchanges the code: reloads,
// replays, and duplicate initializations can never yield a second exchange.
// The transaction is also deleted on every failure path where one existed,
// so stale data never lingers.
export function claimCallbackTransaction({
  params,
  storage = undefined,
  now = Date.now,
} = {}) {
  const store = storage === undefined ? defaultByopStore() : storage;
  if (!store) return { ok: false, kind: 'storage' };
  let raw = null;
  try {
    raw = store.getItem(BYOP_TXN_ITEM);
  } catch (_) {
    return { ok: false, kind: 'storage' };
  }
  let txn = null;
  try {
    txn = raw ? JSON.parse(raw) : null;
  } catch (_) {
    txn = null;
  }
  try {
    if (store.removeItem) store.removeItem(BYOP_TXN_ITEM);
  } catch (_) { /* already failing closed */ }
  if (!txn || typeof txn !== 'object') return { ok: false, kind: 'no-txn' };
  if (!params || typeof params !== 'object') return { ok: false, kind: 'missing' };
  if (params.error) return { ok: false, kind: 'denied', error: params.error };
  if (params.duplicated) return { ok: false, kind: 'duplicate' };
  if (typeof params.code !== 'string' || params.code.length === 0) {
    return { ok: false, kind: 'missing' };
  }
  if (typeof txn.verifier !== 'string' || txn.verifier.length === 0 ||
      typeof txn.state !== 'string' || txn.state.length === 0) {
    return { ok: false, kind: 'missing' };
  }
  if (typeof params.state !== 'string' || params.state !== txn.state) {
    return { ok: false, kind: 'mismatch' };
  }
  const createdAt = Number(txn.createdAt);
  const age = now() - createdAt;
  if (!Number.isFinite(createdAt) || age < 0 || age > BYOP_TXN_MAX_AGE_MS) {
    return { ok: false, kind: 'stale' };
  }
  return { ok: true, code: params.code, verifier: txn.verifier };
}

// Exchange an authorization code for a token. Exact urlencoded body,
// exact redirect_uri, publishable client_id, code_verifier — and no client
// secret field. The token is returned to the caller for the key vault;
// it is never placed in a URL or logged here.
export async function exchangeCode({
  code,
  verifier,
  fetchImpl,
  now = Date.now,
} = {}) {
  if (typeof code !== 'string' || code.length === 0 ||
      typeof verifier !== 'string' || verifier.length === 0) {
    return { ok: false, reason: 'missing' };
  }
  if (typeof fetchImpl !== 'function') return { ok: false, reason: 'missing' };
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: BYOP_REDIRECT_URI,
    client_id: BYOP_CLIENT_ID,
    code_verifier: verifier,
  }).toString();
  let res = null;
  try {
    res = await fetchImpl(BYOP_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      redirect: 'error',
    });
  } catch (_) {
    return { ok: false, reason: 'network' };
  }
  if (!res || !res.ok) {
    return { ok: false, reason: 'exchange-failed', status: res ? res.status : 0 };
  }
  let payload = null;
  try {
    payload = await res.json();
  } catch (_) {
    return { ok: false, reason: 'malformed' };
  }
  const token = payload &&
    (typeof payload.access_token === 'string' ? payload.access_token
      : typeof payload.accessToken === 'string' ? payload.accessToken : null);
  if (!token) return { ok: false, reason: 'malformed' };
  const expiresInRaw = payload
    ? (payload.expires_in !== undefined ? payload.expires_in : payload.expiresIn)
    : undefined;
  const expiresInNum = Number(expiresInRaw);
  const expiresInSec = Number.isFinite(expiresInNum) && expiresInNum > 0
    ? Math.floor(expiresInNum)
    : null;
  return { ok: true, ...createTokenRecord({ token, expiresInSec, now }) };
}

// Token lifetime record. expiresAt is a ms epoch or null when the provider
// returned no usable expiry — usable-until-proven-otherwise, with
// authentication failures still clearing the token via the normal path.
export function createTokenRecord({ token, expiresInSec = null, now = Date.now } = {}) {
  const at = Number.isFinite(expiresInSec) && expiresInSec > 0
    ? now() + Math.floor(expiresInSec) * 1000
    : null;
  return { token, expiresAt: at, obtainedAt: now() };
}

export function tokenExpired(record, now = Date.now) {
  if (!record || record.expiresAt === null || record.expiresAt === undefined) {
    return false;
  }
  return now() >= record.expiresAt;
}

export function tokenUsable(record, now = Date.now) {
  return !!record && typeof record.token === 'string' &&
    record.token.length > 0 && !tokenExpired(record, now);
}

// Explicit cleanup: drop the pending transaction (Disconnect path and
// failure paths). Never throws.
export function clearTransaction(storage = undefined) {
  const store = storage === undefined ? defaultByopStore() : storage;
  if (!store) return;
  try {
    store.removeItem(BYOP_TXN_ITEM);
  } catch (_) { /* ignore */ }
}
