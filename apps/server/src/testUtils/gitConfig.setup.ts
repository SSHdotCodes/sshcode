// Pins git behaviour for every repository the suite creates, ahead of the
// host's ~/.gitconfig. Git for Windows installs with core.autocrlf=true,
// which checks committed LF files out as CRLF and breaks every byte-exact
// content assertion; a signing key or a non-default init branch on the
// developer's machine breaks fixtures the same way. Set as environment so
// each git child the driver spawns sees it without touching the fixtures.
const entries: ReadonlyArray<readonly [key: string, value: string]> = [
  ["core.autocrlf", "false"],
  ["core.filemode", "false"],
  ["core.longpaths", "true"],
  ["commit.gpgsign", "false"],
  ["tag.gpgsign", "false"],
  ["init.defaultBranch", "main"],
];

const existing = Number(process.env.GIT_CONFIG_COUNT ?? "0");
process.env.GIT_CONFIG_COUNT = String(existing + entries.length);
entries.forEach(([key, value], index) => {
  process.env[`GIT_CONFIG_KEY_${existing + index}`] = key;
  process.env[`GIT_CONFIG_VALUE_${existing + index}`] = value;
});

// `git bisect run`, hooks and `git rebase -x` export the outer repository's location. A
// test's git child then acts on that repository instead of its own temp one: during a
// bisect in a linked worktree this rewrote the real checkout's shared core.worktree.
for (const key of [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
]) {
  delete process.env[key];
}
