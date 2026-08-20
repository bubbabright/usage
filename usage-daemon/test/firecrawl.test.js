import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parse, sliceCredits, AuthExpiredError } from '../src/providers/firecrawl.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const envelope = readFileSync(
  path.resolve(here, 'fixtures/firecrawl-credit-usage.json'),
  'utf8',
);

test('sliceCredits: splits a balance into whole cycles + current slice', () => {
  assert.deepEqual(sliceCredits(8056, 1000), { cycles: 8, sliceRemaining: 56 });
  // exact boundary reads as a FULL fresh slice, not empty
  assert.deepEqual(sliceCredits(8000, 1000), { cycles: 8, sliceRemaining: 1000 });
  assert.deepEqual(sliceCredits(500, 1000), { cycles: 0, sliceRemaining: 500 });
  assert.deepEqual(sliceCredits(0, 1000), { cycles: 0, sliceRemaining: 0 });
});

test('parse: credits window shows progress through the current slice', () => {
  // fixture: remaining 3000, plan 10000 -> cycles 0, slice 3000 of 10000 -> 70% used
  const { windows, tier, _credits } = parse(envelope);
  assert.equal(tier, null);
  const w = windows.find((x) => x.id === 'credits');
  assert.ok(Math.abs(w.pct - 70) < 1e-9);
  assert.equal(w.used, 3000); // absolute balance rides on the window
  assert.equal(w.cap, 10000); // one slice
  assert.equal(w.unit, 'credits');
  assert.equal(w.color, '#0072B2');
  assert.equal(_credits.cycles_remaining, 0);
});

test('parse: rollover slice sawtooth — banked cycles read fresh, spend fills', () => {
  // 8056 banked on a 1000 plan = 8 cycles + 56 in the current slice
  const top = parse(JSON.stringify({ remaining_credits: 8056, plan_credits: 1000 }));
  const w = top.windows[0];
  // slice 56 of 1000 -> 94.4% used within this slice (about to roll)
  assert.ok(Math.abs(w.pct - 94.4) < 1e-9);
  assert.equal(top._credits.cycles_remaining, 8);
  // spend down to a fresh boundary -> slice reads full again (0% used)
  const rolled = parse(JSON.stringify({ remaining_credits: 8000, plan_credits: 1000 }));
  assert.equal(rolled.windows[0].pct, 0);
});

test('parse: resets_at (next plan top-up) surfaces even with banked cycles remaining', () => {
  // Useful for planning ("will I have enough before the next 1000 lands")
  // regardless of how much rollover buffer is left — the top-up date is
  // real either way, so it's never hidden.
  const banked = parse(
    JSON.stringify({ remaining_credits: 8056, plan_credits: 1000, period_end: '2026-08-14T13:25:19.683Z' }),
  );
  assert.equal(banked._credits.cycles_remaining, 8);
  assert.equal(banked.windows[0].resets_at, '2026-08-14T13:25:19.683Z');
});

test('parse: resets_at still surfaces on the last slice (cycles_remaining 0)', () => {
  const last = parse(
    JSON.stringify({ remaining_credits: 400, plan_credits: 1000, period_end: '2026-08-14T13:25:19.683Z' }),
  );
  assert.equal(last._credits.cycles_remaining, 0);
  assert.equal(last.windows[0].resets_at, '2026-08-14T13:25:19.683Z');
  // slice 400 of 1000 -> 60% used
  assert.ok(Math.abs(last.windows[0].pct - 60) < 1e-9);
});

test('parse: no plan size -> pct null (bare-count meter), figure still present', () => {
  const { windows, _credits } = parse(JSON.stringify({ remaining_credits: 500 }));
  assert.equal(windows[0].pct, null);
  assert.equal(windows[0].used, 500);
  assert.equal(_credits.remaining, 500);
  assert.equal(_credits.cycles_remaining, null);
});

test('parse: error payload throws auth_expired', () => {
  assert.throws(
    () => parse(JSON.stringify({ success: false, error: 'Unauthorized' })),
    AuthExpiredError,
  );
});

test('parse: missing credit figures throws auth_expired', () => {
  assert.throws(() => parse(JSON.stringify({ plan_credits: 10000 })), AuthExpiredError);
});

test('parse: unparseable envelope throws auth_expired', () => {
  assert.throws(() => parse('not json'), AuthExpiredError);
});
