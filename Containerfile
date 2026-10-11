# Infra toolchain: Node.js 24, OpenTofu >= 1.13, CDK Terrain (cdktn) CLI and
# TypeScript 7 (the native Go compiler, `tsgo`). Built and run by the Makefile
# with Apple `container` on macOS and Docker on Linux / GitHub Actions.
#
# Every version is pinned. To pin the base by digest (e.g. through an
# Artifactory remote), override NODE_IMAGE:
#   make image NODE_IMAGE=artifactory.example/docker-remote/library/node@sha256:...
ARG NODE_IMAGE=docker.io/library/node:24.21.0-bookworm-slim
FROM ${NODE_IMAGE}

ARG TOFU_VERSION=1.13.1
ARG TOFU_SHA256_AMD64=378ada19d4bc70c43732004e8159be771b23b9a5afdf059e5f8a2b3fa2c70a69
ARG TOFU_SHA256_ARM64=9c1ef375aa1852db0b2888aa921b640c71f8140d4682aa4fec99378a64fa7dc3
ARG CDKTN_CLI_VERSION=0.24.0
ARG TYPESCRIPT_VERSION=7.0.2
# Set by BuildKit (Docker) and by Apple container's builder; falls back to dpkg.
ARG TARGETARCH

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git jq make \
 && rm -rf /var/lib/apt/lists/*

# OpenTofu from the official release, checksum-verified.
RUN set -eu; \
    arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "$arch" in \
      amd64) sha="$TOFU_SHA256_AMD64" ;; \
      arm64) sha="$TOFU_SHA256_ARM64" ;; \
      *) echo "unsupported arch: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSLo /tmp/tofu.tgz "https://github.com/opentofu/opentofu/releases/download/v${TOFU_VERSION}/tofu_${TOFU_VERSION}_linux_${arch}.tar.gz"; \
    echo "${sha}  /tmp/tofu.tgz" | sha256sum -c -; \
    tar -xzf /tmp/tofu.tgz -C /usr/local/bin tofu; \
    rm /tmp/tofu.tgz; \
    tofu version

# cdktn CLI and TypeScript 7. TS 7 ships the native compiler as `tsc`; `tsgo`
# is the same binary under the name used during the native preview.
RUN npm install -g "cdktn-cli@${CDKTN_CLI_VERSION}" "typescript@${TYPESCRIPT_VERSION}" \
 && ln -s "$(npm root -g)/typescript/bin/tsc" /usr/local/bin/tsgo \
 && npm cache clean --force \
 && cdktn --version && tsgo --version

# cdktn drives OpenTofu, never Terraform. No telemetry calls.
ENV TERRAFORM_BINARY_NAME=tofu \
    CHECKPOINT_DISABLE=1 \
    HOME=/tmp \
    npm_config_cache=/tmp/.npm \
    npm_config_update_notifier=false

WORKDIR /work/infra
CMD ["bash"]
