// Synthetic fixtures ONLY. Not imported by server.ts or any production module.
import type { Database } from "@citygo/db";
import type { readConfig } from "@citygo/config";
import type { ProviderMap } from "./provider.js";
import { createAiControl } from "./ai-control.js";
import { createAiExecution } from "./ai-execution.js";

export async function seedTestBudget(
  db: Database,
  config: ReturnType<typeof readConfig>,
  providers: ProviderMap,
) {
  if (config.NODE_ENV !== "test")
    throw new Error("Synthetic budget requires test configuration");
  const rules = createAiControl(config, providers).options.flatMap((option) =>
    option.policy
      ? [
          {
            ...createAiExecution(config, option.policy),
            attemptCeilingMicros: 1,
          },
        ]
      : [],
  );
  // One micro-unit per mock attempt is NOT a real price or a deployment default.
  await db.query(
    "update ai_budget set enabled=$1,currency='RUB',daily_limit_micros=1000000,total_limit_micros=1000000,rules=$2 where id=1",
    [rules.length > 0, JSON.stringify(rules)],
  );
}
