# The browser client and the server that serves it.
#
# The client is built outside, because it needs emsdk and a wasm Rust toolchain: run
# `npm run build` first, then `docker build .`. CI does both.
#
# glibc, not Alpine: punktfunk-core's Linux UDP code is written against glibc's `recvmmsg`.

FROM rust:1.96-slim-trixie AS server
# aws-lc-rs, rustls' crypto provider here, compiles C.
RUN apt-get update && apt-get install -y --no-install-recommends cmake && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY server/ ./
RUN cargo build --release --locked \
 && cp target/release/punktfunk-client-web-server /usr/local/bin/

FROM debian:trixie-slim
COPY --from=server /usr/local/bin/punktfunk-client-web-server /usr/local/bin/
COPY apps/web/dist /srv/dist
RUN useradd --system --uid 10001 --no-create-home punktfunk && install -d -o punktfunk /data
ENV DIST_DIR=/srv/dist DATA_DIR=/data LISTEN=0.0.0.0:8443
USER punktfunk
VOLUME /data
EXPOSE 8443
ENTRYPOINT ["punktfunk-client-web-server"]
