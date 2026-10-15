# Trolley Match

[![Made with pollinations.ai](https://raw.githubusercontent.com/pollinations/pollinations/main/packages/ui/src/brand/badge-made-with.svg)](https://pollinations.ai/?ref=badge)

You decide, then Jev decides. A five-scenario trolley-problem game against the
**live** Pollinations Jev decision model (`POST /alpha/decisions`), entered for
quest **#17647**.

- The player reads the facts and commits to an action **first**.
- Jev answers the **same facts** through a typed-choice API call.
- Both answers are revealed with a plain-language outcome and an **agreement**
  score (agreement with Jev — Jev is the comparison subject, not the answer key).
- One round is an **order-swap lab**: Jev answers twice (2 disclosed calls)
  with identical facts and only the presentation order swapped, compared by
  **semantic action** — never by option index.

Static site, no backend, no dependencies. Every Jev answer is a live call made
with the player's own Pollen through BYOP OAuth; nothing is pre-generated.

## Status

- Design: Sol **CONDITIONAL GO** (2026-10-16).
- Gate 0: `POST /alpha/decisions` proven from a Pages origin via browser
  fetch (CORS OK) before the game UI was built.
- `BYOP_CLIENT_ID` is still `'pk_PLACEHOLDER'` in `src/byop-config.js` — the
  real publishable key for `https://patbing.github.io/trolley-match/` is issued
  separately and replaces that one constant only.

## Run it

```sh
npm run check   # validate scenarios + mocked test suite (zero network)
npm run serve   # python3 -m http.server 8080, then open http://localhost:8080/
```

Deploy target: GitHub Pages at `https://patbing.github.io/trolley-match/`
(the exact redirect URI the OAuth binding requires).

## Connecting (BYOP)

1. Press **Connect with Pollinations** — the app opens the Pollinations
   approval page (PKCE S256, `scope=usage`, `models=text`).
2. Approve a budget-capped key: **budget 5 USD, valid 7 days**.
3. The key lands in this tab's `sessionStorage` only (in-memory fallback when
   tab storage is blocked) and is sent solely in the `Authorization` header of
   Jev calls. **Disconnect** removes it.

Cost notice (shown in the app, KO+EN): a full run makes **1 live call per
scenario and 2 for the order-swap lab — 6 calls in total**. Failed, retried,
and cancelled requests may still cost, including requests already sent.
Developer earnings are off, so no +25% applies.

## How a round works

1. Read the facts, pick your action (keyboard: Tab + Enter — native buttons).
2. The app calls Jev live with a typed `choice` question built from the same
   facts. The exact prompt is inspectable in the expandable panel.
3. Reveal shows your choice, Jev's choice, a plain outcome, and agreement.
4. Loading can be cancelled; failures offer retry of **only the failed
   calls**; budget exhaustion stops the run; expired/rejected keys offer
   reconnect — all without losing your choices or duplicating answered calls.

## Reviewer walkthrough (minutes)

1. Open the app, read the intro and cost notice, Connect.
2. Play round 1: commit first, watch Jev answer live, expand the prompt panel.
3. Reach the Spur order lab: note the 2-call disclosure, compare both prompts.
4. Finish for the agreement tally; Disconnect to clear the tab key.

## Project layout

```
index.html               static shell (aria-live main, no-referrer badge)
src/main.js              DOM shell: intro/connect/rounds/reveal/result
src/game.js              round state machine (DOM-free, injected fetch)
src/jev.js               /alpha/decisions client (DOM-free, injected fetch)
src/byop.js              OAuth PKCE flow (DOM-free; logic reused from model-match)
src/byop-config.js       THE one publishable client id + redirect (placeholder now)
src/keyvault.js          session-only token vault
src/cost.js              KO+EN cost disclosure (1/round, 2 swap, 6 full run)
src/styles.css           mobile-first styles
data/scenarios.v1.json   5 scenarios, original wording, semantic pull/hold mapping
scripts/validate-scenarios.mjs  shape + swap-contract validator
tests/unit/              mocked zero-network suite (OAuth, Jev, game, data)
```

## Attribution

Scenario themes are adapted from trolley-bench; all wording is original to
this project. OAuth/security logic is reused from the sibling project
model-match (same guarantees, new storage namespace).

## License

MIT — see LICENSE.
