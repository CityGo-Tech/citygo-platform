import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import {
  AccountProfile,
  DomainError,
  MessengerAccounts,
  Repository,
  connectDatabase,
  migrate,
  type Database,
  type MessengerProvider,
  type VerifiedMessengerLaunch,
} from "./index.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const status = (n: number) => (error: unknown) =>
  error instanceof DomainError && error.statusCode === n;
const passwordHash = "synthetic-password-hash";

function launch(
  provider: MessengerProvider,
  subject: string,
  marker: string,
): VerifiedMessengerLaunch {
  return {
    provider,
    subject,
    fingerprint: hash(marker),
    expiresAt: Math.floor(Date.now() / 1000) + 240,
  };
}

async function seed(db: Database, label: string, verified = true) {
  const repo = new Repository(db);
  const email = `${label}@example.test`;
  const userId = await repo.register(email, passwordHash);
  const sessionTokenHash = hash(label);
  await repo.createSession(userId, sessionTokenHash);
  if (verified) {
    const profile = new AccountProfile(db);
    const confirmation = {
      userId,
      sessionTokenHash,
      id: randomUUID(),
      proofHash: hash(`${label}:proof`),
      codeHash: hash(`${label}:code`),
    };
    await profile.begin({
      ...confirmation,
      email,
      recipientKey: hash(`${label}:recipient`),
      ipKey: hash(`${label}:ip`),
    });
    await profile.markSent(confirmation.id, confirmation.codeHash);
    await profile.confirm(confirmation);
  }
  return { userId, sessionTokenHash, expectedPasswordHash: passwordHash };
}

async function local(t: TestContext) {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  return db;
}

test("link requires a live owned session, current password and verified CityGo email", async (t) => {
  const db = await local(t);
  const owner = await seed(db, "owner");
  const unverified = await seed(db, "unverified", false);
  const store = new MessengerAccounts(db);
  const proof = launch("telegram", "1001", "link");

  await assert.rejects(store.link({ ...unverified, proof }), status(403));
  await assert.rejects(
    store.link({
      ...owner,
      sessionTokenHash: unverified.sessionTokenHash,
      proof,
    }),
    status(401),
  );
  await assert.rejects(
    store.link({ ...owner, expectedPasswordHash: "previous-hash", proof }),
    status(401),
  );
  await assert.rejects(
    store.link({ ...owner, proof: { ...proof, expiresAt: 1 } }),
    status(409),
  );
  await assert.rejects(
    store.signIn({ proof, newSessionTokenHash: hash("before-link") }),
    status(401),
  );
  assert.deepEqual(await store.list(owner.userId), []);
  await store.link({ ...owner, proof });
  assert.deepEqual(await store.list(owner.userId), ["telegram"]);
  await assert.rejects(
    store.signIn({ proof, newSessionTokenHash: hash("reused-link") }),
    status(409),
  );
});

test("revoke and unlink affect only messenger sessions and a relink cannot replay a consumed launch", async (t) => {
  const db = await local(t);
  const owner = await seed(db, "first-owner");
  const next = await seed(db, "next-owner");
  const store = new MessengerAccounts(db);
  const repo = new Repository(db);
  const first = launch("telegram", "1001", "first-link");
  await store.link({ ...owner, proof: first });
  await store.link({ ...owner, proof: launch("max", "1001", "max-link") });
  await assert.rejects(
    store.link({ ...next, proof: launch("telegram", "1001", "wrong-owner") }),
    status(409),
  );
  await assert.rejects(
    store.link({ ...owner, proof: launch("telegram", "2001", "second-link") }),
    status(409),
  );
  const telegram = hash("telegram-session");
  const max = hash("max-session");
  const signIn = launch("telegram", "1001", "telegram-login");
  assert.deepEqual(
    await store.signIn({ proof: signIn, newSessionTokenHash: telegram }),
    {
      id: owner.userId,
      email: "first-owner@example.test",
    },
  );
  await store.signIn({
    proof: launch("max", "1001", "max-login"),
    newSessionTokenHash: max,
  });
  await assert.rejects(
    store.signIn({ proof: signIn, newSessionTokenHash: hash("repeat-login") }),
    status(409),
  );
  await assert.rejects(
    db.query("delete from messenger_launch_consumptions where fingerprint=$1", [
      signIn.fingerprint,
    ]),
    /Unexpired messenger launch consumption is immutable/,
  );
  await store.revoke({ ...owner, provider: "telegram" });
  assert.equal(await repo.session(telegram), undefined);
  assert.deepEqual(await store.list(owner.userId), ["max", "telegram"]);
  assert.ok(await repo.session(max));
  assert.ok(await repo.session(owner.sessionTokenHash));

  const nextTelegram = hash("telegram-after-revocation");
  await store.signIn({
    proof: launch("telegram", "1001", "telegram-after-revocation"),
    newSessionTokenHash: nextTelegram,
  });
  await store.unlink({ ...owner, provider: "telegram" });
  assert.equal(await repo.session(nextTelegram), undefined);
  assert.ok(await repo.session(max));
  assert.ok(await repo.session(owner.sessionTokenHash));
  await assert.rejects(store.link({ ...next, proof: first }), status(409));
  await store.link({
    ...next,
    proof: launch("telegram", "1001", "new-owner-link"),
  });
  assert.deepEqual(await store.list(owner.userId), ["max"]);
  assert.deepEqual(await store.list(next.userId), ["telegram"]);
});

test(
  "PostgreSQL concurrent linking has one owner and unlink cannot leave a concurrently issued session",
  {
    skip: !process.env.TEST_DATABASE_URL && "Requires disposable PostgreSQL",
    timeout: 60000,
  },
  async (t) => {
    const url = new URL(process.env.TEST_DATABASE_URL!);
    assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
    assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
    assert.ok(
      ((url.port || "5432") === "5432" && url.pathname === "/citygo_test") ||
        (url.port === "55438" && url.pathname === "/citygo_synthetic"),
    );
    assert.equal(url.search, "");
    assert.equal(url.hash, "");
    const admin = await connectDatabase(url.toString());
    const name = "cg_messenger_" + randomUUID().replaceAll("-", "");
    const cleanup: { first?: Database; second?: Database; created?: true } = {};
    t.after(async () => {
      try {
        await cleanup.first?.close();
        await cleanup.second?.close();
        if (cleanup.created) await admin.exec(`drop database ${name}`);
      } finally {
        await admin.close();
      }
    });
    await admin.exec(`create database ${name} template template0`);
    cleanup.created = true;
    url.pathname = "/" + name;
    const db = await connectDatabase(url.toString());
    cleanup.first = db;
    const other = await connectDatabase(url.toString());
    cleanup.second = other;
    await migrate(db);
    const owners = [await seed(db, "owner-one"), await seed(db, "owner-two")];
    const first = new MessengerAccounts(db);
    const second = new MessengerAccounts(other);
    const outcomes = await Promise.allSettled([
      first.link({
        ...owners[0]!,
        proof: launch("telegram", "2011", "claim-one"),
      }),
      second.link({
        ...owners[1]!,
        proof: launch("telegram", "2011", "claim-two"),
      }),
    ]);
    const winner = outcomes.findIndex(
      (outcome) => outcome.status === "fulfilled",
    );
    assert.ok(winner >= 0);
    const loser = outcomes[1 - winner]!;
    assert.equal(loser.status, "rejected");
    if (loser.status === "rejected") assert.ok(status(409)(loser.reason));
    assert.deepEqual(await first.list(owners[winner]!.userId), ["telegram"]);
    assert.deepEqual(await second.list(owners[1 - winner]!.userId), []);

    const issued = hash("concurrent-messenger-session");
    const [signIn, unlink] = await Promise.allSettled([
      first.signIn({
        proof: launch("telegram", "2011", "concurrent-login"),
        newSessionTokenHash: issued,
      }),
      second.unlink({ ...owners[winner]!, provider: "telegram" }),
    ]);
    assert.equal(unlink.status, "fulfilled");
    if (signIn.status === "rejected") assert.ok(status(401)(signIn.reason));
    assert.equal(await new Repository(db).session(issued), undefined);
    assert.deepEqual(await first.list(owners[winner]!.userId), []);
    t.diagnostic("Independent PostgreSQL pools, same account-security lock");
  },
);
