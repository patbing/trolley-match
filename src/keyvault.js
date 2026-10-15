// Single-item session vault for the BYOP-issued token.
// Copied guarantees from the model-match reference (fresh.js createKeyStore):
// one session tab-storage item only, in-memory fallback when tab storage is
// unavailable or blocked, never written anywhere else.
//
// The stored value is either a legacy bare token string or a JSON record
// { token, expiresAt } (ms epoch, or null when the provider gave no usable
// expiry). load() always returns the bare token string; loadRecord() returns
// the full record for expiry gating (see byop.js tokenUsable).

export const TROLLEY_KEY_ITEM = 'trolley-match:jev-key:v1';

function defaultSessionStore() {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : null;
  } catch (_) {
    return null; // storage access blocked
  }
}

export function createKeyStore(backing = undefined) {
  const store = backing === undefined ? defaultSessionStore() : backing;
  let mem = null;
  let useMem = store === null || store === undefined;

  // expiresAt: ms epoch, or null/undefined for "no known expiry" (legacy).
  function save(key, expiresAt = null) {
    if (typeof key !== 'string' || key.length === 0) {
      clear();
      return;
    }
    const value = Number.isFinite(expiresAt)
      ? JSON.stringify({ token: key, expiresAt })
      : key;
    if (useMem) {
      mem = value;
      return;
    }
    try {
      store.setItem(TROLLEY_KEY_ITEM, value);
    } catch (_) {
      useMem = true; // e.g. quota / SecurityError mid-session
      mem = value;
    }
  }
  // Parse any stored shape back to a { token, expiresAt } record. Unknown or
  // corrupt shapes yield an empty record (never throws, never a bare token).
  function readRecord() {
    const raw = useMem ? mem : (() => {
      try {
        return store.getItem(TROLLEY_KEY_ITEM);
      } catch (_) {
        return mem;
      }
    })();
    if (typeof raw !== 'string' || raw.length === 0) {
      return { token: null, expiresAt: null };
    }
    if (raw.charAt(0) === '{') {
      try {
        const parsed = JSON.parse(raw);
        const token = typeof parsed.token === 'string' && parsed.token.length > 0
          ? parsed.token
          : null;
        const expiresAt = Number.isFinite(parsed.expiresAt) ? parsed.expiresAt : null;
        return { token, expiresAt };
      } catch (_) {
        return { token: null, expiresAt: null };
      }
    }
    return { token: raw, expiresAt: null }; // legacy bare-token shape
  }
  function load() {
    return readRecord().token;
  }
  function loadRecord() {
    return readRecord();
  }
  function clear() {
    mem = null;
    try {
      if (store) store.removeItem(TROLLEY_KEY_ITEM);
    } catch (_) { /* ignore */ }
  }
  function storeMode() {
    return useMem ? 'memory' : 'session';
  }
  return { save, load, loadRecord, clear, storeMode };
}

// Start gate: a non-empty connected token (BYOP OAuth vault). Expiry is
// checked separately via byop.tokenUsable — an unknown expiry starts, and
// authentication failures clear it.
export function canStart({ token }) {
  return typeof token === 'string' && token.length > 0;
}
