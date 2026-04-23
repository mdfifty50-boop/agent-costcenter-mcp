# agent-costcenter-mcp

MCP server for per-agent cost attribution and budget management. Answer "which agent costs the most?" across your entire AI agent fleet.

## Features

- **Per-agent cost tracking** — register agents, log LLM and tool calls, get per-agent spend
- **Built-in pricing table** — 11 models (Claude, GPT, Gemini, DeepSeek) with fuzzy name matching
- **Budget management** — set caps and alerts, check remaining budget, warn or block on overspend
- **Cost reports** — breakdown by agent, team, project, or all; includes model-level detail and percentages
- **Anomaly detection** — automatically flag agents with 2x+ spending spikes
- **Model comparison** — compare cost-per-1K-tokens across all models used

## Quick Start

```bash
npx agent-costcenter-mcp
```

### Claude Desktop

```json
{
  "mcpServers": {
    "agent-costcenter": {
      "command": "npx",
      "args": ["agent-costcenter-mcp"]
    }
  }
}
```

## Tools

| Tool | Description |
|------|-------------|
| `register_agent` | Register agent with team, project, model, and budget cap |
| `log_llm_call` | Log an LLM call — auto-calculates cost from pricing table |
| `log_tool_call` | Log a tool/API call cost |
| `get_cost_report` | Cost breakdown by agent, team, project, or all |
| `set_budget_alert` | Set spending threshold (warn or block) |
| `check_budget` | Check if agent is within budget |
| `get_cost_anomalies` | Find agents with unusual spending spikes |
| `compare_models` | Compare cost efficiency across models |

## Resources

| URI | Description |
|-----|-------------|
| `costcenter://summary` | Current total spend across all agents |
| `costcenter://pricing` | Built-in model pricing table |

## Built-in Pricing (per 1M tokens)

| Model | Input | Output |
|-------|-------|--------|
| claude-opus-4 | $15.00 | $75.00 |
| claude-sonnet-4 | $3.00 | $15.00 |
| claude-haiku-4 | $0.80 | $4.00 |
| gpt-4o | $2.50 | $10.00 |
| gpt-4o-mini | $0.15 | $0.60 |
| gpt-4.1 | $2.00 | $8.00 |
| gpt-4.1-mini | $0.40 | $1.60 |
| gemini-2.5-pro | $1.25 | $10.00 |
| gemini-2.5-flash | $0.15 | $0.60 |
| deepseek-v3 | $0.27 | $1.10 |
| deepseek-r1 | $0.55 | $2.19 |

Model names are fuzzy-matched (case-insensitive, strips version suffixes).

## Example Workflow

```
1. register_agent(agent_id="researcher", team="discovery", model="claude-sonnet-4", budget_cap_usd=10)
2. log_llm_call(agent_id="researcher", model="claude-sonnet-4", input_tokens=5000, output_tokens=2000)
3. log_tool_call(agent_id="researcher", tool_name="web_search", duration_ms=1200, cost_usd=0.01)
4. check_budget(agent_id="researcher")
5. get_cost_report(scope="all")
6. get_cost_anomalies()
7. compare_models()
```

## Development

```bash
npm install
npm test
npm run dev  # watch mode
```

## License

MIT
