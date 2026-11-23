// A chat on the user's second account of a provider runs with that account's
// folder in its environment. Started from such a chat, the suite would hand
// the folder on to every adapter it builds, and fixtures that describe the
// default login (the Claude sign-in hint names the folder it was given) would
// fail on that machine only. Tests that need one of these set it themselves.
for (const name of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "GROK_HOME"]) {
  delete process.env[name];
}
