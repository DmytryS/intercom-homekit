# Home Assistant add-on image. Debian (glibc) is required by the Hikvision SDK.
FROM node:26-bookworm-slim

ARG BUILD_ARCH=amd64
ARG BUILD_VERSION=dev
LABEL io.hass.type="addon" \
      io.hass.arch="${BUILD_ARCH}" \
      io.hass.version="${BUILD_VERSION}" \
      org.opencontainers.image.title="Hikvision Doorbell for HomeKit" \
      org.opencontainers.image.version="${BUILD_VERSION}" \
      org.opencontainers.image.source="https://github.com/DmytryS/intercom-homekit"
RUN case "${BUILD_ARCH}" in amd64|aarch64) ;; *) echo "Unsupported architecture: ${BUILD_ARCH}" >&2; exit 1 ;; esac

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Hikvision HCNetSDK, bundled in vendor/hcnetsdk (see its README). It is the only way to reach
# the DS-KV61xx speaker: ISAPI two-way audio is rejected by the firmware. Only this
# architecture's libraries go into the image, and every file is checked against SHA256SUMS.
COPY vendor/hcnetsdk/SHA256SUMS /tmp/hcnetsdk.sha256
COPY vendor/hcnetsdk/lib-${BUILD_ARCH}/ /opt/hcnetsdk/
RUN set -eu; \
    cd /opt/hcnetsdk; \
    grep " lib-${BUILD_ARCH}/" /tmp/hcnetsdk.sha256 | sed "s# lib-${BUILD_ARCH}/# #" | sha256sum -c --quiet -; \
    rm /tmp/hcnetsdk.sha256

ENV HCNETSDK_DIR=/opt/hcnetsdk \
    LD_LIBRARY_PATH=/opt/hcnetsdk:/opt/hcnetsdk/HCNetSDKCom \
    NODE_ENV=production

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src

CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
