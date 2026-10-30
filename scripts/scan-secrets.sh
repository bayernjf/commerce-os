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

hits=0
for pat in "${PATTERNS[@]}"; do
  # Only tracked files (git ls-files); skip node_modules/dist/.astro/front build outputs.
  while IFS= read -r f; do
    case "$f" in
      node_modules/*|dist/*|front/.astro/*|front/dist/*|.git/*) continue ;;
    esac
    if grep -nE "$pat" "$f" >/dev/null 2>&1; then
      echo "HIT [$pat] -> $f"
      hits=1
    fi
  done < <(git ls-files)
done

if [ "$hits" = "1" ]; then
  echo "SECRET SCAN FAILED: tracked credential-like content found" >&2
  exit 1
fi

printf 'SECRET SCAN CLEAN: no tracked credential patterns (token 零命中)\n'
