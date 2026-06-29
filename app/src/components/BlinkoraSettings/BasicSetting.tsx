import { observer } from "mobx-react-lite";
import { useEffect, useState } from "react";
import { Button, Select, SelectItem, Switch, Tooltip, Image } from "@heroui/react";
import { RootStore } from "@/store";
import { Icon } from '@/components/Common/Iconify/icons';
import { UserStore } from "@/store/user";
import { WorkspaceStore } from "@/store/workspace";
import { useTranslation } from "react-i18next";
import { DialogStore } from "@/store/module/Dialog";
import { UpdateUserInfo, UpdateUserPassword } from "../Common/UpdateUserInfo";
import { Item } from "./Item";
import { Copy } from "../Common/Copy";
import { PromiseCall } from "@/store/standard/PromiseState";
import { api } from "@/lib/trpc";
import { BlinkoraStore } from "@/store/blinkoraStore";
import { ShowGen2FATokenModal } from "../Common/TwoFactorModal/gen2FATokenModal";
import { CollapsibleCard } from "../Common/CollapsibleCard";
import { eventBus } from "@/lib/event";
import { UploadFileWrapper } from "../Common/UploadFile";
import { signOut } from "../Auth/auth-client";
import { getBlinkoraEndpoint } from "@/lib/blinkoraEndpoint";

export const BasicSetting = observer(() => {
  const user = RootStore.Get(UserStore)
  const { t } = useTranslation()
  const blinkora = RootStore.Get(BlinkoraStore)

  return (
    <CollapsibleCard
      icon="tabler:settings"
      title={t('basic-information')}
    >
      <Item
        leftContent={<>{t('name')}</>}
        rightContent={
          <div className="flex gap-2 items-center">
            <div className="text-desc">{user.name}</div>
            <div className="relative group">
              <UploadFileWrapper
                acceptImage
                onUpload={async ({ filePath }) => {
                  if (!user.userInfo.value?.id) return
                  await PromiseCall(api.users.upsertUser.mutate({
                    id: user.userInfo.value?.id,
                    image: filePath
                  }));
                  await user.userInfo.call(Number(user.id))
                  await signOut({ callbackUrl: '/signin' })
                  eventBus.emit('user:signout')
                }}
              >
                {user.userInfo.value?.image ? (
                  <img
                    src={getBlinkoraEndpoint(`${user.userInfo.value.image}?token=${user.tokenData.value?.token}`)}
                    alt="avatar"
                    className="w-10 h-10 rounded-full object-cover cursor-pointer hover:opacity-80 transition-opacity"
                  />
                ) : (
                  <Image src="/logo.png" width={30} />
                )}
              </UploadFileWrapper>
            </div>

            <Button variant="flat" isIconOnly startContent={<Icon icon="tabler:edit" width="20" height="20" />} size='sm'
              onPress={e => {
                RootStore.Get(DialogStore).setData({
                  isOpen: true,
                  title: t('change-user-info'),
                  content: <UpdateUserInfo />
                })
              }} />
            <Button variant="flat" isIconOnly startContent={<Icon icon="material-symbols:password" width="20" height="20" />} size='sm'
              onPress={e => {
                RootStore.Get(DialogStore).setData({
                  title: t('rest-user-password'),
                  isOpen: true,
                  content: <UpdateUserPassword />
                })
              }} />
          </div>
        }
      />

      <WorkspaceTokenSetting />

      <Item
        leftContent={<>{t('hide-pc-editor')}</>}
        rightContent={
          <div className="flex gap-2 items-center">
            <Switch
              isSelected={blinkora.config.value?.hidePcEditor ?? false}
              onChange={async (e) => {
                await PromiseCall(api.config.update.mutate({
                  key: 'hidePcEditor',
                  value: e.target.checked
                }));
                blinkora.config.call();
              }}
            />
          </div>
        }
      />

      <Item
        leftContent={<>{t('two-factor-authentication')}</>}
        rightContent={
          <div className="flex gap-2 items-center">
            <Switch
              isSelected={blinkora.config.value?.twoFactorEnabled ?? false}
              onChange={async (e) => {
                if (!e.target.checked) {
                  await PromiseCall(api.config.update.mutate({
                    key: 'twoFactorEnabled',
                    value: false
                  }));
                  blinkora.config.call();
                } else {
                  const response = await PromiseCall(api.users.generate2FASecret.mutate({
                    name: user.name!
                  }), { autoAlert: false });
                  if (response) {
                    ShowGen2FATokenModal({
                      qrCodeUrl: response.qrCode,
                      totpSecret: response.secret
                    })
                  }
                }
              }}
            />
          </div>
        }
      />

      <Item
        leftContent={<></>}
        rightContent={
          <Tooltip placement="bottom" content={t('logout')}>
            <Button isIconOnly startContent={<Icon icon="hugeicons:logout-05" width="20" height="20" />} color='danger' onPress={async () => {
              await signOut({ callbackUrl: '/signin' })
              eventBus.emit('user:signout')
            }}></Button>
          </Tooltip>
        } />
    </CollapsibleCard>
  );
})

type AgentTokenItem = {
  id: number;
  name: string;
  workspaceId: number;
  workspaceName: string;
  expiresAt?: string | null;
  revokedAt?: string | null;
  lastUsedAt?: string | null;
  createdAt?: string | null;
  token?: string;
}

const WorkspaceTokenSetting = observer(() => {
  const workspaceStore = RootStore.Get(WorkspaceStore)
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState('')
  const [tokens, setTokens] = useState<AgentTokenItem[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    workspaceStore.list.call()
  }, [workspaceStore])

  useEffect(() => {
    if (selectedWorkspaceId || workspaceStore.workspaceList.length === 0) return
    const current = workspaceStore.workspaceId ?? workspaceStore.workspaceList[0].id
    setSelectedWorkspaceId(String(current))
  }, [selectedWorkspaceId, workspaceStore.workspaceId, workspaceStore.workspaceList.length])

  const loadTokens = async (workspaceId = selectedWorkspaceId) => {
    if (!workspaceId) return
    setLoading(true)
    try {
      const res = await api.agentTokens.list.query({ workspaceId: Number(workspaceId) })
      setTokens(res as AgentTokenItem[])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadTokens()
  }, [selectedWorkspaceId])

  const selectedWorkspace = workspaceStore.workspaceList.find(workspace => String(workspace.id) === selectedWorkspaceId)
  const selectedWorkspaceName = selectedWorkspace?.name ?? '当前工作区'
  const activeTokens = tokens.filter(token => !token.revokedAt && String(token.workspaceId) === selectedWorkspaceId)
  const currentToken = activeTokens.find(token => token.token)?.token ?? ''
  const baseUrl = getBlinkoraEndpoint('/').replace(/\/$/, '')

  const refreshToken = async () => {
    if (!selectedWorkspaceId) return
    setLoading(true)
    try {
      await Promise.all(activeTokens.map(token => api.agentTokens.revoke.mutate({ id: token.id })))
      const res = await PromiseCall(api.agentTokens.create.mutate({
        workspaceId: Number(selectedWorkspaceId),
        name: '工作区令牌'
      }), { autoAlert: false }) as AgentTokenItem | undefined
      if (!res?.token) return
      await loadTokens(selectedWorkspaceId)
    } finally {
      setLoading(false)
    }
  }

  const aiGuide = buildWorkspaceTokenGuide({
    baseUrl,
    workspaceName: selectedWorkspaceName,
    token: currentToken,
    hasExistingToken: activeTokens.length > 0,
    hasUnrecoverableToken: activeTokens.some(token => !token.token)
  })

  return (
    <Item
      type="col"
      leftContent={
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="flex flex-col gap-1">
            <div>工作区令牌</div>
            <div className="text-xs text-default-500 font-normal">
              给外部 Agent 用的单工作区授权。刷新只更新右侧所选工作区的令牌。
            </div>
          </div>
          <div className="flex w-full items-center gap-2 md:w-auto">
            <Select
              size="sm"
              className="min-w-0 flex-1 md:w-[220px]"
              selectedKeys={selectedWorkspaceId ? [selectedWorkspaceId] : []}
              onChange={e => {
                setSelectedWorkspaceId(e.target.value)
              }}
              placeholder="选择工作区"
              aria-label="选择工作区令牌绑定的工作区"
            >
              {workspaceStore.workspaceList.map(workspace => (
                <SelectItem key={String(workspace.id)}>{workspace.name}</SelectItem>
              ))}
            </Select>
            <Tooltip content="刷新当前工作区令牌">
              <Button
                isIconOnly
                aria-label="刷新当前工作区令牌"
                size="sm"
                variant="flat"
                isLoading={loading}
                isDisabled={!selectedWorkspaceId}
                onPress={refreshToken}
              >
                {!loading && <Icon icon="fluent:arrow-sync-12-filled" width="18" height="18" />}
              </Button>
            </Tooltip>
          </div>
        </div>
      }
      rightContent={
        <div className="rounded-md border border-default-200 bg-default-50 p-3">
          <div className="mb-2 flex items-center justify-between gap-3">
            <div className="text-sm font-medium">给 AI 的调用指南</div>
            <Copy size={20} content={aiGuide} />
          </div>
          <pre className="whitespace-pre-wrap break-words text-xs leading-5 text-default-700">{aiGuide}</pre>
        </div>
      }
    />
  )
})

const buildWorkspaceTokenGuide = ({
  baseUrl,
  workspaceName,
  token,
  hasExistingToken,
  hasUnrecoverableToken
}: {
  baseUrl: string;
  workspaceName: string;
  token: string;
  hasExistingToken: boolean;
  hasUnrecoverableToken: boolean;
}) => {
  const tokenLine = token || '<点击右侧刷新按钮生成工作区令牌>'
  const skillMdUrl = `${baseUrl}/api/agent/blinkora-workspace/SKILL.md`
  const skillZipUrl = `${baseUrl}/api/agent/blinkora-workspace.zip`
  const mcpGuideUrl = `${baseUrl}/api/agent/mcp-guide.md`
  const statusLine = token
    ? '当前工作区令牌已回显在上方。不要写进仓库、skill、脚本、提交记录或公开日志。'
    : hasUnrecoverableToken
      ? '当前工作区已有令牌，但没有保存明文，无法直接显示；点击右侧刷新按钮后，新令牌会保存并回显。'
      : hasExistingToken
        ? '当前工作区已有令牌；如果上方没有显示明文，请点击右侧刷新按钮生成新的可回显令牌。'
        : '当前工作区还没有令牌；请点击右侧刷新按钮生成。'

  return `请使用 Blinkora Workspace Skill / MCP 访问我的 Blinkora。

环境变量：
BLINKORA_BASE_URL=${baseUrl}
BLINKORA_AGENT_TOKEN=${tokenLine}

MCP：
- SSE endpoint: ${baseUrl}/sse
- 请求头：Authorization: Bearer \${BLINKORA_AGENT_TOKEN}
- 不要传 workspaceId，工作区由 token 绑定。

Skill / 文档资源：
- 在线 MCP 指南：${mcpGuideUrl}
- Skill Markdown：${skillMdUrl}
- Skill zip：${skillZipUrl}

给支持本地 skill 的 Agent 安装：
\`\`\`bash
mkdir -p .agents/skills/blinkora-workspace
curl -fsSL \\
  -H "Authorization: Bearer \${BLINKORA_AGENT_TOKEN}" \\
  "\${BLINKORA_BASE_URL}/api/agent/blinkora-workspace/SKILL.md" \\
  -o .agents/skills/blinkora-workspace/SKILL.md
\`\`\`

下载 zip：
\`\`\`bash
curl -fsSL \\
  -H "Authorization: Bearer \${BLINKORA_AGENT_TOKEN}" \\
  "\${BLINKORA_BASE_URL}/api/agent/blinkora-workspace.zip" \\
  -o blinkora-workspace.zip
\`\`\`

权限边界：
- 仅限工作区：${workspaceName}
- 可创建、读取、修改闪念、笔记、待办、评论、笔记引用和 metadata 自定义属性
- 可读取标签树
- 不允许访问其他工作区、文件、备份、配置和管理接口

推荐 MCP 工具：
getWorkspaceContext、searchBlinkora、getBlinkora、upsertBlinkora、updateBlinkora、deleteBlinkora、listReferences、addReference、removeReference、setReferences、listComments、createComment、updateComment、listTagTree、listOperationLogs

写入提醒：
- 搜索是普通关键词 / metadata 检索，不是语义、向量、embedding 或 RAG 搜索。
- metadata.properties 是自定义属性；修改 metadata 前先读原笔记并合并，避免覆盖导入键、来源、哈希等维护字段。
- updateBlinkora 不传 content、type 或状态字段时保持原值。
- listOperationLogs 可按 afterId 增量读取用户和 Agent 的笔记操作日志。
- 不能通过工作区令牌读写附件文件、彻底删除笔记或跨 Workspace 移动卡片。

注意：
${statusLine}`
}
