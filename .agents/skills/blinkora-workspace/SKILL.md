---
name: blinkora-workspace
description: Use when an agent needs workspace-scoped access to Blinkora notes, blinkoras, todos, comments, note references, custom note properties, operation logs, read-only attachment files, and the tag tree through Blinkora MCP with BLINKORA_BASE_URL and BLINKORA_AGENT_TOKEN.
---

# Blinkora Workspace

Operate one authorized Blinkora workspace from an external Agent such as Codex, OpenClaw, Pi Agent, or Hermes.

## Environment

Require these environment variables:

- `BLINKORA_BASE_URL`: Blinkora Web/API base URL, for example `http://localhost:6676`.
- `BLINKORA_AGENT_TOKEN`: Workspace-scoped token created in Blinkora settings.

Never write the token into a repo file, script, skill, shell history snippet, or log. Treat it as a secret. Local instructions do not provide security isolation; Blinkora backend enforces workspace scope.

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

- `getWorkspaceContext`: confirm the account and workspace bound to the token before large writes.
- `searchBlinkora`: read notes with `page` and `size`; always paginate for broad reads.
- `getBlinkora`: read one note by `id`.
- `upsertBlinkora`: create a flash thought, note, or todo. Hashtags in `content` create and sync tags.
- `updateBlinkora`: update a note by `id`. To add, remove, or rename tags, edit hashtags in `content`; `tags` is a read-only derived field.
- `deleteBlinkora`: move notes to recycle bin.
- `listReferences`: read outgoing and incoming note references.
- `addReference`: create one note-to-note reference.
- `removeReference`: remove one note-to-note reference.
- `setReferences`: replace all outgoing references for one note.
- `listComments`: read comments for a note.
- `createComment`: create a comment for a note.
- `updateComment`: update a comment by `id`.
- `listTagTree`: read the current workspace tag tree.
- `cleanupOrphanTags`: preview or remove historical orphan tag rows that have no note references and no child tags. This is only for tag-tree cleanup, not card tag maintenance.
- `listOperationLogs`: read note operation logs. Use `afterId` as a cursor for incremental sync.

Returned notes include `id`, `type`, `content`, status flags, `metadata`, tags, attachment metadata, outgoing `references`, incoming `referencedBy`, and timestamps.

Attachment metadata may include `/api/file/...` or `/api/s3file/...` paths. To read the file bytes, send a `GET` request to `${BLINKORA_BASE_URL}${path}` with `Authorization: Bearer ${BLINKORA_AGENT_TOKEN}`. Workspace tokens cannot upload, delete, move, or rename attachment files.

`searchBlinkora` supports ordinary keyword and metadata search only; do not assume semantic, vector, embedding, or RAG search exists. Useful filters include `searchText`, `type`, `isArchived`, `isRecycle`, `tagId`, `withoutTag`, `withFile`, `withLink`, `hasTodo`, `startDate`, `endDate`, `metadata` / `metadataContains`, and `includePageInfo`.

`isArchived` defaults to `false`; pass `true` for archived notes and `null` to search both normal and archived notes. Pass `isRecycle: true` for recycle-bin notes. `deleteBlinkora` only moves notes to the recycle bin; MCP does not expose hard deletion.

`upsertBlinkora` and `updateBlinkora` accept optional status flags, `metadata`, and `references`. On update, omit `content`, `type`, `isArchived`, `isRecycle`, `isTop`, or `isReviewed` to keep the current value. `isReviewed` means daily-review status, not moderation or approval.

Tags are not a separate writable field. Returned `tags` are derived from hashtags in note `content`. To maintain card tags, read the note, edit hashtags in `content`, then call `updateBlinkora`; Blinkora will sync `tagsToNote` and the tag tree automatically. If old zero-reference tag rows remain visible in `listTagTree` after content cleanup, use `cleanupOrphanTags` with `dryRun: true` first, then rerun with `dryRun: false` only for confirmed orphan tag ids or with `all: true`.

Use `listOperationLogs({ afterId, actorType: "user", noteTypes: [1], orderBy: "asc" })` before maintenance work when you need to see user changes since the last agent pass. Operation log actions `markDailyReviewed` and `markDailyUnreviewed` mean daily-review state changes, not approval or content audit.

Use `metadata` for machine-readable maintenance fields such as `importSourceKey`, `sourcePath`, `sourceUrl`, `sha256`, `originalType`, `originalTitle`, `externalId`, `schema`, or workflow-specific state.
Use `metadata.properties` for human-readable custom properties shown in Blinkora. Keep properties flat: `string`, `number`, `boolean`, `null`, or `string[]`.
When changing only properties, read the note first and merge into the full existing `metadata`; writing `metadata` replaces the whole metadata object.
Use `references` as an array of target note ids when the complete outgoing reference set is known.
Use `searchBlinkora` with `metadata` or `metadataContains` for JSON subset matching, for example `{ "properties": { "status": "open" } }`.

Custom property update pattern:

```json
{
  "id": 123,
  "metadata": {
    "importSourceKey": "keep-existing-maintenance-fields",
    "properties": {
      "status": "open",
      "rating": 4,
      "tags": ["AI", "workflow"]
    }
  }
}
```

Reference update pattern:

```json
{
  "fromNoteId": 123,
  "toNoteIds": [456, 789]
}
```

Use `addReference` or `removeReference` for one reference. `removeReference` can clean up existing references that touch recycle-bin notes; prefer passing the reference `id` when known, otherwise pass `fromNoteId` and `toNoteId`. Use `setReferences` only when replacing the complete outgoing reference set for `fromNoteId`.

## Write Rules

Before writing:

- Confirm the target type: `blinkora`, `note`, or `todo`.
- Confirm note ids and comment ids by reading them first when the user did not provide exact ids.
- For large edits, read the current object first and preserve fields not being changed.
- You may read attachment file bytes from attachment paths returned by Blinkora. Do not upload, delete, move, or rename attachment files.
- Do not move notes between workspaces; workspace-scoped tokens cannot call workspace management or move endpoints.
- Do not modify the tag tree directly. To assign tags, write hashtags in content, for example `#项目/类型/概念`; Blinkora will create and sync the tag tree.
- Do not use `cleanupOrphanTags` to add, remove, or rename a card's tags. It only removes tag-table rows that no note references and that have no child tags.
- For idempotent imports, use a stable `metadata.importSourceKey` or another stable workflow key, then search by that metadata before creating a new note.
- For migrations or graph-style writes, create or update notes first, then run a second pass to call `setReferences` after all target ids are known.
- Domain-specific writing rules, taxonomy, content retention policy, and card/wiki conventions belong in the target workspace or project `AGENTS.md`, not in this generic Blinkora skill.

When reading all content, use pages until the result page is empty or shorter than requested. Keep page size reasonable, normally 50 to 200.
