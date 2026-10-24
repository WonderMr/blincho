# Local MCP

[Back to the overview](../README.md)

Desktop settings include an optional **Local MCP** switch, off by default. Turn it on to connect a local AI client, then choose **Copy connection** for the server URL and Bearer token in MCP JSON format. The listener binds only to `127.0.0.1`, prefers port `47831`, and uses a free local port if that port is occupied. Disabling the switch closes the listener and discards pending commands. Re-enabling or restarting changes the token, so copy the connection again.

The stateless Streamable HTTP endpoint supports `get_status`, `get_settings`, `get_today_stats`, `get_data_range`, `get_stats`, `start_break`, `pause_timer`, `resume_timer` and `skip_break`. Actions are queued requests, then checked against the current app state. They respect presence checks, active exercises, pending camera checks and strict breaks. Poll `get_status` to observe the result. Settings and daily aggregate totals are shared; detailed activity/call history, journal answers and camera frames are excluded. Browser access is not supported.

`get_data_range` reports `dataStartDate`, `dataEndDate`, `activityStartDate`, `recordedDays` and the device's `timeZone`. The first two dates describe saved daily counters; `activityStartDate` is the first saved date with activity observations and can be later or `null` for older history. These are available-data boundaries, not the installation date or a guarantee of continuous recording.

`get_stats` accepts inclusive local calendar dates `startDate` and `endDate` (`YYYY-MM-DD`) and `groupBy: "day"` (default) or `"week"` (Monday through Sunday). Omitted bounds use the first and last saved dates. For one day, set both dates to that day. Each result includes focus minutes, completed breaks/exercises and observed work, away, manual pause, rest and recorded minutes. Observed work is separate from older focus counters. Missing dates have no period record; `recordedDays` and `calendarDays` make gaps visible. Weekly bounds are clipped to the requested range. `totals` always covers the entire range; paginate `periods` with `offset` (default 0) and `limit` (default 100, maximum 366), following `hasMore`. Empty history has `null` data boundaries and zero totals.

For example, call `get_stats` with `{"startDate":"2026-10-01","endDate":"2026-10-18","groupBy":"week"}` to compare calendar weeks in that range. Neither tool returns individual activity intervals or call names. The MCP projection omits invalid calendar dates and keeps the first saved record for a duplicate date. Completion counts are rounded down to nonnegative safe integers and invalid numeric totals become zero; these rules do not modify saved history.

## Client setup

Run the desktop app and your AI client on the same computer. Set `BLINCHO_MCP_TOKEN` in the client's environment to the value after `Bearer ` in the `Authorization` header from **Copy connection**, without the `Bearer ` prefix. Use the actual URL shown by Blincho if its port differs from the examples. Blincho includes the MCP server, so no separate server package is needed. Keep the token private and out of committed configuration. After Blincho restarts or Local MCP is re-enabled, copy the new token, update the client process's environment and restart the client. Reconnecting alone does not update an already-running process's environment.

### Codex

Use the copied URL in an HTTP MCP entry and provide the token through an environment variable:

```toml
[mcp_servers.blincho]
url = "http://127.0.0.1:47831/mcp"
bearer_token_env_var = "BLINCHO_MCP_TOKEN"
```

See [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

### Claude Code

Add the following entry to `.mcp.json` in your project, merging it with any existing `mcpServers`. Claude Code expands `${BLINCHO_MCP_TOKEN}` from its environment:

```json
{
  "mcpServers": {
    "blincho": {
      "type": "http",
      "url": "http://127.0.0.1:47831/mcp",
      "headers": {
        "Authorization": "Bearer ${BLINCHO_MCP_TOKEN}"
      }
    }
  }
}
```

Start Claude Code with the token available in its environment, approve the project server when prompted, and use `/mcp` to check the connection. See [Claude Code MCP configuration](https://code.claude.com/docs/en/mcp).

### Cursor

Merge this entry into `.cursor/mcp.json` for one project or `~/.cursor/mcp.json` for all projects. Cursor uses `${env:BLINCHO_MCP_TOKEN}` for environment-variable interpolation:

```json
{
  "mcpServers": {
    "blincho": {
      "url": "http://127.0.0.1:47831/mcp",
      "headers": {
        "Authorization": "Bearer ${env:BLINCHO_MCP_TOKEN}"
      }
    }
  }
}
```

Make the token available to the Cursor process before launching it. Restart Cursor after adding or editing this configuration. In Agent chat, enable the `blincho` tools and ask for your current break status or work-time statistics. See [Cursor MCP configuration](https://cursor.com/docs/mcp).

All examples use Blincho's [Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports). The tool reference and agent usage rules are in [AGENTS.md](../AGENTS.md#local-mcp-client-tools).
