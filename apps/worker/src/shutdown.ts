import type { EventEmitter } from "node:events";
import type { Database } from "@citygo/db";

export const WORKER_SHUTDOWN_MS = 60_000;

// One invocation, one transaction, no automatic retry. Install before connecting
// so a stop during startup cannot admit a new maintenance operation afterwards.
export async function runWorkerOnce(
  connect: () => Promise<Database>,
  maintain: (db: Database) => Promise<unknown>,
  {
    signals = process as EventEmitter,
    shutdownMs = WORKER_SHUTDOWN_MS,
    onDrain = () => console.log("CityGo worker draining"),
  } = {},
): Promise<"completed" | "skipped"> {
  let stopping = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expire: (error: Error) => void;
  const deadline = new Promise<never>((_, reject) => {
    expire = reject;
  });
  const stop = () => {
    if (stopping) return;
    stopping = true;
    timer = setTimeout(
      () => expire(new Error("Worker shutdown deadline exceeded")),
      shutdownMs,
    );
    onDrain();
  };
  for (const signal of ["SIGTERM", "SIGINT"]) signals.on(signal, stop);
  try {
    return await Promise.race([
      (async () => {
        const db = await connect();
        try {
          if (stopping) return "skipped" as const;
          await maintain(db); // Resolves only after COMMIT; do not close DB early.
          return "completed" as const;
        } finally {
          await db.close(); // A close error or hung cleanup cannot report success.
        }
      })(),
      deadline,
    ]);
  } catch {
    // Driver errors can include credentials/query data. Only a safe terminal status.
    throw new Error("Worker maintenance failed");
  } finally {
    clearTimeout(timer);
    for (const signal of ["SIGTERM", "SIGINT"]) signals.off(signal, stop);
  }
}
