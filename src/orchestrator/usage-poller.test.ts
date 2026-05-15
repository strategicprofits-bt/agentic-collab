import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseClaudeUsage, parseCodexStatus, UsagePoller, type UsageBucket } from './usage-poller.ts';

describe('parseClaudeUsage', () => {
  it('parses typical /usage output with two buckets', () => {
    const output = [
      '  Current session',
      '  ████▌                                              9% used',
      '  Resets 12pm (America/Chicago)',
      '',
      '  Current week (all models)',
      '  ███████████                                        22% used',
      '  Resets Mar 13, 12am (America/Chicago)',
    ].join('\n');

    const buckets = parseClaudeUsage(output);
    assert.equal(buckets.length, 2);

    assert.equal(buckets[0]!.label, 'Current session');
    assert.equal(buckets[0]!.pctUsed, 9);
    assert.equal(buckets[0]!.resetsAt, '12pm (America/Chicago)');

    assert.equal(buckets[1]!.label, 'Current week (all models)');
    assert.equal(buckets[1]!.pctUsed, 22);
    assert.equal(buckets[1]!.resetsAt, 'Mar 13, 12am (America/Chicago)');
  });

  it('parses three buckets including Sonnet-only', () => {
    const output = [
      '  Current session',
      '  ██                                                 4% used',
      '  Resets 6pm (America/Chicago)',
      '',
      '  Current week (all models)',
      '  ████████████████                                   32% used',
      '  Resets Mar 15, 12am (America/Chicago)',
      '',
      '  Current week (Sonnet only)',
      '  ███████                                            14% used',
      '  Resets Mar 15, 12am (America/Chicago)',
    ].join('\n');

    const buckets = parseClaudeUsage(output);
    assert.equal(buckets.length, 3);
    assert.equal(buckets[2]!.label, 'Current week (Sonnet only)');
    assert.equal(buckets[2]!.pctUsed, 14);
  });

  it('returns empty array for no usage data', () => {
    const buckets = parseClaudeUsage('some random output\nno usage here');
    assert.equal(buckets.length, 0);
  });

  it('handles missing reset info', () => {
    const output = '  Session\n  ████████████████████  50% used\n';
    const buckets = parseClaudeUsage(output);
    assert.equal(buckets.length, 1);
    assert.equal(buckets[0]!.pctUsed, 50);
    assert.equal(buckets[0]!.resetsAt, '');
  });

  it('skips progress bar lines when finding label', () => {
    const output = [
      '  My label',
      '  ████████████████████████████████████████████',
      '  75% used',
      '  Resets tomorrow',
    ].join('\n');
    const buckets = parseClaudeUsage(output);
    assert.equal(buckets[0]!.label, 'My label');
    assert.equal(buckets[0]!.pctUsed, 75);
  });

  it('ignores "NN% used" without adjacent progress bar (false positive)', () => {
    const output = [
      '  Claude adapter: parseContextPercent reports %',
      '  used directly: 19% used',
      '  some other text',
    ].join('\n');
    const buckets = parseClaudeUsage(output);
    assert.equal(buckets.length, 0);
  });

  it('ignores stray "NN% used" in conversation text', () => {
    const output = [
      '  The API shows 45% used this month',
      '  We need to reduce usage',
    ].join('\n');
    const buckets = parseClaudeUsage(output);
    assert.equal(buckets.length, 0);
  });

  it('filters out paths and bare timezones as labels', () => {
    const output = [
      '  /tmp',
      '  ████▌                                              5% used',
      '  Resets 12pm',
      '  (America/Chicago)',
      '',
      '  Current week (all models)',
      '  ██████████████████████████                         102% used',
      '  Resets May 1 (America/Chicago)',
    ].join('\n');
    const buckets = parseClaudeUsage(output);
    // Should only capture "Current week (all models)", not "/tmp" or "(America/Chicago)"
    assert.equal(buckets.length, 1);
    assert.equal(buckets[0]!.label, 'Current week (all models)');
    assert.equal(buckets[0]!.pctUsed, 102);
  });

  it('parses v2.1.118+ inline format (no labels, just reset times)', () => {
    const output = [
      '  Resets 2pm (America/Chicago)████████████████████   96% used',
      '',
      '  Resets 5pm (America/Chicago)                       0% used',
      '',
      '  $203.22 / $200.00 spent · Resets May 1 (America/Chicago)',
    ].join('\n');
    const buckets = parseClaudeUsage(output);
    assert.equal(buckets.length, 3);

    assert.equal(buckets[0]!.label, 'Resets 2pm');
    assert.equal(buckets[0]!.pctUsed, 96);
    assert.equal(buckets[0]!.resetsAt, '2pm (America/Chicago)');

    assert.equal(buckets[1]!.label, 'Resets 5pm');
    assert.equal(buckets[1]!.pctUsed, 0);

    assert.equal(buckets[2]!.label, 'Extra usage');
    assert.equal(buckets[2]!.pctUsed, 102); // 203.22/200 = 101.6%
    assert.equal(buckets[2]!.resetsAt, 'May 1 (America/Chicago)');
  });
});

describe('parseCodexStatus', () => {
  it('parses real codex /status output', () => {
    const output = [
      '╭─────────────────────────────────────────────────────────────────────────────────╮',
      '│  >_ OpenAI Codex (v0.111.0)                                                     │',
      '│                                                                                 │',
      '│  Model:                gpt-5.4 (reasoning xhigh, summaries auto)                │',
      '│  Account:              user@example.com (Plus)                                    │',
      '│                                                                                 │',
      '│  5h limit:             [████████████████░░░░] 80% left (resets 12:19)           │',
      '│  Weekly limit:         [█████░░░░░░░░░░░░░░░] 26% left (resets 01:44 on 13 Mar) │',
      '╰─────────────────────────────────────────────────────────────────────────────────╯',
    ].join('\n');
    const buckets = parseCodexStatus(output);
    assert.equal(buckets.length, 2);
    assert.equal(buckets[0]!.label, '5h limit');
    assert.equal(buckets[0]!.pctUsed, 20); // 100 - 80
    assert.equal(buckets[0]!.resetsAt, '12:19');
    assert.equal(buckets[1]!.label, 'Weekly limit');
    assert.equal(buckets[1]!.pctUsed, 74); // 100 - 26
    assert.equal(buckets[1]!.resetsAt, '01:44 on 13 Mar');
  });

  it('parses "NN% used" format', () => {
    const output = '│  Daily limit:  [████] 45% used (resets tomorrow) │';
    const buckets = parseCodexStatus(output);
    assert.equal(buckets.length, 1);
    assert.equal(buckets[0]!.label, 'Daily limit');
    assert.equal(buckets[0]!.pctUsed, 45);
    assert.equal(buckets[0]!.resetsAt, 'tomorrow');
  });

  it('ignores non-limit lines (model, account, prompts)', () => {
    const output = [
      '│  Model:                gpt-5.4 (reasoning xhigh)                │',
      '│  Account:              test@test.io (Plus)                      │',
      '› Implement {feature}',
      '  83% context left',
    ].join('\n');
    const buckets = parseCodexStatus(output);
    assert.equal(buckets.length, 0);
  });

  it('returns empty for no usage data', () => {
    const buckets = parseCodexStatus('no status info here');
    assert.equal(buckets.length, 0);
  });
});

function makePoller(): UsagePoller {
  const stubDb = {
    listProxies: () => [],
    listAgents: () => [],
    logEvent: () => {},
  } as any;
  return new UsagePoller({ db: stubDb, proxyDispatch: async () => ({ ok: true }) as any });
}

function bucket(pctUsed: number, resetsAt = 'May 19 (America/Chicago)'): UsageBucket {
  return { label: 'Current week (all models)', pctUsed, resetsAt };
}

describe('assessBucketQuality', () => {
  it('returns normal on first reading (no history)', () => {
    const poller = makePoller();
    const b = bucket(18);
    const q = poller.assessBucketQuality('claude', undefined, b);
    assert.equal(q, 'normal');
    assert.equal(b.quality, undefined);
    assert.equal(b.baselinePct, undefined);
  });

  it('returns normal when pct increases', () => {
    const poller = makePoller();
    poller.assessBucketQuality('claude', undefined, bucket(10), 1000);
    poller.assessBucketQuality('claude', undefined, bucket(15), 2000);
    const b = bucket(20);
    const q = poller.assessBucketQuality('claude', undefined, b, 3000);
    assert.equal(q, 'normal');
    assert.equal(b.quality, undefined);
  });

  it('returns normal for small drop within threshold', () => {
    const poller = makePoller();
    poller.assessBucketQuality('claude', undefined, bucket(18), 1000);
    const b = bucket(14); // 4 point drop, within 5-point threshold
    const q = poller.assessBucketQuality('claude', undefined, b, 2000);
    assert.equal(q, 'normal');
  });

  it('returns suspect when drop exceeds threshold', () => {
    const poller = makePoller();
    poller.assessBucketQuality('claude', undefined, bucket(18), 1000);
    const b = bucket(2); // 16 point drop
    const q = poller.assessBucketQuality('claude', undefined, b, 2000);
    assert.equal(q, 'suspect');
    assert.equal(b.quality, 'suspect');
    assert.equal(b.baselinePct, 18);
  });

  it('returns suspect at exactly threshold + 1', () => {
    const poller = makePoller();
    poller.assessBucketQuality('claude', undefined, bucket(20), 1000);
    const b = bucket(14); // 6 point drop > 5 threshold
    const q = poller.assessBucketQuality('claude', undefined, b, 2000);
    assert.equal(q, 'suspect');
    assert.equal(b.baselinePct, 20);
  });

  it('returns normal at exactly threshold boundary', () => {
    const poller = makePoller();
    poller.assessBucketQuality('claude', undefined, bucket(20), 1000);
    const b = bucket(15); // exactly 5 point drop = threshold, not exceeded
    const q = poller.assessBucketQuality('claude', undefined, b, 2000);
    assert.equal(q, 'normal');
  });

  it('clears history when resetsAt changes (new billing period)', () => {
    const poller = makePoller();
    poller.assessBucketQuality('claude', undefined, bucket(50, 'May 19'), 1000);
    poller.assessBucketQuality('claude', undefined, bucket(55, 'May 19'), 2000);
    // New billing period — drop from 55 to 5 is expected
    const b = bucket(5, 'May 26');
    const q = poller.assessBucketQuality('claude', undefined, b, 3000);
    assert.equal(q, 'normal');
  });

  it('uses max of history as baseline, not last reading', () => {
    const poller = makePoller();
    poller.assessBucketQuality('claude', undefined, bucket(30), 1000);
    poller.assessBucketQuality('claude', undefined, bucket(25), 2000); // dip but within threshold
    // Baseline should be 30 (max), not 25 (last)
    const b = bucket(24); // 6 drop from 30 (suspect), but only 1 from 25
    const q = poller.assessBucketQuality('claude', undefined, b, 3000);
    assert.equal(q, 'suspect');
    assert.equal(b.baselinePct, 30);
  });

  it('tracks separate histories per engine/account/label', () => {
    const poller = makePoller();
    poller.assessBucketQuality('claude', 'acct-a', bucket(50), 1000);
    // Different account — no history, so no suspect
    const b = bucket(2);
    const q = poller.assessBucketQuality('claude', 'acct-b', b, 2000);
    assert.equal(q, 'normal');
  });

  it('trims history to HISTORY_SIZE', () => {
    const poller = makePoller();
    // Push 15 readings at 10 each
    for (let i = 0; i < 15; i++) {
      poller.assessBucketQuality('claude', undefined, bucket(10), i * 1000);
    }
    // Now push one at 50 — this becomes the new max
    poller.assessBucketQuality('claude', undefined, bucket(50), 15000);
    // Drop to 2 — should be suspect (baseline 50)
    const b = bucket(2);
    const q = poller.assessBucketQuality('claude', undefined, b, 16000);
    assert.equal(q, 'suspect');
    assert.equal(b.baselinePct, 50);
  });
});
