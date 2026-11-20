// The Windows client transport (design §14 answer 11): a named pipe beside loopback TCP. Deno's
// `Deno.serve` has no named-pipe listener, so the hub listens on the pipe through node:net and
// bridges each connection to its own loopback API listener byte for byte. The pipe's default
// security descriptor (creator and SYSTEM / Administrators only) is the first gate; the client token
// is still required on every request, as on the Unix socket.
//
// NOT YET VERIFIED ON WINDOWS (phase 1 was written on macOS): the CI matrix's Windows job runs the
// pipe test once it exists there.

export interface PipeBridge {
  close(): Promise<void>;
}

export async function startPipeBridge(pipePath: string, apiPort: number): Promise<PipeBridge> {
  const net = await import("node:net");
  const server = net.createServer((client) => {
    const upstream = net.connect({ host: "127.0.0.1", port: apiPort });
    client.pipe(upstream);
    upstream.pipe(client);
    const end = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", end);
    upstream.on("error", end);
    client.on("close", end);
    upstream.on("close", end);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipePath, () => resolve());
  });
  return {
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
