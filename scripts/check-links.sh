#!/usr/bin/env bash
# Check for broken internal links in README and docs/ (M4-01 AC4)

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

echo "Checking internal links in README.md and docs/*.md..."

broken=0

# Function to check if a file path exists
check_link() {
    local file="$1"
    local link="$2"

    # Skip external URLs
    if [[ "$link" =~ ^https?:// ]]; then
        return 0
    fi

    # Skip GitLab uploads (AC3 screenshots)
    if [[ "$link" =~ ^/uploads/ ]]; then
        return 0
    fi

    # Skip anchors for now (would need markdown parser)
    link="${link%#*}"

    # Empty link after removing anchor
    if [[ -z "$link" ]]; then
        return 0
    fi

    # Resolve relative to file's directory
    local dir="$(dirname "$file")"
    local target="$dir/$link"

    if [[ ! -e "$target" ]]; then
        echo "BROKEN: $file -> $link (target not found: $target)"
        ((broken++))
        return 1
    fi
    return 0
}

# Extract markdown links: [text](link)
extract_links() {
    local file="$1"
    grep -oP '\[([^\]]+)\]\(([^)]+)\)' "$file" | grep -oP '\([^)]+\)' | tr -d '()' || true
}

# Check README
if [[ -f README.md ]]; then
    while IFS= read -r link; do
        check_link "README.md" "$link" || true
    done < <(extract_links "README.md")
fi

# Check all docs/*.md
for file in docs/*.md; do
    if [[ -f "$file" ]]; then
        while IFS= read -r link; do
            check_link "$file" "$link" || true
        done < <(extract_links "$file")
    fi
done

if [[ $broken -eq 0 ]]; then
    echo "✓ No broken internal links found"
    exit 0
else
    echo "✗ Found $broken broken link(s)"
    exit 1
fi
