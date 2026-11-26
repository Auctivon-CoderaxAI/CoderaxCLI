# Private-repository readiness — CoderaxCLI

Status: prepared for GitHub Free private operation at $0 additional spend. Visibility is unchanged.

## Blockers found and replaced

| Dependency | Why it blocks private Free | Replacement |
|---|---|---|
| `actions/attest-build-provenance` + `gh attestation verify` | Artifact attestations are public-only on Free/Pro/Team; private needs Enterprise Cloud. | Keyless Sigstore signing (`cosign sign-blob`) with a `.sigstore.json` bundle per asset, verified in-workflow with `cosign verify-blob`. Both are free. |
| `npm publish --provenance` and `publishConfig.provenance` | npm provenance requires a public repository matching the package. | Flags removed; npm OIDC trusted publishing and the protected `npm-publish` environment remain. |
| Three-OS matrix on every PR | Private Free includes $12/month compute; macOS is 10x and Windows 2x. | PRs run Linux; `main` runs Ubuntu + Windows + macOS, preserving post-merge compatibility coverage. |
| Artifact evidence on every run | 500 MB artifact allowance on Free. | Upload only on failure or `main`, retention 7 days. |
| Secret scanning / push protection | Public-only on Free. | `secret-scan.yml` gitleaks history scan. Push blocking has no free private equivalent. |

## Cost math

A 4-minute job costs about $0.024 on Linux, $0.048 on Windows and $0.24 on macOS.
The old PR matrix cost roughly $0.31 per run; the new PR path costs about $0.024.

## Owner action before privatizing

1. Confirm `npm-publish` environment reviewers are configured.
2. Add a $0 billing/spending limit.
3. Installer `--provenance` currently verifies GitHub attestations. On a private
   repo those no longer exist; use the published cosign bundle instead.
