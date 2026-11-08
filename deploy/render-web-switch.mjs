import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { resolve } from "node:path";
import { renderNginx } from "./render-pilot.mjs";

// Rendering is inert. Installation and upstream changes require the separate
// protected Web-switch controller; the existing publisher never selects this.
export function renderWebSwitchNginx(host) {
  renderNginx(host); // Reuse the existing strict hostname validation.
  return readFileSync(
    new URL("./nginx/pilot-web-switch.conf.template", import.meta.url),
    "utf8",
  ).replaceAll("__CITYGO_HOST__", host);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv.length !== 3) throw new Error("Supply one hostname");
  process.stdout.write(renderWebSwitchNginx(process.argv[2]));
}
