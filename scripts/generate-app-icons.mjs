import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

// Approved Figma logo 2, node 20005872:3151. Keep the original raster intact.
// The symbol crop follows .citygo-brand-symbol in globals.css; the wordmark and
// the original app-tile shadow are deliberately outside this small icon crop.
const source = fileURLToPath(
  new URL("../apps/web/public/figma/citygo-original-logo.png", import.meta.url),
);
const destination = (name) =>
  fileURLToPath(new URL("../apps/web/src/app/" + name, import.meta.url));
const original = await readFile(source);
assert.equal(
  createHash("sha256").update(original).digest("hex"),
  "6599af9927be6eaec594b5ca5ce37249d20896fe7166cab9c6c9ff7ed4bdcaa5",
  "The approved logo changed; review its crop before regenerating icons.",
);
const metadata = await sharp(original).metadata();
assert.equal(metadata.width, 669);
assert.equal(metadata.height, 669);
const symbol = await sharp(original)
  .extract({ left: 176, top: 177, width: 318, height: 224 })
  .flatten({ background: "#ffffff" })
  .extend({
    left: 21,
    right: 21,
    top: 68,
    bottom: 68,
    background: "#ffffff",
  })
  .toColourspace("srgb")
  .removeAlpha()
  .png({ compressionLevel: 9 })
  .toBuffer();
const png = (size) =>
  sharp(symbol)
    .resize(size, size, { kernel: sharp.kernel.lanczos3 })
    .png({ compressionLevel: 9 })
    .toBuffer();

// ICO supports PNG-compressed frames. Ship the common small browser/Windows
// sizes together, so each display can select a native frame instead of scaling.
const sizes = [16, 32, 48];
const frames = await Promise.all(
  sizes.map(async (size) =>
    sharp(await png(size))
      .ensureAlpha()
      .png({ compressionLevel: 9 })
      .toBuffer(),
  ),
);
const directory = Buffer.alloc(6 + 16 * frames.length);
directory.writeUInt16LE(1, 2);
directory.writeUInt16LE(frames.length, 4);
let offset = directory.length;
for (let index = 0; index < frames.length; index++) {
  const entry = 6 + index * 16;
  directory[entry] = sizes[index];
  directory[entry + 1] = sizes[index];
  directory.writeUInt16LE(1, entry + 4);
  directory.writeUInt16LE(32, entry + 6);
  directory.writeUInt32LE(frames[index].length, entry + 8);
  directory.writeUInt32LE(offset, entry + 12);
  offset += frames[index].length;
}
const assets = new Map([
  ["favicon.ico", Buffer.concat([directory, ...frames])],
  ["icon.png", await png(512)],
  ["apple-icon.png", await png(180)],
]);
assert(
  process.argv.length === 2 ||
    (process.argv.length === 3 && process.argv[2] === "--check"),
  "Usage: node scripts/generate-app-icons.mjs [--check]",
);
for (const [name, bytes] of assets) {
  if (process.argv[2] === "--check") {
    assert.deepEqual(
      await readFile(destination(name)),
      bytes,
      name + " does not match the approved logo; regenerate app icons.",
    );
  } else {
    await writeFile(destination(name), bytes);
  }
}
console.log(
  JSON.stringify({
    checked: process.argv[2] === "--check",
    assets: [...assets].map(([name, bytes]) => ({ name, bytes: bytes.length })),
  }),
);
