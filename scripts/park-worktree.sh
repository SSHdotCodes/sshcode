#!/bin/zsh
# Compatibility entry point for retiring a finished checkout.
# The server now prepares its own clean spares after worktree delegation.
REPO=${1:?usage: park-worktree.sh <repo checkout> <worktree>}
WT=${2:?usage: park-worktree.sh <repo checkout> <worktree>}
git -C "$REPO" worktree remove --force -- "${WT:A}"
