import { readFile, writeFile } from "node:fs/promises";
const root = new URL("../", import.meta.url);
const tokens = JSON.parse(await readFile(new URL("tokens.json", root), "utf8"));
const declarations = [];
for (const [group, values] of Object.entries(tokens)) {
  for (const [name, value] of Object.entries(values)) {
    declarations.push(
      "  --cg-" +
        group +
        "-" +
        name.replace(/[A-Z]/g, (v) => "-" + v.toLowerCase()) +
        ": " +
        value +
        (typeof value === "number" ? "px" : "") +
        ";",
    );
  }
}
const outputs = {
  "tokens.css": ":root {\n" + declarations.join("\n") + "\n}\n",
  "index.ts":
    "// Generated from tokens.json. Do not edit.\nexport const tokens = " +
    JSON.stringify(tokens, null, 2) +
    " as const;\n",
};
for (const [name, source] of Object.entries(outputs)) {
  const path = new URL(name, root);
  if (process.argv.includes("--check")) {
    if ((await readFile(path, "utf8")).replaceAll("\r\n", "\n") !== source)
      throw new Error("Regenerate design tokens before committing: " + name);
  } else await writeFile(path, source);
}
