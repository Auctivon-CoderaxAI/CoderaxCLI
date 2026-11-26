#!/bin/sh
# Remove a standalone Coderax CLI installation. User data is only removed with
# --purge, because credentials and preferences may be worth keeping.
set -eu

PREFIX="${CODERAX_PREFIX:-$HOME/.coderax/cli}"
BIN_DIR="${CODERAX_BIN_DIR:-$HOME/.local/bin}"
VERSION=""
PURGE=0
YES=0

usage() {
  cat <<'EOF'
Usage: uninstall.sh [options]

  --prefix <dir>    Install root (default: ~/.coderax/cli)
  --bin-dir <dir>   Launcher directory (default: ~/.local/bin)
  --version <x.y.z> Remove one version (default: all installed versions)
  --purge           Also remove the stored configuration (credentials)
  --yes             Perform the removal (without it, prints the plan)
  -h, --help        Show this help
EOF
}

die() {
  echo "coderax uninstall: $1" >&2
  exit "${2:-1}"
}

need_value() {
  [ "$#" -ge 2 ] || die "option $1 requires a value" 2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix) need_value "$@"; PREFIX="$2"; shift 2 ;;
    --bin-dir) need_value "$@"; BIN_DIR="$2"; shift 2 ;;
    --version) need_value "$@"; VERSION="$2"; shift 2 ;;
    --purge) PURGE=1; shift ;;
    --yes) YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (try --help)" 2 ;;
  esac
done

case "$PREFIX" in
  ''|/|"$HOME") die "refusing to remove '$PREFIX'" 2 ;;
esac

LAUNCHER="$BIN_DIR/coderax"
CONFIG="${CODERAX_CONFIG:-$HOME/.coderax/config.json}"

has_targets() {
  if [ -n "$VERSION" ]; then
    [ -d "$PREFIX/$VERSION" ] && return 0
    return 1
  fi
  for directory in "$PREFIX"/*; do
    if [ -d "$directory" ]; then
      return 0
    fi
  done
  return 1
}

list_targets() {
  if [ -n "$VERSION" ]; then
    printf '    %s\n' "$PREFIX/$VERSION"
    return 0
  fi
  for directory in "$PREFIX"/*; do
    if [ -d "$directory" ]; then
      printf '    %s\n' "$directory"
    fi
  done
}

remove_targets() {
  if [ -n "$VERSION" ]; then
    if [ -d "$PREFIX/$VERSION" ]; then
      rm -rf "$PREFIX/$VERSION"
    fi
    return 0
  fi
  for directory in "$PREFIX"/*; do
    if [ -d "$directory" ]; then
      rm -rf "$directory"
    fi
  done
}

echo "coderax uninstall plan"
if has_targets; then
  list_targets
else
  echo "    (no installed versions under $PREFIX)"
fi
if [ -L "$LAUNCHER" ]; then
  echo "  launcher  $LAUNCHER"
fi
if [ "$PURGE" -eq 1 ]; then
  echo "  user data $CONFIG (and temporary config files)"
fi

if [ "$YES" -ne 1 ]; then
  echo "Re-run with --yes to remove the items above."
  exit 0
fi

remove_targets

# Only remove a launcher that points at this prefix.
if [ -L "$LAUNCHER" ]; then
  resolved="$(readlink "$LAUNCHER" || true)"
  case "$resolved" in
    "$PREFIX"/*) rm -f "$LAUNCHER" ;;
    *) echo "coderax uninstall: leaving $LAUNCHER (points to $resolved)" >&2 ;;
  esac
fi

if [ "$PURGE" -eq 1 ]; then
  rm -f "$CONFIG"
  rm -f "$CONFIG".*.tmp
fi

rmdir "$PREFIX" 2>/dev/null || true
echo "coderax-cli removed"
