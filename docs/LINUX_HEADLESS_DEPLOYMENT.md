# Linux 无头单二进制部署

Blinkora 的 Linux 交付面只支持无头服务器。发布物是一个静态链接的 `blinkora-server`：内置 SQLite schema、Web 前端和所有静态资源，不需要 Docker、Bun、Node.js、Rust、SQLite CLI、GUI、FUSE 或额外的 `public/`、`db/` 目录。

## 构建发布物

在开发机或 CI 执行：

```bash
bun run build:linux-headless
```

产物包括：

- `release/linux/blinkora-server-<version>-linux-x86_64` 与同名 `.sha256`；
- `release/linux/blinkora-<version>-linux-x86_64.tar.gz` 与同名 `.sha256`。

压缩包用于直接分享，内含二进制、`AGENTS.md`、简明说明、systemd 安装器、版本元数据和逐文件 `MANIFEST.sha256`。单文件和压缩包都不包含 SQLite、附件、日志或密钥。

构建机缺少 Linux musl 交叉编译环境时，脚本会尝试临时 Docker builder；也可以显式设置 `BLINKORA_RUST_DOCKER_BUILD=1`。Docker 只参与构建，目标服务器始终直接运行二进制。

## 分享包部署

把 `.tar.gz` 和外层 `.sha256` 一起发给对方。接收方校验并解压后，Agent 应先读取包根目录的 `AGENTS.md`：

```bash
sha256sum --check blinkora-<version>-linux-x86_64.tar.gz.sha256
tar -xzf blinkora-<version>-linux-x86_64.tar.gz
cd blinkora-<version>-linux-x86_64
./install.sh verify-package
./install.sh check
sudo ./install.sh install
./install.sh status
```

安装器固定使用下方 systemd 布局，默认只监听 `127.0.0.1:6676`。它会保留已有环境文件和数据，升级前备份旧二进制；新服务未通过健康检查时恢复此前的二进制、unit 和启用状态。若发现同名 systemd unit 使用不同 `ExecStart`，或现有环境文件使用其他 `DATA_DIR`，安装器会拒绝覆盖，交由用户决定是否迁移。

## systemd 部署

以下示例以 `blinkora` 系统账号、`/opt/blinkora` 程序目录和 `/var/lib/blinkora` 数据目录为例。数据目录必须是本机磁盘，不能是 NFS、SMB 或云盘同步目录。

```bash
sudo groupadd --system blinkora
sudo useradd --system --gid blinkora --home-dir /var/lib/blinkora --shell /usr/sbin/nologin blinkora
sudo install -d -o root -g root -m 0755 /opt/blinkora
sudo install -d -o root -g root -m 0700 /opt/blinkora/backups
sudo install -d -o blinkora -g blinkora -m 0700 /var/lib/blinkora /var/lib/blinkora/data
sudo install -d -o root -g root -m 0700 /etc/blinkora
sudo install -o root -g root -m 0755 \
  blinkora-server-<version>-linux-x86_64 /opt/blinkora/blinkora-server
sudo sh -c 'umask 077; { \
  printf "NODE_ENV=production\\nBIND_ADDR=127.0.0.1\\nPORT=6676\\nDATA_DIR=/var/lib/blinkora/data\\nBLINKORA_SECRET="; \
  openssl rand -hex 32; \
  printf "RUST_LOG=info\\n"; \
} > /etc/blinkora/blinkora.env'
```

上述命令以 `0600` 权限创建 `/etc/blinkora/blinkora.env`，不会把密钥输出到终端。不要把 `BLINKORA_SECRET` 放到 shell 历史、命令行、Git 或聊天记录。

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
WorkingDirectory=/var/lib/blinkora
EnvironmentFile=/etc/blinkora/blinkora.env
ExecStart=/opt/blinkora/blinkora-server
Restart=on-failure
RestartSec=3
TimeoutStopSec=20s
UMask=0077
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

手工升级只替换二进制，分享包安装器还会同步仓库维护的 systemd unit；两种方式都绝不替换环境文件或 `DATA_DIR`。服务收到停止信号时会先等待最多 20 秒让已有请求完成，超时后由 systemd 结束进程：

```bash
sudo systemctl stop blinkora.service
sudo cp /opt/blinkora/blinkora-server /opt/blinkora/backups/blinkora-server.pre-<version>
sudo install -m 0755 blinkora-server-<new-version>-linux-x86_64 /opt/blinkora/blinkora-server
sudo systemctl start blinkora.service
curl -fsS http://127.0.0.1:6676/health
```

若新版本无法健康启动，先停止服务，再把 `backups/blinkora-server.pre-<version>` 覆盖回 `/opt/blinkora/blinkora-server` 后启动。数据库与附件始终保留在 `DATA_DIR`，不能随着程序回退被删除或覆盖。

物理备份需要停止单个服务进程后执行 `scripts/sqlite-backup.sh --offline`；恢复必须落到空数据目录。不要只复制 `blinkora.sqlite3` 主文件，因为 WAL 中可能有已提交数据。
