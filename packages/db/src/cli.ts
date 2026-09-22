import { connectDatabase, migrate } from "./index.js";
// The scoped launcher supplies DATABASE_URL. Never reload a broad .env here.
const db = await connectDatabase(
  process.env.DATABASE_URL ?? "pglite://.local/database",
);
try {
  await migrate(db);
  console.log("CityGo migrations applied");
} finally {
  await db.close();
}
