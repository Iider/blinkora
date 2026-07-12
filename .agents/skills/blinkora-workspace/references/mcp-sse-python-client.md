# Blinkora MCP SSE Python Client Pattern

Use this when no first-class MCP tool wrapper is available and a script must call
Blinkora MCP directly.

## Protocol flow

1. Open `${BLINKORA_BASE_URL}/sse` with:
   - `Authorization: Bearer ${BLINKORA_AGENT_TOKEN}`
   - `Accept: text/event-stream`
2. Read the initial SSE event named `endpoint`. Its `data:` value is a relative
   message endpoint such as `/messages?sessionId=...`.
3. POST JSON-RPC messages to `${BLINKORA_BASE_URL}${endpoint}` with:
   - `Authorization: Bearer ${BLINKORA_AGENT_TOKEN}`
   - `Content-Type: application/json`
4. Run MCP initialization before tool calls:
   - call `initialize` with the supported protocol version and client info;
   - send the `notifications/initialized` notification.
5. Call tools through `tools/call`:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "getWorkspaceContext",
    "arguments": {}
  }
}
```

6. Keep the SSE reader alive in a background thread or task and match responses by
   JSON-RPC `id`.

## Response handling

- The SSE connection may remain open indefinitely. Read line by line until the
  `endpoint` event appears; do not wait for the whole response body.
- MCP tool results arrive on SSE. A successful result normally places the payload
  in `structuredContent`.
- `getBlinkora` returns the note object directly in `structuredContent`; do not
  require an extra `note` wrapper.
- `listReferences` legitimately returns an array in `structuredContent`. Treat
  that as a valid response shape, not as a tool failure.
- Prefer a built-in MCP/tool wrapper whenever the Agent provides one. This pattern
  is the narrow fallback for scripts and diagnostics.

## Safety

- Never hard-code or print `BLINKORA_AGENT_TOKEN`.
- Do not pass `workspaceId`; the token already binds every request to one
  Workspace.
- For card tag changes, edit hashtags in note `content` through
  `updateBlinkora`; do not try to write returned `tags`.
