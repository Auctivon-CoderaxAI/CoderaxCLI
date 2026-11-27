> **Private-repository note (GitHub Free):** GitHub artifact attestations are
> public-repository-only on Free. Releases are signed with keyless Sigstore and
> publish a `.sigstore.json` bundle next to each asset; verify with
> `cosign verify-blob --bundle …`. Public npm publication is disabled. Every tag
> is gated by an approved merged pull request, exact-head checks, and a full
> Linux/Windows/macOS certification run. The gate proves release provenance; it
> cannot stop a repository writer from editing the workflow.

# Release process

This document is for maintainers. It describes how a version becomes a set of
verified artifacts and, when authorized, a published GitHub Release.

## Versioning

- Semantic versioning; `package.json` is the only version source.
  `src/version.js` derives `VERSION` from it, and the release workflow refuses
  to publish a tag that disagrees with it.
- While `0.x`, a minor release may change behaviour. Every release documents
  changes in `CHANGELOG.md`.
- The compatibility contract (`src/compat.js`) is part of the release:
  `supportedApiVersion` comes from the shared SDK (`API_VERSION`) and
  `supportedDeploymentRange` is the deployment release the contract was
  validated against. Widening or narrowing either is at least a minor release.

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

3. **Open a pull request and use cloud verification**:

   Do not run builds or tests on the owner's computer. Open a PR; the reusable
   `verify.yml` workflow runs the syntax, unit, contract, build, artifact,
   reproducibility, and installation checks on GitHub-hosted Linux. The weekly
   schedule and the release workflow repeat the complete matrix on Linux,
   Windows, and macOS.

4. **Merge only after review and green exact-head checks, then tag the merge**:

   ```sh
   git tag -a v0.3.0 -m "coderax-cli 0.3.0"
   git push origin v0.3.0
   ```

   The tag must point at the merge commit of the approved PR. `release.yml`
   refuses a tag created by a direct push, a tag without an independent human
   approval at the PR head, or a tag whose required exact-head checks did not
   succeed.

5. **The `release` workflow runs** on the tag:
   - checks that the tag equals `v` + `package.json` version
   - refuses a direct/unapproved tag and verifies the merged PR, independent
     approval, and exact-head `test`, `changed-commits`, and `dependency audit`
   - certifies Linux, Windows, and macOS through the reusable verify workflow
   - builds and verifies the artifacts without rerunning the full test matrix
   - signs every asset, creates a private GitHub Release, and attaches the
     `release-authorization.json` record
   - refuses to reuse an existing tag or release

6. **Confirm the published release**:
   - assets are present and `SHA256SUMS` matches `release-manifest.json`
   - `install.sh --dry-run` and the Windows installer report the right version
   - the release notes render correctly

## Permissions and credential isolation

| Workflow | Trigger | Token permissions | Secrets |
| --- | --- | --- | --- |
| `ci.yml` | push to `main`, pull requests, weekly schedule | `contents: read` | none |
| `release.yml` `authorize` job | version tag, manual dispatch | `contents: read`, `checks: read`, `pull-requests: read` | `GITHUB_TOKEN` only |
| `release.yml` `certify` job | after authorization | `contents: read` | none |
| `release.yml` `release` job | after authorization and certification | `contents: write`, `id-token: write` | `GITHUB_TOKEN` only |

Rules that keep publication credentials away from untrusted code:

- No workflow uses `pull_request_target`.
- Pull requests get `contents: read` and never reach the release workflow.
- Checkout uses `persist-credentials: false` everywhere, so the repository token
  is not left in `.git/config` for later steps or scripts.
- `contents: write` exists only in the release job, which runs from a tag or a
  manual dispatch, never from a pull request.
- There is no npm publication job and no registry credential in this repository.
- Third-party actions are pinned to commit SHAs; the release path uses `gh`
  from the runner image instead of a third-party release action.

## Publication is private-only

The package is `"private": true`, `publishConfig` is absent, and the release
workflow has no npm job. GitHub Releases are the only distribution channel;
they inherit the repository's private visibility and require an authenticated
download. This is intentional for an owner-only product. Adding a public
registry would require a separate owner decision, a licence, name ownership,
and a new review of private artifact distribution.

### Build provenance

Every artifact is covered by `SHA256SUMS`. The release workflow also signs
each asset with keyless Cosign, verifies the standalone tarball's signature,
and uploads each asset's `.sigstore.json` bundle. The installers can verify
these bundles with Cosign via `--provenance`, `-Provenance`, or
`CODERAX_REQUIRE_PROVENANCE=1`. They require the GitHub Actions OIDC issuer
and the repository's release workflow, on the corresponding version tag
or on a branch for manual dispatch. If a bundle is absent, a valid legacy
GitHub attestation verified by `gh` is required. See [Install](INSTALL.md)
for local archive verification.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `tag v0.3.0 does not match package.json version 0.3.0` | Version not bumped | Bump, commit, retag |
| `release v0.3.0 already exists` | Tag reused | Cut a new version; do not move published tags |
| `checksum mismatch` in `npm run verify` | Build raced an edit, or `SOURCE_DATE_EPOCH` differed | Rebuild from a clean checkout |
| `dist/` hashes differ in `npm run repro` | Non-deterministic input (untracked file, locale, zlib difference) | Build with the same Node version; check `git status` |
| Hosted runner cannot start | Organization billing or spending limit | Check the organization's Actions policy and the $0 budget |
| Release authorization refuses the tag | Direct push, unmerged tag, missing approval, or a stale/missing exact-head check | Tag the merge commit of an independently approved green PR |
