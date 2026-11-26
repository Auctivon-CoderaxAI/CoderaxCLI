#!/bin/sh
# Coderax CLI installer for Linux and macOS.
#
# What this does: downloads one release archive, verifies its SHA-256 checksum,
# extracts it under a versioned directory, and puts a launcher on PATH.
#
# What this does NOT do: install Node.js, Ollama, Docker, local AI runtimes,
# databases, or background services. Coderax inference and state live in the
# cloud deployment; the CLI is only the access and control interface. If Node
# is missing the installer stops and tells you to install it yourself.
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
FORCE=0
COMPLETION=1
ROLLBACK=0
ALLOW_DOWNGRADE=0
TMP=""

usage() {
  cat <<'EOF'
Usage: install.sh [options]

  --version <x.y.z>   Release to install (default: latest)
  --prefix <dir>      Install root (default: ~/.coderax/cli)
  --bin-dir <dir>     Launcher directory (default: ~/.local/bin)
  --from-file <path>  Install a local standalone .tar.gz (offline install)
  --checksum <sha256> Expected checksum for --from-file
  --base-url <url>    Releases base URL (default: GitHub Releases)
  --skip-verify       Do not verify the download (not recommended)
  --force             Replace an existing installation of the same version
  --no-completion     Do not install shell completion
  --rollback          Repoint the launcher to an installed version
                      (requires --version; nothing is downloaded)
  --allow-downgrade   Permit installing an older version over a newer one
  --dry-run           Print the plan without changing anything
  -h, --help          Show this help

Environment: CODERAX_VERSION, CODERAX_PREFIX, CODERAX_BIN_DIR, CODERAX_BASE_URL
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
    --force) FORCE=1; shift ;;
    --no-completion) COMPLETION=0; shift ;;
    --rollback) ROLLBACK=1; shift ;;
    --allow-downgrade) ALLOW_DOWNGRADE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (try --help)" 2 ;;
  esac
done

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

if [ "$ROLLBACK" -eq 1 ] && [ "$VERSION" = "latest" ]; then
  die "--rollback requires --version <x.y.z>" 2
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/coderax-install.XXXXXX")"
trap 'if [ -n "$TMP" ] && [ -d "$TMP" ]; then rm -rf "$TMP"; fi' EXIT INT TERM

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

# Compare release versions without relying on GNU-only `sort -V` (macOS ships
# BSD sort). Exit 0 when $1 is newer than $2, 1 otherwise.
version_gt() {
  awk -v a="$1" -v b="$2" 'BEGIN {
    split(a, x, "."); split(b, y, ".");
    for (i = 1; i <= 3; i++) {
      if ((x[i] + 0) > (y[i] + 0)) exit 0;
      if ((x[i] + 0) < (y[i] + 0)) exit 1;
    }
    exit 1;
  }'
}

# Installing an older release over a newer one is an explicit decision, never a
# side effect of a stale download URL. `--rollback` is the supported downgrade
# path because it only switches between versions already on disk.
if [ "$ROLLBACK" -eq 0 ] && [ "$ALLOW_DOWNGRADE" -eq 0 ] && [ -d "$PREFIX" ] && { [ ! -e "$DEST" ] || [ "$FORCE" -eq 1 ]; }; then
  newest=""
  for candidate in "$PREFIX"/*; do
    [ -d "$candidate" ] || continue
    name="${candidate##*/}"
    case "$name" in
      [0-9]*.[0-9]*.[0-9]*) ;;
      *) continue ;;
    esac
    if [ -z "$newest" ] || version_gt "$name" "$newest"; then newest="$name"; fi
  done
  if [ -n "$newest" ] && version_gt "$newest" "$VERSION"; then
    die "refusing to downgrade $newest -> $VERSION (use --allow-downgrade or --rollback)" 2
  fi
fi

# Replace the launcher by renaming a sibling symlink over it. `ln -sfn` unlinks
# first, which leaves a window with no launcher; `mv` is atomic on one filesystem.
link_launcher() {
  target="$1"
  staged="${LAUNCHER}.new.$$"
  ln -sfn "$target" "$staged"
  mv -f "$staged" "$LAUNCHER"
}

# Completion is generated by the installed launcher, so it always matches the
# version that is actually on PATH. Only shells present on this machine get a
# file; no shell profile is edited.
install_completions() {
  if [ "$COMPLETION" -ne 1 ]; then
    echo "  completion skipped (--no-completion)"
    return 0
  fi
  data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
  config_home="${XDG_CONFIG_HOME:-$HOME/.config}"
  installed=0
  if command -v bash >/dev/null 2>&1; then
    path="$data_home/bash-completion/completions/coderax"
    mkdir -p "$(dirname "$path")"
    "$LAUNCHER" completion bash > "$path"
    echo "  bash      $path"
    installed=1
  fi
  if command -v zsh >/dev/null 2>&1; then
    path="$data_home/zsh/site-functions/_coderax"
    mkdir -p "$(dirname "$path")"
    "$LAUNCHER" completion zsh > "$path"
    echo "  zsh       $path"
    echo "            add ${data_home}/zsh/site-functions to fpath before compinit"
    installed=1
  fi
  if command -v fish >/dev/null 2>&1; then
    path="$config_home/fish/completions/coderax.fish"
    mkdir -p "$(dirname "$path")"
    "$LAUNCHER" completion fish > "$path"
    echo "  fish      $path"
    installed=1
  fi
  if [ "$installed" -eq 0 ]; then
    echo "  completion  no bash, zsh, or fish found; run \`coderax completion <shell>\` manually"
  fi
}

# Rollback only repoints the launcher at a version that is already on disk.
if [ "$ROLLBACK" -eq 1 ]; then
  [ -d "$DEST" ] || die "version $VERSION is not installed at $DEST" 1
  [ -f "$DEST/bin/coderax" ] || die "$DEST/bin/coderax is missing; reinstall version $VERSION" 1
  if [ "$DRY_RUN" -eq 1 ]; then
    cat <<EOF
coderax rollback plan (dry run, nothing was changed)
  version    $VERSION
  launcher   $LAUNCHER -> $DEST/bin/coderax
EOF
    exit 0
  fi
  mkdir -p "$BIN_DIR"
  link_launcher "$DEST/bin/coderax"
  INSTALLED="$("$LAUNCHER" --version 2>/dev/null || true)"
  case "$INSTALLED" in
    "coderax-cli $VERSION") ;;
    *) die "launcher did not report $VERSION after rollback (got '$INSTALLED')" 1 ;;
  esac
  echo "coderax-cli $VERSION restored"
  echo "  program   $DEST"
  echo "  launcher  $LAUNCHER"
  install_completions
  exit 0
fi

if [ "$DRY_RUN" -eq 1 ]; then
  cat <<EOF
coderax install plan (dry run, nothing was changed)
  version    $VERSION
  package    ${ASSET}
  install    $DEST
  launcher   $LAUNCHER
  node       $NODE_VERSION
  verify     $([ "$SKIP_VERIFY" -eq 1 ] && echo "disabled" || echo "sha256")
  completion $([ "$COMPLETION" -eq 1 ] && echo "bash, zsh, fish where installed" || echo "disabled")
EOF
  exit 0
fi

# --- acquire ---------------------------------------------------------------
if [ -n "$FROM_FILE" ]; then
  [ -f "$FROM_FILE" ] || die "archive not found: $FROM_FILE" 2
  ARCHIVE="$FROM_FILE"
  if [ -n "$CHECKSUM" ] && [ "$SKIP_VERIFY" -eq 0 ]; then
    actual="$(sha256_file "$ARCHIVE" | tr 'A-Z' 'a-z')"
    expected="$(printf '%s' "$CHECKSUM" | tr 'A-Z' 'a-z')"
    [ "$actual" = "$expected" ] || die "checksum mismatch for $ARCHIVE" 3
  elif [ "$SKIP_VERIFY" -eq 0 ]; then
    die "--from-file requires --checksum, or --skip-verify to install unverified" 2
  fi
else
  if [ "$VERSION" = "latest" ]; then
    release_base="${BASE_URL}/download/latest"
  else
    release_base="${BASE_URL}/download/v${VERSION}"
  fi
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

# --- install ---------------------------------------------------------------
# Reject traversal, absolute paths, and symlink entries before the system tar
# extracts anything. The checksum already authenticates the bytes; this keeps a
# malformed or substituted archive from writing outside the staging directory.
tar -tzf "$ARCHIVE" > "$TMP/archive-entries" 2>/dev/null || die "archive is not a readable tar.gz" 3
if grep -Eq '(^/|(^|/)\.\.(/|$))' "$TMP/archive-entries"; then
  die "archive contains an unsafe path" 3
fi
if tar -tvzf "$ARCHIVE" 2>/dev/null | grep -q '^l'; then
  die "archive contains a symbolic link" 3
fi
tar -xzf "$ARCHIVE" -C "$TMP"
EXTRACTED="$TMP/coderax-cli-$VERSION"
[ -f "$EXTRACTED/src/cli.js" ] || die "unexpected archive layout: src/cli.js is missing" 3

if [ -e "$DEST" ]; then
  if [ "$FORCE" -eq 1 ]; then
    rm -rf "$DEST"
  else
    die "version $VERSION is already installed at $DEST (use --force to replace it)" 1
  fi
fi

mkdir -p "$PREFIX" "$BIN_DIR"
mv "$EXTRACTED" "$DEST"
link_launcher "$DEST/bin/coderax"

INSTALLED="$("$LAUNCHER" --version 2>/dev/null || true)"
case "$INSTALLED" in
  "coderax-cli $VERSION") ;;
  *) die "installed launcher did not report the expected version (got '$INSTALLED')" 1 ;;
esac

echo "coderax-cli $VERSION installed"
echo "  program   $DEST"
echo "  launcher  $LAUNCHER"
install_completions
case ":${PATH:-}:" in
  *":$BIN_DIR:"*) ;;
  *) echo "  PATH      add it: export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
echo ""
echo "Next: coderax config set --base-url https://your-deployment --token <token>"
echo "      coderax doctor && coderax compat"
echo "No other software was installed: no Node.js runtime, Ollama, containers,"
echo "databases, or background services. Coderax runs in the cloud deployment."
