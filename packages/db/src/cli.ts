import "dotenv/config";
import { connectDatabase, migrate } from "./index.js";
const db = await connectDatabase(
  process.env.DATABASE_URL ?? "pglite://.local/database",
);
try {
  await migrate(db);
  console.log("CityGo migrations applied");
} finally {
  await db.close();
}
