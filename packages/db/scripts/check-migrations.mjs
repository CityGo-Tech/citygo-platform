import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const migrationUrl = new URL("../migrations/0001_initial.sql", import.meta.url);
const sql = await readFile(fileURLToPath(migrationUrl), "utf8");

const requiredTables = [
  "users",
  "relocation_profiles",
  "questionnaire_answers",
  "relocation_plans",
  "quests",
  "user_quests",
  "xp_events",
  "agent_threads",
  "messages",
  "agent_handoffs",
  "generated_artifacts",
  "knowledge_sources",
  "consent_events",
  "audit_log",
];

for (const table of requiredTables) {
  if (!sql.includes(`create table ${table}`)) {
    throw new Error(`Missing required table: ${table}`);
  }
}

if (!sql.includes("unique (user_id, event_key)")) {
  throw new Error("XP events must have an idempotency constraint");
}

console.log(`Migration contract verified: ${requiredTables.length} tables`);
