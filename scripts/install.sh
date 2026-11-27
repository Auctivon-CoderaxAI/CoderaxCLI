#!/bin/sh
# Coderax CLI installer for Linux and macOS.
#
# What this does: downloads one release archive, verifies its SHA-256 checksum
# (and, with --provenance, the release's build provenance), extracts it with a
# traversal- and symlink-safe extractor, stages it, and swaps the launcher into
# place atomically. A failed swap restores the previous install.
#
# What this does NOT do: install Node.js, Ollama, Docker, local AI runtimes,
# databases, or background services. Coderax inference and state live in the
# cloud deployment; the CLI is only the access and control interface. If Node
# is missing the installer stops and tells you to install it yourself.
#
# No token is accepted, stored, or printed here. Run `coderax login` after
# installing; it prompts with echo disabled and uses the OS credential store.
set -eu

REPO="Auctivon-CoderaxAI/CoderaxCLI"
DEFAULT_BASE_URL="https://github.com/${REPO}/releases"

VERSION="${CODERAX_VERSION:-latest}"
PREFIX="${CODERAX_PREFIX:-$HOME/.coderax/cli}"
BIN_DIR="${CODERAX_BIN_DIR:-$HOME/.local/bin}"
FROM_FILE=""
CHECKSUM=""
BASE_URL="${CODERAX_BASE_URL:-$DEFAULT_BASE_URL}"
DRY_RUN=0
SKIP_VERIFY=0
PROVENANCE=0
FORCE=0
TMP=""

usage() {
  cat <<'EOF'
Usage: install.sh [options]

  --version <x.y.z>   Release to install (default: latest)
  --prefix <dir>      Install root (default: ~/.coderax/cli)
  --bin-dir <dir>     Launcher directory (default: ~/.local/bin)
  --from-file <path>  Install a local standalone .tar.gz (offline install)
  --checksum <sha256> Expected checksum for --from-file (required)
  --base-url <url>    Releases base URL (default: GitHub Releases, HTTPS only)
  --provenance        Also verify the archive's release signature
  --skip-verify       Do not verify the download (not recommended)
  --force             Atomically replace an existing install of this version
  --dry-run           Print the plan without changing anything
  -h, --help          Show this help

Environment: CODERAX_VERSION, CODERAX_PREFIX, CODERAX_BIN_DIR, CODERAX_BASE_URL,
CODERAX_REQUIRE_PROVENANCE=1

Authentication is never an installer argument: run `coderax login` afterwards.
EOF
}

die() {
  echo "coderax install: $1" >&2
  exit "${2:-1}"
}

need_value() {
  [ "$#" -ge 2 ] || die "option $1 requires a value" 2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version) need_value "$@"; VERSION="$2"; shift 2 ;;
    --prefix) need_value "$@"; PREFIX="$2"; shift 2 ;;
    --bin-dir) need_value "$@"; BIN_DIR="$2"; shift 2 ;;
    --from-file) need_value "$@"; FROM_FILE="$2"; shift 2 ;;
    --checksum) need_value "$@"; CHECKSUM="$2"; shift 2 ;;
    --base-url) need_value "$@"; BASE_URL="$2"; shift 2 ;;
    --skip-verify) SKIP_VERIFY=1; shift ;;
    --provenance) PROVENANCE=1; shift ;;
    --force) FORCE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (try --help)" 2 ;;
  esac
done

if [ "${CODERAX_REQUIRE_PROVENANCE:-0}" = "1" ]; then
  PROVENANCE=1
fi

# --- prerequisites ---------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  cat >&2 <<'EOF'
coderax install: Node.js is required but was not found on PATH.

Install Node.js 24 or newer from https://nodejs.org/ and run this installer
again. This installer deliberately does not install runtimes, containers,
databases, Ollama, or background services.
EOF
  exit 2
fi

NODE_VERSION="$(node -p 'process.versions.node' 2>/dev/null || true)"
NODE_MAJOR="${NODE_VERSION%%.*}"
case "$NODE_MAJOR" in
  ''|*[!0-9]*) die "could not determine the Node.js version (got '$NODE_VERSION')" 2 ;;
esac
if [ "$NODE_MAJOR" -lt 24 ]; then
  die "Node.js 24 or newer is required (found $NODE_VERSION)" 2
fi

case "$PREFIX" in
  ''|/|"$HOME") die "refusing to use '$PREFIX' as the install prefix" 2 ;;
esac

case "$BASE_URL" in
  https://*) ;;
  http://localhost*|http://127.0.0.1*) ;;
  *) die "releases URL must use HTTPS (got '$BASE_URL')" 2 ;;
esac

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$1" | awk '{print $NF}'
  else
    die "no SHA-256 tool found (sha256sum, shasum, or openssl)" 2
  fi
}

fetch() {
  url="$1"
  destination="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --proto '=https' --tlsv1.2 --retry 2 -o "$destination" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$destination" "$url"
  else
    die "curl or wget is required to download a release" 2
  fi
}

# Return 44 only for an HTTP 404, which permits verification of older releases.
fetch_bundle() {
  if command -v curl >/dev/null 2>&1; then
    if status="$(curl -fsSL --proto '=https' --tlsv1.2 --retry 2 -w '%{http_code}' -o "$2" "$1")"; then
      return 0
    fi
  else
    if response="$(wget --server-response -O "$2" "$1" 2>&1)"; then
      return 0
    fi
    status="$(printf '%s\n' "$response" | awk '$1 ~ /^HTTP\// {code=$2} END {print code}')"
  fi
  [ "$status" = 404 ] && return 44
  return 1
}

TMP="$(mktemp -d "${TMPDIR:-/tmp}/coderax-install.XXXXXX")"
trap 'if [ -n "$TMP" ] && [ -d "$TMP" ]; then rm -rf "$TMP"; fi' EXIT INT TERM
# Node resolves the extractor module to its physical path, including on macOS
# where the system temp directory can be reached through a symlink.
TMP_PHYSICAL="$(cd -P "$TMP" && pwd)"
TMP="$TMP_PHYSICAL"

# --- resolve version -------------------------------------------------------
if [ -n "$FROM_FILE" ] && [ "$VERSION" = "latest" ]; then
  die "--from-file requires --version <x.y.z>" 2
fi

if [ "$VERSION" = "latest" ]; then
  fetch "https://api.github.com/repos/${REPO}/releases/latest" "$TMP/latest.json"
  VERSION="$(node -e '
    const fs = require("node:fs");
    const release = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const tag = String(release.tag_name || "").replace(/^v/, "");
    if (!/^\d+\.\d+\.\d+([-.][0-9A-Za-z.]+)?$/.test(tag)) process.exit(1);
    process.stdout.write(tag);
  ' "$TMP/latest.json")" || die "could not resolve the latest release version" 2
fi

case "$VERSION" in
  *[!0-9A-Za-z.+-]*) die "invalid version: $VERSION" 2 ;;
esac
if ! printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.]+)?$'; then
  die "invalid version: $VERSION" 2
fi

ASSET="coderax-cli-${VERSION}-standalone.tar.gz"
DEST="${PREFIX}/${VERSION}"
LAUNCHER="${BIN_DIR}/coderax"

if [ "$DRY_RUN" -eq 1 ]; then
  cat <<EOF
coderax install plan (dry run, nothing was changed)
  version    $VERSION
  package    ${ASSET}
  install    $DEST
  launcher   $LAUNCHER
  node       $NODE_VERSION
  verify     $([ "$SKIP_VERIFY" -eq 1 ] && echo "disabled" || echo "sha256")$([ "$PROVENANCE" -eq 1 ] && echo " + provenance" || true)
EOF
  exit 0
fi

# --- acquire ---------------------------------------------------------------
if [ -n "$FROM_FILE" ]; then
  [ -f "$FROM_FILE" ] || die "archive not found: $FROM_FILE" 2
  ARCHIVE="$FROM_FILE"
  if [ "$SKIP_VERIFY" -eq 0 ]; then
    [ -n "$CHECKSUM" ] || die "--checksum is required for --from-file (or pass --skip-verify explicitly)" 2
    actual="$(sha256_file "$ARCHIVE" | tr 'A-Z' 'a-z')"
    expected="$(printf '%s' "$CHECKSUM" | tr 'A-Z' 'a-z')"
    [ "$actual" = "$expected" ] || die "checksum mismatch for $ARCHIVE" 3
  else
    echo "coderax install: WARNING: checksum verification disabled" >&2
  fi
else
  release_base="${BASE_URL}/download/v${VERSION}"
  ARCHIVE="$TMP/$ASSET"
  fetch "$release_base/$ASSET" "$ARCHIVE"
  if [ "$SKIP_VERIFY" -eq 0 ]; then
    fetch "$release_base/SHA256SUMS" "$TMP/SHA256SUMS"
    expected="$(grep -F "  $ASSET" "$TMP/SHA256SUMS" | head -n 1 | awk '{print $1}' | tr 'A-Z' 'a-z')"
    [ -n "$expected" ] || die "SHA256SUMS does not list $ASSET" 3
    actual="$(sha256_file "$ARCHIVE" | tr 'A-Z' 'a-z')"
    [ "$actual" = "$expected" ] || die "checksum mismatch for $ASSET" 3
  else
    echo "coderax install: WARNING: checksum verification disabled" >&2
  fi
fi

if [ "$PROVENANCE" -eq 1 ]; then
  legacy=0
  if [ -n "$FROM_FILE" ]; then
    bundle="$ARCHIVE.sigstore.json"
    if [ ! -e "$bundle" ]; then legacy=1; fi
  else
    bundle="$TMP/$ASSET.sigstore.json"
    fetch_bundle "$release_base/$ASSET.sigstore.json" "$bundle" || {
      [ "$?" -eq 44 ] || die "could not download the provenance bundle for $ASSET" 3
      legacy=1
    }
  fi
  if [ "$legacy" -eq 1 ]; then
    command -v gh >/dev/null 2>&1 || die "legacy provenance verification requires the GitHub CLI (gh)" 3
    gh attestation verify "$ARCHIVE" --repo "$REPO" >/dev/null ||
      die "legacy provenance verification failed for $ARCHIVE" 3
  else
    command -v cosign >/dev/null 2>&1 || die "--provenance requires Cosign for signed bundles" 3
    # Manual releases may be signed from a branch; tag runs must match this version.
    tag_pattern="$(printf '%s' "$VERSION" | sed 's/[.+]/[&]/g')"
    cosign verify-blob --bundle "$bundle" \
      --certificate-identity-regexp "^https://github[.]com/${REPO}/[.]github/workflows/release[.]yml@refs/(tags/v${tag_pattern}|heads/.+)$" \
      --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
      "$ARCHIVE" >/dev/null || die "provenance verification failed for $ARCHIVE" 3
  fi
fi

# --- extract safely --------------------------------------------------------
# The extractor is injected at release-build time so this script stays one
# self-contained download. Extractors never honour absolute paths, `..`,
# symlinks, duplicates, or overwrites.
mkdir -p "$TMP/extract/lib"
base64 -d > "$TMP/extract/lib/archive.mjs" <<'CODERAX_ARCHIVE_EOF'
@CODERAX_ARCHIVE_B64@
CODERAX_ARCHIVE_EOF
base64 -d > "$TMP/extract/lib/safe-extract.mjs" <<'CODERAX_EXTRACT_EOF'
@CODERAX_EXTRACT_B64@
CODERAX_EXTRACT_EOF
STAGING="$TMP/stage"
mkdir -p "$STAGING"
node "$TMP/extract/lib/safe-extract.mjs" "$ARCHIVE" "$STAGING" >/dev/null ||
  die "archive failed safe extraction" 3

# The archive contains a single top-level directory named for the version.
EXTRACTED="$STAGING/coderax-cli-$VERSION"
if [ ! -d "$EXTRACTED" ]; then
  die "unexpected archive layout: coderax-cli-$VERSION/ is missing (staging contains: $(ls -A "$STAGING" 2>&1 | tr '\n' ' '))" 3
fi
[ -f "$EXTRACTED/src/cli.js" ] || die "unexpected archive layout: src/cli.js is missing" 3
[ -f "$EXTRACTED/bin/coderax" ] || die "unexpected archive layout: bin/coderax is missing" 3

STAGED_VERSION="$(node "$EXTRACTED/src/cli.js" --version 2>/dev/null || true)"
case "$STAGED_VERSION" in
  "coderax-cli $VERSION") ;;
  *) die "staged build did not report the expected version (got '$STAGED_VERSION')" 3 ;;
esac

# --- commit atomically -----------------------------------------------------
mkdir -p "$PREFIX" "$BIN_DIR"
BACKUP=""
if [ -e "$DEST" ]; then
  if [ "$FORCE" -ne 1 ]; then
    die "version $VERSION is already installed at $DEST (use --force to replace it)" 1
  fi
  BACKUP="$PREFIX/.rollback-$VERSION-$(date +%s)-$$"
  mv "$DEST" "$BACKUP" || die "could not move the existing install aside" 1
fi

if ! mv "$EXTRACTED" "$DEST"; then
  if [ -n "$BACKUP" ] && [ -e "$BACKUP" ]; then mv "$BACKUP" "$DEST"; fi
  die "could not move the staged install into place" 1
fi

# Swap the launcher with rename(2), not a non-atomic unlink+symlink.
TMP_LINK="$LAUNCHER.tmp.$$"
if ! ln -s "$DEST/bin/coderax" "$TMP_LINK" || ! mv -f "$TMP_LINK" "$LAUNCHER"; then
  rm -f "$TMP_LINK"
  rm -rf "$DEST"
  if [ -n "$BACKUP" ] && [ -e "$BACKUP" ]; then mv "$BACKUP" "$DEST"; fi
  die "could not install the launcher; the previous version was restored" 1
fi

INSTALLED="$("$LAUNCHER" --version 2>/dev/null || true)"
if [ "$INSTALLED" != "coderax-cli $VERSION" ]; then
  rm -rf "$DEST"
  if [ -n "$BACKUP" ] && [ -e "$BACKUP" ]; then mv "$BACKUP" "$DEST"; fi
  die "installed launcher did not report the expected version (got '$INSTALLED'); rolled back" 1
fi

if [ -n "$BACKUP" ]; then
  echo "coderax install: previous $VERSION kept for rollback at $BACKUP"
fi

echo "coderax-cli $VERSION installed"
echo "  program   $DEST"
echo "  launcher  $LAUNCHER"
case ":${PATH:-}:" in
  *":$BIN_DIR:"*) ;;
  *) echo "  PATH      add it: export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
echo ""
echo "Next: coderax login            (prompts with echo disabled; no token in argv)"
echo "      coderax doctor && coderax compat"
echo "No other software was installed: no Node.js runtime, Ollama, containers,"
echo "databases, or background services. Coderax runs in the cloud deployment."
