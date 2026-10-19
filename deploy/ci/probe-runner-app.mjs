// Launch ONLY from the protected pinned host bundle. Private config arrives via
// inherited anonymous stdin, NEVER argv/env/source/ISO. No native VM access.
// Default/probe are read-only. Group creation needs a separate exact typed ack.
import { createRunnerAppClient } from "./github-runner-app.mjs";
import { pathToFileURL } from "node:url";

export async function probeMain(args, input, output) {
  if (args.length === 0 || (args.length === 1 && args[0] === "--plan")) {
    output({
      stage: "plan_only_unverified",
      appAccessVerified: false,
      runnerRegistered: false,
    });
    return 0;
  }
  const createMainGroup =
    args.length === 3 &&
    args[0] === "--prepare-main-group" &&
    args[1] === "--acknowledge" &&
    args[2] ===
      "CREATE_CITYGO_ISOLATED_GROUP:CityGo-Tech/citygo-platform:MAIN_ONLY";
  const inspectGroup = args.length === 1 && args[0] === "--inspect-main-group";
  const prMode =
    args.length === 1 && args[0] === "--inspect-pr-access"
      ? "inspect"
      : args.length === 3 &&
          ["--configure-pr-access", "--repair-pr-repository"].includes(
            args[0],
          ) &&
          args[1] === "--acknowledge" &&
          /^LIMIT_CITYGO_PR_WORKFLOWS:[1-9][0-9]*:[a-f0-9]{40}:[a-f0-9]{40}$/.test(
            args[2],
          )
        ? args[0] === "--repair-pr-repository"
          ? "repair-repository"
          : "apply"
        : null;
  if (
    !prMode &&
    !createMainGroup &&
    !inspectGroup &&
    (args.length !== 1 || args[0] !== "--probe")
  ) {
    output({ stage: "refused", runnerRegistered: false });
    return 2;
  }
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of input) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > 32768) throw Error("ci_factory_app_input_bounds");
      chunks.push(bytes);
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (
      prMode &&
      (!payload ||
        Object.keys(payload).sort().join("|") !== "config|intent" ||
        (prMode !== "inspect" &&
          args[2] !==
            `LIMIT_CITYGO_PR_WORKFLOWS:${payload.intent?.prNumber}:${payload.intent?.headSha}:${payload.intent?.mergeSha}`))
    )
      throw Error("ci_factory_app_pr_acknowledgement_invalid");
    const client = createRunnerAppClient(prMode ? payload.config : payload);
    try {
      const refs = ["ci.yml", "container-smoke.yml"].map(
        (file) =>
          "CityGo-Tech/citygo-platform/.github/workflows/" +
          file +
          "@refs/heads/main",
      );
      output(
        prMode
          ? await client.prAccess(payload.intent, prMode)
          : createMainGroup
            ? await client.prepareGroup(refs)
            : inspectGroup
              ? await client.inspectGroup(refs)
              : await client.inspect(),
      );
    } finally {
      client.clearCachedToken();
    }
    return 0;
  } catch (error) {
    const code =
      error instanceof Error &&
      /^ci_factory_app_[a-z_]{1,64}$/.test(error.message)
        ? error.message
        : "ci_factory_app_probe_refused";
    output({
      stage: "failed_preserved",
      code,
      runnerRegistered: false,
      vmCreated: false,
      productionChanged: false,
      ...(error?.message === "ci_factory_app_request_refused" &&
      [
        "create_group",
        "update_group",
        "read_group",
        "installation_token",
        "read_installation",
        "generate_jit",
        "read_job",
      ].includes(error.operation)
        ? {
            operation: error.operation,
            httpStatus: error.httpStatus,
            reason: [
              "unspecified",
              "workflow_ref_rejected",
              "group_feature_unavailable",
              "scope_denied",
              "repository_rejected",
            ].includes(error.reason)
              ? error.reason
              : "unspecified",
            ...(error.operation === "update_group" && error.groupValidation
              ? { groupValidation: error.groupValidation }
              : {}),
          }
        : {}),
    });
    return 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = await probeMain(
    process.argv.slice(2),
    process.stdin,
    (value) => {
      process.stdout.write(JSON.stringify(value) + "\n");
    },
  );
}
