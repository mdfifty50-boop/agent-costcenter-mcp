/**
 * SQLite-backed storage for agent cost center data.
 * All state persists to ~/.agent-costcenter-mcp/costs.db
 */

import { resolveModelPricing, calculateCost } from './pricing.js';
import { getDb } from './db.js';

// ── Agent management ─────────────────────────────────

/**
 * Register a new agent or update an existing one.
 */
export function registerAgent({ agent_id, team, project, model, budget_cap_usd }) {
  const db = getDb();
  const now = new Date().toISOString();

  const existing = db.prepare('SELECT * FROM agents WHERE agent_id = ?').get(agent_id);

  db.prepare(`
    INSERT INTO agents (agent_id, team, project, default_model, budget_cap_usd, registered_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_id) DO UPDATE SET
      team = excluded.team,
      project = excluded.project,
      default_model = excluded.default_model,
      budget_cap_usd = excluded.budget_cap_usd
  `).run(
    agent_id,
    team || existing?.team || '',
    project || existing?.project || '',
    model,
    budget_cap_usd !== undefined ? budget_cap_usd : (existing?.budget_cap_usd ?? null),
    existing?.registered_at || now
  );

  return _getAgentRecord(agent_id);
}

function _getAgentRecord(agent_id) {
  const db = getDb();
  const agent = db.prepare('SELECT * FROM agents WHERE agent_id = ?').get(agent_id);
  if (!agent) return null;

  const llmCalls = db.prepare('SELECT * FROM cost_entries WHERE agent_id = ? ORDER BY timestamp ASC').all(agent_id);
  const toolCalls = db.prepare('SELECT * FROM tool_calls WHERE agent_id = ? ORDER BY timestamp ASC').all(agent_id);

  const total_llm_cost_usd = llmCalls.reduce((s, r) => s + r.cost_usd, 0);
  const total_tool_cost_usd = toolCalls.reduce((s, r) => s + r.cost_usd, 0);
  const total_llm_calls = llmCalls.length;

  return {
    agent_id: agent.agent_id,
    team: agent.team,
    project: agent.project,
    default_model: agent.default_model,
    budget_cap_usd: agent.budget_cap_usd,
    total_llm_cost_usd,
    total_tool_cost_usd,
    total_llm_calls,
    llm_calls: llmCalls.map((r) => ({
      model: r.model,
      input_tokens: r.input_tokens,
      output_tokens: r.output_tokens,
      cost_usd: r.cost_usd,
      timestamp: r.timestamp,
    })),
    tool_calls: toolCalls.map((r) => ({
      tool_name: r.tool_name,
      duration_ms: r.duration_ms,
      cost_usd: r.cost_usd,
      timestamp: r.timestamp,
    })),
    registered_at: agent.registered_at,
  };
}

// ── LLM call logging ────────────────────────────────

export function logLLMCall({ agent_id, model, input_tokens, output_tokens, cost_override_usd }) {
  const db = getDb();
  const agent = db.prepare('SELECT * FROM agents WHERE agent_id = ?').get(agent_id);
  if (!agent) throw new Error(`Agent "${agent_id}" not registered. Call register_agent first.`);

  let cost_usd;
  if (cost_override_usd !== undefined && cost_override_usd !== null) {
    cost_usd = cost_override_usd;
  } else {
    const pricing = resolveModelPricing(model);
    cost_usd = pricing ? calculateCost(input_tokens, output_tokens, pricing) : 0;
  }

  db.prepare(`
    INSERT INTO cost_entries (agent_id, department, model, input_tokens, output_tokens, cost_usd, task_id, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(agent_id, agent.team, model, input_tokens, output_tokens, cost_usd, '', new Date().toISOString());

  const totals = db.prepare(`
    SELECT COALESCE(SUM(ce.cost_usd), 0) AS llm_total, COALESCE(SUM(tc.cost_usd), 0) AS tool_total
    FROM (SELECT SUM(cost_usd) AS cost_usd FROM cost_entries WHERE agent_id = ?) ce,
         (SELECT SUM(cost_usd) AS cost_usd FROM tool_calls WHERE agent_id = ?) tc
  `).get(agent_id, agent_id);

  const totalSpend = (totals.llm_total || 0) + (totals.tool_total || 0);
  const budgetRemaining = agent.budget_cap_usd !== null
    ? Math.max(0, agent.budget_cap_usd - totalSpend)
    : null;
  const budgetWarning = agent.budget_cap_usd !== null && totalSpend >= agent.budget_cap_usd * 0.8;

  return {
    logged: true,
    call_cost_usd: round(cost_usd),
    session_total_usd: round(totalSpend),
    budget_remaining_usd: budgetRemaining !== null ? round(budgetRemaining) : null,
    budget_warning: budgetWarning,
  };
}

// ── Tool call logging ───────────────────────────────

export function logToolCall({ agent_id, tool_name, duration_ms, cost_usd }) {
  const db = getDb();
  const agent = db.prepare('SELECT * FROM agents WHERE agent_id = ?').get(agent_id);
  if (!agent) throw new Error(`Agent "${agent_id}" not registered. Call register_agent first.`);

  const cost = cost_usd || 0;

  db.prepare(`
    INSERT INTO tool_calls (agent_id, tool_name, duration_ms, cost_usd, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `).run(agent_id, tool_name, duration_ms, cost, new Date().toISOString());

  const total = db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM tool_calls WHERE agent_id = ?').get(agent_id).total;

  return {
    logged: true,
    tool_cost_usd: round(cost),
    total_tool_costs_usd: round(total),
  };
}

// ── Cost reports ────────────────────────────────────

export function getCostReport({ scope, filter }) {
  const db = getDb();
  let targetAgentIds = [];

  if (scope === 'agent') {
    const a = db.prepare('SELECT agent_id FROM agents WHERE agent_id = ?').get(filter);
    if (a) targetAgentIds = [a.agent_id];
  } else if (scope === 'team') {
    targetAgentIds = db.prepare('SELECT agent_id FROM agents WHERE team = ?').all(filter).map((r) => r.agent_id);
  } else if (scope === 'project') {
    targetAgentIds = db.prepare('SELECT agent_id FROM agents WHERE project = ?').all(filter).map((r) => r.agent_id);
  } else {
    targetAgentIds = db.prepare('SELECT agent_id FROM agents').all().map((r) => r.agent_id);
  }

  if (targetAgentIds.length === 0) {
    return { scope, filter: filter || null, total_spend_usd: 0, agent_count: 0, agents: [], model_breakdown: {} };
  }

  let totalSpend = 0;
  const modelTotals = {};
  const agentBreakdowns = [];

  for (const aid of targetAgentIds) {
    const record = _getAgentRecord(aid);
    if (!record) continue;

    const agentTotal = record.total_llm_cost_usd + record.total_tool_cost_usd;
    totalSpend += agentTotal;

    const perModel = {};
    for (const call of record.llm_calls) {
      if (!perModel[call.model]) perModel[call.model] = { calls: 0, cost_usd: 0, input_tokens: 0, output_tokens: 0 };
      perModel[call.model].calls += 1;
      perModel[call.model].cost_usd += call.cost_usd;
      perModel[call.model].input_tokens += call.input_tokens;
      perModel[call.model].output_tokens += call.output_tokens;

      if (!modelTotals[call.model]) modelTotals[call.model] = { calls: 0, cost_usd: 0, input_tokens: 0, output_tokens: 0 };
      modelTotals[call.model].calls += 1;
      modelTotals[call.model].cost_usd += call.cost_usd;
      modelTotals[call.model].input_tokens += call.input_tokens;
      modelTotals[call.model].output_tokens += call.output_tokens;
    }

    for (const m of Object.values(perModel)) {
      m.cost_usd = round(m.cost_usd);
      m.avg_cost_per_call = m.calls > 0 ? round(m.cost_usd / m.calls) : 0;
    }

    agentBreakdowns.push({
      agent_id: record.agent_id,
      team: record.team,
      project: record.project,
      llm_cost_usd: round(record.total_llm_cost_usd),
      tool_cost_usd: round(record.total_tool_cost_usd),
      total_cost_usd: round(agentTotal),
      total_calls: record.total_llm_calls,
      percentage_of_total: 0,
      model_breakdown: perModel,
    });
  }

  for (const ab of agentBreakdowns) {
    ab.percentage_of_total = totalSpend > 0 ? round((ab.total_cost_usd / totalSpend) * 100) : 0;
  }

  for (const m of Object.values(modelTotals)) {
    m.cost_usd = round(m.cost_usd);
    m.avg_cost_per_call = m.calls > 0 ? round(m.cost_usd / m.calls) : 0;
  }

  agentBreakdowns.sort((a, b) => b.total_cost_usd - a.total_cost_usd);

  return {
    scope,
    filter: filter || null,
    total_spend_usd: round(totalSpend),
    agent_count: targetAgentIds.length,
    agents: agentBreakdowns,
    model_breakdown: modelTotals,
  };
}

// ── Budget management ───────────────────────────────

export function setBudgetAlert({ agent_id, threshold_usd, action }) {
  const db = getDb();
  const agent = db.prepare('SELECT * FROM agents WHERE agent_id = ?').get(agent_id);
  if (!agent) throw new Error(`Agent "${agent_id}" not registered.`);

  db.prepare(`
    INSERT INTO budget_alerts (agent_id, threshold_usd, action)
    VALUES (?, ?, ?)
    ON CONFLICT(agent_id) DO UPDATE SET threshold_usd = excluded.threshold_usd, action = excluded.action
  `).run(agent_id, threshold_usd, action);

  const record = _getAgentRecord(agent_id);
  const spent = record.total_llm_cost_usd + record.total_tool_cost_usd;

  return {
    set: true,
    agent_id,
    threshold_usd,
    action,
    current_spend_usd: round(spent),
  };
}

export function checkBudget(agent_id) {
  const db = getDb();
  const agent = db.prepare('SELECT * FROM agents WHERE agent_id = ?').get(agent_id);
  if (!agent) throw new Error(`Agent "${agent_id}" not registered.`);

  const record = _getAgentRecord(agent_id);
  const spent = record.total_llm_cost_usd + record.total_tool_cost_usd;
  const budget = agent.budget_cap_usd;
  const alertRow = db.prepare('SELECT * FROM budget_alerts WHERE agent_id = ?').get(agent_id);

  if (budget === null) {
    return {
      within_budget: true,
      spent_usd: round(spent),
      budget_usd: null,
      remaining_usd: null,
      percentage_used: null,
      action_if_exceeded: alertRow?.action || null,
      note: 'No budget cap set for this agent',
    };
  }

  return {
    within_budget: spent <= budget,
    spent_usd: round(spent),
    budget_usd: budget,
    remaining_usd: round(Math.max(0, budget - spent)),
    percentage_used: round((spent / budget) * 100),
    action_if_exceeded: alertRow?.action || 'warn',
  };
}

// ── Anomaly detection ───────────────────────────────

export function getCostAnomalies() {
  const db = getDb();
  const agentIds = db.prepare('SELECT agent_id FROM agents').all().map((r) => r.agent_id);
  const anomalies = [];

  for (const aid of agentIds) {
    const costs = db.prepare(
      'SELECT cost_usd FROM cost_entries WHERE agent_id = ? ORDER BY timestamp ASC'
    ).all(aid).map((r) => r.cost_usd);

    if (costs.length < 3) continue;

    const overallAvg = costs.reduce((s, c) => s + c, 0) / costs.length;
    if (overallAvg === 0) continue;

    const recentCalls = costs.slice(-3);
    const recentAvg = recentCalls.reduce((s, c) => s + c, 0) / recentCalls.length;
    const spikeFactor = recentAvg / overallAvg;

    if (spikeFactor >= 2) {
      const agent = db.prepare('SELECT * FROM agents WHERE agent_id = ?').get(aid);
      anomalies.push({
        agent_id: aid,
        team: agent.team,
        project: agent.project,
        expected_avg_usd: round(overallAvg),
        actual_recent_avg_usd: round(recentAvg),
        spike_factor: round(spikeFactor),
        total_calls: costs.length,
        severity: spikeFactor >= 5 ? 'critical' : spikeFactor >= 3 ? 'high' : 'medium',
      });
    }
  }

  anomalies.sort((a, b) => b.spike_factor - a.spike_factor);

  return {
    anomaly_count: anomalies.length,
    anomalies,
    checked_agents: agentIds.length,
  };
}

// ── Model comparison ────────────────────────────────

export function compareModels() {
  const db = getDb();
  const rows = db.prepare('SELECT model, COUNT(*) as calls, SUM(cost_usd) as cost, SUM(input_tokens) as input_tokens, SUM(output_tokens) as output_tokens FROM cost_entries GROUP BY model').all();

  if (rows.length === 0) {
    return { model_count: 0, models: [], cheapest: null, most_expensive: null, total_spend_usd: 0 };
  }

  const models = rows.map((r) => {
    const totalTokens = r.input_tokens + r.output_tokens;
    return {
      model: r.model,
      total_calls: r.calls,
      total_cost_usd: round(r.cost),
      total_input_tokens: r.input_tokens,
      total_output_tokens: r.output_tokens,
      total_tokens: totalTokens,
      cost_per_1k_tokens: totalTokens > 0 ? round((r.cost / totalTokens) * 1000) : 0,
      avg_cost_per_call: r.calls > 0 ? round(r.cost / r.calls) : 0,
    };
  });

  models.sort((a, b) => a.cost_per_1k_tokens - b.cost_per_1k_tokens);

  return {
    model_count: models.length,
    models,
    cheapest: models[0].model,
    most_expensive: models[models.length - 1].model,
    total_spend_usd: round(models.reduce((s, m) => s + m.total_cost_usd, 0)),
  };
}

// ── Summary ─────────────────────────────────────────

export function getSummary() {
  const db = getDb();
  const agentCount = db.prepare('SELECT COUNT(*) AS cnt FROM agents').get().cnt;
  const llmTotals = db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total, COUNT(*) AS calls FROM cost_entries').get();
  const toolTotals = db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM tool_calls').get();

  return {
    total_agents: agentCount,
    total_llm_cost_usd: round(llmTotals.total),
    total_tool_cost_usd: round(toolTotals.total),
    total_cost_usd: round(llmTotals.total + toolTotals.total),
    total_llm_calls: llmTotals.calls,
  };
}

// ── Helpers ─────────────────────────────────────────

function round(n) {
  return parseFloat(n.toFixed(6));
}

/**
 * Clear all state — used in tests.
 */
export function _resetAll() {
  const db = getDb();
  db.exec('DELETE FROM cost_entries; DELETE FROM budgets; DELETE FROM agents; DELETE FROM tool_calls; DELETE FROM budget_alerts;');
}

// Keep the exported Maps for backward compatibility (tests may reference these)
// These are now proxies that always read from DB — for test compatibility
export const agents = {
  get size() {
    return getDb().prepare('SELECT COUNT(*) AS cnt FROM agents').get().cnt;
  },
  values() {
    const agentIds = getDb().prepare('SELECT agent_id FROM agents').all().map((r) => r.agent_id);
    return agentIds.map(_getAgentRecord).filter(Boolean)[Symbol.iterator]();
  },
};

export const budgetAlerts = {
  get(agent_id) {
    return getDb().prepare('SELECT * FROM budget_alerts WHERE agent_id = ?').get(agent_id);
  },
  set(agent_id, alert) {
    // handled via setBudgetAlert
  },
};
