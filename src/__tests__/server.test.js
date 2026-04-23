import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { registerAgent, logLLMCall, logToolCall, getCostReport, checkBudget, _resetAll } from '../storage.js';

describe('agent-costcenter-mcp', () => {
  const AGENT = 'test-agent-' + Date.now();
  
  it('registers an agent', () => {
    _resetAll();
    const result = registerAgent({ agent_id: AGENT, team: 'eng', project: 'test', model: 'claude-sonnet-4', budget_cap_usd: 10 });
    assert.equal(result.agent_id, AGENT);
    assert.equal(result.budget_cap_usd, 10);
  });

  it('logs an LLM call with auto-pricing', () => {
    const result = logLLMCall({ agent_id: AGENT, model: 'claude-sonnet-4', input_tokens: 1000, output_tokens: 500 });
    assert.equal(result.logged, true);
    assert.ok(result.call_cost_usd >= 0);
  });

  it('logs a tool call', () => {
    const result = logToolCall({ agent_id: AGENT, tool_name: 'search', duration_ms: 200, cost_usd: 0.001 });
    assert.equal(result.logged, true);
  });

  it('generates cost report', () => {
    const report = getCostReport({ scope: 'agent', filter: AGENT });
    assert.equal(report.agent_count, 1);
    assert.ok(report.total_spend_usd >= 0);
  });

  it('checks budget status', () => {
    const result = checkBudget(AGENT);
    assert.equal(result.within_budget, true);
    assert.ok(result.percentage_used >= 0);
  });

  it('throws for unregistered agent', () => {
    assert.throws(() => logLLMCall({ agent_id: 'nonexistent', model: 'gpt-4', input_tokens: 100, output_tokens: 50 }));
  });
});
