# Private-repository readiness — CoderaxCLI

<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:b2f7d263b5c9c4528cad754c56b635210a3456b336bb82bbc2a7ea3b54bec3ef -->

Status: CI and release changes are prepared for GitHub Free private operation. Visibility is unchanged. Before privatizing, the owner must resolve the merge and publish approval controls and establish a release distribution path for both installers. The POSIX and Windows installers download GitHub Release assets without credentials, so their default downloads will fail once the repository is private. Provide a release endpoint both installers can use, or document how users with repository access can download the release assets and install offline with `--from-file` (POSIX) and `-FromFile` (Windows).

<!-- /coderabbit-ai-generated:v1 -->

## Blockers and required controls

| Dependency | Why it blocks private Free | Replacement |
|---|---|---|
| `actions/attest-build-provenance` + `gh attestation verify` | Artifact attestations are public-only on Free/Pro/Team; private needs Enterprise Cloud. | Keyless Sigstore signing (`cosign sign-blob`) with a `.sigstore.json` bundle per asset, verified in-workflow with `cosign verify-blob`. Both are free. |
| `npm publish --provenance` and `publishConfig.provenance` | npm provenance requires a public repository matching the package. | Flags removed; npm OIDC trusted publishing remains available. See the separate approval control below. |
| Required `test` merge check on `main` | GitHub Free cannot enforce protected branch checks on private repositories. | Owner must select and document a replacement merge control before privatizing. |
| Required `npm-publish` reviewers | GitHub Free does not enforce environment reviewers on private repositories. | Keep npm publishing disabled until a replacement approval control is in place. |
| Three-OS matrix on every PR | Private Free includes $12/month compute; macOS is 10x and Windows 2x. | PRs run Linux; `main` runs Ubuntu + Windows + macOS, preserving post-merge compatibility coverage. |
| Artifact evidence on every run | 500 MB artifact allowance on Free. | Upload only on failure or `main`, retention 7 days. |
| Secret scanning / push protection | Public-only on Free. | `secret-scan.yml` scans introduced commits on PRs and pushes, and audits full history on a schedule or manual dispatch. Push blocking has no free private equivalent. |

## Cost math

A 4-minute job costs about $0.024 on Linux, $0.048 on Windows and $0.24 on macOS.
The old PR matrix cost roughly $0.31 per run; the new PR path costs about $0.024.

## Owner action before privatizing

1. Choose, name, and document the replacement control for merges to `main`,
   including how it requires a passing `test` check before merge.
2. Establish and document a replacement approval control for the `npm` job.
   Keep `NPM_PUBLISH_ENABLED` unset until that control is in place.
3. Add a $0 billing/spending limit.
