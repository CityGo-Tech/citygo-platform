// Append-only host-owned evidence. Never stores registration tokens, raw REST
// responses, guest output, commands or an exception stack. Never deletes files.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ADAPTER_METHODS } from "./runner-job-factory.mjs";
import { requireCi, validateJobPlan } from "./runner-job-policy.mjs";

const keyPattern =
  /^[1-9][0-9]{0,15}-[1-9][0-9]{0,15}-[1-9][0-9]{0,15}-[1-9][0-9]{0,15}$/;
const stages = new Set([
  "resource_mutation_intent",
  "listen_one_job_intent",
  "github_job_completed",
  "failed_preserved",
  "cleanup_intent",
  "cleanup_verified",
  "quarantined",
  ...ADAPTER_METHODS.flatMap((name) => [name + "_intent", name + "_verified"]),
]);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const raw = (value) => JSON.stringify(value) + "\n";
async function ordinary(path, directory) {
  const item = await lstat(path);
  requireCi(
    !item.isSymbolicLink() &&
      (directory ? item.isDirectory() : item.isFile() && item.nlink === 1),
    "journal_plain_path_required",
  );
  return item;
}
async function create(path, value) {
  // Exclusive create and flush BEFORE returning permission to do a side effect.
  // A partial write remains a fault, never silently truncated or overwritten.
  const fd = await open(path, "wx", 0o600);
  try {
    await fd.writeFile(raw(value), "utf8");
    await fd.sync();
  } finally {
    await fd.close();
  }
}
async function read(path) {
  const before = await ordinary(path, false);
  requireCi(before.size > 0 && before.size <= 16384, "journal_size_invalid");
  const fd = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const item = await fd.stat();
    requireCi(
      item.ino === before.ino &&
        item.dev === before.dev &&
        item.nlink === 1 &&
        item.size === before.size,
      "journal_replaced",
    );
    const data = await fd.readFile("utf8");
    requireCi(Buffer.byteLength(data, "utf8") === item.size, "journal_changed");
    const value = JSON.parse(data);
    requireCi(raw(value) === data, "journal_noncanonical");
    return value;
  } finally {
    await fd.close();
  }
}
function validEvent(event) {
  requireCi(
    event &&
      stages.has(event.stage) &&
      Object.keys(event).every((x) =>
        ["stage", "phase", "code", "conclusion"].includes(x),
      ),
    "journal_event_invalid",
  );
  if (Object.hasOwn(event, "phase"))
    requireCi(
      [
        "reserve",
        "initial_admission",
        "pre_registration_admission",
        "pre_listener_admission",
        ...ADAPTER_METHODS,
      ].includes(event.phase),
      "journal_phase_invalid",
    );
  if (Object.hasOwn(event, "code"))
    requireCi(
      typeof event.code === "string" &&
        /^ci_factory_[a-z_]{1,64}$/.test(event.code),
      "journal_code_invalid",
    );
  if (Object.hasOwn(event, "conclusion"))
    requireCi(
      [
        "success",
        "failure",
        "cancelled",
        "timed_out",
        "action_required",
      ].includes(event.conclusion),
      "journal_conclusion_invalid",
    );
}

export async function openJobJournal(directory, assertHostPrivateDirectory) {
  requireCi(
    typeof directory === "string" &&
      resolve(directory) === directory &&
      typeof assertHostPrivateDirectory === "function",
    "journal_trust_guard_required",
  );
  await ordinary(directory, true);
  // Windows requires a native ACL/reparse/ancestor guard, not chmod or a boolean
  // caller assertion. The installed adapter provides it; no insecure default.
  await assertHostPrivateDirectory(directory);
  async function jobDirectory(key) {
    requireCi(
      typeof key === "string" && keyPattern.test(key),
      "journal_job_key_invalid",
    );
    const path = join(directory, key);
    await ordinary(path, true);
    await assertHostPrivateDirectory(path);
    return path;
  }
  async function evidence(key) {
    const path = await jobDirectory(key);
    const names = (await readdir(path)).sort();
    requireCi(
      names.includes("plan.json") &&
        names.length <= 130 &&
        names.every(
          (name) => name === "plan.json" || /^[0-9]{4}\.json$/.test(name),
        ),
      "journal_entries_invalid",
    );
    const plan = validateJobPlan(await read(join(path, "plan.json")));
    requireCi(plan.jobKey === key, "journal_identity_invalid");
    for (const [role, operation] of [
      ["client", plan.operationId],
      ["gateway", plan.gatewayOperationId],
    ]) {
      const owner = await read(
        join(directory, "operation-" + operation + ".json"),
      );
      requireCi(
        raw(owner) === raw({ version: 1, jobKey: key, role }),
        "journal_operation_binding_invalid",
      );
    }
    let previous = hash(raw(plan));
    const entries = [];
    for (const name of names.filter((name) => name !== "plan.json")) {
      requireCi(
        name === String(entries.length).padStart(4, "0") + ".json",
        "journal_sequence_invalid",
      );
      const entry = await read(join(path, name));
      requireCi(
        entry &&
          Object.keys(entry).sort().join("|") === "event|previous|sequence" &&
          entry.previous === previous &&
          entry.sequence === entries.length,
        "journal_chain_invalid",
      );
      validEvent(entry.event);
      previous = hash(raw(entry));
      entries.push(entry);
    }
    return { path, plan, entries, previous };
  }
  return {
    async reserve(plan) {
      validateJobPlan(plan);
      await assertHostPrivateDirectory(directory);
      // mkdir (nonrecursive, no exist_ok) reserves a GitHub job attempt forever.
      // A failed CreateNew leaves a quarantine marker, not permission to retry.
      const path = join(directory, plan.jobKey);
      await mkdir(path, { mode: 0o700 });
      await assertHostPrivateDirectory(path);
      // Also reserve VM operation IDs globally, across different GitHub jobs.
      // A UUID collision or a faulty provider cannot resurrect a prior disk
      // namespace just because the previous guest has already been deleted.
      for (const [role, operation] of [
        ["client", plan.operationId],
        ["gateway", plan.gatewayOperationId],
      ])
        await create(join(directory, "operation-" + operation + ".json"), {
          version: 1,
          jobKey: plan.jobKey,
          role,
        });
      await create(join(path, "plan.json"), plan);
    },
    async append(key, event) {
      validEvent(event);
      const item = await evidence(key);
      requireCi(item.entries.length < 128, "journal_full");
      const terminal = item.entries.at(-1)?.event.stage;
      requireCi(
        !["cleanup_verified", "quarantined"].includes(terminal),
        "journal_terminal",
      );
      await create(
        join(item.path, String(item.entries.length).padStart(4, "0") + ".json"),
        {
          sequence: item.entries.length,
          previous: item.previous,
          event,
        },
      );
    },
    read: evidence,
  };
}
