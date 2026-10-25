// Synthetic choices for isolated fixtures only. Production never imports this.
import { serviceConsentPolicy } from "@citygo/contracts";
import { createHash, randomUUID } from "node:crypto";
import type { Database } from "./index.js";
import { readFile } from "node:fs/promises";
export const syntheticServiceConsents = {
  policyVersion: serviceConsentPolicy.version,
  personalData: true as const,
  marketing: false,
};
export async function applyFixtureMigration(db: Database, name: string) {
  if (!/^\d{4}_[a-z_]+\.sql$/.test(name))
    throw new Error("Invalid fixture migration");
  const source = await readFile(
    new URL("../migrations/" + name, import.meta.url),
    "utf8",
  );
  const checksum = createHash("sha256")
    .update(source.replaceAll("\r\n", "\n"))
    .digest("hex");
  await db.transaction(async (tx) => {
    const applied = (
      await tx.query<{ checksum: string }>(
        "select checksum from citygo_migrations where name=$1",
        [name],
      )
    ).rows[0];
    if (applied) {
      if (applied.checksum !== checksum)
        throw new Error("Changed historical fixture migration");
      return;
    }
    await tx.exec(
      source.replace(/^begin;\s*/i, "").replace(/commit;\s*$/i, ""),
    );
    await tx.query(
      "insert into citygo_migrations(name,checksum) values($1,$2)",
      [name, checksum],
    );
  });
}

// Historical schema26–29 fixtures predate explicit service consent. Seed their
// actual old email-verification evidence without calling the new signup API or
// manufacturing a consent grant. The schema30 upgrade must leave them gated.
export async function seedLegacyVerifiedEmail(db: Database, email: string) {
  const digest = createHash("sha256").update(email).digest("hex"),
    id = randomUUID();
  return db.transaction(async (tx) => {
    const user = (
      await tx.query<{ id: string }>(
        "insert into users(auth_subject) values($1) returning id::text",
        [randomUUID()],
      )
    ).rows[0]!;
    await tx.query(
      "insert into user_credentials(user_id,email,password_hash) values($1,$2,'synthetic-historical-hash')",
      [user.id, email],
    );
    await tx.query(
      `insert into email_registrations(id,email,password_hash,proof_hash,code_hash,recipient_key,delivery,expires_at,consumed_user_id,consumed_at)
      values($1,$2,'synthetic-historical-hash',$3,$3,$3,'sent',clock_timestamp()+interval '10 minutes',$4,clock_timestamp())`,
      [id, email, digest, user.id],
    );
    await tx.query(
      "insert into account_email_verifications(user_id,registration_id,email) values($1,$2,$3)",
      [user.id, id, email],
    );
    await tx.query(
      "insert into sessions(token_hash,user_id,expires_at) values($1,$2,clock_timestamp()+interval '7 days')",
      [digest, user.id],
    );
    return user;
  });
}
