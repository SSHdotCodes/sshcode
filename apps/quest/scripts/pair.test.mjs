import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import * as NodeURL from "node:url";
const script = NodeURL.fileURLToPath(new URL("./pair.mjs", import.meta.url));
NodeTest.test("pair helper passes a quoted URL to adb without echoing its secret", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "quest-pair-test-"));
  try {
    const adb = NodePath.join(directory, "adb");
    const args = NodePath.join(directory, "args.json");
    NodeFS.writeFileSync(
      adb,
      `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(args)}, JSON.stringify(process.argv.slice(2))); console.log('Intent URL intentionally suppressed');\n`,
      { mode: 0o700 },
    );
    const url = "http://localhost:3997/pair#token=synthetic'test&x=one";
    const result = NodeChildProcess.spawnSync(process.execPath, [script], {
      env: { ...process.env, ADB: adb },
      input: JSON.stringify({ pairUrl: url }),
      encoding: "utf8",
    });
    NodeAssert.equal(result.status, 0);
    NodeAssert.equal(`${result.stdout}${result.stderr}`.includes(url), false);
    const received = JSON.parse(NodeFS.readFileSync(args, "utf8"));
    NodeAssert.equal(
      received[received.indexOf("-d") + 1],
      "'" + url.replaceAll("'", "'\\''") + "'",
    );
    NodeAssert.equal(received.includes("com.example.sshcode.quest/.MainActivity"), true);
  } finally {
    NodeFS.rmSync(directory, { recursive: true });
  }
});
NodeTest.test("malformed JSON never leaks its input", () => {
  const secret = "synthetic-secret-never-echo";
  const result = NodeChildProcess.spawnSync(process.execPath, [script], {
    input: `{"pairUrl":"${secret}`,
    encoding: "utf8",
  });
  NodeAssert.equal(result.status, 1);
  NodeAssert.equal(`${result.stdout}${result.stderr}`.includes(secret), false);
});
