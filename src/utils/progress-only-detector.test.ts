// Run with: npx tsx --test src/utils/progress-only-detector.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isProgressOnlyOutput } from './progress-only-detector';

// --- SHOULD be blocked (true) ---
test('blocks "I\'ll investigate this further"', () =>
  assert.equal(isProgressOnlyOutput("I'll investigate this further"), true));

test('blocks "Let me check on that"', () =>
  assert.equal(isProgressOnlyOutput('Let me check on that'), true));

test('blocks "I\'m going to analyze the logs"', () =>
  assert.equal(isProgressOnlyOutput("I'm going to analyze the logs"), true));

test('blocks "I need to review the code"', () =>
  assert.equal(isProgressOnlyOutput('I need to review the code'), true));

test('blocks "Next, I\'ll look at the configuration"', () =>
  assert.equal(isProgressOnlyOutput("Next, I'll look at the configuration"), true));

test('blocks "I will check on this now"', () =>
  assert.equal(isProgressOnlyOutput('I will check on this now'), true));

test('blocks "Reviewing the logs now"', () =>
  assert.equal(isProgressOnlyOutput('Reviewing the logs now'), true));

test('blocks "Let me look into this for you"', () =>
  assert.equal(isProgressOnlyOutput('Let me look into this for you'), true));

test('blocks "I need to investigate the issue"', () =>
  assert.equal(isProgressOnlyOutput('I need to investigate the issue'), true));

// --- SHOULD NOT be blocked (false) ---
test('does not block a real answer with diagnosis + fix', () =>
  assert.equal(isProgressOnlyOutput('The issue is caused by X. Here is the fix: ...'), false));

test('does not block a results-bearing answer', () =>
  assert.equal(isProgressOnlyOutput('Here are the results: all tests pass.'), false));

test('does not block empty string', () =>
  assert.equal(isProgressOnlyOutput(''), false));

test('does not block null', () =>
  assert.equal(isProgressOnlyOutput(null), false));

test('does not block a 1000-char detailed response (length guard)', () => {
  const detailed = 'Detailed analysis: '.repeat(50);
  assert.ok(detailed.length > 800);
  assert.equal(isProgressOnlyOutput(detailed), false);
});

test('does not block progress opener followed by substantive second sentence', () =>
  assert.equal(
    isProgressOnlyOutput(
      "I'll check. The root cause is a missing env var: DATABASE_URL is not set in production."
    ),
    false
  ));
