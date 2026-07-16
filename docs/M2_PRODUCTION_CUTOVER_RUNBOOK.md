# M2 生产切换运行手册（历史）

> 当前飞牛 SQLite 已于 2026-07-16 在新目录启用为主服务。本手册记录的是此前“飞牛 PostgreSQL 主服务迁移到 macOS 本机 SQLite”的历史预案，**不得按此手册操作当前服务**。当前运维、更新和回退请使用 [飞牛常驻部署](./FNAS_PERSISTENT_DEPLOYMENT.md)。

原适用范围：把飞牛 PostgreSQL 主服务迁移到 macOS 本机 SQLite。飞牛保留 PostgreSQL、原附件和最终快照作为回滚源，不部署 SQLite。

当前没有执行最终切换。本手册和脚本已经就绪；飞牛仍是主服务。

## 固定拓扑

| 项目 | 值 |
| --- | --- |
| 飞牛 SSH | `weio@192.168.2.25` |
| 飞牛 Web/MCP/Agent unit | `blinkora.service` |
| 飞牛 PostgreSQL unit | `blinkora-db.service` |
| 飞牛环境文件 | `/vol1/1000/docker/blinkora/local/blinkora.env` |
| 本机 unit | `com.blinkora.local` |
| 本机应用目录 | `~/.blinkora/local` |
| 本机正式数据目录 | `~/.blinkora/local/data` |
| 本机迁移证据 | `~/.blinkora/migrations/<RUN_ID>` |

停止 `blinkora.service` 会同时关闭 Web、REST、tRPC、MCP 和 Agent 写入口。最终快照完成前，`blinkora-db.service` 必须保持运行。不得停止、重建或删除 PostgreSQL，也不得把 SQLite 写入反向同步到 PostgreSQL。

## 授权和禁止边界

正式执行前必须再次明确授权以下动作：

- 进入维护窗口并停止飞牛 `blinkora.service`；
- 在飞牛用户目录创建权限受限的最终快照；
- 替换本机 `data` 和 `blinkora.env`；
- 本机全部门禁通过后，持久禁用飞牛 `blinkora.service` 的开机自启，避免重启后出现双主；
- 失败时自动恢复飞牛，并恢复本机原数据和原认证 secret。

`--confirm-cutover` 只算第一道授权。候选全量校验和隔离 smoke 通过后，脚本还会要求在控制终端精确输入 `ACTIVATE <RUN_ID>`。没有控制终端、输入不符、输入中断或恢复时限不足，都会中止激活。

以下边界不随维护窗口扩大：

- 不列举、不读取、不写入、不删除现有 S3 业务对象；
- S3 写入测试只使用另行批准的全新前缀，不能包含 `blinkora/` 或 `blinkora_local/`；
- 不清理飞牛 PostgreSQL、附件目录、快照或 systemd unit；
- 密码、token、`BLINKORA_SECRET` 和 S3 凭据不得进入命令行参数、日志或报告。

## 一键脚本的保护模型

正式入口是 [m2-final-cutover.sh](../scripts/m2-final-cutover.sh)，回滚矩阵由 [verify-m2-cutover-guardrails.sh](../scripts/verify-m2-cutover-guardrails.sh) 验证。

脚本默认不做任何操作：

```bash
bun run cutover:m2
```

它只打印计划，不连接飞牛，不创建目录，不停止服务。

执行只读预检：

```bash
bun run cutover:m2 -- --prepare
```

这一步检查两端健康、源 unit、环境文件、PostgreSQL 工具、本机数据库完整性和所需命令，不创建迁移目录，不移动数据。

正式维护窗口的一键命令：

```bash
bun run cutover:m2 -- \
  --confirm-cutover \
  --run-id "m2-final-$(date -u +%Y%m%dT%H%M%SZ)" \
  --rto-seconds 1800
```

脚本需要正常的交互式 SSH 和 `sudo` 认证，不保存密码。每个远端高权限阶段都在同一个 SSH TTY 内先完成 `sudo -v`，兼容按 TTY 隔离 sudo 时间戳的系统；无需配置免密 sudo。`RUN_ID` 不允许复用；所有候选、备份、`.pre-*`、`.failed-*` 或证据路径只要已有一个，都会在停止服务前拒绝执行。

## 自动执行顺序

1. 复查本机 SQLite、外键、健康、release 和所有目标路径；复查飞牛 Web、PostgreSQL 与健康。
2. 在飞牛创建 systemd 自动恢复 timer，再验证 timer 已经运行。SSH 断开、本机进程退出、候选失败或超时，timer 会启动 `blinkora.service`；本机 trap 也会主动恢复源服务。
3. 只停止 `blinkora.service`，保持 `blinkora-db.service` 运行。`inactive` 和明确的 `failed` 停止态都可接受，`active` 一律阻断。
4. 在新的远端目录生成 PostgreSQL custom dump、完整 `files.tar`、只含一行的 secret sidecar 和 SHA-256 清单。清单只写文件名，因此复制到本机后可以直接校验。
5. 在本机权限为 `0700` 的新目录校验 SHA-256、`pg_restore --list` 和 tar 成员；拒绝绝对路径、`..`、软链接和硬链接。
6. 用 PostgreSQL 14 本机隔离实例恢复 dump。恢复前主动删除空数据库自带的 `public` schema，避免与 dump 中的 schema 冲突。
7. 迁移工具在临时 SQLite 中导入 14 张表并逐表比较规范化行数与 SHA-256；同时校验 JSON、BLOB、本地附件、完整性、外键和 orphan。只有全部通过才生成候选。
8. 从候选制作物理备份，在独立端口运行 `m2-clone` 浏览器、MCP、账号 token、Workspace token、备份恢复和清理 smoke。克隆会强制切回本地存储，不请求旧 S3 key，也不占用 `6676`。
9. 再次确认飞牛 Web 仍停止、PostgreSQL 与恢复 timer 正常，然后等待精确输入 `ACTIVATE <RUN_ID>`；自动恢复前至少还需保留 300 秒。最后提交源端状态时会在新的 SSH TTY 中再次验证 `sudo`。
10. 停止本机服务，先生成旧本机物理备份，再按同一文件系统依次保留并切换：

    ```text
    data         → data.pre-<RUN_ID>
    blinkora.env → blinkora.env.pre-<RUN_ID>
    candidate data/env → 正式 data/env
    ```

    新环境只替换源端 `BLINKORA_SECRET`，继续使用本机的 `DATA_DIR`、release 和端口。数据与 secret 必须成对成功，不能混搭启动。
11. 启动本机并检查 `/health`、SQLite 完整性、外键和 orphan；再停机完成切换后物理备份、空目录恢复与二次完整性检查，最后重新启动本机。
12. 最后一次确认飞牛 Web 仍停止。随后禁用它的开机自启并取消恢复 timer；只有这一步完成后，状态才写为 `CUTOVER_COMMITTED`。

迁移工具的 stdout 只保存阶段、表计数和哈希；Cargo 构建输出单独保存，证据和 sidecar 权限为 `0600`，目录为 `0700`。

## 自动回滚顺序

下列任一情况都会触发自动回滚：快照或校验失败、旧路径冲突、确认拒绝、信号中断、剩余时限不足、任一步移动失败、本机 30 秒内不健康、完整性/外键/orphan 失败、切换后备份恢复失败、飞牛状态漂移、禁用源自启或取消 timer 失败。

回滚顺序固定：

1. 如果候选已经启动，先停止本机，避免双主继续写入。
2. 主动启动飞牛并等待健康；即使本机进程或 SSH 已经失效，远端 timer 仍会在时限到达时恢复飞牛。
3. 把已激活的候选保留为 `data.failed-<RUN_ID>` / `blinkora.env.failed-<RUN_ID>`。
4. 把 `data.pre-<RUN_ID>` 和 `blinkora.env.pre-<RUN_ID>` 成对恢复。
5. 只有旧数据和旧环境都恢复成功，才重新启动本机旧版本并检查健康。

脚本不删除 `.pre-*`、`.failed-*`、快照或备份。若连续两次都无法停止本机候选，脚本不会移动任何 live 文件，也不会主动启动飞牛；它会取消远端恢复 timer 并保持飞牛 Web 停止，避免形成双主，然后写入 `ROLLBACK_FAILED`。如果连 timer 都无法取消，只能依赖人工网络隔离。其他自动回滚不完整场景同样写为 `ROLLBACK_FAILED`，禁止清理任何保留路径。

## 状态和人工恢复

每次正式运行的当前状态在：

```text
~/.blinkora/migrations/<RUN_ID>/state
```

无敏感事件序列在同目录 `events.log`。常见终态只有：

- `CUTOVER_COMMITTED`：本机成为主服务，飞牛 Web 已禁用，PostgreSQL 和快照保留；
- `ROLLED_BACK`：飞牛恢复为主服务，本机恢复原数据与环境；
- `ROLLBACK_FAILED`：需要人工处理；不能假定本机或飞牛的运行状态。

若出现 `ROLLBACK_FAILED`，先在本机执行并确认停止；如果无法停止，先把本机从网络隔离，不能直接启动飞牛：

```bash
bun run deploy:local stop
lsof -nP -iTCP:6676 -sTCP:LISTEN
```

确认本机不再监听后，才在飞牛恢复主服务并检查健康：

```bash
sudo systemctl enable blinkora.service
sudo systemctl reset-failed blinkora.service
sudo systemctl start blinkora.service
systemctl is-active blinkora.service
curl -fsS http://127.0.0.1:6676/health
```

之后只按 `events.log` 和实际目录状态恢复本机完整 pair；不得只恢复数据库或只恢复环境文件。无法同时确认两者时，本机继续保持停止。

## 成功后的验收与保留

自动门禁成功不等于所有人工验收已经签署。维护窗口结束前仍需记录：

- 原账号登录、账号 API token、未撤销 Workspace token；
- 5 个 Workspace、历史、引用、评论、操作日志、配置和字体；
- 在新建 Workspace 中执行笔记、评论、标签、附件和 MCP 最小写入，再清理测试数据；
- 如需真实 OSS 写入，只使用新前缀；现有 8 个业务对象继续保持未读取，除非另获只读授权；
- `integrity_check=ok`、外键和 orphan 为 0；
- 最终快照、14 表计数/哈希、附件文件哈希、切换前后物理备份和空目录恢复结果；
- 实际停机时间、回滚用时或未触发回滚的原因。

成功后继续保留飞牛 PostgreSQL、原附件、最终远端快照、本机 `data.pre-*` / `blinkora.env.pre-*`、切换前后备份和证据。没有新的清理授权，不得删除。
