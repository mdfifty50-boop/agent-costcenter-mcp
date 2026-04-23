/**
 * In-memory storage for agent cost center data.
 * All state lives in Maps — no persistence, no dependencies.
 */

import { resolveModelPricing, calculateCost } from './pricing.js';

// ── Core stores ──────────────────────────────────────

/** @type {Map<string, AgentRecord>} */
export const agents = new Map();

/** @type {Map<string, BudgetAlert>} */
export const budgetAlerts = new Map();

// ── Types (JSDoc) ────────────────────────────────────

/**
 * @typedef {Object} LLMCall
 * @property {string} model
 * @property {number} input_tokens
 * @property {number} output_tokens
 * @property {number} cost_usd
 * @property {string} timestamp
 */

/**
 * @typedef {Object} ToolCallEntry
 * @property {string} tool_name
 * @property {number} duration_ms
 * @property {number} cost_usd
 * @property {string} timestamp
 */

/**
 * @typedef {Object} AgentRecord
 * @property {string} agent_id
 * @property {string} team
 * @property {string} project
 * @property {string} default_model
 * @property {number|null} budget_cap_usd
 * @property {number} total_llm_cost_usd
 * @property {number} total_tool_cost_usd
 * @property {number} total_llm_calls
 * @property {LLMCall[]} llm_calls
 * @property {ToolCallEntry[]} tool_calls
 * @property {string} registered_at
 */

/**
 * @typedef {Object} BudgetAlert
 * @property {string} agent_id
 * @property {number} threshold_usd
 * @property {'warn'|'block'} action
 */

// ── Agent management ─────────────────────────────────

/**
 * Register a new agent or update an existing one.
 */
export function registerAgent({ agent_id, team, project, model, budget_cap_usd }) {
  const existing = agents.get(agent_id);
  const record = {
    agent_id,
    team: team || (existing?.team ?? ''),
    project: project || (existing?.project ?? ''),
    default_model: model,
    budget_cap_usd: budget_cap_usd ?? (existing?.budget_cap_usd ?? null),
    total_llm_cost_usd: existing?.total_llm_cost_usd ?? 0,
    total_tool_cost_usd: existing?.total_tool_cost_usd ?? 0,
    total_llm_calls: existing?.total_llm_calls ?? 0,
    llm_calls: existing?.llm_calls ?? [],
    tool_calls: existing?.tool_calls ?? [],
    registered_at: existing?.registered_at ?? new Date().toISOString(),
  };
  agents.set(agent_id, record);
  return record;
}

// ── LLM call logging ────────────────────────────────

/**
 * Log an LLM API call. Auto-calculates cost from pricing table if no override.
 * Returns the computed cost details.
 */
export function logLLMCall({ agent_id, model, input_tokens, output_tokens, cost_override_usd }) {
  const agent = agents.get(agent_id);
  if (!agent) throw new Error(`Agent "${agent_id}" not registered. Call register_agent first.`);

  let cost_usd;
  if (cost_override_usd !== undefined && cost_override_usd !== null) {
    cost_usd = cost_override_usd;
  } else {
    const pricing = resolveModelPricing(model);
    if (pricing) {
      cost_usd = calculateCost(input_tokens, output_tokens, pricing);
    } else {
      cost_usd = 0; // unknown model, zero cost (caller should provide override)
    }
  }

  const entry = {
    model,
    input_tokens,
    output_tokens,
    cost_usd,
    timestamp: new Date().toISOString(),
  };

  agent.llm_calls.push(entry);
  agent.total_llm_cost_usd += cost_usd;
  agent.total_llm_calls += 1;

  const totalSpend = agent.total_llm_cost_usd + agent.total_tool_cost_usd;
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

/**
 * Log a tool/API call cost for an agent.
 */
export function logToolCall({ agent_id, tool_name, duration_ms, cost_usd }) {
  const agent = agents.get(agent_id);
  if (!agent) throw new Error(`Agent "${agent_id}" not registered. Call register_agent first.`);

  const entry = {
    tool_name,
    duration_ms,
    cost_usd: cost_usd || 0,
    timestamp: new Date().toISOString(),
  };

  agent.tool_calls.push(entry);
  agent.total_tool_cost_usd += entry.cost_usd;

  return {
    logged: true,
    tool_cost_usd: round(entry.cost_usd),
    total_tool_costs_usd: round(agent.total_tool_cost_usd),
  };
}

// ── Cost reports ────────────────────────────────────

/**
 * Generate a cost report scoped by agent, team, project, or all.
 */
export function getCostReport({ scope, filter }) {
  let targetAgents = [];

  if (scope === 'agent') {
    const a = agents.get(filter);
    if (a) targetAgents = [a];
  } else if (scope === 'team') {
    for (const a of agents.values()) {
      if (a.team === filter) targetAgents.push(a);
    }
  } else if (scope === 'project') {
    for (const a of agents.values()) {
      if (a.project === filter) targetAgents.push(a);
    }
  } else {
    // 'all'
    targetAgents = [...agents.values()];
  }

  if (targetAgents.length === 0) {
    return { scope, filter: filter || null, total_spend_usd: 0, agent_count: 0, agents: [], model_breakdown: {} };
  }

  let totalSpend = 0;
  const modelTotals = {};
  const agentBreakdowns = [];

  for (const agent of targetAgents) {
    const agentTotal = agent.total_llm_cost_usd + agent.total_tool_cost_usd;
    totalSpend += agentTotal;

    // Per-model breakdown for this agent
    const perModel = {};
    for (const call of agent.llm_calls) {
      if (!perModel[call.model]) {
        perModel[call.model] = { calls: 0, cost_usd: 0, input_tokens: 0, output_tokens: 0 };
      }
      perModel[call.model].calls += 1;
      perModel[call.model].cost_usd += call.cost_usd;
      perModel[call.model].input_tokens += call.input_tokens;
      perModel[call.model].output_tokens += call.output_tokens;

      // Accumulate global model totals
      if (!modelTotals[call.model]) {
        modelTotals[call.model] = { calls: 0, cost_usd: 0, input_tokens: 0, output_tokens: 0 };
      }
      modelTotals[call.model].calls += 1;
      modelTotals[call.model].cost_usd += call.cost_usd;
      modelTotals[call.model].input_tokens += call.input_tokens;
      modelTotals[call.model].output_tokens += call.output_tokens;
    }

    // Round model costs
    for (const m of Object.values(perModel)) {
      m.cost_usd = round(m.cost_usd);
      m.avg_cost_per_call = m.calls > 0 ? round(m.cost_usd / m.calls) : 0;
    }

    agentBreakdowns.push({
      agent_id: agent.agent_id,
      team: agent.team,
      project: agent.project,
      llm_cost_usd: round(agent.total_llm_cost_usd),
      tool_cost_usd: round(agent.total_tool_cost_usd),
      total_cost_usd: round(agentTotal),
      total_calls: agent.total_llm_calls,
      percentage_of_total: 0, // filled below
      model_breakdown: perModel,
    });
  }

  // Compute percentages
  for (const ab of agentBreakdowns) {
    ab.percentage_of_total = totalSpend > 0
      ? round((ab.total_cost_usd / totalSpend) * 100)
      : 0;
  }

  // Round global model totals
  for (const m of Object.values(modelTotals)) {
    m.cost_usd = round(m.cost_usd);
    m.avg_cost_per_call = m.calls > 0 ? round(m.cost_usd / m.calls) : 0;
  }

  // Sort agents by cost descending
  agentBreakdowns.sort((a, b) => b.total_cost_usd - a.total_cost_usd);

  return {
    scope,
    filter: filter || null,
    total_spend_usd: round(totalSpend),
    agent_count: targetAgents.length,
    agents: agentBreakdowns,
    model_breakdown: modelTotals,
  };
}

// ── Budget management ───────────────────────────────

/**
 * Set a budget alert threshold for an agent.
 */
export function setBudgetAlert({ agent_id, threshold_usd, action }) {
  const agent = agents.get(agent_id);
  if (!agent) throw new Error(`Agent "${agent_id}" not registered.`);

  const alert = { agent_id, threshold_usd, action };
  budgetAlerts.set(agent_id, alert);
  return {
    set: true,
    agent_id,
    threshold_usd,
    action,
    current_spend_usd: round(agent.total_llm_cost_usd + agent.total_tool_cost_usd),
  };
}

/**
 * Check if an agent is within its budget.
 */
export function checkBudget(agent_id) {
  const agent = agents.get(agent_id);
  if (!agent) throw new Error(`Agent "${agent_id}" not registered.`);

  const spent = agent.total_llm_cost_usd + agent.total_tool_cost_usd;
  const budget = agent.budget_cap_usd;
  const alert = budgetAlerts.get(agent_id);

  if (budget === null) {
    return {
      within_budget: true,
      spent_usd: round(spent),
      budget_usd: null,
      remaining_usd: null,
      percentage_used: null,
      action_if_exceeded: alert?.action || null,
      note: 'No budget cap set for this agent',
    };
  }

  return {
    within_budget: spent <= budget,
    spent_usd: round(spent),
    budget_usd: budget,
    remaining_usd: round(Math.max(0, budget - spent)),
    percentage_used: round((spent / budget) * 100),
    action_if_exceeded: alert?.action || 'warn',
  };
}

// ── Anomaly detection ───────────────────────────────

/**
 * Find agents with unusual spending: per-call avg 2x+ above their own historical average.
 */
export function getCostAnomalies() {
  const anomalies = [];

  for (const agent of agents.values()) {
    if (agent.llm_calls.length < 3) continue; // need at least 3 calls to detect anomaly

    const costs = agent.llm_calls.map(c => c.cost_usd);
    const overallAvg = costs.reduce((s, c) => s + c, 0) / costs.length;

    if (overallAvg === 0) continue;

    // Check recent calls (last 3) vs historical average
    const recentCalls = costs.slice(-3);
    const recentAvg = recentCalls.reduce((s, c) => s + c, 0) / recentCalls.length;

    const spikeFactor = recentAvg / overallAvg;

    if (spikeFactor >= 2) {
      anomalies.push({
        agent_id: agent.agent_id,
        team: agent.team,
        project: agent.project,
        expected_avg_usd: round(overallAvg),
        actual_recent_avg_usd: round(recentAvg),
        spike_factor: round(spikeFactor),
        total_calls: agent.llm_calls.length,
        severity: spikeFactor >= 5 ? 'critical' : spikeFactor >= 3 ? 'high' : 'medium',
      });
    }
  }

  anomalies.sort((a, b) => b.spike_factor - a.spike_factor);

  return {
    anomaly_count: anomalies.length,
    anomalies,
    checked_agents: agents.size,
  };
}

// ── Model comparison ────────────────────────────────

/**
 * Compare cost efficiency across all models used.
 */
export function compareModels() {
  const modelStats = {};

  for (const agent of agents.values()) {
    for (const call of agent.llm_calls) {
      if (!modelStats[call.model]) {
        modelStats[call.model] = {
          model: call.model,
          total_calls: 0,
          total_cost_usd: 0,
          total_input_tokens: 0,
          total_output_tokens: 0,
        };
      }
      const ms = modelStats[call.model];
      ms.total_calls += 1;
      ms.total_cost_usd += call.cost_usd;
      ms.total_input_tokens += call.input_tokens;
      ms.total_output_tokens += call.output_tokens;
    }
  }

  const models = Object.values(modelStats).map(ms => {
    const totalTokens = ms.total_input_tokens + ms.total_output_tokens;
    return {
      ...ms,
      total_cost_usd: round(ms.total_cost_usd),
      total_tokens: totalTokens,
      cost_per_1k_tokens: totalTokens > 0
        ? round((ms.total_cost_usd / totalTokens) * 1000)
        : 0,
      avg_cost_per_call: ms.total_calls > 0
        ? round(ms.total_cost_usd / ms.total_calls)
        : 0,
    };
  });

  models.sort((a, b) => a.cost_per_1k_tokens - b.cost_per_1k_tokens);

  const cheapest = models.length > 0 ? models[0].model : null;
  const mostExpensive = models.length > 0 ? models[models.length - 1].model : null;

  return {
    model_count: models.length,
    models,
    cheapest,
    most_expensive: mostExpensive,
    total_spend_usd: round(models.reduce((s, m) => s + m.total_cost_usd, 0)),
  };
}

// ── Summary (for resources) ─────────────────────────

/**
 * Get a total summary across all agents.
 */
export function getSummary() {
  let totalLLM = 0;
  let totalTool = 0;
  let totalCalls = 0;

  for (const agent of agents.values()) {
    totalLLM += agent.total_llm_cost_usd;
    totalTool += agent.total_tool_cost_usd;
    totalCalls += agent.total_llm_calls;
  }

  return {
    total_agents: agents.size,
    total_llm_cost_usd: round(totalLLM),
    total_tool_cost_usd: round(totalTool),
    total_cost_usd: round(totalLLM + totalTool),
    total_llm_calls: totalCalls,
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
  agents.clear();
  budgetAlerts.clear();
}
