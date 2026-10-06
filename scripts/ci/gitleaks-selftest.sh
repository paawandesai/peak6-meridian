#!/bin/sh
# CI self-test for the secret scanner (runs in the gitleaks image, hence POSIX sh): plant a fake
# private key in a temp directory outside the repo and require gitleaks, with the repo's
# .gitleaks.toml, to report it. A scanner or config that cannot see a secret fails the job.
set -eu

readonly LEAK_EXIT_CODE=42
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
config="$repo_root/.gitleaks.toml"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
case "$tmp" in
  "$repo_root"/*) echo "gitleaks-selftest: temp dir $tmp is inside the repo" >&2 && exit 1 ;;
esac

# The key is random and generated here, so no secret-shaped text is ever committed.
{
  printf -- '-----BEGIN %s PRIVATE KEY-----\n' RSA
  head -c 384 /dev/urandom | base64
  printf -- '-----END %s PRIVATE KEY-----\n' RSA
} > "$tmp/id_rsa_fake"

rc=0
gitleaks dir "$tmp" --config "$config" --redact --no-banner --exit-code "$LEAK_EXIT_CODE" || rc=$?
if [ "$rc" -ne "$LEAK_EXIT_CODE" ]; then
  echo "gitleaks-selftest: FAILED, gitleaks exited $rc instead of reporting the planted key." >&2
  exit 1
fi

# Control: the same scan of a directory without secrets must be clean.
mkdir "$tmp/clean"
echo "MERIDIAN_PROGRAM_ID=" > "$tmp/clean/settings.env"
rc=0
gitleaks dir "$tmp/clean" --config "$config" --redact --no-banner --exit-code "$LEAK_EXIT_CODE" || rc=$?
if [ "$rc" -ne 0 ]; then
  echo "gitleaks-selftest: FAILED, gitleaks exited $rc on a directory without secrets." >&2
  exit 1
fi

echo "gitleaks-selftest: OK, the planted key was reported and the clean directory passed."
