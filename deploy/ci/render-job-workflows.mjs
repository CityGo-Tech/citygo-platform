// Pure preview only. NO filesystem/GitHub writes and NO automatic activation.
// Activate after org group + native factory acceptance, never merely on labels.
import { createHash } from "node:crypto";
import { requireCi } from "./runner-job-policy.mjs";

const digest = (text) => createHash("sha256").update(text).digest("hex");
export function renderJobWorkflow(source, kind, expectedSourceSha256) {
  requireCi(
    typeof source === "string" &&
      source.endsWith("\n") &&
      /^[a-f0-9]{64}$/.test(expectedSourceSha256) &&
      digest(source) === expectedSourceSha256,
    "workflow_source_pin_invalid",
  );
  requireCi(kind === "ci" || kind === "container", "workflow_kind_invalid");
  const normalized = source.replaceAll("\r\n", "\n");
  const suffix = kind === "ci" ? "verify" : "production-images";
  requireCi(
    (normalized.match(/[ ]{4}runs-on: ubuntu-latest\n/g) ?? []).length === 1 &&
      normalized.startsWith(
        kind === "ci" ? "name: CI\n" : "name: Container smoke\n",
      ) &&
      normalized.includes(`jobs:\n  ${suffix}:\n`),
    "workflow_structure_changed",
  );
  let output = normalized.replace(
    "    runs-on: ubuntu-latest\n",
    "    runs-on:\n      group: CityGo-isolated-checks\n" +
      `      labels: citygo-ci-\${{ github.run_id }}-\${{ github.run_attempt }}-${suffix}\n`,
  );
  if (kind === "ci") {
    requireCi(
      !normalized.includes("    timeout-minutes:"),
      "workflow_timeout_changed",
    );
    output = output.replace(
      "    services:\n",
      "    timeout-minutes: 60\n    services:\n",
    );
    requireCi(
      output.includes("      - uses: actions/checkout@v7\n"),
      "workflow_checkout_changed",
    );
    output = output.replace(
      "      - uses: actions/checkout@v7\n",
      "      - uses: actions/checkout@v7\n        with:\n          persist-credentials: false\n",
    );
  }
  // All other steps, service images, env isolation canaries, names, events,
  // concurrency, timeouts (Container 40), assertions and failure evidence stay.
  return output;
}
