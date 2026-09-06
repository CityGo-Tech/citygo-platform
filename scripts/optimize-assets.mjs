import sharp from "sharp";
import { readdir, mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
const source = process.argv[2];
if (!source)
  throw new Error("Pass the source character directory as the first argument");
const root = fileURLToPath(new URL("../packages/assets/", import.meta.url));
await mkdir(resolve(root, "characters"), { recursive: true });
const files = await readdir(source);
const definitions = [
  ["housing", "Housing Navigator"],
  ["job-search", "Job Search Mentor"],
  ["resume-builder", "Resume Builder Expert"],
  ["support", "Support Assistant"],
  ["digital-mentor", "Digital Mentor"],
  ["traveler-female", "основной женский персонаж"],
  ["traveler-male", "Мужчина-переезжающий"],
  ["child-female", "Персонаж девочка"],
  ["child-male", "Персонаж - мальчик"],
];
const characters = [];
for (const [id, label] of definitions) {
  const filename = files.find(
    (n) =>
      n.normalize("NFC").includes(label.normalize("NFC")) && n.endsWith(".png"),
  );
  if (!filename) throw new Error("Missing character " + label);
  const input = await readFile(resolve(source, filename));
  const variants = [];
  for (const width of [192, 640]) {
    const output = await sharp(input)
      .rotate()
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: 82, effort: 6 })
      .toBuffer();
    const metadata = await sharp(output).metadata();
    const path = "characters/" + id + "-" + width + ".webp";
    await writeFile(resolve(root, path), output);
    variants.push({
      path,
      width: metadata.width,
      height: metadata.height,
      bytes: output.length,
    });
  }
  characters.push({
    id,
    label,
    sourceFile: filename,
    sourceSha256: createHash("sha256").update(input).digest("hex"),
    sourceBytes: input.length,
    variants,
  });
}
await writeFile(
  resolve(root, "manifest.json"),
  JSON.stringify(
    {
      source:
        "User-provided CityGo character illustrations; no Figma export available",
      characters,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify(
    characters.map((c) => ({
      id: c.id,
      original: c.sourceBytes,
      optimized: c.variants.reduce((n, v) => n + v.bytes, 0),
    })),
  ),
);
