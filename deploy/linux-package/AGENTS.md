# Blinkora 部署包 Agent 指南

Blinkora 无头 Linux x86_64 部署包，不含源码。优先使用随包脚本，不要自行编译，也不要引入 Docker。

## 部署目标

- 使用 systemd 运行一个 `blinkora-server` 进程。
- 程序安装到 `/opt/blinkora/blinkora-server`。
- SQLite 与附件保存在 `/var/lib/blinkora/data`。
- 运行配置保存在 `/etc/blinkora/blinkora.env`。
- 默认只监听 `127.0.0.1:6676`。

## 必须遵守的边界

- 先运行 `./install.sh verify-package` 和 `./install.sh check`，任何一项失败都不要继续。
- 安装需要 root 权限。执行前应向用户说明会创建系统账号、目录和 systemd unit，然后使用 `sudo ./install.sh install`。
- 不要把 `BLINKORA_SECRET`、登录令牌或数据库内容输出到终端、对话、日志或其他文件。
- 不要删除或覆盖 `/var/lib/blinkora/data`。升级只允许替换二进制和受控更新 systemd unit。
- 如果已有 systemd unit 使用不同的 `ExecStart`，或环境文件使用不同的 `DATA_DIR`，不要自动迁移或覆盖；向用户报告冲突并等待决定。
- 不要自动把服务开放到局域网或公网。修改 `BIND_ADDR`、防火墙或反向代理前必须获得用户明确同意。
- 数据目录必须位于服务器本机磁盘，不能放在 NFS、SMB 或云盘同步目录。

## 推荐流程

```bash
./install.sh verify-package
./install.sh check
sudo ./install.sh install
./install.sh status
```

安装器会校验包内容，创建专用系统账号和权限受限的配置，保留已有配置与数据，升级前备份旧二进制，并在新版本健康检查失败时回滚运行时。

完成后向用户报告：安装版本、systemd 状态、访问地址、数据目录，以及是否仍需配置反向代理或局域网访问。不要在报告中包含密钥。

## 排障

```bash
./install.sh status
./install.sh logs
```

若安装器失败，先阅读它输出的原因和 journal。不要通过删除数据目录、重新生成已有密钥或降低文件权限来绕过问题。
