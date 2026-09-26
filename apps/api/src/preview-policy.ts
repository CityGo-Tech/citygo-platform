import { readConfig } from "@citygo/config";
import { createAiPolicy } from "./ai-policy.js";

// Deliberately no provider constructor, DB, file writes or inherited credentials.
// API-scoped launchers may load .env.api; print only the public consent snapshot.
try {
  const config = readConfig({
    ROUTERAI_MODEL: process.env.ROUTERAI_MODEL,
    ROUTERAI_UPSTREAM: process.env.ROUTERAI_UPSTREAM,
    ROUTERAI_COUNTRY: process.env.ROUTERAI_COUNTRY,
    ROUTERAI_DATA_NOTICE: process.env.ROUTERAI_DATA_NOTICE,
  });
  if (
    !config.ROUTERAI_MODEL ||
    !config.ROUTERAI_UPSTREAM ||
    !config.ROUTERAI_DATA_NOTICE
  )
    throw new Error();
  console.log(
    JSON.stringify(
      createAiPolicy(config, {
        name: "routerai",
        model: config.ROUTERAI_MODEL,
      }),
      null,
      2,
    ),
  );
} catch {
  console.error(
    "Set RouterAI model, upstream and public operator notice; invalid values are hidden",
  );
  process.exitCode = 1;
}
