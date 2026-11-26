#!/bin/sh
# Install a published Coderax CLI release without npm or root.
#
#   CODERAX_VERSION=1.0.0 sh install.sh
#
# The archive and SHA256SUMS are fetched over HTTPS from the GitHub release.
# Nothing is published to an external package registry.
set -eu

fail() {
  printf 'coderax installer: %s\n' "$*" >&2
  exit 1
}

VERSION="${CODERAX_VERSION:-1.0.0}"
case "$VERSION" in
  *[!A-Za-z0-9._-]*|'') fail "invalid CODERAX_VERSION: $VERSION" ;;
esac
INSTALL_ROOT="${CODERAX_HOME:-$HOME/.coderax}"
RELEASE_BASE="${CODERAX_RELEASE_BASE:-https://github.com/Auctivon-CoderaxAI/CoderaxCLI/releases/download/v${VERSION}}"

case "$RELEASE_BASE" in
  https://*) CURL_PROTO="=https" ;;
  http://localhost|http://localhost/*|http://127.0.0.1|http://127.0.0.1:*|http://\[::1\]|http://\[::1\]:*) CURL_PROTO="=https,http" ;;
  *) fail "release base must use HTTPS (HTTP only for loopback test servers)" ;;
esac

command -v node >/dev/null 2>&1 || fail "Node.js 24 or newer is required"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 24 ] || fail "Node.js 24 or newer is required (found $(node --version))"
command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v tar >/dev/null 2>&1 || fail "tar is required"

OS="$(uname -s)"
case "$OS" in
  Linux) PLATFORM="linux" ;;
  Darwin) PLATFORM="darwin" ;;
  *) fail "unsupported operating system: $OS" ;;
esac
MACHINE="$(uname -m)"
case "$MACHINE" in
  x86_64|amd64) ARCH="x64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *) fail "unsupported architecture: $MACHINE" ;;
esac

ARCHIVE="coderax-cli-${VERSION}-${PLATFORM}-${ARCH}.tar.gz"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/coderax-install.XXXXXX")"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT INT TERM

printf 'Downloading %s\n' "$ARCHIVE"
curl -fsSL --proto "$CURL_PROTO" --tlsv1.2 --retry 3 --retry-delay 1 \
  "$RELEASE_BASE/$ARCHIVE" -o "$TMP/$ARCHIVE" \
  || fail "could not download $RELEASE_BASE/$ARCHIVE"
curl -fsSL --proto "$CURL_PROTO" --tlsv1.2 --retry 3 --retry-delay 1 \
  "$RELEASE_BASE/SHA256SUMS" -o "$TMP/SHA256SUMS" \
  || fail "could not download SHA256SUMS"

EXPECTED="$(awk -v file="$ARCHIVE" '$2 == file { print $1 }' "$TMP/SHA256SUMS")"
[ -n "$EXPECTED" ] || fail "$ARCHIVE is not listed in SHA256SUMS"
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL="$(sha256sum "$TMP/$ARCHIVE" | awk '{ print $1 }')"
elif command -v shasum >/dev/null 2>&1; then
  ACTUAL="$(shasum -a 256 "$TMP/$ARCHIVE" | awk '{ print $1 }')"
else
  fail "sha256sum or shasum is required to verify the archive"
fi
[ "$EXPECTED" = "$ACTUAL" ] || fail "SHA256 mismatch for $ARCHIVE"

mkdir -p "$TMP/unpack"
tar -xzf "$TMP/$ARCHIVE" -C "$TMP/unpack"
DEST="$INSTALL_ROOT/cli/$VERSION"
rm -rf "$DEST"
mkdir -p "$DEST"
cp -R "$TMP/unpack/package/." "$DEST/"
BIN="$INSTALL_ROOT/bin"
mkdir -p "$BIN"
cat > "$BIN/coderax" <<EOF
#!/bin/sh
exec node "$DEST/src/cli.js" "\$@"
EOF
chmod 755 "$BIN/coderax"

"$BIN/coderax" --version || fail "the installed executable did not start"
printf '\nInstalled Coderax CLI %s in %s\n' "$VERSION" "$DEST"
printf 'Add this directory to PATH if needed:\n  export PATH="%s:$PATH"\n' "$BIN"
