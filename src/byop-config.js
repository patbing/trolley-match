// BYOP App Key binding — the ONE place the publishable client id lives.
//
// BYOP_CLIENT_ID is 'pk_PLACEHOLDER' until the real publishable key for the
// Pages redirect below is issued. All OAuth code (src/byop.js) and tests read
// this constant — never hardcode a pk_ anywhere else.
//
// The real key must be registered for redirect URI:
//   https://patbing.github.io/trolley-match/   (EXACT, both authorize+exchange)
export const BYOP_CLIENT_ID = 'pk_lZejHpAQ5nNYSREk';
export const BYOP_REDIRECT_URI = 'https://patbing.github.io/trolley-match/';
