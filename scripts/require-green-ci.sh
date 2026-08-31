#!/usr/bin/env bash
# Refuses to let a release publish unless the CI workflow succeeded for the exact commit being
# released. Takes the tag (or any ref) that is about to be published and resolves it to its commit
# itself, because that commit -- not the tip of the default branch -- is what the publishing jobs
# check out and build.
#
# A CI run still in flight is waited for rather than guessed at. A missing run is a failure: an
# absent result is not a passing one.
#
# Reads GITHUB_REPOSITORY and needs GH_TOKEN with `actions: read` and `contents: read`.
set -euo pipefail

ref="${1:?usage: require-green-ci.sh <tag-or-commit>}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY must be set}"

sha=$(gh api "repos/$GITHUB_REPOSITORY/commits/$ref" --jq .sha)
echo "Released commit: $sha"

# The CI workflow's runs for exactly that commit, newest last. Restricted to push events, because
# that is what a commit on the default branch produces; a pull request's run belongs to a merge
# reference, which is a different tree.
#
# Only the two scalars are carried out of jq. Commit subjects reach this response and re-parsing a
# JSON blob through a shell variable trips over the control characters some of them contain.
run=$(gh api \
  "repos/$GITHUB_REPOSITORY/actions/workflows/ci.yml/runs?head_sha=$sha&per_page=100" \
  --jq '[.workflow_runs[] | select(.event == "push")]
        | sort_by(.run_number) | last | select(. != null)
        | "\(.id) \(.html_url)"')

if [ -z "$run" ]; then
  echo "::error::No CI run exists for $sha. A missing result is not a passing one, so this" \
    "release does not publish. Run the CI workflow for that commit and try again."
  exit 1
fi

# The newest run wins: a re-run after a fixed infrastructure failure is the answer that counts,
# and an older attempt for the same commit is history.
id=${run%% *}
echo "CI run: ${run#* }"

# Blocks until that run finishes and exits non-zero unless it succeeded. `-R` because the calling
# job checks out nothing, so there is no repository for the CLI to infer.
gh run watch "$id" -R "$GITHUB_REPOSITORY" --exit-status --interval 30 >/dev/null

conclusion=$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$id" --jq .conclusion)
if [ "$conclusion" != "success" ]; then
  echo "::error::CI for $sha concluded '$conclusion'. Nothing is published from a tree whose CI" \
    "did not pass."
  exit 1
fi
echo "CI succeeded for $sha -- the release may publish."
