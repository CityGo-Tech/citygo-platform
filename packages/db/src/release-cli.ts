import { fileURLToPath } from "node:url";
import { connectDatabase, type Database } from "./index.js";
import {
  loadReleaseMigrationAssets,
  migrateRelease,
  parseReleaseMigrationPlan,
  releaseInputLimit,
} from "./release-migration.js";

// Internal executor only: fixed assets from the verified jobs image, no URLs,
// arbitrary file paths or SQL supplied on stdin. Not a host deployment command.
let db: Database | undefined;
const deadline = setTimeout(() => process.exit(1), 150000);
const inputDeadline = setTimeout(() => process.exit(1), 10000);
try {
  if (
    process.argv.length !== 2 ||
    !/^postgres(?:ql)?:\/\//.test(process.env.DATABASE_URL ?? "")
  )
    throw new Error();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > releaseInputLimit) throw new Error();
    chunks.push(bytes);
  }
  clearTimeout(inputDeadline);
  const plan = parseReleaseMigrationPlan(
    new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
  );
  const assets = await loadReleaseMigrationAssets(
    fileURLToPath(new URL("../migrations/", import.meta.url)),
    "/app/release-grants.sql",
  );
  db = await connectDatabase(process.env.DATABASE_URL!);
  const result = await migrateRelease(db, plan, assets);
  await db.close();
  db = undefined;
  process.stdout.write(JSON.stringify(result) + "\n");
} catch {
  // Never expose SQL, provider credentials, connection URLs or raw DB errors.
  process.stderr.write(
    "Release migration failed; keep maintenance closed and reconcile before any retry\n",
  );
  process.exitCode = 1;
} finally {
  clearTimeout(inputDeadline);
  try {
    await db?.close();
  } catch {
    process.exitCode = 1;
  }
  clearTimeout(deadline);
}
