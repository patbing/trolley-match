// Validate data/scenarios.v1.json: shape, uniqueness, semantic-mapping
// fields, and the swap-pair contract. No network. Exit non-zero on failure.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const raw = readFileSync(join(root, 'data', 'scenarios.v1.json'), 'utf8');
let doc;
try {
  doc = JSON.parse(raw);
} catch (e) {
  console.error('scenarios: invalid JSON: ' + e.message);
  process.exit(1);
}

const errors = [];
const fail = (msg) => errors.push(msg);

if (!doc || !Array.isArray(doc.scenarios)) fail('top-level scenarios array is required');
const list = (doc && Array.isArray(doc.scenarios)) ? doc.scenarios : [];

if (list.length !== 5) fail(`expected 5 scenarios, found ${list.length}`);

const ids = new Set();
let swapCount = 0;
list.forEach((sc, i) => {
  const where = `scenarios[${i}]`;
  if (!sc || typeof sc !== 'object') { fail(`${where}: must be an object`); return; }
  if (typeof sc.id !== 'string' || !sc.id) fail(`${where}: id is required`);
  else if (ids.has(sc.id)) fail(`${where}: duplicate id ${sc.id}`);
  else ids.add(sc.id);
  for (const f of ['title', 'facts', 'note', 'source']) {
    if (typeof sc[f] !== 'string' || sc[f].trim().length === 0) fail(`${sc.id || where}: ${f} is required`);
  }
  const { actionA, actionB } = sc;
  for (const [name, a] of [['actionA', actionA], ['actionB', actionB]]) {
    if (!a || typeof a !== 'object') { fail(`${sc.id}: ${name} is required`); continue; }
    if (typeof a.label !== 'string' || !a.label.trim()) fail(`${sc.id}: ${name}.label required`);
    if (typeof a.text !== 'string' || !a.text.trim()) fail(`${sc.id}: ${name}.text required`);
    if (a.effect !== 'pull' && a.effect !== 'hold') fail(`${sc.id}: ${name}.effect must be pull|hold`);
  }
  if (actionA && actionB && actionA.effect === actionB.effect) {
    fail(`${sc.id}: actionA/actionB must have distinct effects (one pull, one hold)`);
  }
  if (actionA && actionB && actionA.text === actionB.text) {
    fail(`${sc.id}: actionA/actionB texts must be distinct`);
  }
  if (actionA && actionB && actionA.label === actionB.label) {
    fail(`${sc.id}: actionA/actionB labels must be distinct`);
  }
  const jev = sc.jev;
  if (!jev || typeof jev !== 'object') fail(`${sc.id}: jev mapping is required`);
  else {
    if (typeof jev.pullKey !== 'string' || !jev.pullKey) fail(`${sc.id}: jev.pullKey required`);
    if (typeof jev.holdKey !== 'string' || !jev.holdKey) fail(`${sc.id}: jev.holdKey required`);
    if (jev.pullKey && jev.pullKey === jev.holdKey) fail(`${sc.id}: jev keys must differ`);
    if (typeof jev.instructions !== 'string' || !jev.instructions.trim()) {
      fail(`${sc.id}: jev.instructions required`);
    }
  }
  if (sc.swapPair === true) swapCount += 1;
  else if (sc.swapPair !== false && sc.swapPair !== undefined) fail(`${sc.id}: swapPair must be boolean`);
});

if (swapCount !== 1) fail(`expected exactly 1 swapPair scenario, found ${swapCount}`);

if (errors.length > 0) {
  for (const e of errors) console.error('scenarios: ' + e);
  process.exit(1);
}
console.log(`scenarios: OK (${list.length} scenarios, 1 swap lab)`);
