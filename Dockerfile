# syntax=docker/dockerfile:1.7

FROM node:24-bookworm AS build

ENV PNPM_HOME=/pnpm
ENV PATH="/pnpm:/root/.cargo/bin:${PATH}"
ENV CI=1

RUN corepack enable \
	&& apt-get update \
	&& apt-get install -y --no-install-recommends \
		binaryen \
		build-essential \
		ca-certificates \
		curl \
		git \
		pkg-config \
	&& rm -rf /var/lib/apt/lists/* \
	&& curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
		| sh -s -- -y --profile minimal \
	&& cargo install wasm-bindgen-cli --version 0.2.105 --locked \
	&& cargo install --git https://github.com/r58Playz/wasm-snip --locked

WORKDIR /src
RUN rustup toolchain install nightly --profile minimal \
	--component rust-src \
	--target wasm32-unknown-unknown
ARG BINARYEN_VERSION=130
RUN cd /tmp \
	&& curl -fsSLO "https://github.com/WebAssembly/binaryen/releases/download/version_${BINARYEN_VERSION}/binaryen-version_${BINARYEN_VERSION}-x86_64-linux.tar.gz" \
	&& curl -fsSLO "https://github.com/WebAssembly/binaryen/releases/download/version_${BINARYEN_VERSION}/binaryen-version_${BINARYEN_VERSION}-x86_64-linux.tar.gz.sha256" \
	&& sha256sum -c "binaryen-version_${BINARYEN_VERSION}-x86_64-linux.tar.gz.sha256" \
	&& tar -xzf "binaryen-version_${BINARYEN_VERSION}-x86_64-linux.tar.gz" -C /opt \
	&& mv "/opt/binaryen-version_${BINARYEN_VERSION}" /opt/binaryen \
	&& rm "binaryen-version_${BINARYEN_VERSION}-x86_64-linux.tar.gz"*
ENV PATH="/opt/binaryen/bin:${PATH}"
COPY . .
RUN sed -i 's/\r$//' packages/core/rewriter/wasm/build.sh

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
	pnpm install --frozen-lockfile
RUN --mount=type=cache,id=cargo-registry,target=/root/.cargo/registry \
	--mount=type=cache,id=cargo-git,target=/root/.cargo/git \
	--mount=type=cache,id=rust-target,target=/src/packages/core/rewriter/target \
	RELEASE=1 pnpm --dir packages/core rewriter:build
RUN pnpm --dir packages/core build
RUN VITE_WISP_URL=/wisp/ pnpm --dir packages/demo build
RUN pnpm --filter scramjet-docker-runtime deploy --prod --legacy /runtime

FROM node:24-bookworm-slim AS runtime

RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		ca-certificates \
		python3 \
		python3-pip \
	&& python3 -m pip install --no-cache-dir --break-system-packages \
		curl_cffi==0.15.0 \
	&& rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4141
WORKDIR /app

COPY --from=build --chown=node:node /runtime/ ./
COPY --from=build --chown=node:node /src/packages/demo/dist/ ./public/

USER node
EXPOSE 4141
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
	CMD ["node", "-e", "fetch('http://127.0.0.1:4141/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "server.mjs"]
