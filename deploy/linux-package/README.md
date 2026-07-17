# Blinkora Linux 分享包

这是 Blinkora 的无头 Linux x86_64 原生部署包。程序、Web 前端和 SQLite schema 已经合并在一个静态二进制中，目标服务器不需要 Docker、Bun、Node.js、Rust、SQLite CLI 或图形界面。

如果由 Agent 部署，请让它先阅读同目录的 `AGENTS.md`。

## 系统要求

- x86_64 Linux
- systemd
- root 或 `sudo` 权限
- 本机磁盘上的数据目录
- Bash 4+
- `systemctl`、`journalctl`、`install`、`od`、`getent`、`useradd`、`groupadd`
- `sha256sum` 或 `shasum`

## 安装

```bash
./install.sh verify-package
./install.sh check
sudo ./install.sh install
```

安装完成后：

```bash
./install.sh status
./install.sh logs
```

默认访问地址是 `http://127.0.0.1:6676`。它只允许服务器本机访问；需要局域网或公网访问时，应先配置防火墙和 HTTPS 反向代理，再按实际网络方案修改 `/etc/blinkora/blinkora.env` 中的 `BIND_ADDR`。

## 默认目录

| 内容 | 路径 |
| --- | --- |
| 运行二进制 | `/opt/blinkora/blinkora-server` |
| 二进制回退备份 | `/opt/blinkora/backups` |
| SQLite 与附件 | `/var/lib/blinkora/data` |
| 环境配置 | `/etc/blinkora/blinkora.env` |
| systemd unit | `/etc/systemd/system/blinkora.service` |

配置和数据都在二进制之外。重新运行新版本分享包里的 `sudo ./install.sh install` 即可升级；安装器会保留数据与密钥，并在健康检查失败时恢复旧运行时。

不要单独复制正在运行的 `blinkora.sqlite3`。备份前应先停止 `blinkora.service`，并同时保存整个数据目录和 `/etc/blinkora/blinkora.env`。
