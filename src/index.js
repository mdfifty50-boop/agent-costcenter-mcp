#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { MODEL_PRICING } from './pricing.js';
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
} from './storage.js';

const server = new McpServer({
  name: 'agent-costcenter-mcp',
  version: '0.1.0',
  description: 'Per-agent cost attribution and budget management for AI agent fleets',
});

// ═══════════════════════════════════════════
// TOOL: register_agent
// ═══════════════════════════════════════════

server.tool(
  'register_agent',
  'Register an agent with optional team, project, model, and budget cap. Must be called before logging costs.',
  {
    agent_id: z.string().describe('Unique agent identifier'),
    team: z.string().optional().describe('Team the agent belongs to'),
    project: z.string().optional().describe('Project the agent is working on'),
    model: z.string().describe('Default model used by this agent'),
    budget_cap_usd: z.number().optional().describe('Maximum budget in USD (null = unlimited)'),
  },
  async (params) => {
    const record = registerAgent(params);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          registered: true,
          agent_id: record.agent_id,
          team: record.team,
          project: record.project,
          model: record.default_model,
          budget_cap_usd: record.budget_cap_usd,
          registered_at: record.registered_at,
        }, null, 2),
      }],
    };
  }
);

// ═══════════════════════════════════════════
// TOOL: log_llm_call
// ═══════════════════════════════════════════

server.tool(
  'log_llm_call',
  'Log an LLM API call with token counts. Auto-calculates cost from built-in pricing table, or use cost_override_usd.',
  {
    agent_id: z.string().describe('Agent that made the call'),
    model: z.string().describe('Model name (e.g. claude-sonnet-4, gpt-4o)'),
    input_tokens: z.number().int().min(0).describe('Number of input tokens'),
    output_tokens: z.number().int().min(0).describe('Number of output tokens'),
    cost_override_usd: z.number().optional().describe('Override auto-calculated cost with explicit USD amount'),
  },
  async (params) => {
    try {
      const result = logLLMCall(params);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: err.message }, null, 2) }],
        isError: true,
      };
    }
  }
);

// ═══════════════════════════════════════════
// TOOL: log_tool_call
// ═══════════════════════════════════════════

server.tool(
  'log_tool_call',
  'Log a tool or API call cost for an agent, with duration and optional cost.',
  {
    agent_id: z.string().describe('Agent that made the call'),
    tool_name: z.string().describe('Name of the tool or API called'),
    duration_ms: z.number().int().min(0).describe('Call duration in milliseconds'),
    cost_usd: z.number().default(0).describe('Cost of the tool call in USD'),
  },
  async (params) => {
    try {
      const result = logToolCall(params);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: err.message }, null, 2) }],
        isError: true,
      };
    }
  }
);

// ═══════════════════════════════════════════
// TOOL: get_cost_report
// ═══════════════════════════════════════════

server.tool(
  'get_cost_report',
  'Get cost breakdown by agent, team, project, or across all agents. Includes per-model breakdowns and percentages.',
  {
    scope: z.enum(['agent', 'team', 'project', 'all']).describe('Scope of the report'),
    filter: z.string().optional().describe('Filter value: agent_id, team name, or project name (required for agent/team/project scope)'),
  },
  async (params) => {
    const report = getCostReport(params);
    return {
      content: [{ type: 'text', text: JSON.stringify(report, null, 2) }],
    };
  }
);

// ═══════════════════════════════════════════
// TOOL: set_budget_alert
// ═══════════════════════════════════════════

server.tool(
  'set_budget_alert',
  'Set a spending threshold for an agent. When exceeded, either warn or block further calls.',
  {
    agent_id: z.string().describe('Agent to set the alert for'),
    threshold_usd: z.number().min(0).describe('Spending threshold in USD'),
    action: z.enum(['warn', 'block']).describe('Action when threshold is exceeded'),
  },
  async (params) => {
    try {
      const result = setBudgetAlert(params);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: err.message }, null, 2) }],
        isError: true,
      };
    }
  }
);

// ═══════════════════════════════════════════
// TOOL: check_budget
// ═══════════════════════════════════════════

server.tool(
  'check_budget',
  'Check if an agent is within its budget. Returns spend, remaining budget, and percentage used.',
  {
    agent_id: z.string().describe('Agent to check'),
  },
  async ({ agent_id }) => {
    try {
      const result = checkBudget(agent_id);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: err.message }, null, 2) }],
        isError: true,
      };
    }
  }
);

// ═══════════════════════════════════════════
// TOOL: get_cost_anomalies
// ═══════════════════════════════════════════

server.tool(
  'get_cost_anomalies',
  'Find agents with unusual spending patterns. Flags agents whose recent per-call average is 2x+ above their historical average.',
  {},
  async () => {
    const result = getCostAnomalies();
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ═══════════════════════════════════════════
// TOOL: compare_models
// ═══════════════════════════════════════════

server.tool(
  'compare_models',
  'Compare cost efficiency across all models used. Shows cost per 1K tokens, total spend, cheapest and most expensive.',
  {},
  async () => {
    const result = compareModels();
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ═══════════════════════════════════════════
// RESOURCES
// ═══════════════════════════════════════════

server.resource(
  'cost-summary',
  'costcenter://summary',
  async () => ({
    contents: [{
      uri: 'costcenter://summary',
      mimeType: 'application/json',
      text: JSON.stringify(getSummary(), null, 2),
    }],
  })
);

server.resource(
  'pricing-table',
  'costcenter://pricing',
  async () => ({
    contents: [{
      uri: 'costcenter://pricing',
      mimeType: 'application/json',
      text: JSON.stringify(MODEL_PRICING, null, 2),
    }],
  })
);

// ═══════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Agent Cost Center MCP Server running on stdio');
}

main().catch(console.error);
