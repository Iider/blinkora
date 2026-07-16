# 本机持久化部署

这个模式直接在 macOS 上用 `launchd` 运行 Blinkora，不需要 Docker。SQLite、附件、运行配置和本机发布产物都放在用户目录，重启、升级和卸载服务都不会删除数据。

- 数据目录：`~/.blinkora/local/data`（含 `blinkora.sqlite3` 与 `files/`）
- 服务配置：`~/.blinkora/local/blinkora.env`，权限为 `0600`
- 服务日志：`~/.blinkora/local/logs`
- 本机发布产物：`~/.blinkora/local/release`，避免 `launchd` 读取受 macOS 文件访问控制保护的项目目录
- 访问地址：`http://localhost:6676`

## 前置条件

- Bun：构建前端资源。
- Rust toolchain：编译 macOS 本机 `blinkora-server`。

## 安装与更新

```bash
bun run deploy:local install
# 代码更新后
bun run deploy:local update
```

安装脚本会构建前端和本机 release、生成随机 `BLINKORA_SECRET`、写入受限权限的环境文件，并安装 `com.blinkora.local`。首次启动会在 `DATA_DIR` 创建 SQLite schema；已有库会先做版本和完整性探针，不会覆盖非空未知数据库。`install`、`update` 和 `start` 只有在 `http://127.0.0.1:6676/health` 成功后才返回；30 秒内未就绪会失败并输出最近的错误日志。

## 日常命令

```bash
bun run deploy:local status
bun run deploy:local logs
bun run deploy:local restart
bun run deploy:local rotate-secret
bun run deploy:local stop
bun run deploy:local start
bun run deploy:local uninstall
```

`uninstall` 只移除 `launchd` 服务，保留全部数据。

`rotate-secret` 会生成新的随机 `BLINKORA_SECRET` 并重启服务。轮换后现有登录会话和账号 API token 立即失效，需要重新登录并更新使用账号 token 的外部调用；密码、笔记、附件和 Workspace Agent token 不受影响。新服务未能通过健康检查时，脚本会恢复原环境和服务。

## 验收与排障

```bash
curl -fsS http://127.0.0.1:6676/health
sqlite3 ~/.blinkora/local/data/blinkora.sqlite3 'PRAGMA integrity_check;'
sqlite3 ~/.blinkora/local/data/blinkora.sqlite3 'SELECT COUNT(*) FROM pragma_foreign_key_check;'
```

健康接口仅在 SQLite 已打开、schema 已完成且探针成功时返回 `200`。页面打不开时先检查 `bun run deploy:local status`、端口监听和 `~/.blinkora/local/logs/blinkora.err.log`。若数据目录只读、磁盘空间不足、数据库损坏或 schema 版本过新，服务会拒绝提供健康状态；先保留原文件，再根据错误恢复。

需要回归浏览器数据主路径时，在安装了本机 Google Chrome 的 macOS 开发机运行：

```bash
bun run smoke:browser-local
```

该命令会重新构建一个临时原生 release，在独立 SQLite 目录中完成桌面和移动登录、工作区创建/自动切换/重载后回显、三类笔记创建、每日回顾、闪念/笔记/待办编辑（各自历史；笔记另含嵌套标签、附件新增/删除和引用）、待办完成/恢复、置顶、归档/恢复、回收站/恢复及确认后的彻底删除、评论树新建/回复/编辑/两级删除、日期范围、附件、外链、Markdown 待办与无标签条件筛选/重置（可持久筛选另验证刷新后回显）、操作日志正文/操作者/笔记类型/操作类型组合筛选、隔离库中本地字体的选择/重载/恢复默认，以及闪念、笔记、待办、全部、归档和回收站列表的页码分页（均覆盖第 2 页刷新、删除后保持页码与越界页回首页）。它还会验证单卡移入默认工作区后的评论树回显、工作区 Agent 令牌生成及调用指南回显、S3 未填凭据时禁止验证、临时空工作区的 Markdown 导出后重新导入、全量 JSON 导出后经设置页全量恢复并清理导入副本、全局笔记/附件搜索和资源目录创建/附件与目录重命名/嵌套、附件移入目录后移回根目录、两项附件多选删除和同前缀兄弟目录删除保护。它要求浏览器 console 与本机 4xx/5xx 为 0，并检查 SQLite 完整性、外键、连续历史版本、编辑操作日志、迁移笔记的历史/评论/附件/标签工作区归属、已删除附件不再存在、orphan 和目录记录落盘。它不访问 `6676` 的常驻服务，结束时会删除临时服务、数据和构建目录。

高风险回归还覆盖五种 JSON 自定义属性、只改 metadata 时保留正文/附件/引用、三类笔记往返转换不丢数据、标签与附件组合筛选、浏览器下载字节校验，以及 Workspace 重命名、默认保护、两卡批量移动和当前 Workspace 级联删除后的零残留检查。

需要实测真实 S3 兼容存储时，将 S3 smoke 所需变量放入权限为 `0600` 的本地环境文件后加载，再运行：

```bash
BLINKORA_S3_SMOKE_CUSTOM_PATH=codex-sqlite-qa \
  bun run smoke:s3-local
```

该命令重新构建隔离原生 release，不访问 `6676`，自动创建临时账号和 SQLite，并把对象限制在专用测试路径下的 `smoke-*` 随机子目录。测试会验证配置、上传、读取、移动、删除、删除后 404 和回退本地存储；正常结束后删除临时本地数据与测试对象。不要把生产附件正在使用的自定义路径传给 smoke。

macOS 可能因复制后二进制保留的 Finder provenance 而以 `OS_REASON_CODESIGNING` 终止 `launchd` 服务。`install`、`update` 和 `start` 会清理该元数据并重新进行 ad-hoc 签名；若系统提示缺少 `codesign`，先安装 Xcode Command Line Tools。

## 物理备份与恢复

先停止服务，再执行：

```bash
bun run deploy:local stop
scripts/sqlite-backup.sh --offline \
  --data-dir ~/.blinkora/local/data \
  --output ~/BlinkoraBackups/20260714
```

该命令用 SQLite `.backup` 生成一致数据库快照，并在服务停写时一并复制附件；不能只复制 `blinkora.sqlite3` 主文件。恢复时必须使用空数据目录：

```bash
scripts/sqlite-restore.sh \
  --backup ~/BlinkoraBackups/20260714 \
  --data-dir ~/.blinkora/local/data-restored
```

恢复后启动 Blinkora，完成登录、附件读取和健康检查，再切换正式数据目录。
