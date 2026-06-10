---
name: blinkora-workspace
description: Use when an agent needs workspace-scoped access to Blinkora notes, blinkoras, todos, comments, and the tag tree through Blinkora MCP with BLINKORA_BASE_URL and BLINKORA_AGENT_TOKEN.
---

# Blinkora Workspace

Use this skill to operate one authorized Blinkora workspace from an external Agent such as Codex, OpenClaw, Pi Agent, or Hermes.

## Environment

Require these environment variables:

- `BLINKORA_BASE_URL`: Blinkora Web/API base URL, for example `http://localhost:6676`.
- `BLINKORA_AGENT_TOKEN`: Workspace-scoped token created in Blinkora settings.

Never write the token into a repo file, script, skill, shell history snippet, or log. Treat it as a secret. The skill does not provide security isolation; Blinkora backend enforces workspace scope.

## Install / Refresh

If the agent supports project skills, install this skill into the workspace:

```bash
mkdir -p .agents/skills/blinkora-workspace
curl -fsSL \
  -H "Authorization: Bearer ${BLINKORA_AGENT_TOKEN}" \
  "${BLINKORA_BASE_URL}/api/agent/blinkora-workspace/SKILL.md" \
  -o .agents/skills/blinkora-workspace/SKILL.md
```

If the agent does not support local skills, read the same `SKILL.md` as task instructions and then connect through MCP.

## Connect

Prefer Blinkora MCP over raw HTTP.

- SSE endpoint: `${BLINKORA_BASE_URL}/sse`
- Message endpoint is returned by the SSE `endpoint` event.
- Authenticate every MCP request with `Authorization: Bearer ${BLINKORA_AGENT_TOKEN}`.

The token is bound to exactly one workspace. Do not pass or invent `workspaceId`; scoped tokens use their bound workspace.

## Tools

Available note types:

- `0` or `blinkora`: flash thought
- `1` or `note`: note
- `2` or `todo`: todo

Prefer these MCP tools:

- `searchBlinkora`: read notes with `page` and `size`; always paginate for broad reads.
- `getBlinkora`: read one note by `id`.
- `upsertBlinkora`: create a flash thought, note, or todo.
- `updateBlinkora`: update a note by `id`.
- `deleteBlinkora`: move notes to recycle bin.
- `listComments`: read comments for a note.
- `createComment`: create a comment for a note.
- `updateComment`: update a comment by `id`.
- `listTagTree`: read the current workspace tag tree.

## Write Rules

Before writing:

- Confirm the target type: `blinkora`, `note`, or `todo`.
- Confirm note ids and comment ids by reading them first when the user did not provide exact ids.
- For large edits, read the current object first and preserve fields not being changed.
- Do not try to read or write attachment files; only use attachment metadata already returned with notes.
- Do not modify the tag tree directly. Tags are read-only for this skill.

When reading all content, use pages until the result page is empty or shorter than requested. Keep page size reasonable, normally 50 to 200.
