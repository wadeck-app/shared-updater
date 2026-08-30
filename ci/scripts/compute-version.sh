#!/usr/bin/env bash
# Computes the build version string and writes it to $GITHUB_OUTPUT.
#
# Inputs (env vars set by the workflow):
#   GITHUB_EVENT_NAME  -- "push" or "workflow_dispatch"
#   VERSION_INPUT      -- version string from workflow_dispatch input (e.g. "1.2.0")
#   BREAKING_INPUT     -- "true" or "false" from workflow_dispatch input
#   GITHUB_SHA         -- full commit SHA (set by GitHub Actions)
#
# Outputs (to $GITHUB_OUTPUT or stdout when GITHUB_OUTPUT is unset):
#   version        e.g. 2026.08.20-142-a3f2b1c4  (edge) or  1.2.0  (stable)
#   dist_tag       edge | latest | breaking-edge
#   is_prerelease  true | false
#   tag            v<version>
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

EVENT="${GITHUB_EVENT_NAME:-push}"
VERSION_INPUT="${VERSION_INPUT:-}"
BREAKING_INPUT="${BREAKING_INPUT:-false}"

if [[ "$EVENT" == "workflow_dispatch" && -n "$VERSION_INPUT" ]]; then
  VERSION="$VERSION_INPUT"
  if [[ "$BREAKING_INPUT" == "true" ]]; then
    DIST_TAG="breaking-edge"
    IS_PRERELEASE="true"
  else
    DIST_TAG="latest"
    IS_PRERELEASE="false"
  fi
else
  # Push to main (default): edge release with date-based version
  DATE=$(date -u '+%Y.%m.%d')
  # Zero-pad BUILD to 3 digits minimum (e.g. 001, 015, 142).
  # Without padding, going from commit 9 to 10 on the same day produces
  # "2026.08.23-9-..." < "2026.08.23-10-..." in lexicographic order (9 > 1),
  # which breaks "is this version newer?" comparisons in npm and GitLab UI.
  BUILD=$(printf '%03d' "$(git -C "$REPO_ROOT" rev-list --count HEAD)")
  SHA=$(git -C "$REPO_ROOT" rev-parse --short=8 HEAD)
  VERSION="${DATE}-${BUILD}-${SHA}"
  DIST_TAG="latest"
  IS_PRERELEASE="true"
fi

TAG="v${VERSION}"

OUT="${GITHUB_OUTPUT:-/dev/stdout}"
echo "version=${VERSION}"             >> "$OUT"
echo "dist_tag=${DIST_TAG}"           >> "$OUT"
echo "is_prerelease=${IS_PRERELEASE}" >> "$OUT"
echo "tag=${TAG}"                     >> "$OUT"

echo "Computed: version=${VERSION} dist_tag=${DIST_TAG} tag=${TAG}" >&2
