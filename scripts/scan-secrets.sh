#!/usr/bin/env bash
# Secret-boundary scan (SF-13 GATE-S1): verify no real credentials are
# tracked in this repository. Matches only high-entropy/live credential
# patterns; deterministic test fixtures (fake tokens) are explicitly allowed
# and skipped. Exit 0 = zero hits (token 零命中).
set -euo pipefail

COMMERCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$COMMERCE_DIR"

PATTERNS=(
  'SUPABASE_SERVICE_ROLE_KEY=[A-Za-z0-9._-]{20,}'
  'ghp_[A-Za-z0-9]{20,}'
  'github_pat_[A-Za-z0-9_]{20,}'
  'sk_live_[A-Za-z0-9]{16,}'
  'AKIA[0-9A-Z]{16}'
  'BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY'
  'xox[baprs]-[A-Za-z0-9-]{10,}'
  'AIza[0-9A-Za-z_-]{20,}'
  'COMMERCE_STOREFRONT_CART_SECRET=[^$[:space:]]{8,}'
  'COMMERCE_API_TOKEN=[^$[:space:]]{8,}'
)

# Documented placeholders, allowlisted by exact line fragment (review
# 2026-11-02 P1-2): these match a pattern by shape but are documentation
# values, never credentials. Anything else that matches still fails the scan.
ALLOWLIST=(
  'COMMERCE_API_TOKEN=dev-token'
)

# Repo-relative file list; SCAN_FILES (space-separated) overrides
# `git ls-files` so tests can scan fixtures without touching the index.
FILES=()
if [ -n "${SCAN_FILES:-}" ]; then
  # Intentional word splitting: the test hook passes a flat list.
  FILES=(${SCAN_FILES})
else
  while IFS= read -r f; do FILES+=("$f"); done < <(git ls-files)
fi

hits=0
for pat in "${PATTERNS[@]}"; do
  for f in "${FILES[@]}"; do
    case "$f" in
      node_modules/*|dist/*|front/.astro/*|front/dist/*|.git/*) continue ;;
    esac
    [ -f "$f" ] || continue
    while IFS= read -r line; do
      allowed=0
      for fragment in "${ALLOWLIST[@]}"; do
        case "$line" in
          *"$fragment"*) allowed=1; break ;;
        esac
      done
      if [ "$allowed" = "1" ]; then
        echo "SKIP [allowlisted placeholder] -> $f"
      else
        echo "HIT [$pat] -> $f: ${line}"
        hits=1
      fi
    done < <(grep -nE "$pat" "$f" || true)
  done
done

if [ "$hits" = "1" ]; then
  echo "SECRET SCAN FAILED: tracked credential-like content found" >&2
  exit 1
fi

printf 'SECRET SCAN CLEAN: no tracked credential patterns (token 零命中)\n'
