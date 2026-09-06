import { readFile, stat } from "node:fs/promises";
const root = new URL("../", import.meta.url);
const manifest = JSON.parse(
  await readFile(new URL("manifest.json", root), "utf8"),
);
if (manifest.characters.length !== 9)
  throw new Error("Expected nine characters");
for (const asset of manifest.characters) {
  for (const variant of asset.variants) {
    const file = await stat(new URL(variant.path, root));
    if (file.size !== variant.bytes || file.size > 250000)
      throw new Error("Asset size mismatch: " + variant.path);
  }
}
