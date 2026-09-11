FROM rust:1.85.1-bookworm AS builder
WORKDIR /src
COPY runtime/helper runtime/helper
WORKDIR /src/runtime/helper
RUN cargo build --locked --release --bin dsh-remote-helper

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server git ripgrep ca-certificates \
    && rm -rf /var/lib/apt/lists/* /etc/ssh/ssh_host_* \
    && useradd --create-home --shell /bin/bash world \
    && passwd -d world \
    && mkdir -p /run/sshd /workspace /opt/dsh-e2e/bin \
    && chown world:world /workspace
COPY --from=builder /src/runtime/helper/target/release/dsh-remote-helper /opt/dsh-e2e/bin/dsh-remote-helper
COPY integrations/dsh/tests/e2e/start-world.sh /usr/local/bin/start-world
EXPOSE 22
CMD ["sh", "/usr/local/bin/start-world"]
