# Patchwalk

Patchwalk is a VS Code extension that replays AI code handoffs.

The local MCP endpoint is implemented with the official TypeScript SDK and follows the standard MCP lifecycle over Streamable HTTP.

It hosts a local MCP-compatible HTTP endpoint. When it receives a valid handoff payload, it:

1. Speaks the payload `summary` using the OS default TTS voice.
2. Loops through `walkthrough` items.
3. Opens each file in the editor.
4. Scrolls to `range.startLine`.
5. Highlights `range.startLine..range.endLine`.
6. Speaks each step `narration`.

## Commands

- `Patchwalk: Start MCP Server`
- `Patchwalk: Stop MCP Server`
- `Patchwalk: Play Handoff From Clipboard`

## Settings

- `patchwalk.autoStartMcpServer` (default: `true`)
- `patchwalk.mcpPort` (default: `7357`)

## MCP endpoint

- URL: `http://127.0.0.1:<patchwalk.mcpPort>/mcp`
- Health check: `GET /health`
- Transport: stateful Streamable HTTP via `@modelcontextprotocol/sdk`
- Methods handled on the MCP endpoint: `POST`, `GET`, `DELETE`
- Recommended client path: use an MCP client library instead of hand-rolling JSON-RPC

### Capabilities

Tools:

- `patchwalk.play`

Resources:

- `patchwalk://server/status`
- `patchwalk://server/operator-manual`
- `patchwalk://handoff/example`

Prompts:

- `patchwalk.compose-handoff`
- `patchwalk.expand-walkthrough`

## Minimal payload

```json
{
  "specVersion": "1.0.0",
  "handoffId": "8d8f64f2-6f2c-4f91-a7ba-3af2f0ef8d9a",
  "createdAt": "2026-03-05T09:10:00Z",
  "producer": { "agent": "codex", "agentVersion": "1.0", "model": "gpt-5" },
  "summary": "Added refresh flow.",
  "walkthrough": [
    {
      "id": "step-1",
      "title": "Refresh handler",
      "narration": "This file adds refresh token validation, rotation, and response shaping.",
      "path": "src/auth/refresh.ts",
      "type": "symbol",
      "symbol": "handleRefresh",
      "range": { "startLine": 24, "endLine": 92 }
    }
  ]
}
```

## Sample client

For a full end-to-end sample client, run:

```bash
pnpm play:sample
```

That script:

1. Connects with the official MCP client transport
2. Reads the status and example resources
3. Fetches a prompt template
4. Lists tools
5. Calls `patchwalk.play`

Expected result: VS Code focuses the file/range and narrates each step in sequence while the client receives a normal MCP tool result.

## Development

```bash
pnpm install
pnpm esbuild:base
```

Run the extension via `F5` in VS Code.
