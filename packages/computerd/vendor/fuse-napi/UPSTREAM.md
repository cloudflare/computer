# Upstream provenance

The initial source tree was imported from the npm package
`@cocalc/fuse-native@2.4.3`.

- Package: https://www.npmjs.com/package/@cocalc/fuse-native/v/2.4.3
- Source repository: https://github.com/sagemathinc/fuse-native
- Tarball:
  https://registry.npmjs.org/@cocalc/fuse-native/-/fuse-native-2.4.3.tgz
- npm SHA-512 integrity:
  `oINV1aDDPHTZkIIjDFPMAGFypdoi2Vsy2OB+uPljIibcosRW/oTkDsfRUKFPcHgRx7qwVlQ4rcHH2T7mYsxTTw==`
- Baseline commit: `527b2fa`
- Baseline tag: `cocalc-v2.4.3`

The package tarball was used because the source repository does not contain a
Git tag for version 2.4.3. The baseline commit contains the tarball contents
without project-specific modifications.

## FUSE runtime build provenance

Baseline Linux prebuilds are linked against the distribution libfuse 3.10.3
ABI (`libfuse3.so.3`) on Debian bullseye/glibc 2.31. Modern Linux prebuilds
are linked against libfuse 3.18.2 (`libfuse3.so.4`) built in the same baseline
container from:

- Release:
  https://github.com/libfuse/libfuse/releases/tag/fuse-3.18.2
- Source archive SHA-256:
  `f01de85717e20adf5f98aff324acd85dd73d61a5ca3834d573dcf0bd6e54a298`
- Meson 1.7.2 wheel SHA-256:
  `82c6818dc81743c96de3a458f06175776ebfde4081195ea31ea6971838f25e38`

Musl prebuilds are linked against Alpine 3.23's distribution
`libfuse3.so.4` runtime. The release workflow verifies both downloaded hashes,
the reported libfuse version, shared-library linkage, target architecture,
musl tagging, and maximum glibc symbol version before packaging.
