# Contributing

Thank you for proposing an improvement to `fuse-napi`.

## Repository model

The repository is publicly readable and forkable. Direct writes to maintained
branches are restricted to the maintainer:

- `main` contains the current `2.x` release line.
- `1.0` contains the supported `1.x` maintenance line.
- External changes are proposed through pull requests.
- The maintainer decides whether and when a pull request is merged, tested, or
  released.

Do not include release version changes, release tags, generated prebuilds, or
npm publication steps in a pull request unless the maintainer explicitly asks
for them.

## Before opening a pull request

Keep each pull request focused and explain the user-visible behavior, supported
platforms, compatibility impact, and tests performed. Add tests and update
documentation for public API or behavior changes.

When the required FUSE runtime is available, run:

```sh
npm ci
npm run check
npm run test:types
npm run test:unit
npm run test:fuzz
npm test
```

`npm test` performs real mounts. See `README.md` for the Linux and macOS runtime
requirements.

## CI and releases

Pull requests and pushes intentionally do not start GitHub Actions. CI is
started manually by the maintainer after review. Prebuild workflows, tags,
GitHub Releases, and npm publication are also maintainer-only manual actions.

## Security

Do not report suspected vulnerabilities in an issue or pull request. Follow
the private reporting process in `SECURITY.md`.
