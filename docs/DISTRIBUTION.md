# Distribution channels

Research and decisions for shipping Coderax CLI at zero cost. Nothing here
publishes a package or changes registry ownership; every channel that would do
so is listed as **requires authorization**.

## Constraints

- Windows, macOS, and Linux.
- No runtime dependency on Node beyond the documented `>=24.0.0`.
- No automatic installation of Ollama, containers, local AI runtimes,
  databases, or background services.
- No paid hosting, paid runners, or self-hosted infrastructure.
- Publication credentials must never be reachable from pull-request workflows.

## Options

| Channel | Cost | Who can install | Needs | Fit |
| --- | --- | --- | --- | --- |
| **GitHub Releases** | Free. Up to 1,000 assets per release, each file under 2 GiB, no total-size or bandwidth limit ([docs](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)) | Anyone with repository access | `contents: write` at release time only | **Primary.** Works for private and public repositories, all OSes, no registry ownership |
| **npm public registry** | Free for public packages | Node users; `npx` | npm account and ownership of the name | **Secondary, not enabled.** Best ergonomics; see the publication gate below |
| GitHub Packages (npm) | 500 MB included on Free ([pricing](https://github.com/pricing)) | Authenticated users only | GitHub org + token to install | Rejected: installs require a registry token, which defeats one-command install |
| **JSR** | Free | Deno and Node ESM users | A JSR scope; `jsr.json` with `name`, `version`, `exports` ([publishing](https://jsr.io/docs/publishing-packages), [scopes](https://jsr.io/docs/scopes)) | Optional: the package is already ESM-only, so it would fit; adds a second registry to own |
| **Homebrew tap** | Free | macOS/Linux Homebrew users | A second repository (`homebrew-<name>`) and a formula that points at the release tarball + SHA-256 ([tap docs](https://docs.brew.sh/Taps)) | Optional: no approval needed, but every release needs a formula bump |
| **Scoop bucket** | Free | Windows Scoop users | A bucket repository with a JSON manifest pointing at the release zip + hash | Optional, same maintenance shape as the Homebrew tap |
| **WinGet** | Free | Windows users | Manifest submitted to `microsoft/winget-pkgs`; moderated review | Optional: widest Windows reach, slowest turnaround |
| Snap / Flathub | Free | Linux desktop users | Store account; bundling a Node runtime | Rejected: bundles a runtime and duplicates what the installer does |
| Docker image | Free image hosting | Container users | A container runtime to use it | Rejected: would require Docker, contradicting the install constraint |
| Self-hosted runners | Server + maintenance | — | Infrastructure | Rejected: not zero-cost in time or risk |

## GitHub Actions cost

- Standard GitHub-hosted runners are **free and unlimited for public
  repositories** ([runner docs](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)).
- For private repositories, GitHub Free includes **2,000 CI/CD minutes per
  month** ([pricing](https://github.com/pricing)); usage draws from that
  allowance.

This repository's CI runs three OS jobs of roughly one to two minutes each on
pushes and pull requests, plus the release job on tags. On a private repository
that fits comfortably inside the free allowance; making the repository public
removes the limit entirely.

## Recommendation

1. **GitHub Releases are the canonical channel.** They already carry every
   property this task requires: versioned artifacts, checksums, SBOM, installers,
   no registry ownership, and no dependency on a package manager. The installer
   verifies SHA-256 by default.
2. **npm is the second channel once the owner authorizes publication.** It is
   prepared but disabled: `package.json` is `"private": true`, and the release
   workflow's npm job is gated behind a manual input, a repository variable, and
   a protected environment.
3. **Homebrew tap and Scoop bucket later, if users ask.** Both can be generated
   mechanically from `release-manifest.json`; neither should be added before
   there is demand, because each is another artifact to keep in sync.

### Why npm is not simply enabled

- Publishing requires ownership of the package name and a licence decision.
  Both belong to the repository owner, not to an automated change.
- npm provenance is not available for packages published from **private source
  repositories** ([GitHub changelog](https://github.blog/changelog/2023-07-25-publishing-with-npm-provenance-from-private-source-repositories-is-no-longer-supported/)),
  so provenance would require making the repository public first.
- Trusted publishing (OIDC, no long-lived token) requires npm CLI 11.5.1+ and a
  trusted-publisher configuration on npmjs.com
  ([npm docs](https://docs.npmjs.com/trusted-publishers)).

The release workflow therefore uses OIDC and no stored npm token at all. If the
project later publishes with a token, that token belongs in a protected
environment, never in a workflow reachable from a pull request.

### What is implemented today

- GitHub Release assets built locally by `npm run build` and verified by
  `npm run verify`: npm tarball, POSIX tarball, Windows zip, `SHA256SUMS`,
  manifest, SBOM, notes, installers, uninstallers.
- A tag-driven release workflow that publishes those assets to a GitHub Release
  with `contents: write` scoped to that job.
- Installation from the GitHub Release (`install.sh`, `install.ps1`) and from
  the npm tarball (`npm install --global ./coderax-cli-<version>.tgz`).
- No registry, no package publication, no ownership change.

### What still needs the owner

| Action | Why it is gated |
| --- | --- |
| Publish to npm | Name ownership, licence, and an explicit authorization |
| Make the repository public | Changes who can download releases and enables provenance |
| Create a Homebrew tap or Scoop bucket | Creates a new repository the owner must own |
| Submit to WinGet | External moderation and a lasting maintenance obligation |
| Enable an auto-update feed | Would add automatic installation; explicitly out of scope |
