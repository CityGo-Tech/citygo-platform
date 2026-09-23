import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";

export function commandArgs(command, args, inherited = process.env) {
  if (command === "node") return args;
  if (command !== "pnpm" || !inherited.npm_execpath)
    throw new Error(
      "Run this command through pnpm; only node/pnpm child commands are supported",
    );
  return [inherited.npm_execpath, ...args];
}

// No shell interpolation. Forward shutdown and remove listeners after each
// short-lived build/migration, so they cannot accumulate across stages.
export function launch(command, args, { env, cwd, inherited = process.env }) {
  const group =
    process.platform !== "win32" && inherited.CITYGO_CHILD_PROCESS !== "1";
  const child = spawn(process.execPath, commandArgs(command, args, inherited), {
    cwd,
    env: { ...env, CITYGO_CHILD_PROCESS: "1" },
    stdio: "inherit",
    windowsHide: true,
    detached: group,
  });
  const stop = (signal = "SIGTERM") => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null)
      return;
    if (process.platform === "win32") {
      // Only the process tree that this launcher created, never a port/name scan.
      spawnSync(
        join(env.SystemRoot ?? "C:\\Windows", "System32/taskkill.exe"),
        ["/pid", String(child.pid), "/T", "/F"],
        {
          env: { SystemRoot: env.SystemRoot ?? "C:\\Windows" },
          stdio: "ignore",
          windowsHide: true,
          timeout: 5000,
        },
      );
    } else {
      try {
        process.kill(group ? -child.pid : child.pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
  };
  const handlers = ["SIGINT", "SIGTERM"].map((signal) => {
    const handler = () => stop(signal);
    process.on(signal, handler);
    return [signal, handler];
  });
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Child command failed (${signal ?? code})`));
    });
  }).finally(() => {
    for (const [signal, handler] of handlers)
      process.removeListener(signal, handler);
  });
  return { child, done, stop };
}
