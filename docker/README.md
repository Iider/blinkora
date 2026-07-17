# Linux 二进制构建兜底

`docker/` 只保留构建机使用的 Rust Linux builder，不提供容器运行时、Compose 部署或用户数据目录。Blinkora 的正式交付物是静态单二进制，目标服务器不需要 Docker。

本机缺少 Linux musl 交叉编译环境时，可以强制使用 builder：

```bash
BLINKORA_RUST_DOCKER_BUILD=1 bun run build:linux-headless
```

脚本先构建前端，再通过 [rust-builder.Dockerfile](./rust-builder.Dockerfile) 编译 Rust 服务端，最后生成 `release/linux/blinkora-server-<version>-linux-x86_64` 及 SHA-256 文件。builder 镜像和临时容器会在产物复制完成后删除。
