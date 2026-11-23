/** Local diagnostic history is read only when flushing or inspecting it. */
export function createLoadMarkJournal(options: {
  readonly read: () => Promise<string>;
  readonly write: (text: string) => Promise<void>;
  readonly limit?: number;
  readonly delayMs?: number;
}) {
  const limit = options.limit ?? 4_000;
  let lines: string[] = [];
  let history: Promise<void> | undefined;
  let writing: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let revision = 0;
  let savedRevision = 0;
  const trim = () => {
    if (lines.length > limit) lines.splice(0, lines.length - limit);
  };
  const load = () => {
    history ??= options
      .read()
      .then((text) => {
        lines = [...text.split("\n").filter(Boolean), ...lines];
        trim();
      })
      .catch((error: unknown) => {
        history = undefined;
        throw error;
      });
    return history;
  };
  const schedule = () => {
    timer ??= setTimeout(() => {
      timer = undefined;
      void flush().catch(() => undefined);
    }, options.delayMs ?? 2_000);
  };
  const flush = (): Promise<void> => {
    if (writing) return writing;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const attemptedRevision = revision;
    writing = (async () => {
      // A failed read must not overwrite history that we have not recovered.
      await load();
      const capturedRevision = revision;
      await options.write(`${lines.join("\n")}\n`);
      savedRevision = capturedRevision;
    })().finally(() => {
      writing = undefined;
      // Retry only for a newer mark (including app foreground). A failed I/O
      // attempt with no new marks must not keep waking the phone every 2s.
      if (savedRevision !== revision && revision !== attemptedRevision) schedule();
    });
    return writing;
  };
  return {
    record(line: string) {
      lines.push(line);
      revision++;
      trim();
      schedule();
    },
    async read() {
      await load();
      return `${lines.join("\n")}\n`;
    },
    flush,
  };
}
