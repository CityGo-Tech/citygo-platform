import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolveFigma, verifyMapping } from "./figma.mjs";
const read = async (name) =>
  JSON.parse(await readFile(new URL("../" + name, import.meta.url), "utf8"));
const snapshot = await read("figma.snapshot.json");
const mapping = await read("figma.mapping.json");
const tokens = await read("tokens.json");

test("all 37 Figma variables and aliases resolve and match the public tokens", () => {
  const result = resolveFigma(snapshot);
  assert.equal(Object.keys(result.resolved).length, 37);
  assert.equal(
    result.tokens["CityGo / Semantic"]["color/bg/action-primary"],
    "#3F5BD8",
  );
  verifyMapping(tokens, mapping, result.resolved);
  assert.throws(
    () =>
      verifyMapping(
        { ...tokens, color: { ...tokens.color, primaryStrong: "#000000" } },
        mapping,
        result.resolved,
      ),
    /drift/,
  );
});
test("invalid aliases, cycles and unreviewed modes fail closed", () => {
  const broken = structuredClone(snapshot);
  broken.variables[0].valuesByMode["258:0"] = {
    type: "VARIABLE_ALIAS",
    id: "missing",
  };
  assert.throws(() => resolveFigma(broken), /Missing/);
  broken.variables[0].valuesByMode["258:0"].id = broken.variables[0].id;
  assert.throws(() => resolveFigma(broken), /cycle/);
  const multiMode = structuredClone(snapshot);
  multiMode.collections[0].modes.push({ name: "Dark", modeId: "new" });
  assert.throws(() => resolveFigma(multiMode), /modes/);
});
test("action, focus, error and success colors retain readable contrast", () => {
  const luminance = (hex) =>
    hex
      .slice(1)
      .match(/../g)
      .map((part) => parseInt(part, 16) / 255)
      .map((value) =>
        value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
      )
      .reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
  const contrast = (a, b) =>
    (Math.max(luminance(a), luminance(b)) + 0.05) /
    (Math.min(luminance(a), luminance(b)) + 0.05);
  for (const key of ["primaryStrong", "accentStrong", "danger", "success"])
    assert.ok(contrast(tokens.color[key], tokens.color.onAction) >= 4.5, key);
  assert.ok(contrast(tokens.color.focus, tokens.color.surface) >= 3);
});
