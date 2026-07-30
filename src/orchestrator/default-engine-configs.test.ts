import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_ENGINE_CONFIGS } from './default-engine-configs.ts';

describe('DEFAULT_ENGINE_CONFIGS claude model-pin (GAP-050)', () => {
  const claude = DEFAULT_ENGINE_CONFIGS.find((c) => c.name === 'claude')!;

  it('exists', () => {
    assert.ok(claude, 'claude default engine config present');
  });

  // A hardcoded `--model opus` in the default start/reload hooks forces every
  // preset-start (no custom start-hook) agent onto opus, ignoring its declared
  // model. $MODEL_FLAG resolves the agent's configured model (or "" when unpinned).
  for (const field of ['hookStart', 'hookReload'] as const) {
    it(`${field} pins $MODEL_FLAG, not a hardcoded --model opus`, () => {
      const raw = claude[field];
      assert.ok(raw, `${field} present`);
      assert.ok(raw!.includes('$MODEL_FLAG'), `${field} should carry $MODEL_FLAG`);
      assert.ok(!raw!.includes('--model opus'), `${field} must not hardcode --model opus`);
    });
  }

  it('hookResume carries $MODEL_FLAG (from the GAP-049 fix, still intact)', () => {
    assert.ok(claude.hookResume!.includes('$MODEL_FLAG'));
  });
});
