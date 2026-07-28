import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractComposerText,
  hasComposerText,
  composerCorrespondsToMessage,
  composerHoldsPaste,
  MIN_CORRESPONDENCE_CHARS,
} from './composer.ts';

const HINT = '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents              /rc';
const box = (composer: string[]): string =>
  ['──────────────── Agent ──', ...composer, '────────────────────────', HINT].join('\n');

const ENVELOPE = "[from: CoachBeard, reply with collab send CoachBeard --topic ops]: 'please handle the queued task now and report back'";

describe('extractComposerText', () => {
  it('single-line composer', () => {
    assert.equal(extractComposerText(box(['❯ please respond ok'])), 'please respond ok');
  });
  it('multi-line wrapped composer, joined in visual order', () => {
    assert.equal(
      extractComposerText(box(['❯ first line here', '  second line', '  third line'])),
      'first line here second line third line',
    );
  });
  it('empty composer → null', () => {
    assert.equal(extractComposerText(box(['❯ '])), null);
    assert.equal(hasComposerText(box(['❯ '])), false);
  });
  it('empty composer with "> …" scrollback ABOVE the box → null (bounded, never climbs)', () => {
    const pane = [
      '  > quoted scrollback text from persona', // scrollback, ABOVE the top border
      '──────────────── Agent ──',
      '❯ ',
      '────────────────────────',
      HINT,
    ].join('\n');
    assert.equal(extractComposerText(pane), null);
  });
});

describe('composerCorrespondsToMessage (common-prefix ≥ MIN)', () => {
  it('real paste — full, truncated, reformatted-whitespace all MATCH', () => {
    assert.equal(composerCorrespondsToMessage(ENVELOPE, ENVELOPE), true);
    assert.equal(composerCorrespondsToMessage(ENVELOPE.slice(0, 60), ENVELOPE), true); // capture truncation
    assert.equal(composerCorrespondsToMessage(ENVELOPE.replace(/ /g, '  '), ENVELOPE), true); // wrap re-spacing
  });
  it('own-draft EXCLUDED', () => {
    assert.equal(composerCorrespondsToMessage('check the queue for anything else pending', ENVELOPE), false);
  });
  it('TUI placeholder EXCLUDED', () => {
    assert.equal(composerCorrespondsToMessage('Try "how do I log an error?"', ENVELOPE), false);
  });
  it('own-draft that is a COLLAB COMMAND to the same sender+topic EXCLUDED (boilerplate false-match)', () => {
    // The sharpest false-match: a drafted reply shares "collab send CoachBeard
    // --topic ops" with the envelope's boilerplate. Common-prefix defeats it —
    // the draft does not START with "[from:", so the prefix is ~0. (LCS would false-match here.)
    assert.equal(
      composerCorrespondsToMessage('collab send CoachBeard --topic ops "on it, handling now"', ENVELOPE),
      false,
    );
  });
  it('too-short text EXCLUDED', () => {
    assert.equal(composerCorrespondsToMessage('ok', ENVELOPE), false);
    assert.equal('ok'.length < MIN_CORRESPONDENCE_CHARS, true);
  });
});

describe('composerHoldsPaste (Part A: did my paste fail to submit?)', () => {
  it('long paste still sitting → held (throw)', () => {
    assert.equal(composerHoldsPaste(ENVELOPE, ENVELOPE), true);
    assert.equal(composerHoldsPaste(ENVELOPE.slice(0, 50), ENVELOPE), true);
  });
  it('placeholder after a successful submit → NOT held (no false-throw / no double-delivery)', () => {
    assert.equal(composerHoldsPaste('Try "how do I log an error?"', ENVELOPE), false);
  });
  it('a DIFFERENT own-draft → not held (my paste submitted)', () => {
    assert.equal(composerHoldsPaste('check the queue for anything else pending', ENVELOPE), false);
  });
  it('SHORT hook paste ("/compact") still sitting → held via containment', () => {
    assert.equal(composerHoldsPaste('/compact', '/compact'), true);
    assert.equal(composerHoldsPaste('some prefix /compact', '/compact'), true);
  });
  it('SHORT hook paste submitted (composer shows other text) → not held', () => {
    assert.equal(composerHoldsPaste('Try "how do I log an error?"', '/compact'), false);
  });
});
