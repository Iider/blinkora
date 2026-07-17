# 国内网络下继续使用 Bun 的策略

本文件记录在国内网络环境、Windows 开发环境和 Linux 发布物构建环境中使用 Bun 的推荐做法。当前运行栈为 Rust 后端加 React/Vite 前端。

## 当前策略

- 本地开发默认使用项目级 `bunfig.toml`，将 Bun registry 指向 `https://registry.npmmirror.com`。
- Linux 正式交付物是静态单二进制，目标服务器不运行 Bun、Cargo 或容器运行时。
- 本机持久化部署会在 macOS 本机直接跑 Bun 和 Cargo，首次安装依赖或编译 Rust crate 时需要本机网络可用。
- Rust crate 下载只发生在开发机/CI 的 Linux release 构建、macOS 本机构建，或 `docker/rust-builder.Dockerfile` 兜底路径。
- `bun.lock` 继续作为 Bun 路径的锁文件提交；依赖变更必须刷新并验证。
- `npmmirror` 只作为加速路径，不作为唯一可信路径；遇到 integrity、同步延迟或平台包异常时，回退官方源或内部缓存源。

## 本地开发

默认安装依赖：

```bash
bun install
```

如果国内镜像失败，回退官方源：

```bash
bun install --registry https://registry.npmjs.org
```

刷新锁文件但不安装到 `node_modules`：

```bash
bun install --lockfile-only --ignore-scripts
```

验证锁文件一致性：

```bash
bun install --frozen-lockfile
```

## Windows 缓存设置

建议给 Bun 设置固定缓存目录，避免每个项目重复下载大依赖。

PowerShell：

```powershell
[Environment]::SetEnvironmentVariable("BUN_INSTALL_CACHE_DIR", "D:\DevCache\bun-install", "User")
```

设置后重新打开终端，再验证：

```powershell
bun --version
bun install --frozen-lockfile
```

如果 Windows Defender 明显拖慢依赖安装，可考虑把 Bun 缓存目录加入 Defender 排除项。该操作涉及系统安全策略，应由使用者按机器情况自行决定，不写入项目脚本。

## macOS/Linux 缓存设置

```bash
export BUN_INSTALL_CACHE_DIR="$HOME/.cache/bun-install"
```

如需长期生效，可以加入个人 shell 配置文件。

## Linux 单二进制构建

在开发机或 CI 构建 x86_64 Linux 发布物：

```bash
bun run build:linux-headless
```

脚本先执行前端构建，再生成静态 Rust 二进制。产物位于 `release/linux/`，目标服务器直接运行二进制，不需要 Bun、Node.js、Rust、SQLite CLI 或 Docker。

如果本机不能直接交叉编译 Linux Rust 二进制，可在开发机或 CI 临时使用 Docker builder 生成 release 产物：

```bash
BLINKORA_RUST_DOCKER_BUILD=1 bun run build:linux-headless
```

Docker 只运行 `docker/rust-builder.Dockerfile` 的临时构建阶段；脚本复制二进制后会删除临时容器和镜像。该路径会访问 Rust crate 下载链路，应配置内部 cargo registry/cache 或放在网络条件稳定的 CI 中执行。Docker 不进入目标服务器的部署链路。

## 本机持久化部署

个人 macOS 长期使用可直接运行 Rust Web 服务：

```bash
bun run deploy:local install
```

这条路径会做两类本机构建：

- `bun run build:web --force`：需要 Bun 和前端依赖。
- `cargo build --release --locked --manifest-path server/Cargo.toml`：需要 Rust toolchain 和 Cargo crate 下载链路。

如果网络不稳定，优先先把依赖装好：

```bash
bun install
cargo fetch --manifest-path server/Cargo.toml
```

之后再跑：

```bash
bun run deploy:local install
```

## 常见失败处理

| 现象 | 优先检查 | 处理 |
| --- | --- | --- |
| `bun install` 慢或超时 | registry 是否可达 | 切官方源或内部缓存源 |
| npm/Bun integrity check failed | 公共镜像源同步是否异常 | 回退官方源，保留锁文件 |
| Rust release 构建下载 crate 失败 | Cargo registry 网络 | 使用 CI、内部 cargo cache，或 `BLINKORA_RUST_DOCKER_BUILD=1` |
| `deploy:local install` 首次构建失败 | Bun 或 Cargo 依赖是否没下载完 | 先跑 `bun install` 和 `cargo fetch --manifest-path server/Cargo.toml` |
| 本机缺 `aarch64-linux-musl-gcc` 或其他 Linux musl 交叉编译器 | 是否在本机原生交叉编译 | 使用 `BLINKORA_RUST_DOCKER_BUILD=1 bun run build:linux-headless` 生成部署产物 |
| Docker builder 下载 crate 失败 | Cargo registry 或构建机网络 | 配置内部 cargo cache/registry，或改由网络稳定的 CI 构建 |

## 后续收敛

- 把 Rust release 构建和 smoke 纳入 CI。
- 保留内部 registry/cache 方案作为团队级基础设施，不把临时网络 workaround 写入运行脚本。
