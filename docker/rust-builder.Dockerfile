FROM rust:1.95-bookworm AS backend-builder

WORKDIR /build/server

ARG RUST_TARGET=x86_64-unknown-linux-musl

RUN apt-get update \
    && apt-get install -y --no-install-recommends musl-tools \
    && rm -rf /var/lib/apt/lists/* \
    && rustup target add "$RUST_TARGET"

COPY server/Cargo.toml server/Cargo.lock ./
COPY server/build.rs ./build.rs
COPY server/src ./src
COPY db/schema.sqlite.sql /build/db/schema.sqlite.sql
COPY dist/public /build/dist/public
COPY .agents/skills/blinkora-workspace /build/.agents/skills/blinkora-workspace

RUN cargo build --release --locked --target "$RUST_TARGET"
