# Release process

This document is for maintainers. It describes how a version becomes a set of
verified artifacts and, when authorized, a published GitHub Release.

## Versioning

- Semantic versioning; `package.json` is the only version source.
  `src/version.js` derives `VERSION` from it, and the release workflow refuses
  to publish a tag that disagrees with it.
- While `0.x`, a minor release may change behaviour. Every release documents
  changes in `CHANGELOG.md`.
- The supported WorkflowEngine range (`src/version.js`) is part of the release
  contract. Widening or narrowing it is at least a minor release.

## What a release contains

| Asset | Purpose |
| --- | --- |
| `coderax-cli-<version>.tgz` | npm-compatible tarball (`package/` layout) |
| `coderax-cli-<version>-standalone.tar.gz` | POSIX standalone tree with launchers |
| `coderax-cli-<version>-standalone.zip` | Windows standalone tree |
| `SHA256SUMS` | SHA-256 for every uploaded asset |
| `release-manifest.json` | Versions, commit, artifact hashes, per-file inventory |
| `sbom.spdx.json` | SPDX 2.3 SBOM (no runtime dependencies) |
| `install.sh`, `install.ps1` | Installers |
| `uninstall.sh`, `uninstall.ps1` | Uninstallers |
| `release-notes.md` | The changelog section for this version |

## Reproducible builds

`npm run build` writes archives directly instead of shelling out to `tar` or
`zip`, and normalizes everything that could vary:

- entries sorted by path; `package.json` first in the npm tarball
- uid/gid `0`, empty user/group names
- fixed modes: `0755` for executables and `.sh`, `0644` otherwise
- one fixed mtime for every entry, from `SOURCE_DATE_EPOCH`, default
  `499162500` (1985-10-26T08:15:00Z, the epoch npm uses for packs)
- fixed compression levels
- no build timestamps, hostnames, absolute paths, or environment data

`npm run repro` builds twice into temporary directories and compares
`SHA256SUMS` and the file inventory, then compares `dist/` against a clean
rebuild. Same source plus same Node/zlib version yields identical bytes.

`SOURCE_DATE_EPOCH` can be overridden for testing, but a release must use the
default so that the hashes in the manifest and checksums match what CI built.

## Release checklist

1. **Update `CHANGELOG.md`** with a `## [<version>]` section. This becomes the
   release notes.
2. **Bump the version** in `package.json` (and the lockfile):

   ```sh
   npm version --no-git-tag-version 0.3.0
   ```

3. **Run the full local gate**:

   ```sh
   npm ci --ignore-scripts
   npm run release:check
   ```

   This runs syntax checks, unit tests, the build, artifact verification, the
   reproducibility check, and the installation test (install → authenticate →
   SDK → uninstall).

4. **Commit and tag**:

   ```sh
   git add -A
   git commit -m "release: 0.3.0"
   git tag -a v0.3.0 -m "coderax-cli 0.3.0"
   git push origin main
   git push origin v0.3.0
   ```

5. **The `release` workflow runs** on the tag:
   - checks that the tag equals `v` + `package.json` version
   - runs the same checks as CI on a GitHub-hosted Ubuntu runner
   - builds, verifies, reproduces, and install-tests the artifacts
   - creates the GitHub Release with every asset in `dist/`
   - refuses to reuse an existing tag or release

6. **Confirm the published release**:
   - assets are present and `SHA256SUMS` matches `release-manifest.json`
   - `install.sh --dry-run` and the Windows installer report the right version
   - the release notes render correctly

## Permissions and credential isolation

| Workflow | Trigger | Token permissions | Secrets |
| --- | --- | --- | --- |
| `ci.yml` | push to `main`, pull requests | `contents: read` | none |
| `release.yml` `release` job | version tag, manual dispatch | `contents: write` | `GITHUB_TOKEN` only |
| `release.yml` `npm` job | manual dispatch + owner variable + protected environment | `contents: read`, `id-token: write` | none (OIDC trusted publishing) |

Rules that keep publication credentials away from untrusted code:

- No workflow uses `pull_request_target`.
- Pull requests get `contents: read` and never reach the release workflow.
- Checkout uses `persist-credentials: false` everywhere, so the repository token
  is not left in `.git/config` for later steps or scripts.
- `contents: write` exists only in the release job, which runs from a tag or a
  manual dispatch, never from a pull request.
- npm publication uses short-lived OIDC credentials from a protected
  environment; no long-lived `NPM_TOKEN` is stored in this repository.
- Third-party actions are pinned to commit SHAs; the release path uses `gh`
  from the runner image instead of a third-party release action.

## Publication is disabled by default

The package is `"private": true`. Publishing to npm requires the owner to:

1. decide that publication is authorized, and choose a licence;
2. confirm ownership of the `coderax-cli` name in the registry (or rename);
3. remove `"private": true` in a reviewed commit;
4. configure a trusted publisher for the repository and workflow on npmjs.com
   (npm CLI 11.5.1+ and Node 22.14+ are required for OIDC publishing);
5. set the repository variable `NPM_PUBLISH_ENABLED=true` and protect the
   `npm-publish` environment with required reviewers.

Only then does the gated `npm` job exist as a usable path. Until all five steps
happen, `npm publish` is refused by npm itself because the package is private.

Note: npm provenance is not available for packages built from **private source
repositories**. If provenance is a requirement, the repository must be public
before publishing. GitHub Releases remain the canonical channel regardless.

Signing (Sigstore/cosign) is not enabled. The `id-token: write` permission and
SHA-256 checksums leave room to add keyless signing later without changing the
artifact layout.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `tag v0.3.0 does not match package.json version 0.3.0` | Version not bumped | Bump, commit, retag |
| `release v0.3.0 already exists` | Tag reused | Cut a new version; do not move published tags |
| `checksum mismatch` in `npm run verify` | Build raced an edit, or `SOURCE_DATE_EPOCH` differed | Rebuild from a clean checkout |
| `dist/` hashes differ in `npm run repro` | Non-deterministic input (untracked file, locale, zlib difference) | Build with the same Node version; check `git status` |
| CI minutes exhausted on a private repo | 3-OS matrix on every push | Standard runners are free only for public repositories; reduce the matrix or make the repository public |
| npm job fails with "package is private" | Publication not authorized | Follow the five steps above |
