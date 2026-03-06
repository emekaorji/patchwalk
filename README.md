# Patchwalk

Patchwalk is a VS Code extension that replays AI code handoffs.

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
- Supported methods: `initialize`, `tools/list`, `tools/call`, `ping`
- Tool name: `patchwalk.play`

`tools/call` accepts the handoff payload either directly in `params.arguments` or wrapped in `params.arguments.payload`.

## Minimal payload

```json
{
  "$schema": "https://patchwalk.dev/schema/handoff-1.0.schema.json",
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

## Example tools/call request

```bash
curl -X POST http://127.0.0.1:7357/mcp \
  -H 'content-type: application/json' \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "patchwalk.play",
      "arguments": {
        "specVersion": "1.0.0",
        "handoffId": "demo-1",
        "createdAt": "2026-03-06T00:00:00Z",
        "producer": { "agent": "codex" },
        "summary": "Demo walkthrough.",
        "walkthrough": [
          {
            "id": "step-1",
            "title": "Open file",
            "narration": "Patchwalk is highlighting this range.",
            "path": "src/extension.ts",
            "range": { "startLine": 1, "endLine": 20 }
          }
        ]
      }
    }
  }'
```

Expected result: VS Code focuses the file/range and narrates each step in sequence.

## Development

```bash
pnpm install
pnpm esbuild:base
```

Run the extension via `F5` in VS Code.
