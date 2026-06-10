# 工作区令牌、MCP 和 Skill 接入

Blinkora 的工作区令牌用于把单个 Workspace 授权给外部 Agent，例如 Codex、OpenClaw、Pi Agent、Hermes。它不是账号访问令牌，不能跨 Workspace 使用。

## 设置页怎么用

入口：`/settings` -> `基本信息` -> `工作区令牌`。

- 左侧是说明和“给 AI 的调用指南”。
- 右侧下拉框选择要授权的 Workspace。
- 刷新按钮只更新下拉框选中的 Workspace 令牌，不受页面顶栏当前 Workspace 影响。
- 刷新会撤销该 Workspace 旧的可用工作区令牌，并生成新的可回显令牌。
- 指南内容可以整段复制给 AI，里面包含 token、MCP endpoint、Skill 下载命令和权限边界。

已有令牌如果没有保存明文，设置页无法直接显示。遇到指南提示令牌不可回显时，点击刷新生成新令牌即可。

## Token 存储和安全边界

- token 格式：`bkws_...`。
- 数据库保存 `tokenHash` 用于认证，也保存 `token` 明文用于设置页回显。
- 数据库备份要按敏感数据处理。
- 不要把 token 写进仓库、脚本、提交记录、公开日志或 Skill 文件。
- 工作区令牌只能访问绑定的单个 Workspace。
- 允许：闪念、笔记、待办、评论读写；标签树只读。
- 禁止：其他 Workspace、文件、备份、配置、工作区管理和 admin 类接口。

## MCP 使用

把设置页指南里的变量交给 Agent：

```bash
export BLINKORA_BASE_URL="http://localhost:6676"
export BLINKORA_AGENT_TOKEN="bkws_xxx"
```

MCP 入口：

```text
${BLINKORA_BASE_URL}/sse
```

认证头：

```text
Authorization: Bearer ${BLINKORA_AGENT_TOKEN}
```

不要传 `workspaceId`。后端会强制使用 token 绑定的 Workspace；如果请求里带了不匹配的 `x-workspace-id`，会被拒绝。

可用 MCP 工具：

- `searchBlinkora`
- `getBlinkora`
- `upsertBlinkora`
- `updateBlinkora`
- `deleteBlinkora`
- `listComments`
- `createComment`
- `updateComment`
- `listTagTree`

## Skill 和文档资源

这些只读资源用于让 AI 安装或加载 Blinkora Workspace Skill。任意有效工作区令牌都可以访问这些资源，但业务数据仍按 token 绑定的 Workspace 隔离。

- 在线指南：`${BLINKORA_BASE_URL}/api/agent/mcp-guide.md`
- Skill Markdown：`${BLINKORA_BASE_URL}/api/agent/blinkora-workspace/SKILL.md`
- Skill zip：`${BLINKORA_BASE_URL}/api/agent/blinkora-workspace.zip`

安装到项目级 `.agents`：

```bash
mkdir -p .agents/skills/blinkora-workspace
curl -fsSL \
  -H "Authorization: Bearer ${BLINKORA_AGENT_TOKEN}" \
  "${BLINKORA_BASE_URL}/api/agent/blinkora-workspace/SKILL.md" \
  -o .agents/skills/blinkora-workspace/SKILL.md
```

下载 zip：

```bash
curl -fsSL \
  -H "Authorization: Bearer ${BLINKORA_AGENT_TOKEN}" \
  "${BLINKORA_BASE_URL}/api/agent/blinkora-workspace.zip" \
  -o blinkora-workspace.zip
```

只读查看在线指南：

```bash
curl -fsSL \
  -H "Authorization: Bearer ${BLINKORA_AGENT_TOKEN}" \
  "${BLINKORA_BASE_URL}/api/agent/mcp-guide.md"
```

## 烟测重点

每次改工作区令牌、MCP 或 Skill 资源后，至少确认这些项：

- 自动专项 smoke：

```bash
BLINKORA_BASE_URL=http://127.0.0.1:6676 \
BLINKORA_ACCOUNT_TOKEN=<account_jwt> \
bun run smoke:agent
```

- 未鉴权访问 `/api/agent/*` 返回 `401`。
- 创建工作区令牌后，`agentTokens.list` 能回显 token，且不返回 `tokenHash`。
- 刷新同一 Workspace 后，旧 token 失效，新 token 可用。
- 用 Workspace A token 搜索不到 Workspace B 内容。
- 用 Workspace A token 携带 Workspace B 的 `x-workspace-id` 返回 `401`。
- 用工作区令牌调用 `workspaces.list` / `config.list` 返回 `403`。
- 用工作区令牌连接 MCP 后，工具列表只包含 note/comment/tag tree 相关工具。
- `searchBlinkora`、`getBlinkora`、`upsertBlinkora`、`updateBlinkora`、`listComments`、`createComment`、`updateComment`、`listTagTree` 主路径可用。
- `/api/agent/mcp-guide.md`、`/api/agent/blinkora-workspace/SKILL.md`、`/api/agent/blinkora-workspace.zip` 能被任意有效工作区令牌读取或下载。
