# Hikvision HCNetSDK (Linux, glibc)

Native libraries the add-on uses for talk-back (SDK voice forwarding). Only one folder is copied
into the image, for the build architecture: `lib-amd64` or `lib-aarch64`.

- **Source:** [pergolafabio/Hikvision-Addons](https://github.com/pergolafabio/Hikvision-Addons),
  `hikvision-doorbell/lib-amd64` and `hikvision-doorbell/lib-aarch64` at commit
  `fb6abc177f62c480e39a6dbc9dbee997875c76a9`, copied unchanged on 2026-11-03.
- **Integrity:** `SHA256SUMS` lists every file; the Docker build and CI check it
  (`sha256sum -c SHA256SUMS`).
- **License:** proprietary Hikvision software, not covered by this repository's license.

To update: replace the two folders with the new ones, regenerate the list and test talk-back.

```sh
cd hikvision_homekit/vendor/hcnetsdk
find lib-amd64 lib-aarch64 -type f | LC_ALL=C sort | xargs sha256sum > SHA256SUMS
```
