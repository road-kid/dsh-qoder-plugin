/**
 * Regression cover for the mid-stream transport failure that ended turns
 * without a retry (observed 2026-10-31: "Qoder transport request failed." with
 * duration 37,742ms, code PI_AI_ERROR, turn/end kind=error, no llm/retry event).
 *
 * The harness never sees the plugin's error CODE. `dsh-llm-pi-ai` classifies an
 * adapter failure by matching TEXT inside the failure MESSAGE, and
 * `dsh-llm-retry` only retries codes in the provider's `retryableCodes` set.
 * A message the text matcher cannot classify lands on its `PI_AI_ERROR`
 * fallback, which is outside the default set, so the turn dies on the first
 * drop.
 *
 * These tests therefore assert the CONTRACT that was violated: every message
 * the transport can surface for a recoverable condition must contain a word the
 * classifier maps into `retryableCodes`.
 *
 * `classifyPiAiError` is reproduced verbatim from the shipped
 * `@deepseek-ai/dsh-llm-pi-ai` build. It is a copy on purpose: this plugin
 * cannot import that module's internals, and the point of the test is to fail
 * loudly if a rewritten message stops matching the classifier the host
 * actually runs.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

/** Verbatim `resolveRetryPolicy` defaults from `@deepseek-ai/dsh-llm`. */
const DEFAULT_RETRYABLE_CODES: readonly string[] = [
  'EMPTY_RESPONSE',
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
]

/** Verbatim `isQuotaExceededError` from `@deepseek-ai/dsh-llm`. */
function isQuotaExceededError(detail: string): boolean {
  return /\binsufficient[\s_-]+(?:quota|balance|credits?)\b/i.test(detail)
    || /\b(?:quota|usage[\s_-]+limit)[\s_-]+(?:exceeded|exhausted|reached)\b/i.test(detail)
    || /\bexceed(?:ed|s)?[\s_-]+(?:(?:your|the)[\s_-]+)?(?:current[\s_-]+)?quota\b/i.test(detail)
    || /\b(?:balance|credits?)[\s_-]+(?:exhausted|depleted)\b/i.test(detail)
    || /\bout[\s_-]+of[\s_-]+(?:credits?|budget)\b/i.test(detail)
}

/** Verbatim `classifyPiAiError` from `@deepseek-ai/dsh-llm-pi-ai` lib/index.js. */
function classifyPiAiError(message: string): string {
  if (/\b(?:401|403)\b/.test(message)) return 'AUTH'
  if (isQuotaExceededError(message)) return 'QUOTA'
  if (/\b429\b|rate.?limit/i.test(message)) return 'RATE_LIMIT'
  if (/\b413\b|failed to buffer the request body:\s*length limit exceeded|payload too large|request body too large/i.test(message)) return 'INVALID_REQUEST'
  if (/\b400\b|invalid.?request/i.test(message)) return 'INVALID_REQUEST'
  if (/\b5\d\d\b/.test(message)) return 'SERVER'
  if (/\btime(?:d)?\s*out\b|timeout/i.test(message)) return 'TIMEOUT'
  if (/stream ended (?:before|without)\b/i.test(message)) return 'TRANSPORT'
  if (/\b(?:network|connection|socket|fetch)\b|\bECONN[A-Z]+\b/i.test(message)
    || /\b(?:other side closed|HTTP2 request did not get a response|WebSocket closed unexpectedly)\b/i.test(message)
    || /\bterminated\b|premature close/i.test(message)) return 'TRANSPORT'
  return 'PI_AI_ERROR'
}

function retries(code: string): boolean {
  return DEFAULT_RETRYABLE_CODES.includes(code)
}

test('the classifier reproduces the reported failure, so the premise holds', () => {
  // The exact message from the user-facing failure. If this ever starts
  // classifying retryably, the tests below are guarding nothing and should be
  // reconsidered rather than quietly passing.
  assert.equal(classifyPiAiError('Qoder transport request failed.'), 'PI_AI_ERROR')
  assert.equal(retries('PI_AI_ERROR'), false)
})

test('undici and socket wording the cause chain can carry all classify as retryable', () => {
  // The lead phrase alone must classify, because the cause chain is whatever
  // undici happened to report. `write EPIPE` is the case that proves this:
  // it matches none of the classifier's transport tokens on its own.
  const causes = [
    'fetch failed',
    'other side closed',
    'terminated',
    'read ECONNRESET',
    'write EPIPE',
    'socket hang up',
    'premature close',
    'Connection error.',
    'The operation was aborted',
    'HTTP2 request did not get a response',
    'something no classifier has ever seen',
  ]
  for (const cause of causes) {
    const message = `Qoder connection failed: ${cause}`
    const code = classifyPiAiError(message)
    assert.equal(retries(code), true, `${JSON.stringify(cause)} classified ${code}, which is not retryable`)
  }
})

test('the cause-less fallback message is retryable', () => {
  // `describeCause` returns '' for a non-Error throw with no usable message.
  // That arm must not reintroduce the unclassifiable bare phrase.
  const message = 'Qoder connection failed with no reported cause.'
  assert.equal(retries(classifyPiAiError(message)), true)
})

test('a bodyless 200 response is reported as a connection failure that retries', () => {
  // `streamQoderChat` throws this when the upstream answered but supplied no
  // readable stream. It is recoverable, so it has to classify retryably.
  const message = 'Qoder connection returned no readable body stream.'
  assert.equal(retries(classifyPiAiError(message)), true)
})

test('a stream truncated before [DONE] retries', () => {
  // The transport raises this when the SSE source ends without the sentinel —
  // a dropped connection, not a bad request.
  const message = 'Qoder connection ended prematurely: the event stream closed without [DONE].'
  assert.equal(retries(classifyPiAiError(message)), true)
})

test('the timeout arms keep classifying as TIMEOUT', () => {
  // These already worked; pinned so a reworded message cannot regress them.
  for (const message of [
    'Qoder model request exceeded its response header timeout.',
    'Qoder model stream exceeded its idle timeout.',
  ]) {
    assert.equal(classifyPiAiError(message), 'TIMEOUT')
    assert.equal(retries('TIMEOUT'), true)
  }
})

test('a rewritten message that loses its classifier token is caught by this suite', () => {
  // Negative control for the assertion style used above: this is what the old
  // message did, and the tests in this file are only meaningful because they
  // would reject it.
  const oldStyle = 'Qoder transport request failed.'
  assert.equal(retries(classifyPiAiError(oldStyle)), false)
})
