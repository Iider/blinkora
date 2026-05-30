# 国内网络下继续使用 Bun 的策略

更新时间：2026-05-29

本文件记录在国内网络环境、Windows 开发环境和 Docker 构建环境中继续沿用 Bun 的推荐做法。当前主运行栈为 Rust，TS/Node 只作为参考实现。Go 栈已归档到 `docker/backups/blinkora-go-stack-archive-2026-05-29.zip`，不再参与 active 构建链路。

## 当前策略

- 本地开发默认使用项目级 `bunfig.toml`，将 Bun registry 指向 `https://registry.npmmirror.com`。
- Rust 默认 Docker 构建只复制 `release/rust` 产物，不需要 `USE_MIRROR`、`NPM_REGISTRY`、`BUN_REGISTRY` 或 cargo registry。
- Rust crate 下载只发生在开发机/CI 的 `bun run build:rust-release` 阶段，或 `docker/dockerfile.rust.fullbuild` 兜底路径。
- TS/Node 参考栈仍保留 `USE_MIRROR`、`NPM_REGISTRY` 和 `BUN_REGISTRY`，只用于行为对照或排障。
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
NEXTAUTH_SECRET=replace-with-a-secure-random-secret docker compose -f docker/docker-compose.rust.yml build web
NEXTAUTH_SECRET=replace-with-a-secure-random-secret docker compose -f docker/docker-compose.rust.yml up -d
```

这条路径中，Docker build 只需要拉取 Debian slim 基础镜像并复制 `release/rust/blinkora-rust`、`release/rust/public` 与 `prisma/migrations`，不会执行 `cargo build`，也不会访问 npm/Bun registry 或 Rust crate 下载链路。最终运行容器不包含 Node、Bun、npm、cargo、Go 或 Rust 编译器。

如果本机不能直接交叉编译 Linux Rust 二进制，可在开发机或 CI 临时使用 Docker builder 生成 release 产物：

```bash
BLINKORA_RUST_DOCKER_BUILD=1 bun run build:rust-release
```

如果确实需要在 Docker 内完成 Rust 编译，可使用兜底 Dockerfile：

```bash
docker build -f docker/dockerfile.rust.fullbuild -t blinkora-rust-web:latest .
```

兜底路径会访问 Rust crate 下载链路，应配置内部 cargo registry/cache 或放在网络条件稳定的 CI 中执行；不建议作为国内服务器默认部署路径。

## TS/Node 参考栈

TS/Node 参考栈仍可用于行为对照。以下 registry 策略仅适用于 `docker/docker-compose.yml`。

官方源构建：

```bash
docker compose -f docker/docker-compose.yml --progress plain build --build-arg USE_MIRROR=false
```

国内网络加速构建：

```bash
docker compose -f docker/docker-compose.yml --progress plain build --build-arg USE_MIRROR=true
```

显式指定 registry：

```bash
NPM_REGISTRY=https://registry.npmmirror.com \
BUN_REGISTRY=https://registry.npmmirror.com \
docker compose -f docker/docker-compose.yml --progress plain build --build-arg USE_MIRROR=true
```

如果公共镜像源出现 integrity check failed，回退官方源或使用团队内部 registry cache。不要在生产排障中临时修改锁文件绕过校验。

## 常见失败处理

| 现象 | 优先检查 | 处理 |
| --- | --- | --- |
| `bun install` 慢或超时 | registry 是否可达 | 切官方源或内部缓存源 |
| npm/Bun integrity check failed | 公共镜像源同步是否异常 | 回退官方源，保留锁文件 |
| Rust release 构建下载 crate 失败 | Cargo registry 网络 | 使用 CI、内部 cargo cache，或 `BLINKORA_RUST_DOCKER_BUILD=1` |
| TS/Node Docker build 失败 | 是否真的需要参考栈 | 优先使用 Rust 主栈；只在对照行为时排障 TS/Node |
| Rust Docker build 访问 npm/Bun registry | 是否误用了 TS/Node Dockerfile 或 Rust fullbuild | 默认应使用 `docker/dockerfile.rust`，并先运行 `bun run build:rust-release` |

## 后续收敛

- 把 Rust release 构建和 smoke 纳入 CI。
- 若 TS/Node 不再提供参考价值，删除 TS/Node Docker 参考栈和对应 npm registry 策略。
- 保留内部 registry/cache 方案作为团队级基础设施，不把临时网络 workaround 写入运行脚本。
