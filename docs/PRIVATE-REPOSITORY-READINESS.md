# Private-repository readiness

This repository is prepared for private operation without reducing test
coverage or publishing an owner-only package.

## CI and cost

- Pull requests run the Linux verification job and separate Linux and macOS
  PTY tests. Pushes to `main` and `rc/**` and weekly CI run verification on
  Linux, Windows, and macOS. Releases use the reusable workflow for certification
  on all three platforms.
- The Linux verification job covers syntax, unit/CLI/contract tests, build,
  artifact/installer verification, hosted installation, authentication,
  upgrade/rollback, and uninstall.
- Dependency audit is a separate required check.
- Full-history secret scanning is a weekly/manual job; changed commits are
  scanned on every PR and main push.
- GitHub Free includes $12 of private compute per billing account. The live
  projection is maintained outside this repository; this note does not claim
  that the organization is under the allowance.

## Distribution and release authorization

- GitHub Releases are the only distribution channel and are private.
- `package.json` remains `"private": true` and has no `publishConfig`.
- The release workflow has no npm publication job.
- A tag must be the merge commit of an independently approved PR with green
  `test`, `changed-commits`, and `dependency audit` checks on the PR head.
  The tagged commit also needs a green dependency audit and changed-commit secret
  scan from its push to `main`.
- Release certification runs Linux, Windows, and macOS before publication.
- Artifacts are covered by `SHA256SUMS`, an SBOM, a manifest, and keyless
  Sigstore bundles.
- The authorization record is attached to the release.

## Honest limits

- GitHub Free private repositories cannot enforce branch protection or required
  reviews against repository administrators. The release gate is fail-closed for
  normal tags, but a writer who can edit `.github/workflows/release.yml` can
  bypass it. Complete enforcement needs an external release/deployment authority.
- A public source repository is not used for npm provenance. Sigstore is the
  private-compatible integrity mechanism.
- The repository's visibility is not changed by this document or by the CI
  workflow.
