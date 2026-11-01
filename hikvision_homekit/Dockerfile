# Home Assistant add-on image. Debian (glibc) is required by the Hikvision SDK.
FROM node:24-bookworm-slim

ARG BUILD_ARCH=amd64
# Hikvision HCNetSDK as packaged by pergolafabio/Hikvision-Addons (pinned + checksum-verified).
# It is the only way to reach the DS-KV61xx speaker: ISAPI two-way audio is rejected by the firmware.
ARG HCNETSDK_SRC_SHA=fb6abc177f62c480e39a6dbc9dbee997875c76a9

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    case "${BUILD_ARCH}" in \
      amd64)   LIB=lib-amd64;   SUM=75c534ff190df836591c2df88305abad0ba0587db9d28ae12f837553b9de8649 ;; \
      aarch64) LIB=lib-aarch64; SUM=b91451886d7ce64284dd50d6abda9a78a13de8bfab5f4409539b554e49cda177 ;; \
      *) echo "Unsupported architecture: ${BUILD_ARCH}" >&2; exit 1 ;; \
    esac; \
    mkdir -p /opt/hcnetsdk; \
    curl -fsSL "https://codeload.github.com/pergolafabio/Hikvision-Addons/tar.gz/${HCNETSDK_SRC_SHA}" \
      | tar -xz -C /opt/hcnetsdk --strip-components=3 "Hikvision-Addons-${HCNETSDK_SRC_SHA}/hikvision-doorbell/${LIB}"; \
    echo "${SUM}  /opt/hcnetsdk/libhcnetsdk.so" | sha256sum -c -

ENV HCNETSDK_DIR=/opt/hcnetsdk \
    LD_LIBRARY_PATH=/opt/hcnetsdk:/opt/hcnetsdk/HCNetSDKCom \
    NODE_ENV=production

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src

CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
