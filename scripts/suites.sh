#!/bin/zsh
# Typechecks and tests each package from its own directory with its own scripts (root runs miss
# package configs: web's wasm plugin, cursor's globals). Exits 1 when any check fails, times out
# or cannot run. A test file that fails once and passes when run again is logged as FLAKY.
#   scripts/suites.sh LOG [pkg ...]   (default: every package under packages/ plus the four shipped apps)
# Runs the checkout this script is in; SSHCODE_ROOT=<checkout> runs another one.
LOG=${1:-/tmp/sshcode-suites.log}; (( $# )) && shift
ROOT=${SSHCODE_ROOT:-${0:A:h:h}}
# macOS's default temp folder (/var/folders/…) is a symlink; a few server tests compare real
# paths and fail there (monitors and plain terminals start with it).
export TMPDIR=/private/tmp
cd $ROOT || exit 1
if (( $# )); then PKGS=("$@"); else PKGS=(packages/*(/) apps/web apps/mobile apps/desktop apps/server); fi
: > $LOG; failed=0
has() { jq -e --arg s $2 '.scripts[$s] != null' $1/package.json >/dev/null 2>&1; }
for p in $PKGS; do
  if [ ! -f $p/package.json ]; then echo "TC $p: FAIL no package.json" >> $LOG; failed=1; continue; fi
  has $p typecheck || { echo "TC $p: no typecheck script" >> $LOG; continue; }
  out=$(cd $p && timeout 900 pnpm run typecheck 2>&1); rc=$?
  if [ $rc -eq 0 ]; then echo "TC $p: ok" >> $LOG; continue; fi
  echo "TC $p: FAIL exit $rc" >> $LOG; failed=1
  errors=$(print -r -- "$out" | grep -E "error TS" | head -5)
  print -r -- "${errors:-$(print -r -- "$out" | tail -5)}" >> $LOG
done
# run_tests PKG [FILE ...]: leaves the output (colour codes removed) in $out and the exit code in $rc.
run_tests() {
  local p=$1; shift
  # apps/server's whole suite can outlast one run's limit on a busy Mac (11-21, twice at 40 min,
  # while eight 15-minute shards all passed), so a whole-suite server run goes in shards.
  local shards=1
  [ $p = apps/server ] && (( $# == 0 )) && shards=8
  : > $LOG.out; rc=0
  for i in $(seq 1 $shards); do
    local args=("$@"); (( shards > 1 )) && args=(--shard=$i/$shards)
    # timeout leads its own process group (and kills a run that ignores its TERM after 30 s);
    # whatever the tests leave in that group is this run's to stop: ask, then make sure.
    (cd $p && NO_COLOR=1 exec timeout --kill-after=30 $(( shards > 1 ? 1200 : 2400 )) pnpm run test $args) >> $LOG.out 2>&1 &
    local pid=$!; wait $pid; local r=$?
    if kill -0 -- -$pid 2>/dev/null; then
      kill -TERM -- -$pid 2>/dev/null; sleep 2; kill -KILL -- -$pid 2>/dev/null
    fi
    # A timed-out shard wins (its files never reported); otherwise the first failure's code.
    if [ $r -eq 124 ]; then rc=124; elif [ $r -ne 0 ] && [ $rc -eq 0 ]; then rc=$r; fi
  done
  out=$(sed -E $'s/\x1b\\[[0-9;]*[a-zA-Z]//g' $LOG.out); rm -f $LOG.out
}
summary() { print -r -- "$out" | grep -E "^ FAIL |Test Files  |Tests  " | sort -u | head -30 >> $LOG; }
for p in $PKGS; do
  [ -f $p/package.json ] && has $p test || continue
  echo "=== $p" >> $LOG
  run_tests $p; summary
  [ $rc -eq 0 ] && continue
  # Tests that time out under load fail a full run. Up to ten failing files run once more on
  # their own: all passing is FLAKY (logged, not a failure), anything else fails with its output.
  files=(${(f)"$(print -r -- "$out" | grep -E '^ FAIL ' | grep -oE '[^ |]+\.(test|spec)\.[cm]?[jt]sx?' | sort -u)"})
  if [ $rc -ne 124 ] && (( $#files >= 1 && $#files <= 10 )); then
    run_tests $p $files
    if [ $rc -eq 0 ]; then echo "FLAKY $p: passed when run again: $files" >> $LOG; continue; fi
    echo "--- run again: $files" >> $LOG; summary
    print -r -- "$out" | sed -n '/Failed Tests/,$p' | grep -vE '^[[:space:]]*$' | head -60 >> $LOG
  fi
  echo "FAIL $p exit $rc$( [ $rc -eq 124 ] && echo ' (timed out)')" >> $LOG; failed=1
  print -r -- "$out" | grep -qE "Tests  " || print -r -- "$out" | tail -8 >> $LOG
done
[ $failed -eq 0 ] && echo "SUITES_OK" >> $LOG || echo "SUITES_FAILED" >> $LOG
exit $failed
