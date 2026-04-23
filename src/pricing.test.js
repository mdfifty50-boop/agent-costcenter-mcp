/**
 * Tests for pricing.js — MODEL_PRICING, resolveModelPricing, calculateCost.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_PRICING, resolveModelPricing, calculateCost } from './pricing.js';

describe('MODEL_PRICING table', () => {
  test('has all 11 models', () => {
    assert.equal(Object.keys(MODEL_PRICING).length, 11);
  });

  test('every entry has input and output as positive numbers', () => {
    for (const [model, pricing] of Object.entries(MODEL_PRICING)) {
      assert.ok(typeof pricing.input === 'number', `${model}.input should be a number`);
      assert.ok(typeof pricing.output === 'number', `${model}.output should be a number`);
      assert.ok(pricing.input > 0, `${model}.input should be > 0`);
      assert.ok(pricing.output > 0, `${model}.output should be > 0`);
    }
  });

  test('output is always >= input (industry standard)', () => {
    for (const [model, pricing] of Object.entries(MODEL_PRICING)) {
      assert.ok(pricing.output >= pricing.input, `${model}: output should be >= input`);
    }
  });

  test('haiku is cheapest Anthropic model', () => {
    assert.ok(MODEL_PRICING['claude-haiku-4'].input < MODEL_PRICING['claude-sonnet-4'].input);
    assert.ok(MODEL_PRICING['claude-sonnet-4'].input < MODEL_PRICING['claude-opus-4'].input);
  });
});

describe('resolveModelPricing', () => {
  test('exact match returns correct pricing', () => {
    const p = resolveModelPricing('claude-sonnet-4');
    assert.deepStrictEqual(p, MODEL_PRICING['claude-sonnet-4']);
  });

  test('case-insensitive match', () => {
    const p = resolveModelPricing('Claude-Opus-4');
    assert.deepStrictEqual(p, MODEL_PRICING['claude-opus-4']);
  });

  test('substring match (model name contains key)', () => {
    const p = resolveModelPricing('my-custom-claude-haiku-4-v2');
    assert.deepStrictEqual(p, MODEL_PRICING['claude-haiku-4']);
  });

  test('strips version suffix -20250414', () => {
    const p = resolveModelPricing('gpt-4o-20250414');
    assert.deepStrictEqual(p, MODEL_PRICING['gpt-4o']);
  });

  test('returns null for unknown model', () => {
    const p = resolveModelPricing('completely-unknown-model-xyz');
    assert.equal(p, null);
  });

  test('returns null for empty string', () => {
    assert.equal(resolveModelPricing(''), null);
  });

  test('returns null for null/undefined', () => {
    assert.equal(resolveModelPricing(null), null);
    assert.equal(resolveModelPricing(undefined), null);
  });

  test('matches deepseek models', () => {
    assert.deepStrictEqual(resolveModelPricing('deepseek-v3'), MODEL_PRICING['deepseek-v3']);
    assert.deepStrictEqual(resolveModelPricing('deepseek-r1'), MODEL_PRICING['deepseek-r1']);
  });

  test('matches gemini models', () => {
    assert.deepStrictEqual(resolveModelPricing('gemini-2.5-pro'), MODEL_PRICING['gemini-2.5-pro']);
    assert.deepStrictEqual(resolveModelPricing('gemini-2.5-flash'), MODEL_PRICING['gemini-2.5-flash']);
  });
});

describe('calculateCost', () => {
  test('calculates correctly for known pricing', () => {
    // claude-sonnet-4: input=3, output=15 per 1M tokens
    const cost = calculateCost(1000, 500, { input: 3, output: 15 });
    // (1000 * 3 + 500 * 15) / 1_000_000 = (3000 + 7500) / 1_000_000 = 0.0105
    assert.equal(cost, 0.0105);
  });

  test('returns 0 for zero tokens', () => {
    assert.equal(calculateCost(0, 0, { input: 15, output: 75 }), 0);
  });

  test('handles large token counts', () => {
    // 1M input tokens at $15/1M = $15
    const cost = calculateCost(1_000_000, 0, { input: 15, output: 75 });
    assert.equal(cost, 15);
  });
});
