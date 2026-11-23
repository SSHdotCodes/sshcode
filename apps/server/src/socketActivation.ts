/**
 * The listening socket systemd passed this process, if any.
 *
 * A socket-activated user service lets systemd hold the port while the server
 * is stopped and start it on the first connection. systemd passes
 * the socket as file descriptor 3 and names the receiving process in
 * LISTEN_PID, so a child that inherits the environment never claims it.
 */
export function systemdListenFd(
  env: Readonly<Record<string, string | undefined>>,
  pid: number,
): number | null {
  if (env.LISTEN_PID !== String(pid)) return null;
  const count = Number(env.LISTEN_FDS);
  return Number.isInteger(count) && count >= 1 ? 3 : null;
}

type HeldEvent = "request" | "upgrade";

/**
 * Holds requests that arrive before the HTTP handlers attach, then replays them.
 *
 * The server starts listening when its layer is built and attaches its request and
 * upgrade handlers a few seconds later, once every route is built. Node accepts a
 * connection in between with no handler, so a request would hang until the client
 * gave up and an upgrade would be dropped. Clients do connect in between: the Mac
 * window opens while its server starts, phones and daemons reconnect the moment the
 * port opens, and a socket systemd passed already holds the connection that woke
 * the server.
 */
export function holdEarlyRequests<S extends NodeJS.EventEmitter>(server: S): S {
  const held: Array<{ readonly event: HeldEvent; readonly args: ReadonlyArray<unknown> }> = [];
  // Listeners present now, such as error guards, never answer a request themselves.
  let passive = new Set<unknown>();
  const answered = (event: HeldEvent) =>
    server.listeners(event).some((listener) => !passive.has(listener));
  const hold =
    (event: HeldEvent) =>
    (...args: ReadonlyArray<unknown>) => {
      // Once a real handler is attached it answers; this listener only bridges the gap.
      if (answered(event)) return;
      held.push({ event, args });
    };
  const onRequest = hold("request");
  const onUpgrade = hold("upgrade");
  const onNewListener = (event: string | symbol) => {
    if (event !== "request" && event !== "upgrade") return;
    // newListener fires before the listener is added; replay once both are in place.
    setImmediate(() => {
      if (!answered("request") || !answered("upgrade")) return;
      server.removeListener("request", onRequest);
      server.removeListener("upgrade", onUpgrade);
      server.removeListener("newListener", onNewListener);
      for (const { event: name, args } of held.splice(0)) server.emit(name, ...args);
    });
  };
  server.on("request", onRequest);
  server.on("upgrade", onUpgrade);
  passive = new Set([...server.listeners("request"), ...server.listeners("upgrade")]);
  server.on("newListener", onNewListener);
  return server;
}
