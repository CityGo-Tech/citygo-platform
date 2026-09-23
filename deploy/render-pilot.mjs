import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { resolve } from "node:path";

export function renderNginx(host) {
  // A DNS name only, never a URL, IP, wildcard or Nginx directive.
  if (
    typeof host !== "string" ||
    host.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
      host,
    )
  )
    throw new Error(
      "Supply a lowercase DNS hostname without protocol, port or path",
    );
  return readFileSync(
    new URL("./nginx/pilot.conf.template", import.meta.url),
    "utf8",
  ).replaceAll("__CITYGO_HOST__", host);
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv.length !== 3) throw new Error("Supply one hostname");
  process.stdout.write(renderNginx(process.argv[2]));
}
