import { connectDatabase, type Database } from "@citygo/db";
import { runWorkerOnce } from "./shutdown.js";
export async function maintain(db: Database) {
  return db.transaction(async (tx) => {
    await tx.query("delete from sessions where expires_at<now()");
    const expired = (
      await tx.query<{ id: string }>(
        "select id::text from agent_threads where busy_until<now() order by id limit 100 for update skip locked",
      )
    ).rows;
    for (const thread of expired) {
      await tx.query(
        "update chat_requests set status='interrupted' where status='running' and thread_id=$1",
        [thread.id],
      );
      await tx.query(
        "update agent_threads set busy_until=null,lease_token=null where id=$1",
        [thread.id],
      );
    }
    // Analytics contain only event names and internal IDs. Bound retention.
    await tx.query(
      "delete from analytics_events where created_at<now()-interval '90 days'",
    );
  });
}
if (process.argv.includes("--once")) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || !/^postgres(?:ql)?:\/\//.test(databaseUrl))
    throw new Error(
      "Worker requires server PostgreSQL; do not open the API's local PGlite directory twice",
    );
  try {
    const result = await runWorkerOnce(
      () => connectDatabase(databaseUrl),
      maintain,
    );
    console.log(
      result === "completed"
        ? "CityGo maintenance completed"
        : "CityGo worker stopped before maintenance",
    );
  } catch {
    console.error(
      "CityGo worker failed; maintenance completion is not confirmed",
    );
    // A timed-out connect/transaction/close may still hold sockets. Do not hang
    // indefinitely or let a later resolution turn this failure into success.
    process.exit(1);
  }
}
