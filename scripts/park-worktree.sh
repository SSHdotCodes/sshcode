#!/bin/zsh
# Parks a finished app-made worktree for the next new worktree of the repo to reuse, instead of
# deleting it: park-worktree.sh <repo checkout> <worktree>
# Same contract as GitVcsDriverCore's parkWorktree: detached, cleaned of everything but
# node_modules (kept only when t3.json reinstalls packages on worktree creation), moved into
# `.parked` beside it, at most two per repo, none older than seven days. Deleting a worktree
# churns every file it holds, and macOS's fseventsd keeps memory for each file event until it
# restarts. Worktrees outside ~/.t3/worktrees, or with under 10 GB free, are deleted as before.
REPO=${1:?usage: park-worktree.sh <repo checkout> <worktree>}
WT=${2:?usage: park-worktree.sh <repo checkout> <worktree>}
WT=${WT:A}
ROOT=${T3_WORKTREES_DIR:-$HOME/.t3/worktrees}
remove() { git -C "$REPO" worktree remove --force "$WT" && echo "REMOVED $WT ($1)"; }
[ -e "$WT/.git" ] || { echo "not a worktree: $WT"; exit 1; }
case $WT in
  $ROOT/*/.parked/*) echo "already parked: $WT"; exit 0 ;;
  $ROOT/*) ;;
  *) remove "outside $ROOT"; exit $? ;;
esac
free_kb=$(df -k "${WT:h}" | awk 'NR==2 {print $4}')
(( free_kb >= 10 * 1024 * 1024 )) || { remove "under 10 GB free"; exit $?; }

PARK=${WT:h}/.parked
now=$(date +%s)
# Keep the newest parked worktree from the last seven days; delete the rest.
parked=("${(@f)$(git -C "$REPO" worktree list --porcelain | sed -n 's/^worktree //p' | /usr/bin/grep -F "$PARK/")}")
kept=0
for p in ${(f)"$(for q in $parked; do [ -n "$q" ] && echo "$(stat -f %m "$q" 2>/dev/null || echo 0) $q"; done | sort -rn)"}; do
  t=${p%% *}; q=${p#* }
  if (( kept < 1 && now - t <= 7 * 86400 )); then kept=$((kept + 1)); continue; fi
  git -C "$REPO" worktree remove --force "$q" >/dev/null 2>&1 && echo "EVICTED $q"
done

keep=()
/usr/bin/grep -Eq '"runOnWorktreeCreate"[[:space:]]*:[[:space:]]*true' "$WT/t3.json" 2>/dev/null && keep=(-e node_modules)
git -C "$WT" checkout -q -f --detach && git -C "$WT" clean -q -ffdx $keep || { remove "could not clean it"; exit $?; }
mkdir -p "$PARK"
TARGET=$PARK/${WT:t}-$now
git -C "$REPO" worktree move "$WT" "$TARGET" || { remove "git refused to move it"; exit $?; }
touch "$TARGET"
echo "PARKED $TARGET"
