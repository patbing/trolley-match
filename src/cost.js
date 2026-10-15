// Cost disclosure (Sol must-have: consent, spending, and budget limits clear).
// Shown directly above the Connect button and again on the intro screen.
//
// Connect-time parameters mirror the BYOP authorize contract: budget=5 (USD),
// expiry=7 (days). A full run makes 1 live call per scenario and 2 for the
// order-swap lab round — 6 calls total. Failed, retried, and cancelled
// requests may still cost, including requests already sent. Per-call cost is
// on the order of $0.00002 for the default jev alias (Oct 2026, billed to the
// player's own Pollen) — stated as an order of magnitude, not a quote.

import { BYOP_DEVELOPER_EARNINGS_ENABLED } from './byop.js';

export const TROLLEY_CALLS_PER_ROUND = 1;
export const TROLLEY_CALLS_SWAP_ROUND = 2;
export const TROLLEY_CALLS_FULL_RUN = 6;

export const TROLLEY_COST_NOTICE_KO =
  'Trolley Match는 Pollinations 연결로 발급된 키로 결정모델(Jev)을 직접 호출합니다. API 사용료는 플레이어 부담이며, 계정·모델 정책에 따라 발생할 수 있습니다. 연결 시 요청하는 예산은 5 USD, 키 유효기간은 7일입니다. 기본 호출은 시나리오당 1회이며, 순서-바꾸기 실험 라운드는 2회, 전체 1회 플레이는 총 6회입니다. 실패·재시도·취소된 요청도 비용이 발생할 수 있으며, 이미 전송된 요청은 취소해도 과금될 수 있습니다.';
export const TROLLEY_COST_NOTICE_EN =
  'Trolley Match calls the Jev decision model live with a key issued through your Pollinations connection. API usage is billed to you under your account and model policy. Connecting requests a budget of 5 USD and a key valid for 7 days. A full run makes 1 live call per scenario and 2 for the order-swap lab round, 6 calls in total. Failed, retried, and cancelled requests may still cost you, including requests already sent.';
// Developer-earnings disclosure (+25%). Shown ONLY when developer earnings
// are explicitly enabled — never silently.
export const TROLLEY_EARNINGS_NOTICE_KO =
  '개발자 수익 분배가 켜져 있습니다. 사용료의 25%가 개발자에게 추가로 배분됩니다.';
export const TROLLEY_EARNINGS_NOTICE_EN =
  'Developer earnings are on: an extra 25% of usage goes to the developer.';

// Compose the cost notice. Earnings-off returns the base disclosure;
// earnings-on appends the +25% sentence.
export function buildCostNotice(earningsEnabled = BYOP_DEVELOPER_EARNINGS_ENABLED) {
  const on = earningsEnabled === true;
  return {
    ko: on
      ? TROLLEY_COST_NOTICE_KO + ' ' + TROLLEY_EARNINGS_NOTICE_KO
      : TROLLEY_COST_NOTICE_KO,
    en: on
      ? TROLLEY_COST_NOTICE_EN + ' ' + TROLLEY_EARNINGS_NOTICE_EN
      : TROLLEY_COST_NOTICE_EN,
  };
}
