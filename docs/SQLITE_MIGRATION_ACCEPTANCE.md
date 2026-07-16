# SQLite 替换验收记录

这份记录只记已经实际执行的证据；没有执行的项目明确标为待验，不以“可编译”代替验收。

快速收尾、生产迁移和延期工作的执行顺序见 [SQLite 快速收尾与后续完善清单](./SQLITE_CLOSEOUT_CHECKLIST.md)。

## 本次候选

- 基线提交：`f061365fa802e63ccbe1090aa9c0c837b8064057`（迁移前运行时）。
- 候选功能提交：`84c40ff`（冻结的 M1 产品代码；在既有 SQLite 运行时与验收门禁上，补齐 Workspace 范围的受保护附件浏览器读取、单段 HTTP Range、前端附件授权 URL 和设置页稳定深链）。
- M1 测试提交：`d8fb6dc`（完整浏览器 → Rust API → Workspace Agent 原生链路、`m1-review` 聚焦交互、`settings-review`、Range 端到端断言和临时数据清理）。
- 部署范围：`blinkora_local` 只在 macOS 本机持久化模式部署，不在飞牛安装 SQLite 版本。飞牛原服务继续作为主服务；本记录不把只读取数、模板校验或本机副本落地写成飞牛生产切换。
- M1 交付平台：macOS arm64、本地文件系统、SQLite CLI 3.x、Rust 1.96，全程本机原生构建和 `launchd` 部署，不使用 Docker。M1 验收当时没有连接飞牛；历史差分、迁移和 Linux 构建证据使用隔离 PostgreSQL 14.23 与 OrbStack。
- M2 只读副本平台：2026-07-16 从飞牛现用 PostgreSQL 14.23 取得在线一致性快照，在本机隔离 PostgreSQL 中恢复并迁移，再原子切换到 macOS 本地 `DATA_DIR`。迁移过程没有停止、重启或修改飞牛服务，本轮没有向飞牛写数据；S3 业务对象没有列举、读取、写入或删除。
- M2 临时停写预演平台：同日经单独授权临时停止飞牛 `blinkora.service`，保持 `blinkora-db.service` 运行，取得停写候选并在本机隔离校验；没有激活候选，完成后恢复飞牛健康。该候选在源服务恢复写入后立即视为陈旧。
- 数据规模：真实接口 smoke；2,100 条批量笔记；10 客户端 300 秒并发；物理备份/空目录恢复；PostgreSQL 真实迁移夹具；飞牛真实快照共 14 表、1 个账号、5 个 Workspace、256 条笔记、8 条 S3 附件记录。

## 已通过

| 项目 | 证据 |
| --- | --- |
| SQLite 初始化与升级保护 | Rust 集成测试覆盖空库、重复启动、WAL、外键、5 秒 busy timeout、`FULL` 同步、JSON 对象/嵌套对象/数组/字符串/数字/布尔/`null` 包含语义、评论 metadata 一层合并、事务回滚与 2,100 ID JSON 绑定。 |
| 事务与并发 | 单进程写门控覆盖 tRPC、MCP 转发、备份导入和文件写入；10 客户端实际持续 300 秒，完成 2,970 次写入和 990 次读取，种子笔记历史版本连续 990 条；无 `database is locked`、非预期 5xx 或 orphan。完整脚本见 `scripts/sqlite-concurrency.mjs`。 |
| 编辑器附件事务 | 已保存附件不再在编辑器确认删除时调用独立文件删除接口；前端把删除路径随 `notes.upsert` 提交，后端将笔记、历史、标签、引用、附件关系和操作日志放在同一 SQLite 事务。物理文件先进入私有暂存区，事务失败会恢复，提交后才清理；仍被其他笔记正文或附件关系引用的文件只解除当前笔记关联，不做物理删除。Rust 测试覆盖成功、强制触发器失败回滚和共享引用三条路径；附件不改正文的更新也生成 `changedFields=["attachments"]`，失败时历史、日志、附件行和文件全部回滚。完整本地 Chrome smoke 另确认删除前没有 `/api/file/delete`、保存请求包含 `deletedAttachmentPaths`、返回附件为空且文件随后 404。 |
| 2,000 ID 批量路径 | `bun run test:sqlite-bulk` 实测 2,000 条记录的更新、跨 Workspace 移动、导出与删除。 |
| 接口 smoke | `smoke:rust` 和 `smoke:agent` 均在恢复后的 SQLite 数据目录通过。另以 MinIO 启动真实 S3-compatible 服务完成 `smoke:rust` 的 S3 分支（配置校验、上传、读取、移动、删除、目录删除与切回本地存储）。覆盖登录、Workspace、笔记、历史、标签、评论、附件、导入导出、MCP 和 Agent token。 |
| 真实云 S3 | 已在阿里云 OSS 北京区域执行 `bun run smoke:s3-local`，全程不使用 Docker。附件事务使用全新随机隔离前缀；最后一条卡片删除选择专项只使用 `codex-sqlite-m1-20260716-card-delete/` 下的已知测试 key，不列举、不读取也不复用现有 `blinkora/`、`blinkora_local/` 或其他业务对象。API/Chrome 覆盖配置成功与失败、PNG 预览、字节一致、编辑器事务删除、“仅删除卡片”、孤立对象随卡删除、共享对象保护、最后引用删除后 404 和恢复本地存储。最终 `integrity_check=ok`、`foreign_key_check=0`；临时服务、SQLite、构建目录与已知测试对象均已清理。凭据未写入命令输出、日志或仓库；证据提交为 `5ffb233`。 |
| 不完整备份拒绝 | 导入前要求每个可恢复附件都有 ZIP 文件条目，并在数据库事务开始前逐个写入私有临时区；缺任一附件时固定返回 HTTP 400 和 `backup attachment file is missing`，不再保留来源 `/api/s3file/*` 路径。Rust 真实路由测试与独立原生 HTTP 回归均确认 Workspace 数、附件文件数不变，`integrity_check=ok`、`foreign_key_check=0`。备份性能脚本另要求 `BLINKORA_BACKUP_PERF_ISOLATED=1` 和回环地址，并在导出或导入报告缺文件时拒绝清理工作区。 |
| 两步验证登录 | 隔离 Docker 实例执行 `bun run test:sqlite-2fa`：REST 和 tRPC 登录在启用后只返回验证挑战，错误验证码返回 401，正确验证码才签发会话；脚本完成后关闭两步验证并恢复普通登录。浏览器也实际验证了“设置启用 → 退出 → 验证码登录 → 关闭后普通登录”。 |
| 双后端差分 | PostgreSQL 14.23 的全新夹具迁移到隔离 SQLite 后，`test:postgres-sqlite-contract` 覆盖注册表中的 74/74 procedure：19 项确定性结果逐值相等、3 项原本未排序列表按集合相等、36 项随机/写入返回结构相等、16 项业务错误 envelope 相等。实际对照 `/health`、已有附件逐字下载、认证成功/失败与未认证分支、文件上传/读取/删除、备份导入错误分支，以及 MCP 未认证路由、`initialize`、`tools/list`、上下文、详情、搜索、标签树和操作日志。MCP 的即时 UTC 字段和 JSON 文本镜像按明确规则归一化，其他字段逐值相等；最终 SQLite `integrity_check=ok`、`foreign_key_check=0`。同一实跑覆盖 ASCII 大小写、中文、Emoji、`@`、`%`、`_` 六类搜索；每类均只命中目标笔记，不命中干扰笔记，PostgreSQL 与 SQLite 成员关系一致。 |
| 真实无损迁移 | PostgreSQL 14.23 实际迁移，14 张表逐表行数与规范化 SHA-256 均相等；最终夹具包含账号、Workspace、笔记、标签关系、附件、历史、引用、评论、配置、字体 BLOB、工作区令牌、操作日志与 cache。迁移保留快照，目标在临时 SQLite 文件验证后原子切换。 |
| 迁移后凭据与序列 | 使用迁移前 API token、未撤销 Workspace token 和字体 BLOB 直接访问 SQLite 成功；新建笔记、字体和 Agent token ID 分别为 32、4、8，均大于迁移前最大 ID 31、3、7。 |
| 回滚演练 | 停止 SQLite 后重新启动原 PostgreSQL 服务并用原账号登录成功；原 PostgreSQL 实例和数据未被迁移工具删除或改写。 |
| 物理备份 | `sqlite-backup.sh --offline` 后用 `sqlite-restore.sh` 恢复到空目录；恢复库健康检查、完整 smoke、`integrity_check` 与 `foreign_key_check` 均通过。 |
| 完整性 | 恢复测试库的 `integrity_check=ok`，外键、Workspace、标签关系、引用和评论 orphan 均为 0。 |
| 异常启动拒绝 | 损坏 SQLite 页启动时报完整性错误；只读 bind mount 报 `Read-only file system`；32 KiB tmpfs 报磁盘 I/O 错误，三者均以非零退出且未返回健康。未来 schema 版本由 Rust 集成测试覆盖并明确拒绝。 |
| 强制终止恢复 | 在 20,000 个 hashtag 的笔记写入/标签同步请求中对服务发送 `SIGKILL`，客户端请求失败。重启后健康检查正常，`integrity_check=ok`、外键检查为 0，写入中的笔记、标签关系和标签均为 0 条，未出现半写。 |
| 同机 p95 性能 | 同一 macOS arm64 主机、同一迁移夹具、PostgreSQL 与 SQLite macOS release 二进制各采样 100 次、预热 20 次：SQLite/PG p95 为列表 27.6%（2.604/9.446 ms）、详情 36.5%（2.470/6.770 ms）、子串搜索 40.0%（3.014/7.540 ms）、写入 21.8%（3.290/15.091 ms），均低于 120% 门槛。 |
| 导入导出性能 | 固定基线 `f061365` 与候选 `c158b13` 在同一 macOS arm64 主机使用 release 二进制、原生 PostgreSQL 14 和由其无损迁移出的 SQLite；夹具只含 smoke 生成的 2 个 Workspace、16 条笔记、6 个本地附件，不复用真实数据或 S3。Workspace/full × Markdown/JSON 各执行 5 次，每次导入后删除导入 Workspace，双方都回到 2 个 Workspace。SQLite/PG 的导出、导入 p95 比例分别为：Workspace Markdown 66.2%/70.3%、Workspace JSON 64.1%/88.7%、full Markdown 66.4%/52.2%、full JSON 51.5%/38.6%，全部低于 150% 门槛；最终 `integrity_check=ok`、外键检查为 0。指标和迁移计数保存在 `~/.blinkora/acceptance-evidence-20260716/backup-performance-synthetic-*-c158b13.json` 及同目录迁移日志，权限均为 `0600`。 |
| 构建与部署 | M1 冻结候选的 `bun run build:web --force`、`bun run verify:rust` 和 macOS 原生 release 构建均通过；`bun run deploy:local update` 再次完成同一 Web/native 构建并更新 `launchd` 服务。既有 Linux arm64/amd64 与单 Web 容器运行时证据来自此前候选，当前产品代码改动后没有重跑：本机 Homebrew Rust 不提供 Linux musl target，而本次明确不使用 Docker，因此 `bun run build:rust-release` 的 Linux 阶段是平台范围跳过，不写成当前候选通过。Docker 资源最终只读复核为 0 镜像、0 容器、0 卷、0 Build Cache，默认网络之外为 0。 |
| PostgreSQL 残留防回归 | `verify:rust` 会执行 `scripts/verify-sqlite-runtime-residuals.mjs`：检查部署文档、模板与 Compose 文件不含 PostgreSQL URL、`psql`、旧容器名、默认端口或运行时环境变量；检查正式运行时源文件不含 PostgreSQL 专用 backend 或 SQL 语法，并要求 Compose 只定义 `web` 服务。冻结候选最新实跑通过 64 个服务端测试和 6 个迁移工具测试。 |
| 浏览器核心 smoke | 同一隔离 SQLite Docker 实例中，桌面和 390×844 移动视口均完成真实登录与主界面验证；笔记列表、带附件笔记、底部导航与移动侧栏开合正常。最新候选重新构建后，以全新登录标签页验证桌面待办页和编辑器，以及 390×844 待办页；控制台 error、warn、warning 均为 0。当前 macOS 原生本地服务也已验证未登录的桌面与 390×844 登录、注册页正常渲染，控制台 error、warn、warning 均为 0。 |
| 浏览器扩展 smoke | 新建隔离 Docker 实例后，完整 `smoke:rust` 先通过；浏览器随后真实创建闪念、笔记、待办各一条，标签树筛选和全局搜索均能找到新闪念，资源页能列出既有附件并创建/进入嵌套目录，设置页能读取操作日志及新建笔记的日志记录。最新候选通过 UI 将 `type=2` 待办更新为带 `（再次编辑）` 的内容；离线检查确认 `noteHistory.version=1` 保存前一版本，`integrity_check=ok`，`foreign_key_check` 为 0 行，容器重启后 `/health` 恢复正常。基础设置与 2FA 入口均正常渲染。 |
| macOS 本机持久化 | M1 截止时在隔离用户目录执行 `install → update → smoke:rust → smoke:agent → stop → start → uninstall`，全程不启动 Docker；当时未替换默认 `DATA_DIR`。更新、重启、数据保留、健康、完整性、外键、orphan 和 `0700`/`0600` 权限均通过。M2-A 对默认 `DATA_DIR` 的替换结果记录在下文。 |
| macOS 原生隔离数据浏览器 smoke（本轮） | 不使用 Docker；在临时原生 `launchd` 服务、独立 `DATA_DIR` 和临时 SQLite 文件中，用浏览器真实注册/登录测试账号后创建闪念、笔记、待办各一条。已验证待办完成、笔记编辑及两次历史写入、评论新增、`#sqlite-smoke-tag` 标签写入、全局子串搜索（等待搜索防抖后命中）、新建工作区、跨工作区移动笔记及切换隔离、资源目录新建和重命名。390×844 下资源列表、笔记列表和详情均正常渲染。结束前数据库 `integrity_check=ok`、`foreign_key_check` 为 0 行；历史、评论、标签关系、附件关联的 orphan 检查均为 0。随后已经停止临时 `launchd` 服务，并删除临时 SQLite、资源目录、测试账号和构建目录；正式本地服务仍在 6676 健康运行。 |
| 可重复 macOS 原生浏览器 smoke（本轮） | `bun run smoke:browser-local` 从空目录构建独立原生 release 和 SQLite 服务，不使用 Docker、不访问常驻 `6676`；以本机 Chrome 在桌面与 390×844 视口完成注册/登录、工作区创建/自动切换/重载后回显、闪念/笔记/待办创建、每日回顾、闪念/笔记/待办编辑（各自均有历史；笔记另含唯一嵌套标签、附件和笔记引用）、待办完成/恢复、置顶、归档/恢复、回收站/恢复及确认后的彻底删除、评论树新建/回复/编辑/两级删除（回复必须渲染在根评论线程内）、日期范围/附件/外链/Markdown 待办/无标签条件筛选及重置、嵌套标签树父/子节点筛选/刷新后回显，以及闪念、笔记、待办、全部、归档和回收站列表的页码分页（每类 10 条/页；全部列表共 36 条，均覆盖第 2 页刷新、删除后保持页码和越界页复位；回收站的第 2 页再确认彻底删除一张）。它还验证单卡移入默认 Workspace 后的评论树回显、当前 Workspace Agent 令牌的生成与调用指南回显、S3 未填凭据时“保存并验证”保持禁用、临时空工作区经设置页导出 ZIP 后重新导入、全量 JSON 导出和恢复、操作日志组合筛选、本地字体选择/重载/恢复默认、全局笔记/附件搜索，以及资源目录创建/附件与目录重命名/嵌套、附件移入目录后移回根目录、确认删除和两项多选删除、同前缀兄弟目录删除保护。北京时间午夜后的实跑中，日期请求明确为 `2026-07-14T00:00:00.000Z` 至 `2026-07-19T00:00:00.000Z`，后端返回创建时记录的同一稳定笔记 ID；测试不再把本地自然日和现有 UTC 日期序列化契约混为一谈。清除 token、笔记内容、附件和认证流程的浏览器调试输出后，同一完整清单在候选功能提交 `84c40ff` 再次通过。它对每个本机 4xx/5xx、console error 与 page error 失败；结束前断言 11 条闪念、13 条笔记（其中一条已移至默认 Workspace）和 12 条待办已保存，三种编辑正文与所选 Workspace 已保存，三种笔记均存在至少一条历史且每张笔记历史版本从 1 连续递增；笔记编辑另有操作日志，移动笔记的历史/评论/附件/标签都曾在目标 Workspace 回显，附件和临时评论树均已删除、重命名的根目录及嵌套目录和同前缀受保护目录占位记录均已落盘、`integrity_check=ok`、`foreign_key_check=0` 及 Workspace/历史/评论/附件/标签/操作日志关联 orphan 为 0。完整实跑通过后临时服务、SQLite 和构建目录均已删除，6676 保持健康。编辑器使用被编辑笔记的类型，不受全局选择变化影响。 |
| 部分更新与 Workspace 高风险浏览器回归（本轮） | 同一次 `84c40ff` 隔离实跑新增以下断言：自定义属性覆盖字符串、数字、布尔、`null` 和数组；仅改 metadata 时请求体严格只含 `id` 与 `metadata`，响应仍保留正文、附件和出站引用；同一记录按 Note → Blinkora → Todo → Note 往返转换后，正文、metadata、附件和引用均不丢失。标签与附件组合筛选覆盖刷新回显和重置，附件经浏览器真实下载后逐字节相等。Workspace 覆盖重命名、切换默认、默认 Workspace 删除保护、恢复默认、两张笔记批量移入指定目标，以及删除当前临时 Workspace；级联删除响应确认删除一个附件文件，离线检查笔记、历史、标签关系、评论树、附件、Agent token 和操作日志残留均为 0。 |
| 属性、卡背与共享资源浏览器回归（本轮） | 同一次完整 Chrome smoke 验证属性 Markdown 链接的目标地址和新标签页行为；卡片正面不泄漏属性、翻到卡背后显示属性和类型、刷新后恢复正面；重复属性名和非法值被明确拦截；清空属性只移除 `metadata.properties`，其他 metadata、正文、附件和引用不变，随后可完整恢复。共享资源场景中，删除第一张引用卡片时不出现危险的“连同资源删除”选项且文件仍为 200；删除最后一张引用卡片时才识别为 orphan，确认后文件为 404。 |
| Workspace 范围媒体与 Range（M1） | 受保护的 `/api/file/*`、`/api/s3file/*` 仅在 GET 时接受查询参数中的账号 token 和 Workspace ID；请求头优先，后端仍验证账号所有权或 Agent 绑定，其他方法不会放宽。单段显式、开放和 suffix Range 返回 `206`、`Accept-Ranges`、`Content-Length`、`Content-Range`；无效或多段 Range 返回 `416 bytes */<len>`。4 个认证单测、2 个 Range 单测及 `smoke:rust` 的浏览器查询授权 `bytes=0-4` 端到端断言均通过。前端图片、音频、视频、Markdown、编辑器、下载、资源页、头像和设置页统一生成带当前 Workspace 的授权 URL。 |
| M1 聚焦交互 | `BLINKORA_BROWSER_SMOKE_SCENARIO=m1-review` 在独立原生 SQLite 服务中通过：每日回顾普通正文非粗体、长短卡排版、卡背、选择模式不翻面、全屏复制/评论层级/编辑预览、三卡多引用与互相引用去重、合成 WAV/WebM metadata、桌面/390×844、浅色/深色及滚动条状态。共生成 11 张临时截图并逐张目视复核；console error、page error 和本机非预期 4xx/5xx 为 0，截图及临时数据随后清理。 |
| M1 设置页回归 | `settings-review` 验证 `?section=<key>` 深链只接受授权 section，基本信息、偏好、存储、备份、操作日志和关于可以稳定直达；本地字体选择/刷新/恢复、Workspace Agent 调用指南及 S3 空表单保护均通过。期间真实捕获并修复了 `BasicSetting.tsx` 遗漏 `getBlinkoraEndpoint` 导入造成的设置页白屏，修复后重新通过 Web 构建、聚焦设置和完整浏览器链。 |
| M1 最终一体化链路 | `BLINKORA_BROWSER_SMOKE_RUN_API=1 bun run smoke:browser-local` 使用同一临时原生服务、SQLite、合成账号和 Workspace，依次通过完整 Chrome browser smoke、`smoke:rust` 和 `smoke:agent`；最终 `integrity_check=ok`、`foreign_key_check=0`，全部临时服务、数据库、账号、附件和 token 文件由 trap 清理。此前发现并修复了设置页文本定位、自动交互模式编辑、单账号数据库二次注册和本地 URL 上传误用 Docker hostname 四个验收工具问题，最终链路退出码为 0。 |
| 飞牛 unit 模板 | `bun run verify:fnas-systemd` 校验 `deploy/fnas/blinkora.service` 的 section、关键值、服务账号、环境文件和 `ExecStart` 路径。该项仅验证部署定义。 |
| M2 真实结构隔离预检 | `bun run smoke:m2-clone` 从已验证物理备份恢复临时 SQLite 克隆，在启动前强制切换为本地存储并清空克隆中的 S3 连接值。浏览器首次加载即锁定新 Workspace；迁移账号 API token、三类笔记、编辑、历史、标签、评论、本地附件、操作日志、Workspace token、Workspace 导出、MCP SSE/写入/隔离、级联清理、完整性、物理备份、空目录恢复及原账号/Workspace token 复验全部通过。临时服务、克隆和测试 Workspace 已清理，未请求飞牛或旧 S3 key。 |
| M2 新前缀 S3 预检 | 空 SQLite 实例使用 `codex-m2-preflight-20260716/` 下的随机子前缀完成 API 和 Chrome S3 smoke；覆盖验证、上传、预览、字节一致、移动、事务删除、共享引用保护和恢复本地存储。脚本不列举 Bucket，只操作并删除本轮已知 key；未访问 `blinkora/`、`blinkora_local/` 或其他业务前缀。 |

## M2 只读副本迁移实跑

这次实跑的范围是“飞牛继续作为主服务，本机落地点时间副本”。它完成了生产数据迁移预演和本机副本切换，但没有进入最终停写窗口，因此不等同于原始验收标准中的生产主库切换。

- 运行编号：`fnas-readonly-20260716T084621Z`；证据根目录为 `~/.blinkora/migrations/fnas-readonly-20260716T084621Z`，目录及保留文件已收紧为仅当前用户可读写。
- 源快照：PostgreSQL 14.23 自定义格式，283,767 字节，SHA-256 为 `f8ab37f8feae584cd6129584bf06a889758f87eda077b8ad3ba3dcc5800c2a54`。`pg_restore --list` 通过；迁移工具只锁本机恢复出的 PostgreSQL 副本，没有对飞牛源表加迁移锁。
- 迁移结果：14 表逐表行数、最大 ID 和规范化 SHA-256 全部相等；JSON 按规范化键序比较，SQLite 候选库 SHA-256 为 `ad027a6b5f9266ca8b4515db2130c819dd20de207c06b3bcf6a19050c2162315`。

| 表 | 行数 | 最大 ID |
| --- | ---: | ---: |
| `accounts` | 1 | 1 |
| `workspaces` | 5 | 39 |
| `notes` | 256 | 663 |
| `tag` | 246 | 452 |
| `tagsToNote` | 691 | 11045 |
| `attachments` | 8 | 29 |
| `noteHistory` | 248 | 909 |
| `noteReference` | 161 | 884 |
| `comments` | 2 | 23 |
| `config` | 39 | 48 |
| `fonts` | 0 | 0 |
| `agentAccessTokens` | 7 | 24 |
| `operationLog` | 262 | 262 |
| `cache` | 0 | 0 |

- 附件边界：8 条有效附件记录全部指向 S3，本地附件引用为 0；S3 模式和 8 条相关配置经规范化哈希保留。按用户要求，本轮没有请求任何现有 S3 对象。源 `files/` 中另有 2 个没有数据库引用的遗留文件，本轮没有读取内容、复制或删除，仍原样留在飞牛。
- 凭据与序列：隔离迁移副本使用原账号密码登录成功，旧账号 API token 和一个未撤销 Workspace token 均可读取，5 个 Workspace 可见；隔离写入 smoke 新建 ID 大于 663，编辑后生成历史，测试笔记随后删除。正式本机实例只执行只读 smoke，没有为了验收改写真实副本。
- 本机切换：先对原本机数据执行离线物理备份，再在同一文件系统原子替换 `data` 和运行环境文件。切换后 14 表计数与源快照逐项一致，`integrity_check=ok`、`foreign_key_check=0`、显式 orphan 合计为 0，首页和 `/health` 均返回 200。
- 备份恢复：切换后物理备份 SHA-256 为 `d17e90713e536e98aa38053bfd5f5d024f2e44c76a1f0cdf9a22c5f2c400196d`；从空目录恢复后哈希、14 表计数、完整性和外键检查一致，恢复实例再次通过原账号、旧 API token、旧 Workspace token 和列表只读 smoke。校验生成的空 WAL/SHM 已清理，备份只保留一致主库和附件目录。
- 回滚演练：切换前本机物理备份 SHA-256 为 `770f13b46162a38cfefbd55b6d45bc7118fa220dee110c0175fc955d21053fce`；恢复到隔离目录后哈希一致、完整性和外键检查通过，首页及健康接口均为 200。原飞牛 PostgreSQL 和 Web 服务始终保留并继续运行，迁移结束时源 `/health=200`。
- 清理结果：临时 PostgreSQL、隔离验证库、恢复演练副本、构建缓存、临时登录/token 文件和已授权删除的失败版本遗留均已删除。保留源快照、无敏感输出的校验证据、切换后物理备份及其环境 sidecar 和正式本机数据；本机 Docker 容器、镜像和卷均为 0。切换前回滚演练只保留校验记录，最终维护窗口必须重新生成并保留真实回滚目录。

## M2 临时停写候选预演

这次运行只验证维护窗口中的停写、最终快照、隔离恢复、迁移和源服务恢复。用户没有授权主服务切换，因此没有替换本机正式数据，也没有禁用飞牛服务。

- 运行编号：`m2-final-20260716T102959Z`；远端目录为 `/home/weio/.blinkora-migration/m2-final-20260716T102959Z`，本机证据目录为 `~/.blinkora/migrations/m2-final-20260716T102959Z`。
- 停写状态：命令会话中观察到 `blinkora.service` 停止，`blinkora-db.service` 保持 active；预演结束后重新启动 `blinkora.service`，飞牛和本机 `/health` 均返回 200。现有证据目录没有单独保存三次 systemd 状态快照，因此这里只记录会话观察，不把它写成文件级可复核证据；正式脚本会把状态阶段写入 `state` 和 `events.log`。
- 最终快照：PostgreSQL custom dump 为 285,330 字节，SHA-256 `700a9e67fbe5151b86dce73a9d26bdfd96b8d9860ebe3ff3156e1beab469195a`；`files.tar` 为 788,480 字节，SHA-256 `fea5d69199f87db66297691384177f127b0305581d4db1d28fc287407364b3a3`；secret sidecar 为 81 字节，SHA-256 `e7bf54cc125710cd72365fd66b711536313acedb97a414f66d8ce7de5e482ea1`。复制后逐文件哈希和 `pg_restore --list` 通过，没有输出 secret 内容。
- 附件目录：tar 中包含 4 个文件，候选逐文件 SHA-256 已记录；没有列举、读取、写入或删除任何现有 S3 业务对象。
- 隔离恢复：第一次向带默认 `public` schema 的空库执行 `pg_restore` 因 schema 已存在而安全失败，没有生成候选。清理该隔离临时库后，先删除空库自带 schema 再恢复，第二次成功。正式一键脚本已固定这一步，避免预演中的工具漂移。
- 迁移结果：14 表行数和最大 ID 与 M2-A 相同，逐表规范化 SHA-256、`integrity_check=ok`、`foreign_key_check=0` 和显式 orphan=0。候选 SQLite SHA-256 为 `0f20cdf6c16e1baed59de59c254d57c01c1e3d211c93501297478dc97bb0a092`。
- 数据变化识别：除 `agentAccessTokens` 外，其余表规范化哈希与 M2-A 相同；`agentAccessTokens` 从 M2-A 的 `d588…` 变为 `3d95b8a8899e309bd7b4bd216c21a6926bd675ac2292d9e259a599765a4038c7`，符合令牌 `lastUsedAt` 在主服务继续使用期间变化的现象。这里只作合理推断，未改写源数据；它再次证明正式切换不能只比较行数，也不能复用旧候选。
- 只读启动：候选在独立端口健康启动，迁移前账号 API token 可以读取数据。为避免更新 `lastUsedAt`，本轮没有用 Workspace token 调用候选；完整浏览器/MCP 写入仍留给最终候选的隔离克隆。
- 证据偏差：本次 `SHA256SUMS` 记录远端绝对路径，因此本机不能直接执行 `-c`，实跑改为逐文件比对；迁移日志还混入 Cargo 编译输出。两项都不影响已核对的数据结果，但不符合最终证据格式。一键脚本已经改为 basename 清单，并把迁移 stdout 与构建 stderr 分开保存。审计发现混合日志为 `0644` 后，已把整个预演证据树收紧为目录 `0700`、文件 `0600`。
- 最终状态：候选没有激活，本机正式 `data` 没有替换；飞牛恢复后继续作为唯一主服务。该候选及其本机隔离 PostgreSQL 只保留作预演证据，不能进入正式切换。

最终一键入口为 `bun run cutover:m2`。无参数只打印计划，`--prepare` 只读，`--confirm-cutover` 才会进入双重确认的维护窗口。`bun run verify:m2-cutover` 已用 15 个纯临时目录场景验证默认空操作、SSH TTY sudo 封装、远端 helper 语法、冲突拒绝、候选失败、确认拒绝、SIGTERM、三种半切换、健康失败、无法停止候选时拒绝移动、完整回滚和成功提交；本次真实 dump 还在本机隔离 PostgreSQL 中重新通过 schema 恢复、14 表迁移、完整性、外键、orphan 和环境 sidecar 权限校验。以上测试没有连接飞牛、S3 或常驻 `6676`。

## 待验 / 阻断发布

- **M1 唯一发布阻断是凭据处置。** 对话中曾暴露真实 S3 AccessKey；本轮隔离恢复排障的一条过宽检查命令又在工具输出中回显了本机 `BLINKORA_SECRET`。两者都没有写入仓库或正式证据文件，但应按已暴露处理。用户需要完成轮换，或明确接受临时风险并给出轮换期限；在此之前只能写“M1 技术门禁通过，待安全收口”，不能签署“M1 已交付”。
- **M2 最终停写切换尚未执行。** 不停服只读副本和一次临时停写候选均已通过，但临时停写预演结束后飞牛已经恢复写入，候选随即陈旧；本机仍是 `2026-07-16T08:46:21Z` 的点时间副本。正式维护窗口必须重新停写、生成全新快照、重做全量迁移和隔离 smoke，再经过独立激活确认切换主服务。
- **真实 S3 内容未纳入本轮读取验收。** 8 条附件记录和 S3 配置已无损迁移，但按用户要求没有列举、读取、下载、写入或删除现有业务对象，因此内容 SHA-256、真实附件预览和最终切换后的 S3 可用性仍待维护窗口或独立只读授权验证。源 `files/` 中 2 个无数据库引用的遗留文件也仍需在最终迁移前决定是否作为原始目录快照一并归档。
- **最终候选浏览器/MCP smoke 尚未执行。** M2-A 真实结构克隆通过浏览器、MCP、Workspace 级备份恢复、令牌和清理；临时停写候选只做了账号 API token 只读检查。正式脚本会在激活前对全新候选克隆重跑完整隔离 smoke，现有业务 S3 对象继续禁止访问。
- **当前候选的 Linux/Docker release 未重跑。** M1 明确只交付 macOS 本地部署；`bun run build:rust-release` 在本机进入 Linux musl 阶段时因 Homebrew Rust 缺少该 target 无法继续，且本轮按用户要求不启动 Docker fallback。Web、macOS native release 和常驻部署均已通过；Linux/Docker 保留既有证据，若以后恢复该交付面，必须基于当前候选重跑。
- `bunx tsc --noEmit -p app/tsconfig.json` 不是当前交付门禁，且仍存在仓库历史类型错误；正式 `bun run build:web --force` 已通过。若以后把独立 `tsc` 提升为门禁，需要先清理或建立明确基线。
- 卡片长按拖动、相机/麦克风入口重新启用后的权限拒绝、Firefox/Safari 和更多移动尺寸属于延期未分类，不涉及数据测试跳过。相机/麦克风当前没有产品入口；M1 已覆盖音频/视频附件、卡背、多引用、全屏浮层、日夜主题、桌面/移动和真实 OSS 卡片级联删除。
- 飞牛实际机器的 systemd 安装、更新、启动、停止和卸载不属于 `blinkora_local` 分支范围。本轮只保留模板语法校验，不写成飞牛实机通过。

## 当前结论

2026-07-16，冻结候选的 macOS 本地工程门禁通过，M1 状态仍为 **技术通过，待安全收口**，唯一安全阻断是已暴露 S3 AccessKey 和本机 `BLINKORA_SECRET` 的用户侧处置。

同日完成的 M2 只读副本和受控临时停写候选已经证明真实 14 表数据可无损落到本机 SQLite，源服务可安全恢复；真实结构隔离克隆的浏览器/MCP/备份恢复和全新 S3 前缀 smoke 也已通过。最终一键切换与自动回滚保护已实现并通过隔离故障矩阵，但没有用于现网。飞牛仍是主服务，8 个现有 S3 业务对象按用户边界未读取。因此当前结论为 **M2 切换前预检与停写预演通过，最终生产切换待维护窗口**，不能宣告原始数据库替换目标全部完成。
