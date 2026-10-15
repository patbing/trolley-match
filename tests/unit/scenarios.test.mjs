// Scenario data tests: shipped JSON validity plus the swap-lab contract —
// both Jev orders share byte-identical facts and differ only in
// presentation order, with the same semantic key binding. Zero network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  buildDecisionRequest,
  parseDecision,
  JEV_QUESTION_KEY,
} from '../../src/jev.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const doc = JSON.parse(readFileSync(join(root, 'data', 'scenarios.v1.json'), 'utf8'));
const list = doc.scenarios;

test('data: 5 scenarios, unique ids, distinct actions, one swap lab', () => {
  assert.equal(list.length, 5);
  const ids = list.map((s) => s.id);
  assert.equal(new Set(ids).size, 5);
  for (const sc of list) {
    assert.ok(sc.title && sc.facts && sc.note && sc.source, `${sc.id}: metadata required`);
    assert.notEqual(sc.actionA.text, sc.actionB.text);
    assert.notEqual(sc.actionA.label, sc.actionB.label);
    const effects = [sc.actionA.effect, sc.actionB.effect].sort();
    assert.deepEqual(effects, ['hold', 'pull']);
    assert.notEqual(sc.jev.pullKey, sc.jev.holdKey);
    assert.ok(sc.jev.instructions, `${sc.id}: instructions required`);
  }
  const swaps = list.filter((s) => s.swapPair === true);
  assert.equal(swaps.length, 1);
  assert.ok(list[0].id.includes('baseline') || list[0].id === 'baseline-5v1');
  assert.ok(list.some((s) => s.id === 'server-vs-twenty'));
});

test('data: every scenario builds a valid request and maps both answers', () => {
  for (const sc of list) {
    for (const order of ['A', 'B']) {
      const built = buildDecisionRequest(sc, { order });
      const crit = built.prompt.questions[JEV_QUESTION_KEY].criteria;
      // Both semantic keys present with the scenario's own action texts.
      assert.ok(Object.keys(crit).includes(sc.jev.pullKey), `${sc.id}: pullKey present`);
      assert.ok(Object.keys(crit).includes(sc.jev.holdKey), `${sc.id}: holdKey present`);
      assert.equal(parseDecision(
        { answers: { [JEV_QUESTION_KEY]: { choice: sc.jev.pullKey } } }, sc).action, 'pull');
      assert.equal(parseDecision(
        { answers: { [JEV_QUESTION_KEY]: { choice: sc.jev.holdKey } } }, sc).action, 'hold');
    }
  }
});

test('data: swap lab shares facts across orders, criteria order only differs', () => {
  const lab = list.find((s) => s.swapPair === true);
  const a = buildDecisionRequest(lab, { order: 'A' });
  const b = buildDecisionRequest(lab, { order: 'B' });
  assert.ok(a.prompt.state.startsWith(lab.facts));
  assert.ok(b.prompt.state.startsWith(lab.facts));
  assert.equal(
    b.prompt.state.replace(b.prompt.state.slice(lab.facts.length), ''),
    lab.facts);
  const ka = Object.keys(a.prompt.questions[JEV_QUESTION_KEY].criteria);
  const kb = Object.keys(b.prompt.questions[JEV_QUESTION_KEY].criteria);
  assert.deepEqual([...ka].sort(), [...kb].sort()); // same keys
  assert.deepEqual(ka, [...kb].reverse()); // only order swapped
  for (const k of ka) {
    assert.equal(a.prompt.questions[JEV_QUESTION_KEY].criteria[k],
      b.prompt.questions[JEV_QUESTION_KEY].criteria[k]); // same binding
  }
});
