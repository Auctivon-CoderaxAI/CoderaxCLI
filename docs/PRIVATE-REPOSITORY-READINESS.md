# Private-repository readiness

This repository is prepared for private operation without reducing test
coverage or publishing an owner-only package.

## CI and cost

- Pull requests and `main` pushes run the reusable Linux verification workflow.
- A weekly schedule and every release run the complete Linux, Windows, and macOS
  matrix through the same reusable workflow.
- The PR/main Linux path covers syntax, unit/CLI/contract tests, build,
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
  exact-head `test`, `changed-commits`, and `dependency audit` checks.
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
