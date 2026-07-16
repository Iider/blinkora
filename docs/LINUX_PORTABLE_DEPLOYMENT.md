# Linux 便携版（AppImage）

面向 x86_64/amd64 Linux 桌面用户，Blinkora 提供一个可直接双击的 AppImage。用户不需要安装 Docker、Bun、Node.js、Rust 或 SQLite；应用内含静态链接的 Rust 服务端和 Web 前端，启动后会打开本机浏览器。

## 构建发布包

在开发机或 CI 中准备 `appimagetool`，然后执行：

```bash
bun install
APPIMAGETOOL=/绝对路径/appimagetool-x86_64.AppImage \
BLINKORA_RUST_DOCKER_BUILD=1 \
bun run build:linux-appimage
```

产物位于 `release/appimage/Blinkora-<version>-x86_64.AppImage`，同目录的 `.sha256` 文件用于发布前和下载后的校验。构建脚本固定生成 `x86_64-unknown-linux-musl` 静态二进制；Docker builder 仅在构建机使用，最终用户不需要 Docker。

建议随发行包提供 SHA-256 值和最小使用说明：下载后勾选“允许作为程序执行”，或运行 `chmod +x Blinkora-*.AppImage`，再双击文件即可。部分没有 FUSE 的发行版会由 AppImage 运行时提示安装兼容包；这不影响其中的 Blinkora 数据。

## 运行与数据位置

默认直接双击会启动服务并打开 `http://127.0.0.1:6676`。服务只监听本机回环地址，不会暴露到局域网。

| 内容 | 默认位置 |
| --- | --- |
| SQLite 与本地附件 | `~/.local/share/blinkora/data` |
| 持久密钥 | `~/.config/blinkora/blinkora.env` |
| 已解包的版本化运行时与日志 | `~/.local/state/blinkora` |

这些位置遵循 `XDG_DATA_HOME`、`XDG_CONFIG_HOME` 和 `XDG_STATE_HOME`。升级 AppImage 不会覆盖用户数据或密钥；只有运行时副本会按版本更新。

终端控制命令（文件名按实际版本替换）：

```bash
./Blinkora-<version>-x86_64.AppImage --status
./Blinkora-<version>-x86_64.AppImage --stop
./Blinkora-<version>-x86_64.AppImage --restart
./Blinkora-<version>-x86_64.AppImage --headless
```

`--restart` 会让正在运行的本机服务切换到当前 AppImage 的运行时，数据目录保持不变。遇到页面无法打开时，先查看 `~/.local/state/blinkora/logs/server.log`，不要删除 SQLite 文件来排障。

## 备份与恢复

先完全停止 AppImage，再对数据目录做物理备份：

```bash
./Blinkora-<version>-x86_64.AppImage --stop
scripts/sqlite-backup.sh --offline \
  --data-dir "$HOME/.local/share/blinkora/data" \
  --output /安全的备份位置/blinkora-$(date +%F)
```

恢复只能落到空数据目录，详见 `scripts/sqlite-restore.sh --help`。不要只复制 `blinkora.sqlite3` 主文件：正在使用 WAL 时，那样的副本可能缺少已提交的数据。

## 适用范围

这是桌面单用户模式：一台机器只运行一个 Blinkora 进程，SQLite 数据目录必须是本机文件系统，不能放在 NFS、SMB 或云盘同步目录。飞牛等 NAS 的常驻运行方式见 [飞牛常驻部署](./FNAS_PERSISTENT_DEPLOYMENT.md)。
