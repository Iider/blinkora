# Linux 无头单二进制部署

Blinkora 的 Linux 交付面只支持无头服务器。发布物是一个静态链接的 `blinkora-server`：内置 SQLite schema、Web 前端和所有静态资源，不需要 Docker、Bun、Node.js、Rust、SQLite CLI、GUI、FUSE 或额外的 `public/`、`db/` 目录。

## 构建发布物

在开发机或 CI 执行：

```bash
bun run build:linux-headless
```

产物为 `release/linux/blinkora-server-<version>-linux-x86_64` 和同名 `.sha256`。发布前后都应校验 SHA-256。单文件只包含程序代码和只读资源；SQLite、附件、日志和密钥绝不打进二进制。

构建机缺少 Linux musl 交叉编译环境时，脚本会尝试临时 Docker builder；也可以显式设置 `BLINKORA_RUST_DOCKER_BUILD=1`。Docker 只参与构建，目标服务器始终直接运行二进制。

## systemd 部署

以下示例以 `blinkora` 系统账号、`/opt/blinkora` 程序目录和 `/var/lib/blinkora` 数据目录为例。数据目录必须是本机磁盘，不能是 NFS、SMB 或云盘同步目录。

```bash
sudo useradd --system --create-home --home-dir /var/lib/blinkora --shell /usr/sbin/nologin blinkora
sudo install -d -o blinkora -g blinkora -m 0700 /opt/blinkora /opt/blinkora/backups /var/lib/blinkora/data
sudo install -d -o root -g root -m 0700 /etc/blinkora
sudo install -o root -g root -m 0755 \
  blinkora-server-<version>-linux-x86_64 /opt/blinkora/blinkora-server
sudo sh -c 'umask 077; { \
  printf "NODE_ENV=production\\nBIND_ADDR=127.0.0.1\\nPORT=6676\\nDATA_DIR=/var/lib/blinkora/data\\nBLINKORA_SECRET="; \
  openssl rand -hex 32; \
  printf "RUST_LOG=info\\n"; \
} > /etc/blinkora/blinkora.env'
```

上述命令原子创建权限为 `0600` 的 `/etc/blinkora/blinkora.env`，不会把密钥输出到终端。不要把 `BLINKORA_SECRET` 放到 shell 历史、命令行、Git 或聊天记录。

创建 `/etc/systemd/system/blinkora.service`：

```ini
[Unit]
Description=Blinkora SQLite Web service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=blinkora
Group=blinkora
EnvironmentFile=/etc/blinkora/blinkora.env
ExecStart=/opt/blinkora/blinkora-server
Restart=on-failure
RestartSec=3
TimeoutStopSec=20s
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

启用并检查服务：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now blinkora.service
sudo systemctl status --no-pager blinkora.service
curl -fsS http://127.0.0.1:6676/health
```

默认只监听 `127.0.0.1`，建议通过反向代理提供 HTTPS 访问。如果确实需要局域网直连，将 `BIND_ADDR` 改为 `0.0.0.0`，并同时配置主机防火墙与访问控制。

## 升级、备份与回退

升级只替换二进制，绝不替换 `DATA_DIR`。服务收到停止信号时会先等待最多 20 秒让已有请求完成，超时后由 systemd 结束进程：

```bash
sudo systemctl stop blinkora.service
sudo cp /opt/blinkora/blinkora-server /opt/blinkora/backups/blinkora-server.pre-<version>
sudo install -m 0755 blinkora-server-<new-version>-linux-x86_64 /opt/blinkora/blinkora-server
sudo systemctl start blinkora.service
curl -fsS http://127.0.0.1:6676/health
```

若新版本无法健康启动，先停止服务，再把 `backups/blinkora-server.pre-<version>` 覆盖回 `/opt/blinkora/blinkora-server` 后启动。数据库与附件始终保留在 `DATA_DIR`，不能随着程序回退被删除或覆盖。

物理备份需要停止单个服务进程后执行 `scripts/sqlite-backup.sh --offline`；恢复必须落到空数据目录。不要只复制 `blinkora.sqlite3` 主文件，因为 WAL 中可能有已提交数据。
