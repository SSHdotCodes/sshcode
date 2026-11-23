/**
 * A monitor reads its command's stdout through a pipe, so every filter after a
 * never-ending source block-buffers: cut, plain grep/sed/awk and friends hold
 * lines until their buffer fills or the stream ends. Fed by `journalctl -f`,
 * `tail -f` or a `while true` loop, that is never, and the monitor stays silent
 * while the job it watches fails (a DSpine watcher ending in `| cut -c1-900`
 * missed a crash for 7 hours this way).
 *
 * The check parses the command as shell (lists, pipelines, subshells, loops,
 * `case`, functions, heredocs, and the script inside `ssh host '…'` or
 * `bash -c '…'`) and flags known filters downstream of a known never-ending
 * command. Shell is too flexible to judge with certainty, so callers warn
 * rather than refuse: a wrong guess costs a note, not a monitor.
 */

/** Longer commands are not checked. */
const MAX_COMMAND_LENGTH = 50_000;
const MAX_NESTING = 3;
const MAX_PARSE_DEPTH = 64;

interface Token {
  readonly kind: "word" | "op";
  readonly value: string;
  readonly quoted: boolean;
  readonly start: number;
  readonly end: number;
}

/** Index just past a double-quoted string that starts at `open`. */
function skipDoubleQuoted(src: string, open: number): number {
  let index = open + 1;
  while (index < src.length && src[index] !== '"') index += src[index] === "\\" ? 2 : 1;
  return index + 1;
}

/** Index just past the `)` matching the `(` at `open`, skipping quoted text. */
function skipBalanced(src: string, open: number): number {
  let depth = 0;
  let index = open;
  while (index < src.length) {
    const char = src[index]!;
    if (char === "'") {
      const close = src.indexOf("'", index + 1);
      index = close < 0 ? src.length : close + 1;
      continue;
    }
    if (char === '"') {
      index = skipDoubleQuoted(src, index);
      continue;
    }
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
    index += 1;
  }
  return src.length;
}

/** Index just past the heredoc bodies that start at `index`. */
function skipHeredocs(src: string, index: number, delimiters: ReadonlyArray<string>): number {
  let cursor = index;
  for (const delimiter of delimiters) {
    while (cursor < src.length) {
      const newline = src.indexOf("\n", cursor);
      const end = newline < 0 ? src.length : newline;
      const line = src.slice(cursor, end);
      cursor = end + 1;
      if (line.replace(/^\t+/, "").trimEnd() === delimiter) break;
    }
  }
  return Math.min(cursor, src.length);
}

function tokenize(src: string): ReadonlyArray<Token> {
  const tokens: Array<Token> = [];
  let index = 0;
  let heredocs: Array<string> = [];
  let heredocNext = false;
  const op = (value: string) => {
    tokens.push({ kind: "op", value, quoted: false, start: index, end: index + value.length });
    index += value.length;
  };
  while (index < src.length) {
    const char = src[index]!;
    if (char === " " || char === "\t" || char === "\r") {
      index += 1;
      continue;
    }
    if (char === "\\" && src[index + 1] === "\n") {
      index += 2;
      continue;
    }
    if (char === "\n") {
      op("\n");
      if (heredocs.length > 0) {
        index = skipHeredocs(src, index, heredocs);
        heredocs = [];
      }
      continue;
    }
    if (char === "#") {
      while (index < src.length && src[index] !== "\n") index += 1;
      continue;
    }
    const pair = src.slice(index, index + 2);
    if (pair === "||" || pair === "&&" || pair === "|&" || pair === ";;") {
      op(pair);
      continue;
    }
    // `&>file` redirects; it does not end the command.
    const redirect = char === "&" && src[index + 1] === ">";
    if (!redirect && "|;&()".includes(char)) {
      op(char);
      continue;
    }
    const start = index;
    let value = "";
    let quoted = false;
    while (index < src.length) {
      const ch = src[index]!;
      if (ch === "'") {
        quoted = true;
        const close = src.indexOf("'", index + 1);
        const end = close < 0 ? src.length : close;
        value += src.slice(index + 1, end);
        index = end + 1;
        continue;
      }
      if (ch === '"') {
        quoted = true;
        index += 1;
        while (index < src.length && src[index] !== '"') {
          if (src[index] === "\\" && index + 1 < src.length) {
            value += src[index + 1];
            index += 2;
          } else if (src[index] === "$" && src[index + 1] === "(") {
            const end = skipBalanced(src, index + 1);
            value += src.slice(index, end);
            index = end;
          } else {
            value += src[index];
            index += 1;
          }
        }
        index += 1;
        continue;
      }
      if (ch === "\\" && index + 1 < src.length) {
        value += src[index + 1];
        index += 2;
        continue;
      }
      if (ch === "$" && src[index + 1] === "(") {
        const end = skipBalanced(src, index + 1);
        value += src.slice(index, end);
        index = end;
        continue;
      }
      if (ch === "`") {
        const close = src.indexOf("`", index + 1);
        const end = close < 0 ? src.length : close + 1;
        value += src.slice(index, end);
        index = end;
        continue;
      }
      if (ch === "<" || ch === ">" || (ch === "&" && index === start)) {
        value += ch;
        index += 1;
        if (src[index] === "&") {
          value += "&";
          index += 1;
        }
        continue;
      }
      if (" \t\r\n|;&()".includes(ch)) break;
      value += ch;
      index += 1;
    }
    tokens.push({ kind: "word", value, quoted, start, end: index });
    const raw = src.slice(start, index);
    if (heredocNext) {
      heredocs.push(value);
      heredocNext = false;
    } else if (raw.startsWith("<<") && !raw.startsWith("<<<")) {
      const delimiter = value.replace(/^<<-?/, "");
      if (delimiter.length > 0) heredocs.push(delimiter);
      else heredocNext = true;
    }
  }
  return tokens;
}

type Command =
  | { readonly kind: "simple"; readonly words: ReadonlyArray<string>; readonly text: string }
  | { readonly kind: "list"; readonly body: List; readonly text: string }
  | {
      readonly kind: "loop";
      readonly until: boolean;
      readonly condition: List;
      readonly body: List;
      readonly text: string;
    }
  | { readonly kind: "opaque"; readonly text: string };

interface List {
  readonly pipelines: ReadonlyArray<ReadonlyArray<Command>>;
}

const SEPARATORS = new Set([";", "&", "&&", "||", "\n", ";;"]);
const NO_STOPS: ReadonlySet<string> = new Set();

/** A tolerant shell parser: malformed input still yields a best-effort tree. */
function parse(src: string): List {
  const tokens = tokenize(src);
  let pos = 0;
  let depth = 0;
  const peek = (): Token | undefined => tokens[pos];
  const isOp = (token: Token | undefined, value: string) =>
    token?.kind === "op" && token.value === value;
  const isWord = (token: Token | undefined, value: string) =>
    token?.kind === "word" && !token.quoted && token.value === value;
  const textFrom = (first: number) =>
    first < tokens.length && pos > first
      ? src.slice(tokens[first]!.start, tokens[pos - 1]!.end)
      : "";
  const consumeWord = (value: string) => {
    if (isWord(peek(), value)) pos += 1;
  };
  const skipNewlines = () => {
    while (isOp(peek(), "\n")) pos += 1;
  };

  const parseList = (stops: ReadonlySet<string>, closeParen: boolean): List => {
    const pipelines: Array<ReadonlyArray<Command>> = [];
    while (pos < tokens.length) {
      const token = peek()!;
      if (token.kind === "op" && SEPARATORS.has(token.value)) {
        pos += 1;
        continue;
      }
      if (isOp(token, ")")) {
        if (closeParen) break;
        pos += 1;
        continue;
      }
      if (token.kind === "word" && !token.quoted && stops.has(token.value)) break;
      const before = pos;
      const pipeline = parsePipeline(stops);
      if (pipeline.length > 0) pipelines.push(pipeline);
      if (pos === before) pos += 1;
    }
    return { pipelines };
  };

  const parsePipeline = (stops: ReadonlySet<string>): ReadonlyArray<Command> => {
    const commands: Array<Command> = [];
    const first = parseCommand(stops);
    if (first === undefined) return commands;
    commands.push(first);
    while (isOp(peek(), "|") || isOp(peek(), "|&")) {
      pos += 1;
      skipNewlines();
      const next = parseCommand(stops);
      if (next === undefined) break;
      commands.push(next);
    }
    return commands;
  };

  /** A function body is defined here, not run, so it never feeds the pipe. */
  const parseFunctionBody = (first: number): Command => {
    skipNewlines();
    parseCommand(NO_STOPS);
    return { kind: "opaque", text: textFrom(first) };
  };

  const parseCompound = (keyword: string, first: number): Command | undefined => {
    switch (keyword) {
      case "{": {
        pos += 1;
        const body = parseList(new Set(["}"]), false);
        consumeWord("}");
        return { kind: "list", body, text: textFrom(first) };
      }
      case "while":
      case "until": {
        pos += 1;
        const condition = parseList(new Set(["do"]), false);
        consumeWord("do");
        const body = parseList(new Set(["done"]), false);
        consumeWord("done");
        return {
          kind: "loop",
          until: keyword === "until",
          condition,
          body,
          text: textFrom(first),
        };
      }
      case "for":
      case "select": {
        pos += 1;
        while (pos < tokens.length && !isWord(peek(), "do")) pos += 1;
        consumeWord("do");
        const body = parseList(new Set(["done"]), false);
        consumeWord("done");
        return { kind: "list", body, text: textFrom(first) };
      }
      case "if": {
        pos += 1;
        const parts: Array<List> = [];
        while (pos < tokens.length) {
          parts.push(parseList(new Set(["then", "elif", "else", "fi"]), false));
          const next = peek();
          if (isWord(next, "fi")) {
            pos += 1;
            break;
          }
          if (isWord(next, "then") || isWord(next, "elif") || isWord(next, "else")) {
            pos += 1;
            continue;
          }
          break;
        }
        return {
          kind: "list",
          body: { pipelines: parts.flatMap((part) => part.pipelines) },
          text: textFrom(first),
        };
      }
      case "case": {
        // Patterns end in `)`, so the whole statement stays opaque.
        pos += 1;
        let open = 1;
        while (pos < tokens.length && open > 0) {
          const next = tokens[pos]!;
          pos += 1;
          if (isWord(next, "case")) open += 1;
          else if (isWord(next, "esac")) open -= 1;
        }
        return { kind: "opaque", text: textFrom(first) };
      }
      case "function": {
        pos += 2;
        if (isOp(peek(), "(") && isOp(tokens[pos + 1], ")")) pos += 2;
        return parseFunctionBody(first);
      }
      default:
        return undefined;
    }
  };

  const parseCommand = (stops: ReadonlySet<string>): Command | undefined => {
    const first = pos;
    const token = peek();
    if (token === undefined) return undefined;
    if (depth > MAX_PARSE_DEPTH) {
      pos = tokens.length;
      return { kind: "opaque", text: src.slice(token.start) };
    }
    depth += 1;
    try {
      if (isOp(token, "(")) {
        pos += 1;
        const body = parseList(NO_STOPS, true);
        if (isOp(peek(), ")")) pos += 1;
        return { kind: "list", body, text: textFrom(first) };
      }
      if (token.kind === "word" && !token.quoted) {
        if (token.value === "!") {
          pos += 1;
          return parseCommand(stops);
        }
        const compound = parseCompound(token.value, first);
        if (compound !== undefined) return compound;
      }
      const words: Array<string> = [];
      while (pos < tokens.length) {
        const next = peek()!;
        if (next.kind === "op") {
          if (next.value === "(" && words.length === 1 && isOp(tokens[pos + 1], ")")) {
            pos += 2;
            return parseFunctionBody(first);
          }
          if (next.value === "(") pos = tokens.length;
          break;
        }
        if (words.length === 0 && !next.quoted && stops.has(next.value)) break;
        words.push(next.value);
        pos += 1;
      }
      return words.length === 0 ? undefined : { kind: "simple", words, text: textFrom(first) };
    } finally {
      depth -= 1;
    }
  };

  return parseList(NO_STOPS, false);
}

const basename = (word: string) => word.slice(word.lastIndexOf("/") + 1);

/** Short option clusters like `fn` from `-fn` (not `--long` options). */
const shortClusters = (args: ReadonlyArray<string>) =>
  args.filter((word) => /^-[A-Za-z0-9]+$/.test(word)).map((word) => word.slice(1));

const hasShortFlag = (args: ReadonlyArray<string>, letter: string) =>
  shortClusters(args).some((cluster) => cluster.includes(letter));

const hasLongFlag = (args: ReadonlyArray<string>, flag: string) =>
  args.some((word) => word === flag || word.startsWith(`${flag}=`));

/** `-f`, `--follow` or `--follow=<anything but false>`. */
const follows = (args: ReadonlyArray<string>) =>
  hasShortFlag(args, "f") ||
  args.some(
    (word) =>
      word === "--follow" ||
      (word.startsWith("--follow=") && !/^--follow=(false|0|no)$/i.test(word)),
  );

/** Sends its stdout somewhere other than the pipe (`>file`, `&>/dev/null`, `>&2`). */
const redirectsStdout = (words: ReadonlyArray<string>) =>
  words.some((word) => /^(?:1?>|&>)/.test(word));

interface Invocation {
  readonly name: string;
  readonly args: ReadonlyArray<string>;
  /** `stdbuf -oL`, `unbuffer` and similar already make the output stream. */
  readonly lineBuffered: boolean;
}

/** The command a simple command runs, past assignments and wrappers. */
function invocation(words: ReadonlyArray<string>): Invocation {
  let index = 0;
  let lineBuffered = false;
  const skipOptions = (withValue: ReadonlySet<string>) => {
    while (index < words.length && words[index]!.startsWith("-")) {
      const option = words[index]!;
      index += 1;
      if (withValue.has(option)) index += 1;
    }
  };
  while (index < words.length) {
    const word = words[index]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      index += 1;
    } else if (["exec", "command", "builtin", "nohup", "time", "caffeinate"].includes(word)) {
      index += 1;
    } else if (word === "env") {
      index += 1;
      while (
        index < words.length &&
        (words[index]!.startsWith("-") || words[index]!.includes("="))
      ) {
        index += words[index] === "-u" ? 2 : 1;
      }
    } else if (word === "nice") {
      index += 1;
      skipOptions(new Set(["-n"]));
    } else if (word === "sudo") {
      index += 1;
      skipOptions(new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-R", "-T"]));
    } else if (word === "timeout" || word === "gtimeout") {
      index += 1;
      skipOptions(new Set(["-s", "--signal", "-k", "--kill-after"]));
      index += 1;
    } else if (word === "stdbuf" || word === "gstdbuf") {
      index += 1;
      const start = index;
      skipOptions(new Set(["-o", "-i", "-e"]));
      lineBuffered = /-o\s*[L0]|--output=[L0]/.test(words.slice(start, index).join(" "));
    } else if (word === "unbuffer") {
      index += 1;
      lineBuffered = true;
    } else {
      break;
    }
  }
  return { name: basename(words[index] ?? ""), args: words.slice(index + 1), lineBuffered };
}

/** A command that keeps printing until it is killed. */
function isFollowCommand({ name, args }: Invocation): boolean {
  switch (name) {
    case "tail":
    case "gtail":
      return follows(args) || hasShortFlag(args, "F");
    case "journalctl":
      return follows(args);
    case "kubectl":
    case "oc":
    case "docker":
    case "podman":
    case "docker-compose": {
      // Options before `logs` belong to the tool (compose's `-f` picks a file).
      const logs = args.indexOf("logs");
      return logs >= 0 && follows(args.slice(logs + 1));
    }
    case "log":
      return args[0] === "stream";
    case "stern":
      return true;
    case "fswatch":
      return !hasShortFlag(args, "1") && !hasLongFlag(args, "--one-event");
    case "inotifywait":
      return hasShortFlag(args, "m") || hasLongFlag(args, "--monitor");
    case "nvidia-smi":
      if ((args.includes("dmon") || args.includes("pmon")) && !hasShortFlag(args, "c")) {
        return true;
      }
      return args.some((arg) => /^-(l|lms)$/.test(arg) || /^--loop(-ms)?(=|$)/.test(arg));
    default:
      return false;
  }
}

/** grep's `-m`/`--max-count` value, when given. */
function maxCount(args: ReadonlyArray<string>): number | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const long = /^--max-count(?:=(\d+))?$/.exec(arg);
    if (long !== null) return Number(long[1] ?? args[index + 1]);
    const short = /^-[A-Za-z]*m(\d*)$/.exec(arg);
    if (short !== null) return Number(short[1] || args[index + 1]);
  }
  return undefined;
}

const isGrep = (name: string) => ["grep", "egrep", "fgrep", "ggrep"].includes(name);
const isAwk = (name: string) => ["awk", "gawk", "mawk", "nawk"].includes(name);
const isSed = (name: string) => name === "sed" || name === "gsed";

const isQuietGrep = (args: ReadonlyArray<string>) =>
  hasShortFlag(args, "q") || hasLongFlag(args, "--quiet") || hasLongFlag(args, "--silent");

/** An awk program that exits, or a sed script with a `q` command: both stop at a match. */
const awkExits = (args: ReadonlyArray<string>) => args.some((arg) => /\bexit\b/.test(arg));
const sedQuits = (args: ReadonlyArray<string>) =>
  args.some((arg) => !arg.startsWith("-") && /(?:^|[;{}/\d\s])[qQ]\s*\d*\s*(?:$|[;}])/.test(arg));

/** Stops reading after a few lines, so the commands after it see a finite stream. */
function isBoundedConsumer({ name, args }: Invocation): boolean {
  if (name === "head" || name === "ghead") return true;
  if (isGrep(name)) return isQuietGrep(args) || maxCount(args) !== undefined;
  if (isAwk(name)) return awkExits(args);
  if (isSed(name)) return sedQuits(args);
  return false;
}

const usesFflush = (args: ReadonlyArray<string>) =>
  args.some((arg) => arg.includes("fflush")) ||
  args.some(
    (arg, index) =>
      /^-Winteractive$/.test(arg) || (arg === "-W" && args[index + 1] === "interactive"),
  );

const runsPerLine = (args: ReadonlyArray<string>) =>
  args.some((arg) => /^-[Ln]1$/.test(arg) || arg.startsWith("-I")) ||
  args.some((arg, index) => (arg === "-L" || arg === "-n") && args[index + 1] === "1") ||
  hasLongFlag(args, "--max-lines") ||
  hasLongFlag(args, "--max-args");

/** How to stream through this filter, or undefined when it already streams. */
function bufferingFix({ name, args, lineBuffered }: Invocation): string | undefined {
  if (lineBuffered) return undefined;
  if (isGrep(name) || name === "rg") {
    if (hasLongFlag(args, "--line-buffered") || isQuietGrep(args)) return undefined;
    const limit = maxCount(args);
    if (limit === 1) return undefined;
    return limit === undefined
      ? "add `--line-buffered`"
      : "add `--line-buffered` (without it, earlier matches wait for the last one)";
  }
  if (isSed(name)) {
    if (hasShortFlag(args, "u") || hasLongFlag(args, "--unbuffered") || sedQuits(args)) {
      return undefined;
    }
    // macOS `sed -l` line-buffers; GNU `-l N` only sets the wrap width.
    const macLineBuffered =
      name === "sed" &&
      args.some((arg, index) => /^-[A-Za-z]*l$/.test(arg) && !/^\d+$/.test(args[index + 1] ?? ""));
    return macLineBuffered ? undefined : "add `-u` (GNU sed) or `-l` (macOS sed)";
  }
  if (isAwk(name)) {
    return usesFflush(args) || awkExits(args) ? undefined : "call `fflush()` after each print";
  }
  switch (name) {
    case "jq":
      return hasLongFlag(args, "--unbuffered") ? undefined : "add `--unbuffered`";
    case "perl":
      return args.some((arg) => arg.includes("$|") || arg.includes("autoflush"))
        ? undefined
        : "set `$| = 1`";
    case "xargs":
      return runsPerLine(args) ? undefined : "add `-L1` so it runs for each line";
    case "cut":
    case "tr":
    case "rev":
    case "fold":
    case "nl":
    case "expand":
    case "paste":
      return "replace it with `awk '{ ...; fflush() }'` (for `cut -c1-N`: `awk '{ print substr($0, 1, N); fflush() }'`)";
    case "sort":
    case "uniq":
    case "column":
    case "wc":
    case "tac":
      return "drop it: it only prints once the stream ends";
    default:
      return undefined;
  }
}

const SSH_OPTIONS_WITH_VALUE = new Set("BbcDEeFIiJLlmOoPpQRSWw".split(""));

/** The script `ssh host '…'` or `bash -c '…'` runs, and whether ssh gives it a terminal. */
function nestedScript({ name, args }: Invocation): { script: string; tty: boolean } | undefined {
  if (name === "ssh") {
    let index = 0;
    let ttyFlags = 0;
    let forcedTty = false;
    while (index < args.length && args[index]!.startsWith("-") && args[index] !== "--") {
      const cluster = args[index]!.slice(1);
      index += 1;
      for (let char = 0; char < cluster.length; char += 1) {
        const letter = cluster[char]!;
        if (letter === "t") ttyFlags += 1;
        if (SSH_OPTIONS_WITH_VALUE.has(letter)) {
          let value = cluster.slice(char + 1);
          if (value.length === 0) {
            value = args[index] ?? "";
            index += 1;
          }
          if (letter === "o" && /^RequestTTY\s*=?\s*force$/i.test(value)) forcedTty = true;
          break;
        }
      }
    }
    if (args[index] === "--") index += 1;
    const remote = args.slice(index + 1);
    // The monitor's stdin is not a terminal, so only `-tt` or RequestTTY=force forces one.
    return remote.length === 0
      ? undefined
      : { script: remote.join(" "), tty: forcedTty || ttyFlags >= 2 };
  }
  if (["bash", "sh", "zsh", "dash", "ksh"].includes(name)) {
    const flag = args.findIndex((arg) => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg));
    const script = flag < 0 ? undefined : args[flag + 1];
    return script === undefined ? undefined : { script, tty: false };
  }
  return undefined;
}

/** `while true`, `while :`, `while sleep N` or `until false`, with no way out. */
function loopsForever(command: Extract<Command, { kind: "loop" }>): boolean {
  const condition = command.condition.pipelines;
  const only = condition.length === 1 && condition[0]!.length === 1 ? condition[0]![0] : undefined;
  if (only?.kind !== "simple") return false;
  const name = only.words[0];
  const forever = command.until
    ? name === "false"
    : name === "true" || name === ":" || name === "sleep";
  // Any break/exit/return, even inside a case arm, can end it.
  return forever && !/(?:^|[\s;&|(){}])(?:break|exit|return)(?=$|[\s;&|(){}])/.test(command.text);
}

interface Analysis {
  readonly problem?: string;
  readonly streams: boolean;
}

const shorten = (text: string) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
};

const describeProblem = (filter: string, source: Command, fix: string) =>
  `This monitor will likely never wake you: \`${shorten(filter)}\` comes after the ` +
  `never-ending stream \`${shorten(source.text)}\` and, writing into a pipe, holds its output ` +
  `in a buffer until that stream ends. Stop it and start one where every filter after the ` +
  `stream is line-buffered: ${fix}.`;

/** Where a command's stdout goes is the pipe unless it redirects it. */
function analyzeCommand(command: Command, nesting: number): Analysis {
  switch (command.kind) {
    case "simple": {
      if (redirectsStdout(command.words)) return { streams: false };
      const target = invocation(command.words);
      const nested = nesting < MAX_NESTING ? nestedScript(target) : undefined;
      if (nested !== undefined) {
        const inner = analyzeList(parse(nested.script), nesting + 1);
        // With a remote terminal the remote output line-buffers.
        return nested.tty ? { streams: inner.streams } : inner;
      }
      return { streams: isFollowCommand(target) };
    }
    case "list":
      return analyzeList(command.body, nesting);
    case "loop": {
      const body = analyzeList(command.body, nesting);
      if (body.problem !== undefined) return body;
      return { streams: loopsForever(command) || body.streams };
    }
    case "opaque":
      return { streams: false };
  }
}

interface Downstream {
  readonly problem?: string;
  /** The command ends the stream for whatever reads its output. */
  readonly bounded: boolean;
}

/** A command reading the never-ending `source` on stdin. */
function analyzeDownstream(command: Command, source: Command, nesting: number): Downstream {
  const firstPipeline = (list: List, nested: number): Downstream => {
    const first = list.pipelines[0];
    if (first === undefined) return { bounded: false };
    const result = analyzePipeline(first, nested, source);
    return result.problem === undefined
      ? { bounded: !result.streams }
      : { problem: result.problem, bounded: false };
  };
  switch (command.kind) {
    case "simple": {
      if (redirectsStdout(command.words)) return { bounded: true };
      const target = invocation(command.words);
      const nested = nesting < MAX_NESTING ? nestedScript(target) : undefined;
      if (nested !== undefined) {
        const result = firstPipeline(parse(nested.script), nesting + 1);
        return nested.tty ? { bounded: result.bounded } : result;
      }
      const fix = bufferingFix(target);
      if (fix !== undefined) {
        return { problem: describeProblem(command.text, source, fix), bounded: false };
      }
      return { bounded: isBoundedConsumer(target) };
    }
    case "list":
      return firstPipeline(command.body, nesting);
    case "loop": {
      // `while read line; do …; done` consumes the stream line by line.
      const body = analyzeList(command.body, nesting);
      return body.problem === undefined
        ? { bounded: false }
        : { problem: body.problem, bounded: false };
    }
    case "opaque":
      return { bounded: false };
  }
}

function analyzePipeline(
  pipeline: ReadonlyArray<Command>,
  nesting: number,
  inherited?: Command,
): Analysis {
  let source = inherited;
  for (const command of pipeline) {
    if (source !== undefined) {
      const downstream = analyzeDownstream(command, source, nesting);
      if (downstream.problem !== undefined) return { problem: downstream.problem, streams: true };
      if (downstream.bounded) source = undefined;
      continue;
    }
    const inner = analyzeCommand(command, nesting);
    if (inner.problem !== undefined) return inner;
    if (inner.streams) source = command;
  }
  return { streams: source !== undefined };
}

function analyzeList(list: List, nesting: number): Analysis {
  let streams = false;
  for (const pipeline of list.pipelines) {
    const result = analyzePipeline(pipeline, nesting);
    if (result.problem !== undefined) return result;
    streams ||= result.streams;
  }
  return { streams };
}

/**
 * Explains why a monitor command would likely never deliver a line, or returns
 * undefined when every filter after its never-ending source streams.
 */
export function monitorBufferingProblem(command: string): string | undefined {
  if (command.length > MAX_COMMAND_LENGTH) return undefined;
  try {
    return analyzeList(parse(command), 0).problem;
  } catch {
    // Only advice: a parser bug must never fail a monitor that already started.
    return undefined;
  }
}
