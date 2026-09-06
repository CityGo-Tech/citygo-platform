import { cp, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const source = fileURLToPath(
  new URL("../packages/assets/characters/", import.meta.url),
);
const destination = fileURLToPath(
  new URL("../apps/web/public/characters/", import.meta.url),
);
await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });
