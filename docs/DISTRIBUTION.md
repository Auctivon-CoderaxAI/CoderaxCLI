# Distribution channels

Coderax CLI is owner-only. The source repository and its release assets are
private, and distribution is authenticated. No public npm publication,
provenance tied to a public source repository, or anonymous download URL is part
of the supported path.

## Implemented channel

| Channel | Cost | Access | Integrity |
| --- | --- | --- | --- |
| **Private GitHub Release** | $0 on GitHub Free | GitHub account with repository read access | `SHA256SUMS`, SPDX SBOM, Sigstore `.sigstore.json` bundles, release manifest, and `release-authorization.json` |

Release assets include an npm-compatible tarball, a POSIX standalone archive, a
Windows archive, installers, uninstallers, checksums, a manifest, an SBOM, notes,
and the authorization record. They inherit private repository access.

Authenticated download:

```sh
gh release download v0.3.0 --repo Auctivon-CoderaxAI/CoderaxCLI --dir release
```

The local installers verify the archive checksum by default and can verify the
Sigstore bundle after Cosign verifies the release workflow identity. Use
`--from-file` / `-FromFile` for a downloaded archive; do not construct an
anonymous `releases/download` URL.

## Deliberately excluded

- **Public npm registry** — would disclose an owner-only product and requires
  public package metadata. The release workflow has no npm job.
- **GitHub Packages npm** — technically private, but adds a registry token to
  every installation and shares the 500 MB Free storage allowance. The GitHub
  Release is simpler and has the same private access boundary.
- **Homebrew, Scoop, WinGet, JSR, Snap, Flathub, Docker images** — each adds a
  public index, a second repository, a bundled runtime, or a paid/maintained
  distribution surface. None is needed for an owner-only CLI.
- **Public artifact attestations** — GitHub attestations are public-only on Free.
  Keyless Sigstore bundles replace them without making the source public.
- **Auto-update** — deliberately not implemented. `coderax update` prints the
  authenticated upgrade command and never downloads or installs silently.

## Release authorization

A tag is publishable only if it points at the merge commit of an independently
approved pull request into `main`, and the pull-request head has successful
`test`, `changed-commits`, and `dependency audit` checks. The authorization job
records the PR, head SHA, approval, checks, and timestamp in
`release-authorization.json`, which becomes a release asset. The full Linux,
Windows, and macOS matrix must pass before the release job starts.

This gate prevents an unapproved tag or direct-push tag from publishing through
the normal workflow. It does not prevent a repository writer from editing the
workflow: GitHub Free private repositories cannot enforce branch protection
against administrators. Removing release credentials from repository-controlled
workflows would require an external deployment authority such as
DeploymentPlatformAI.
