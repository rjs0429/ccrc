#!/usr/bin/env bash
# Prints the GitHub Release notes for a tag: its section of CHANGELOG.md as the tag has it, how to install or update
# to it, and a link comparing it with the release before it.
#
#   scripts/release-notes.sh <tag>
#
# Run inside a clone that has the tags. GH_REPO (owner/name, as GitHub Actions sets it) names the repository in the
# links; without it, rjs0429/ccrc.
set -euo pipefail

die() {
  echo "release-notes: $*" >&2
  exit 1
}

[ $# -eq 1 ] || die "usage: scripts/release-notes.sh <tag>"
tag=$1
repo=${GH_REPO:-rjs0429/ccrc}
case $tag in
  v[0-9]*) ;;
  *) die "$tag is not a release tag (v<major>.<minor>.<patch>)" ;;
esac
git rev-parse -q --verify "refs/tags/$tag" >/dev/null || die "no tag $tag in this clone"
version=${tag#v}

changelog=$(git show "$tag:CHANGELOG.md" 2>/dev/null) || die "$tag has no CHANGELOG.md"

# The lines under "## [<version>]" (followed by " - <date>" or nothing), up to the next "## [" heading or the link
# definitions at the end, without blank lines around them.
section=$(awk -v v="$version" '
  BEGIN { head = "## [" v "]" }
  !found {
    if ($0 == head || index($0, head " ") == 1) found = 1
    next
  }
  /^## \[/ || /^\[[^]]+\]: / { exit }
  { lines[++n] = $0 }
  END {
    if (!found) exit 2
    first = 1; while (first <= n && lines[first] ~ /^[[:space:]]*$/) first++
    last = n; while (last >= first && lines[last] ~ /^[[:space:]]*$/) last--
    for (i = first; i <= last; i++) print lines[i]
  }' <<<"$changelog") || die "CHANGELOG.md at $tag has no section \"## [$version]\""
[ -n "$section" ] || die "the section \"## [$version]\" in CHANGELOG.md at $tag is empty"

# The release before this one: for a release, the previous release; for a pre-release (a tag with "-"), the tag just
# before it, pre-release or not. Pre-releases sort before their release (v0.8.0-rc.1 < v0.8.0).
tags=$(git -c versionsort.suffix=- tag -l 'v[0-9]*' --sort=v:refname)
previous=$(awk -v t="$tag" '
  $0 == t { print prev; exit }
  t ~ /-/ || $0 !~ /-/ { prev = $0 }' <<<"$tags")

printf '%s\n' "$section"

# install.sh came with 0.7.0; older tags have no installer to point at.
if git cat-file -e "$tag:install.sh" 2>/dev/null; then
  cat <<EOF

### Install or update

On an install of 0.7.0 or newer:

\`\`\`bash
ccrc update --to $tag
\`\`\`

A new install:

\`\`\`bash
curl -fsSL https://raw.githubusercontent.com/$repo/$tag/install.sh | bash -s -- --version $tag
\`\`\`
EOF
  object=$(git cat-file tag "$tag" 2>/dev/null || true)
  if [[ $object == *"-----BEGIN SSH SIGNATURE-----"* ]]; then
    cat <<EOF

The tag is signed with an SSH key listed in \`.ccrc-allowed-signers\`; "Verifying a release" in the README shows how
to check it.
EOF
  fi
fi

if [ -n "$previous" ]; then
  printf '\n**Full changelog**: https://github.com/%s/compare/%s...%s\n' "$repo" "$previous" "$tag"
else
  printf '\n**Full changelog**: https://github.com/%s/commits/%s\n' "$repo" "$tag"
fi
