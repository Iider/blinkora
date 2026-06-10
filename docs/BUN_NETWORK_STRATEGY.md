# 国内网络下继续使用 Bun 的策略

本文件记录在国内网络环境、Windows 开发环境和 Docker 构建环境中使用 Bun 的推荐做法。当前运行栈为 Rust 后端加 React/Vite 前端。

## 当前策略

- 本地开发默认使用项目级 `bunfig.toml`，将 Bun registry 指向 `https://registry.npmmirror.com`。
- Rust 默认 Docker 构建只复制 `docker/release/rust` 产物，不需要 `USE_MIRROR`、`NPM_REGISTRY`、`BUN_REGISTRY` 或 cargo registry。
- 本机持久化部署会在 macOS 本机直接跑 Bun 和 Cargo，首次安装依赖或编译 Rust crate 时需要本机网络可用。
- Rust crate 下载只发生在开发机/CI 的 `bun run build:rust-release`、本机持久化部署的 native cargo build，或 `docker/dockerfile.rust.fullbuild` 兜底路径。
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

## Rust Docker 构建

主部署路径：

```bash
bun run build:rust-release
cd docker
docker compose up -d
```

这条路径中，Docker build 只需要拉取 Debian slim 基础镜像并复制 `docker/release/rust` 中的二进制、静态资源与 `db/schema.sql`，不会执行 `cargo build`，也不会访问 npm/Bun registry 或 Rust crate 下载链路。最终运行容器不包含 Node、Bun、npm、cargo、Go 或 Rust 编译器。

如果本机不能直接交叉编译 Linux Rust 二进制，可在开发机或 CI 临时使用 Docker builder 生成 release 产物：

```bash
BLINKORA_RUST_DOCKER_BUILD=1 bun run build:rust-release
```

如果确实需要在 Docker 内完成 Rust 编译，可使用兜底 Dockerfile：

```bash
docker build -f docker/dockerfile.rust.fullbuild -t blinkora-web:latest .
```

兜底路径会访问 Rust crate 下载链路，应配置内部 cargo registry/cache 或放在网络条件稳定的 CI 中执行；不建议作为国内服务器默认部署路径。

## 本机持久化部署

个人 macOS 长期使用可以只把 PostgreSQL 放在 Docker，Rust Web 服务跑在本机：

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
| 本机缺 `aarch64-linux-musl-gcc` 或其他 Linux musl 交叉编译器 | 是否在本机原生交叉编译 | 直接用 `BLINKORA_RUST_DOCKER_BUILD=1 bun run build:rust-release` 生成部署产物 |
| Rust Docker build 访问 npm/Bun registry | 是否误用了 Rust fullbuild | 默认应使用 `docker/dockerfile.rust`，并先运行 `bun run build:rust-release` |

## 后续收敛

- 把 Rust release 构建和 smoke 纳入 CI。
- 保留内部 registry/cache 方案作为团队级基础设施，不把临时网络 workaround 写入运行脚本。
