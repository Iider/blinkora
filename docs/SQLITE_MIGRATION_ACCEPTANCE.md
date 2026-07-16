# SQLite 替换验收记录

这份记录只记已经实际执行的证据；没有执行的项目明确标为待验，不以“可编译”代替验收。

## 本次候选

- 基线提交：`f061365fa802e63ccbe1090aa9c0c837b8064057`（迁移前运行时）。
- 候选功能提交：`ce12b83`（SQLite 运行时替换、验收门禁、浏览器兼容性、两步验证登录、PostgreSQL 残留防回归、REST/MCP/搜索边界差分、不完整附件备份的零写入拒绝、本机部署旧数据库环境清理、稳定的日期筛选、部分更新保留未提交字段、批量 Workspace 移动，以及扩展后的隔离浏览器 smoke）。
- 部署范围：`blinkora_local` 仅在 macOS 本机持久化模式部署，不包含飞牛部署。本记录不把模板校验视为飞牛实机验收，也不据此宣称飞牛或全平台已通过。
- 平台：macOS arm64、本地文件系统、OrbStack Docker、PostgreSQL 14.23、SQLite CLI 3.x、Rust 1.96。
- 数据规模：真实接口 smoke；2,100 条批量笔记；10 客户端 300 秒并发；物理备份/空目录恢复；PostgreSQL 真实迁移夹具。

## 已通过

| 项目 | 证据 |
| --- | --- |
| SQLite 初始化与升级保护 | Rust 集成测试覆盖空库、重复启动、WAL、外键、5 秒 busy timeout、`FULL` 同步、JSON 对象/嵌套对象/数组/字符串/数字/布尔/`null` 包含语义、评论 metadata 一层合并、事务回滚与 2,100 ID JSON 绑定。 |
| 事务与并发 | 单进程写门控覆盖 tRPC、MCP 转发、备份导入和文件写入；10 客户端实际持续 300 秒，完成 2,970 次写入和 990 次读取，种子笔记历史版本连续 990 条；无 `database is locked`、非预期 5xx 或 orphan。完整脚本见 `scripts/sqlite-concurrency.mjs`。 |
| 2,000 ID 批量路径 | `bun run test:sqlite-bulk` 实测 2,000 条记录的更新、跨 Workspace 移动、导出与删除。 |
| 接口 smoke | `smoke:rust` 和 `smoke:agent` 均在恢复后的 SQLite 数据目录通过。另以 MinIO 启动真实 S3-compatible 服务完成 `smoke:rust` 的 S3 分支（配置校验、上传、读取、移动、删除、目录删除与切回本地存储）。覆盖登录、Workspace、笔记、历史、标签、评论、附件、导入导出、MCP 和 Agent token。 |
| 真实云 S3 | 已在阿里云 OSS 北京区域执行 `bun run smoke:s3-local`，全程不使用 Docker。最近一次只使用全新的 `codex-sqlite-qa-20260716/smoke-*` 随机子前缀，不读取或复用现有 `blinkora/`、`blinkora_local/` 对象；已完成 S3 配置校验、上传、逐字节读取、移动、再次读取、删除、删除后 404 及回退本地存储。临时服务、SQLite、构建目录和测试对象均已清理，凭据未写入日志或仓库。 |
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
| 构建与 Docker 运行时 | `bun run build:web --force`、`bun run verify:rust`、macOS 原生 `cargo build --release --locked --manifest-path server/Cargo.toml`、当前候选的 `bun run build:rust-release`（arm64）及强制 amd64 Docker build 均通过，产物分别为 aarch64 与 x86-64 Linux ELF。`docker compose config --services` 仅输出 `web`，无 PostgreSQL 端口或服务。隔离 arm64 runtime 实际将临时 `DATA_DIR` 挂载到 `/app/.blinkora`（正式镜像的默认路径）：健康检查、静态首页、完整 `smoke:rust` 与 `smoke:agent` 均通过。容器重建后原账号可登录；离线前后账号/笔记/附件行数均为 `1/16/6`，`integrity_check=ok`、外键检查为 0。数据目录为 `0700`，数据库及 WAL 为 `0600`。本地分支交付前已删除全部验收容器、镜像和 BuildKit 缓存；最终 `docker system df` 为 0 镜像、0 容器、0 卷、0 Build Cache，默认 bridge/host/none 网络之外没有项目网络。 |
| PostgreSQL 残留防回归 | `verify:rust` 会执行 `scripts/verify-sqlite-runtime-residuals.mjs`：检查 17 个部署文档、模板与 Compose 文件不含 PostgreSQL URL、`psql`、旧容器名、默认端口或运行时环境变量；检查 30 个正式运行时源文件不含 PostgreSQL 专用 backend 或 SQL 语法，并要求 Compose 只定义 `web` 服务。 |
| 浏览器核心 smoke | 同一隔离 SQLite Docker 实例中，桌面和 390×844 移动视口均完成真实登录与主界面验证；笔记列表、带附件笔记、底部导航与移动侧栏开合正常。最新候选重新构建后，以全新登录标签页验证桌面待办页和编辑器，以及 390×844 待办页；控制台 error、warn、warning 均为 0。当前 macOS 原生本地服务也已验证未登录的桌面与 390×844 登录、注册页正常渲染，控制台 error、warn、warning 均为 0。 |
| 浏览器扩展 smoke | 新建隔离 Docker 实例后，完整 `smoke:rust` 先通过；浏览器随后真实创建闪念、笔记、待办各一条，标签树筛选和全局搜索均能找到新闪念，资源页能列出既有附件并创建/进入嵌套目录，设置页能读取操作日志及新建笔记的日志记录。最新候选通过 UI 将 `type=2` 待办更新为带 `（再次编辑）` 的内容；离线检查确认 `noteHistory.version=1` 保存前一版本，`integrity_check=ok`，`foreign_key_check` 为 0 行，容器重启后 `/health` 恢复正常。基础设置与 2FA 入口均正常渲染。 |
| macOS 本机持久化 | 在隔离用户目录中实际执行 `install → update → smoke:rust → smoke:agent → stop → start → uninstall`，全程不启动 Docker。重启后原账号能登录、笔记数不变；卸载后 `blinkora.sqlite3` 保留，`integrity_check=ok`、`foreign_key_check` 为 0。默认本机目录也已用候选 `ce12b83` 再次执行 `bun run deploy:local update`：更新后 `/health` 正常、首页为 HTTP 200、SQLite `integrity_check=ok`、`foreign_key_check=0`，服务由 `com.blinkora.local` 在 6676 运行，原 `DATA_DIR` 未替换。应用目录和数据目录为 `0700`，数据库为 `0600`。发布产物位于用户目录；启动前清理二进制 provenance 并进行 ad-hoc 签名，静态页面可访问，服务不会因 `OS_REASON_CODESIGNING` 退出。 |
| macOS 原生隔离数据浏览器 smoke（本轮） | 不使用 Docker；在临时原生 `launchd` 服务、独立 `DATA_DIR` 和临时 SQLite 文件中，用浏览器真实注册/登录测试账号后创建闪念、笔记、待办各一条。已验证待办完成、笔记编辑及两次历史写入、评论新增、`#sqlite-smoke-tag` 标签写入、全局子串搜索（等待搜索防抖后命中）、新建工作区、跨工作区移动笔记及切换隔离、资源目录新建和重命名。390×844 下资源列表、笔记列表和详情均正常渲染。结束前数据库 `integrity_check=ok`、`foreign_key_check` 为 0 行；历史、评论、标签关系、附件关联的 orphan 检查均为 0。随后已经停止临时 `launchd` 服务，并删除临时 SQLite、资源目录、测试账号和构建目录；正式本地服务仍在 6676 健康运行。 |
| 可重复 macOS 原生浏览器 smoke（本轮） | `bun run smoke:browser-local` 从空目录构建独立原生 release 和 SQLite 服务，不使用 Docker、不访问常驻 `6676`；以本机 Chrome 在桌面与 390×844 视口完成注册/登录、工作区创建/自动切换/重载后回显、闪念/笔记/待办创建、每日回顾、闪念/笔记/待办编辑（各自均有历史；笔记另含唯一嵌套标签、附件和笔记引用）、待办完成/恢复、置顶、归档/恢复、回收站/恢复及确认后的彻底删除、评论树新建/回复/编辑/两级删除（回复必须渲染在根评论线程内）、日期范围/附件/外链/Markdown 待办/无标签条件筛选及重置、嵌套标签树父/子节点筛选/刷新后回显，以及闪念、笔记、待办、全部、归档和回收站列表的页码分页（每类 10 条/页；全部列表共 36 条，均覆盖第 2 页刷新、删除后保持页码和越界页复位；回收站的第 2 页再确认彻底删除一张）。它还验证单卡移入默认 Workspace 后的评论树回显、当前 Workspace Agent 令牌的生成与调用指南回显、S3 未填凭据时“保存并验证”保持禁用、临时空工作区经设置页导出 ZIP 后重新导入、全量 JSON 导出和恢复、操作日志组合筛选、本地字体选择/重载/恢复默认、全局笔记/附件搜索，以及资源目录创建/附件与目录重命名/嵌套、附件移入目录后移回根目录、确认删除和两项多选删除、同前缀兄弟目录删除保护。北京时间午夜后的实跑中，日期请求明确为 `2026-07-14T00:00:00.000Z` 至 `2026-07-19T00:00:00.000Z`，后端返回创建时记录的同一稳定笔记 ID；测试不再把本地自然日和现有 UTC 日期序列化契约混为一谈。清除 token、笔记内容、附件和认证流程的浏览器调试输出后，同一完整清单在候选功能提交 `ce12b83` 再次通过。它对每个本机 4xx/5xx、console error 与 page error 失败；结束前断言 11 条闪念、13 条笔记（其中一条已移至默认 Workspace）和 12 条待办已保存，三种编辑正文与所选 Workspace 已保存，三种笔记均存在至少一条历史且每张笔记历史版本从 1 连续递增；笔记编辑另有操作日志，移动笔记的历史/评论/附件/标签都曾在目标 Workspace 回显，附件和临时评论树均已删除、重命名的根目录及嵌套目录和同前缀受保护目录占位记录均已落盘、`integrity_check=ok`、`foreign_key_check=0` 及 Workspace/历史/评论/附件/标签/操作日志关联 orphan 为 0。完整实跑通过后临时服务、SQLite 和构建目录均已删除，6676 保持健康。编辑器使用被编辑笔记的类型，不受全局选择变化影响。 |
| 部分更新与 Workspace 高风险浏览器回归（本轮） | 同一次 `ce12b83` 隔离实跑新增以下断言：自定义属性覆盖字符串、数字、布尔、`null` 和数组；仅改 metadata 时请求体严格只含 `id` 与 `metadata`，响应仍保留正文、附件和出站引用；同一记录按 Note → Blinkora → Todo → Note 往返转换后，正文、metadata、附件和引用均不丢失。标签与附件组合筛选覆盖刷新回显和重置，附件经浏览器真实下载后逐字节相等。Workspace 覆盖重命名、切换默认、默认 Workspace 删除保护、恢复默认、两张笔记批量移入指定目标，以及删除当前临时 Workspace；级联删除响应确认删除一个附件文件，离线检查笔记、历史、标签关系、评论树、附件、Agent token 和操作日志残留均为 0。 |
| 飞牛 unit 模板 | `bun run verify:fnas-systemd` 校验 `deploy/fnas/blinkora.service` 的 section、关键值、服务账号、环境文件和 `ExecStart` 路径。该项仅验证部署定义。 |

## 待验 / 阻断发布

- 桌面和移动端的自动化核心浏览器 smoke 已覆盖登录/两步验证、Workspace 创建/切换/重命名/默认保护/单卡和批量移动/当前 Workspace 级联删除、三类笔记新建/编辑/历史/类型往返、五类自定义属性、每日回顾、标签树、附件上传/下载字节校验/移动/重命名/单项与多项删除、引用、置顶/归档/回收、评论树、组合筛选、分页、操作日志、字体、导入导出、Agent 令牌和资源目录。完整人工数据清单仍未 100% 执行：富文本预览、复制、全屏、卡片背面、主题和滚动等视觉/手势状态，图片/音频/视频预览与相机/麦克风路径，自定义属性的非法值/清空/Markdown 链接交互，共享资源删除选择及多引用边界，以及 S3 设置页成功保存、图片预览/编辑/删除和删卡级联对象删除仍需逐项人工验证。真实 S3 API smoke 已通过，但不能代替这些浏览器 UI 路径。
- 旧的 `releasePointerCapture` 是坐标注入工具产生的 pointer id 与浏览器状态不一致时触发的第三方 UI 库异常。新的 Chrome 浏览器 smoke 使用标准浏览器输入路径，桌面和移动全程 console error/page error/local 4xx/5xx 均为 0；该工具伪差异不再作为发布阻断项。完整人工数据清单仍须按上一项补齐。
- `bunx tsc --noEmit -p app/tsconfig.json` 不是当前交付门禁，且目前仍会报出仓库既有的全项目类型错误；正式 `bun run build:web --force` 已通过，但若后续把独立 `tsc` 提升为门禁，需先清理或建立明确基线。
- 生产数据仍在用户当前服务器。按用户要求，本轮没有连接、停写、快照、迁移或修改该服务器，也没有读取其 S3 对象；14 表迁移、凭据延续、哈希和回滚证据来自隔离 PostgreSQL 夹具，不能冒充生产切换证据。只有用户另行安排维护窗口并明确授权后，才能执行真实生产迁移和回滚演练。
- 飞牛实际机器的 systemd 安装、更新、启动、停止和卸载未执行；该部署不属于当前本地分支范围。后续若发布飞牛版本，仍须单独完成该项实机验收，不能用 Linux Docker 构建结果代替。

在浏览器清单和生产数据切换补齐并记录结果前，本次数据库替换不能标记为“全部验收通过”。飞牛版本另按上述平台门禁验收。
