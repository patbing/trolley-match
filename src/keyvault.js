// Single-item session vault for the BYOP-issued token.
// Copied guarantees from the model-match reference (fresh.js createKeyStore):
// one session tab-storage item only, in-memory fallback when tab storage is
// unavailable or blocked, never written anywhere else.

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

  function save(key) {
    if (typeof key !== 'string' || key.length === 0) {
      clear();
      return;
    }
    if (useMem) {
      mem = key;
      return;
    }
    try {
      store.setItem(TROLLEY_KEY_ITEM, key);
    } catch (_) {
      useMem = true; // e.g. quota / SecurityError mid-session
      mem = key;
    }
  }
  function load() {
    if (useMem) return mem;
    try {
      const v = store.getItem(TROLLEY_KEY_ITEM);
      return typeof v === 'string' && v.length > 0 ? v : null;
    } catch (_) {
      return mem;
    }
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
  return { save, load, clear, storeMode };
}

// Start gate: a non-empty connected token (BYOP OAuth vault). Expiry is
// checked separately via byop.tokenUsable — an unknown expiry starts, and
// authentication failures clear it.
export function canStart({ token }) {
  return typeof token === 'string' && token.length > 0;
}
