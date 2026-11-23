import { describe, expect, it } from "@effect/vitest";

import { monitorBufferingProblem } from "./monitorCommandBuffering.ts";

describe("monitorBufferingProblem", () => {
  it("rejects the DSpine watcher that missed a crash for 7 hours", () => {
    const problem = monitorBufferingProblem(
      "ssh -o ServerAliveInterval=30 workstation 'journalctl --user -u ai-dspine-abc-recipe.service -f -n 0 --no-pager -o cat' | grep --line-buffered -E 'paired_evaluation|branch_(finished|failed)|Traceback|Error|error|OOM|exit|complete|refus' | cut -c1-900",
    );
    expect(problem).toContain("`cut -c1-900`");
    expect(problem).toContain("awk '{ print substr($0, 1, N); fflush() }'");
  });

  it.each([
    ["tail -f app.log | grep error", "--line-buffered"],
    ["tail -n0 -F app.log | sed 's/^/x: /'", "-u"],
    ["journalctl -fu web.service | awk '{ print $5 }'", "fflush()"],
    ["kubectl logs -f pod/api | cut -d' ' -f2", "awk"],
    ["docker compose logs --follow api | tr a-z A-Z", "awk"],
    ["tail -f events.jsonl | jq .type", "--unbuffered"],
    ["tail -f app.log | sort", "drop it"],
    ["while true; do date; sleep 5; done | cut -c1-10", "awk"],
    ["while sleep 30; do curl -s localhost:3000/health; done | grep -v ok", "--line-buffered"],
    ["tail -f a.log | /usr/bin/grep -E 'a|b'", "--line-buffered"],
    ["tail -f a.log | env LC_ALL=C grep x", "--line-buffered"],
    ["ssh host 'tail -f /var/log/app.log | cut -c1-80'", "awk"],
    ["timeout 3600 ssh host 'journalctl -f' | grep x", "--line-buffered"],
    ["bash -c 'tail -F out.log | grep done'", "--line-buffered"],
    ["tail -f app.log | grep --line-buffered x | cut -c1-200", "awk"],
    // Review round 1: pipelines the first version missed.
    ["(tail -f app.log | cut -c1-100)", "awk"],
    ["{ tail -f app.log | cut -c1-100; }", "awk"],
    ["bash -c 'tail -f app.log | cut -c1-100' 'watcher'", "awk"],
    ["tail -f app.log | timeout --signal=TERM 3600 cut -c1-900", "awk"],
    ["tail -f app.log | grep -m100 ERROR", "earlier matches wait"],
    ["tail -f app.log | gsed -l 80 's/foo/bar/'", "-u"],
    ["tail -f app.log | sed -l 80 's/foo/bar/'", "-u"],
    ["tail -f app.log | xargs echo", "-L1"],
    ["nvidia-smi dmon -s u | grep -v '#'", "--line-buffered"],
    ["nvidia-smi --query-gpu=utilization.gpu --format=csv -l 5 | cut -d, -f1", "awk"],
    ["while true; do tail -f app.log | cut -c1-80; done", "awk"],
    ["ssh -t host 'tail -f app.log | cut -c1-80'", "awk"],
    // Review round 2: filters inside a downstream group or shell.
    ["tail -f app.log | (cut -c1-80)", "awk"],
    ["tail -f app.log | { cut -c1-80; }", "awk"],
    ["tail -f app.log | bash -c 'cut -c1-80'", "awk"],
    ["docker logs --follow=true api | grep error", "--line-buffered"],
  ])("flags %s", (command, fix) => {
    expect(monitorBufferingProblem(command)).toContain(fix);
  });

  it.each([
    // Every filter after the stream is line-buffered.
    "tail -f app.log | grep --line-buffered error",
    "tail -n0 -F app.log | sed -u 's/^/x: /'",
    "tail -f app.log | sed -l 's/a/b/'",
    "journalctl -f | awk '{ print; fflush() }'",
    "tail -f events.jsonl | jq --unbuffered .type",
    "tail -f a.log | grep -E 'a|b' --line-buffered",
    "ssh host 'journalctl -f' | grep --line-buffered x | awk '{ print substr($0, 1, 900); fflush() }'",
    // Filters that exit on their first match flush as they exit.
    "tail -f app.log | grep -q ready",
    "tail -f app.log | grep -m1 ready",
    "tail -f app.log | head -1",
    // Shell loops and passthroughs write unbuffered.
    'tail -f app.log | while read -r line; do echo "$line"; done',
    "tail -f app.log | tee copy.log",
    // No never-ending source: buffered output arrives when the command ends.
    "sleep 60; ls | cut -c1-5",
    "make test 2>&1 | tail -5",
    "until curl -sf localhost:3000; do sleep 5; done; echo ready",
    "tail -f x || echo failed",
    // Pipes inside a loop body, $( ), or quotes are not the monitor's output pipe.
    "while true; do curl -s x | grep -q ok && echo up; sleep 5; done",
    `last=""; while true; do out=$(timeout 60 ssh -o ConnectTimeout=20 workstation 'st=$(systemctl --user is-active ai-dspine-recipe-r2a.service); echo "STATE $st"; journalctl --user -u ai-dspine-recipe-r2a.service --no-pager -o cat | grep -E "latest_evaluations|branch_finished|Traceback|RuntimeError|OOM" | tail -1 | cut -c1-1500' 2>/dev/null); [ -n "$out" ] && [ "$out" != "$last" ] && { echo "$out" | tr '\\n' ' '; echo; last="$out"; }; sleep 120; done`,
    "echo 'tail -f x | cut -c1-5'",
    "tail -n 5 app.log | cut -c1-80",
    "journalctl --no-pager -n 50 | cut -c1-80",
    "bash scripts/train_watch.sh",
    "python3 watch.py | cut -c1-200",
    // Review round 1: valid monitors the first version rejected.
    "while sleep 5; do kill -0 1234 2>/dev/null || break; done; echo finished | cut -c1-80",
    "while true; do grep done app.log | cut -c1-80; sleep 5; done",
    "while true; do case failed in running) :;; failed) echo failed | cut -c1-80;; esac; sleep 5; done",
    "tail -f app.log | head -n1 | cut -c1-200",
    "tail -f app.log | grep -m1 ready | cut -c1-200",
    "ps aux | grep 'tail -f' | awk '{print $2}'",
    "ssh -tt host 'tail -f app.log | cut -c1-80'",
    "tail -f app.log | xargs -L1 echo",
    "tail -f app.log | stdbuf -oL cut -c1-80",
    "tail -f app.log 2>&1 | grep --line-buffered x",
    "tail -f app.log &>/dev/null; echo done | cut -c1-4",
    "python3 - <<'PY'\nimport subprocess\nsubprocess.run('tail -f x | cut -c1-5', shell=True)\nPY\necho ok | cut -c1-2",
    "watch_job() { tail -f app.log | cut -c1-80; }",
    "if tail -n 1 app.log | grep -q done; then echo done | cut -c1-4; fi",
    'for f in *.log; do tail -n 1 "$f" | cut -c1-80; done',
    // Review round 2: valid monitors the parser version flagged.
    "docker compose -f compose.yml logs --tail 100 api | cut -c1-80",
    "docker logs --follow=false --tail 100 api | grep error",
    "while true; do case ready in ready) echo ready; break;; esac; done | cut -c1-80",
    "while true; do echo ready; command break; done | cut -c1-80",
    "function watch_job {\n  tail -f app.log | cut -c1-80\n}\necho ready",
    "function watch_job() { tail -f app.log | cut -c1-80; }; echo ready",
    "cat <<'EOF'\ntail -f app.log | cut -c1-80\nEOF",
    'cat <<"EOF"\ntail -f app.log | cut -c1-80\nEOF',
    'out=$(printf \'%s\' ") | tail -f app.log | cut -c1-80"); echo "$out"',
    "ssh -o RequestTTY=force host 'tail -f app.log | cut -c1-80'",
    "tail -f app.log | (head -n1) | cut -c1-80",
    "tail -f app.log | { head -n1; } | cut -c1-80",
    "tail -f app.log | bash -c 'head -n1' | cut -c1-80",
    "tail -f app.log | awk '/ready/ {print; exit}'",
    "tail -f app.log | sed -n '/ready/{p;q;}'",
    "tail -f app.log | perl -MIO::Handle -ne 'STDOUT->autoflush(1); print'",
    "nvidia-smi dmon -c 1 | cut -c1-80",
    "fswatch --one-event /tmp/status | cut -c1-80",
    '(tail -f /dev/null > /dev/null & pid=$!; echo ready; kill "$pid"; wait "$pid" || :) | cut -c1-80',
  ])("accepts %s", (command) => {
    expect(monitorBufferingProblem(command)).toBeUndefined();
  });

  it("stays fast on adversarial input", () => {
    const started = performance.now();
    monitorBufferingProblem(`echo ${"tail ".repeat(1600)}-${"f".repeat(1600)}!`);
    monitorBufferingProblem(`tail -f x | ${"( ".repeat(5000)}cut`);
    monitorBufferingProblem(`${"'".repeat(20001)} | cut`);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
