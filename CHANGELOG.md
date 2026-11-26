# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the major
version is `0`, a minor release may add or change behaviour.

## [0.2.0] - 2026-11-26

### Added

- Release engineering for Windows, macOS and Linux: deterministic build
  (`npm run build`), reproducibility check (`npm run repro`), artifact
  verification (`npm run verify`) and an automated installation test
  (`npm run install-test`).
- GitHub Release assets: npm-compatible tarball, POSIX standalone tarball,
  Windows standalone zip, `SHA256SUMS`, SPDX SBOM, release manifest, installers
  and uninstallers.
- `coderax version [--json]` reports the CLI version, Node runtime, platform,
  install method and install path.
- `coderax compat [--json]` compares the deployment's reported WorkflowEngine
  version with the supported range (`>=0.8.0 <1.0.0`).
- `coderax uninstall [--yes] [--purge]` removes user data and prints the
  program-removal commands for the detected install method.
- `coderax doctor` now reports the install method and WorkflowEngine
  compatibility.
- `coderax update` checks the GitHub release feed and prints upgrade commands
  for the detected install method. It never installs anything.

### Changed

- `src/version.js` derives the version from `package.json`, so a release has a
  single version source.
- `update` no longer claims the package is unpublished; it reports the real
  release feed and degrades gracefully when it is unreachable.

### Fixed

- Two Work SSE tests used doubly escaped newlines, so their fixtures never
  produced SSE frames and the suite failed. The fixtures now exercise the
  cumulative-snapshot handling they describe.

## [0.1.0]

### Added

- Initial CLI: configuration with `0600` persistence, `login`/`logout`/`status`,
  chat and Work streaming, products, Cloud/project status, `doctor`, `health`,
  OpenAPI discovery, `agents`, `models`, and `call`.
- Token redaction across every output path, HTTPS enforcement with loopback
  exceptions, redirect refusal, and bounded request timeouts.
