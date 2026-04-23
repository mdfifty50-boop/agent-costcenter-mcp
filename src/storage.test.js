/**
 * Tests for storage.js — agent registration, cost logging, reports, anomalies, budgets.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  registerAgent,
  logLLMCall,
  logToolCall,
  getCostReport,
  setBudgetAlert,
  checkBudget,
  getCostAnomalies,
  compareModels,
  getSummary,
  _resetAll,
} from './storage.js';

beforeEach(() => {
  _resetAll();
});

// ── register_agent ──────────────────────────

describe('registerAgent', () => {
  test('registers a new agent with defaults', () => {
    const r = registerAgent({ agent_id: 'a1', model: 'claude-sonnet-4' });
    assert.equal(r.agent_id, 'a1');
    assert.equal(r.default_model, 'claude-sonnet-4');
    assert.equal(r.total_llm_cost_usd, 0);
    assert.equal(r.budget_cap_usd, null);
  });

  test('registers with team, project, and budget', () => {
    const r = registerAgent({
      agent_id: 'a2', team: 'engineering', project: 'alpha', model: 'gpt-4o', budget_cap_usd: 50,
    });
    assert.equal(r.team, 'engineering');
    assert.equal(r.project, 'alpha');
    assert.equal(r.budget_cap_usd, 50);
  });

  test('re-registering preserves running totals', () => {
    registerAgent({ agent_id: 'a3', model: 'gpt-4o' });
    logLLMCall({ agent_id: 'a3', model: 'gpt-4o', input_tokens: 1000, output_tokens: 500 });
    const r = registerAgent({ agent_id: 'a3', model: 'gpt-4o-mini' });
    assert.ok(r.total_llm_cost_usd > 0, 'should preserve running total');
    assert.equal(r.default_model, 'gpt-4o-mini');
  });
});

// ── log_llm_call ────────────────────────────

describe('logLLMCall', () => {
  test('auto-calculates cost from pricing table', () => {
    registerAgent({ agent_id: 'b1', model: 'claude-sonnet-4' });
    const r = logLLMCall({ agent_id: 'b1', model: 'claude-sonnet-4', input_tokens: 1000, output_tokens: 500 });
    // (1000 * 3 + 500 * 15) / 1M = 0.0105
    assert.equal(r.logged, true);
    assert.equal(r.call_cost_usd, 0.0105);
  });

  test('uses cost_override_usd when provided', () => {
    registerAgent({ agent_id: 'b2', model: 'gpt-4o' });
    const r = logLLMCall({
      agent_id: 'b2', model: 'gpt-4o', input_tokens: 1000, output_tokens: 500, cost_override_usd: 0.42,
    });
    assert.equal(r.call_cost_usd, 0.42);
  });

  test('throws for unregistered agent', () => {
    assert.throws(() => {
      logLLMCall({ agent_id: 'unknown', model: 'gpt-4o', input_tokens: 100, output_tokens: 50 });
    }, /not registered/);
  });

  test('accumulates session total across multiple calls', () => {
    registerAgent({ agent_id: 'b3', model: 'claude-haiku-4' });
    logLLMCall({ agent_id: 'b3', model: 'claude-haiku-4', input_tokens: 1000, output_tokens: 500 });
    const r2 = logLLMCall({ agent_id: 'b3', model: 'claude-haiku-4', input_tokens: 1000, output_tokens: 500 });
    assert.ok(r2.session_total_usd > r2.call_cost_usd);
  });

  test('budget_warning triggers at 80% of cap', () => {
    registerAgent({ agent_id: 'b4', model: 'claude-opus-4', budget_cap_usd: 0.01 });
    // opus: (1000*15 + 500*75)/1M = 0.0525 > 0.01*0.8
    const r = logLLMCall({ agent_id: 'b4', model: 'claude-opus-4', input_tokens: 1000, output_tokens: 500 });
    assert.equal(r.budget_warning, true);
  });
});

// ── log_tool_call ───────────────────────────

describe('logToolCall', () => {
  test('logs tool call with cost', () => {
    registerAgent({ agent_id: 'c1', model: 'gpt-4o' });
    const r = logToolCall({ agent_id: 'c1', tool_name: 'web_search', duration_ms: 1500, cost_usd: 0.01 });
    assert.equal(r.logged, true);
    assert.equal(r.tool_cost_usd, 0.01);
    assert.equal(r.total_tool_costs_usd, 0.01);
  });

  test('defaults cost to 0', () => {
    registerAgent({ agent_id: 'c2', model: 'gpt-4o' });
    const r = logToolCall({ agent_id: 'c2', tool_name: 'read_file', duration_ms: 50 });
    assert.equal(r.tool_cost_usd, 0);
  });
});

// ── get_cost_report ─────────────────────────

describe('getCostReport', () => {
  test('all scope returns all agents', () => {
    registerAgent({ agent_id: 'r1', model: 'gpt-4o', team: 'eng' });
    registerAgent({ agent_id: 'r2', model: 'gpt-4o', team: 'sales' });
    logLLMCall({ agent_id: 'r1', model: 'gpt-4o', input_tokens: 1000, output_tokens: 500 });
    logLLMCall({ agent_id: 'r2', model: 'gpt-4o', input_tokens: 2000, output_tokens: 1000 });

    const report = getCostReport({ scope: 'all' });
    assert.equal(report.agent_count, 2);
    assert.ok(report.total_spend_usd > 0);
    assert.equal(report.agents.length, 2);
  });

  test('team scope filters correctly', () => {
    registerAgent({ agent_id: 'r3', model: 'gpt-4o', team: 'eng' });
    registerAgent({ agent_id: 'r4', model: 'gpt-4o', team: 'sales' });
    logLLMCall({ agent_id: 'r3', model: 'gpt-4o', input_tokens: 1000, output_tokens: 500 });

    const report = getCostReport({ scope: 'team', filter: 'eng' });
    assert.equal(report.agent_count, 1);
    assert.equal(report.agents[0].agent_id, 'r3');
  });

  test('empty result for unknown filter', () => {
    const report = getCostReport({ scope: 'team', filter: 'nonexistent' });
    assert.equal(report.agent_count, 0);
    assert.equal(report.total_spend_usd, 0);
  });
});

// ── budget management ───────────────────────

describe('budget management', () => {
  test('set_budget_alert and check_budget work together', () => {
    registerAgent({ agent_id: 'd1', model: 'gpt-4o', budget_cap_usd: 1.0 });
    setBudgetAlert({ agent_id: 'd1', threshold_usd: 0.5, action: 'block' });
    const budget = checkBudget('d1');
    assert.equal(budget.within_budget, true);
    assert.equal(budget.budget_usd, 1.0);
    assert.equal(budget.percentage_used, 0);
  });

  test('check_budget returns within_budget false when over cap', () => {
    registerAgent({ agent_id: 'd2', model: 'claude-opus-4', budget_cap_usd: 0.001 });
    logLLMCall({ agent_id: 'd2', model: 'claude-opus-4', input_tokens: 10000, output_tokens: 5000 });
    const budget = checkBudget('d2');
    assert.equal(budget.within_budget, false);
    assert.ok(budget.percentage_used > 100);
  });

  test('check_budget with no cap returns within_budget true', () => {
    registerAgent({ agent_id: 'd3', model: 'gpt-4o' });
    logLLMCall({ agent_id: 'd3', model: 'gpt-4o', input_tokens: 1000000, output_tokens: 500000 });
    const budget = checkBudget('d3');
    assert.equal(budget.within_budget, true);
    assert.equal(budget.budget_usd, null);
  });
});

// ── anomaly detection ───────────────────────

describe('getCostAnomalies', () => {
  test('no anomalies with uniform spending', () => {
    registerAgent({ agent_id: 'e1', model: 'gpt-4o' });
    for (let i = 0; i < 5; i++) {
      logLLMCall({ agent_id: 'e1', model: 'gpt-4o', input_tokens: 1000, output_tokens: 500 });
    }
    const result = getCostAnomalies();
    assert.equal(result.anomaly_count, 0);
  });

  test('detects spike when recent calls are 2x+ more expensive', () => {
    registerAgent({ agent_id: 'e2', model: 'gpt-4o-mini' });
    // 5 cheap calls
    for (let i = 0; i < 5; i++) {
      logLLMCall({ agent_id: 'e2', model: 'gpt-4o-mini', input_tokens: 100, output_tokens: 50 });
    }
    // 3 expensive calls (switch to opus)
    for (let i = 0; i < 3; i++) {
      logLLMCall({ agent_id: 'e2', model: 'claude-opus-4', input_tokens: 10000, output_tokens: 5000 });
    }
    const result = getCostAnomalies();
    assert.ok(result.anomaly_count >= 1);
    assert.equal(result.anomalies[0].agent_id, 'e2');
    assert.ok(result.anomalies[0].spike_factor >= 2);
  });
});

// ── compare_models ──────────────────────────

describe('compareModels', () => {
  test('returns empty when no calls logged', () => {
    const result = compareModels();
    assert.equal(result.model_count, 0);
    assert.equal(result.cheapest, null);
  });

  test('identifies cheapest and most expensive models', () => {
    registerAgent({ agent_id: 'f1', model: 'gpt-4o' });
    logLLMCall({ agent_id: 'f1', model: 'gpt-4o-mini', input_tokens: 1000, output_tokens: 500 });
    logLLMCall({ agent_id: 'f1', model: 'claude-opus-4', input_tokens: 1000, output_tokens: 500 });
    const result = compareModels();
    assert.equal(result.model_count, 2);
    assert.equal(result.cheapest, 'gpt-4o-mini');
    assert.equal(result.most_expensive, 'claude-opus-4');
  });
});

// ── getSummary ──────────────────────────────

describe('getSummary', () => {
  test('returns zeros when no agents registered', () => {
    const s = getSummary();
    assert.equal(s.total_agents, 0);
    assert.equal(s.total_cost_usd, 0);
  });

  test('sums across all agents', () => {
    registerAgent({ agent_id: 'g1', model: 'gpt-4o' });
    registerAgent({ agent_id: 'g2', model: 'gpt-4o' });
    logLLMCall({ agent_id: 'g1', model: 'gpt-4o', input_tokens: 1000, output_tokens: 500 });
    logToolCall({ agent_id: 'g2', tool_name: 'search', duration_ms: 100, cost_usd: 0.05 });
    const s = getSummary();
    assert.equal(s.total_agents, 2);
    assert.ok(s.total_cost_usd > 0);
    assert.ok(s.total_llm_cost_usd > 0);
    assert.ok(s.total_tool_cost_usd > 0);
  });
});
