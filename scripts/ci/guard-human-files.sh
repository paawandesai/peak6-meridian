#!/usr/bin/env bash
# CI guard (MR pipelines): fail when the merge request changes a human-owned file and does not
# carry the `human-approved` label. Adding the label does not re-run the pipeline; re-run it.
#
# Inputs (GitLab predefined variables): CI_MERGE_REQUEST_DIFF_BASE_SHA, CI_COMMIT_SHA,
# CI_MERGE_REQUEST_LABELS (comma-separated, may be empty).
set -euo pipefail

readonly APPROVAL_LABEL="human-approved"
readonly HUMAN_OWNED=(
  docs/brief.md
  docs/requirements.md
  docs/threat-model.md
  docs/plan.md
  docs/operating-rules.md
)

base="${CI_MERGE_REQUEST_DIFF_BASE_SHA:?CI_MERGE_REQUEST_DIFF_BASE_SHA is not set (not a merge request pipeline?)}"
head="${CI_COMMIT_SHA:?CI_COMMIT_SHA is not set}"
labels="${CI_MERGE_REQUEST_LABELS:-}"

# --no-renames: a rename shows up as a delete plus an add, so moving a protected file is caught.
changed="$(git diff --name-only --no-renames "$base" "$head")"

touched=()
for file in "${HUMAN_OWNED[@]}"; do
  if grep -qxF -- "$file" <<< "$changed"; then
    touched+=("$file")
  fi
done

if [ "${#touched[@]}" -eq 0 ]; then
  echo "guard-human-files: OK, no human-owned file changed."
  exit 0
fi

if [[ ",$labels," == *",$APPROVAL_LABEL,"* ]]; then
  echo "guard-human-files: OK, human-owned files changed with the '$APPROVAL_LABEL' label:"
  printf '  %s\n' "${touched[@]}"
  exit 0
fi

echo "guard-human-files: FAILED." >&2
for file in "${touched[@]}"; do
  echo "  $file is human-owned (CLAUDE.md § Never) and this merge request changes it." >&2
done
echo "Why: human-owned files may only change in a merge request labelled '$APPROVAL_LABEL'" >&2
echo "(labels on this merge request: '${labels:-none}'). Revert the change, or have the human add" >&2
echo "the label and re-run this pipeline." >&2
exit 1
