// Resolve the committed export offline. Never fetch mutable Figma data at build time.
export function resolveFigma(snapshot) {
  const variables = new Map(snapshot.variables.map((v) => [v.id, v]));
  const collections = new Map(snapshot.collections.map((c) => [c.id, c]));
  if (variables.size !== snapshot.variables.length)
    throw new Error("Duplicate Figma variable IDs");
  function resolve(id, trail = []) {
    if (trail.includes(id)) throw new Error("Figma alias cycle: " + id);
    const variable = variables.get(id);
    if (!variable) throw new Error("Missing Figma variable: " + id);
    const collection = collections.get(variable.collectionId);
    if (!collection || collection.modes.length !== 1)
      throw new Error("Review new Figma modes before generating: " + id);
    const value = variable.valuesByMode[collection.defaultModeId];
    if (value?.type === "VARIABLE_ALIAS")
      return resolve(value.id, [...trail, id]);
    if (variable.type === "COLOR") {
      if (
        !value ||
        !["r", "g", "b"].every(
          (key) =>
            Number.isFinite(value[key]) && value[key] >= 0 && value[key] <= 1,
        )
      )
        throw new Error("Invalid Figma color: " + id);
      if (value.a !== undefined && value.a !== 1)
        throw new Error("Review translucent Figma color: " + id);
      return (
        "#" +
        ["r", "g", "b"]
          .map((key) =>
            Math.round(value[key] * 255)
              .toString(16)
              .padStart(2, "0"),
          )
          .join("")
          .toUpperCase()
      );
    }
    if (variable.type === "FLOAT" && Number.isFinite(value)) return value;
    throw new Error("Unsupported Figma value: " + id);
  }
  const resolved = Object.fromEntries(
    snapshot.variables.map((v) => [v.id, resolve(v.id)]),
  );
  const tokens = Object.fromEntries(
    snapshot.collections.map((c) => [
      c.name,
      Object.fromEntries(
        snapshot.variables
          .filter((v) => v.collectionId === c.id)
          .map((v) => [v.name, resolved[v.id]]),
      ),
    ]),
  );
  return { resolved, tokens };
}

export function verifyMapping(tokens, mapping, resolved) {
  for (const [path, id] of Object.entries(mapping)) {
    const value = path.split(".").reduce((node, key) => node?.[key], tokens);
    if (!(id in resolved) || value !== resolved[id])
      throw new Error("Figma token drift: " + path);
  }
}
