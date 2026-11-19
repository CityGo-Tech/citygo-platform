import type { Database, Sql } from "./index.js";
import { DomainError } from "./errors.js";

export type MessengerProvider = "telegram" | "max";
export type VerifiedMessengerLaunch = {
  provider: MessengerProvider;
  subject: string;
  fingerprint: string;
  expiresAt: number;
};

type OwnerSession = { userId: string; sessionTokenHash: string };
type ActiveAccount = {
  id: string;
  email: string;
  password_hash: string;
  email_verified: boolean;
  must_change_password: boolean;
};
const accountFields = `u.id::text,c.email,c.password_hash,u.must_change_password,
  exists(select 1 from account_email_verifications e where e.user_id=u.id and e.email=c.email) as email_verified`;

function checkId(value: string, maximum = 9223372036854775807n) {
  if (!/^[1-9][0-9]{0,18}$/.test(value) || BigInt(value) > maximum)
    throw new DomainError(400, "Некорректный идентификатор");
}

function checkProvider(provider: MessengerProvider) {
  if (provider !== "telegram" && provider !== "max")
    throw new DomainError(400, "Неизвестный мессенджер");
}

function checkTokenHash(value: string) {
  if (!/^[a-f0-9]{64}$/.test(value))
    throw new DomainError(400, "Некорректная сессия");
}

function invalidLaunch() {
  return new DomainError(409, "Откройте мини-приложение в мессенджере заново");
}

function checkProof(proof: VerifiedMessengerLaunch) {
  checkProvider(proof.provider);
  checkId(
    proof.subject,
    proof.provider === "telegram" ? 4503599627370495n : undefined,
  );
  if (
    !/^[a-f0-9]{64}$/.test(proof.fingerprint) ||
    !Number.isSafeInteger(proof.expiresAt) ||
    proof.expiresAt <= 0 ||
    proof.expiresAt > 253402300799
  )
    throw invalidLaunch();
}

async function lockAccountSecurity(tx: Sql) {
  // Password rotation, account blocking and consent transitions use this
  // singleton before the user and session locks. Keep the same order.
  const state = await tx.query(
    "select id from account_security_state where id=1 for update",
  );
  if (!state.rows.length)
    throw new DomainError(503, "Хранилище аккаунтов не готово");
}

async function activeOwner(tx: Sql, session: OwnerSession) {
  checkId(session.userId);
  checkTokenHash(session.sessionTokenHash);
  await lockAccountSecurity(tx);
  await tx.query("select id from users where id=$1 for update", [
    session.userId,
  ]);
  const account = (
    await tx.query<ActiveAccount>(
      `select ${accountFields} from sessions s
       join users u on u.id=s.user_id join user_credentials c on c.user_id=u.id
       where s.user_id=$1 and s.token_hash=$2 and s.expires_at>clock_timestamp()
       and u.status='active' for update of s`,
      [session.userId, session.sessionTokenHash],
    )
  ).rows[0];
  if (!account) throw new DomainError(401, "Войдите в аккаунт CityGo");
  if (account.must_change_password)
    throw new DomainError(403, "Сначала смените временный пароль");
  return account;
}

async function consumeLaunch(tx: Sql, proof: VerifiedMessengerLaunch) {
  // Bound the pruning work. A database trigger preserves live fingerprints
  // even though the API may delete expired entries.
  await tx.query(
    `delete from messenger_launch_consumptions
     where (provider,fingerprint) in (
       select provider,fingerprint from messenger_launch_consumptions
       where expires_at<=statement_timestamp() order by expires_at limit 64
     )`,
  );
  const receipt = await tx.query(
    `insert into messenger_launch_consumptions(provider,fingerprint,expires_at)
     select $1,$2,to_timestamp($3)
     where to_timestamp($3)>clock_timestamp()
       and to_timestamp($3)<=clock_timestamp()+interval '6 minutes'
     on conflict do nothing returning fingerprint`,
    [proof.provider, proof.fingerprint, proof.expiresAt],
  );
  if (receipt.rows.length !== 1) throw invalidLaunch();
}

export class MessengerAccounts {
  constructor(private db: Database) {}

  async list(userId: string): Promise<MessengerProvider[]> {
    checkId(userId);
    const { rows } = await this.db.query<{ provider: MessengerProvider }>(
      "select provider from messenger_accounts where user_id=$1 order by provider",
      [userId],
    );
    return rows.map(({ provider }) => provider);
  }

  async link(
    input: OwnerSession & {
      expectedPasswordHash: string;
      proof: VerifiedMessengerLaunch;
    },
  ): Promise<void> {
    const { proof } = input;
    checkProof(proof);
    await this.db.transaction(async (tx) => {
      const account = await activeOwner(tx, input);
      if (!account.email_verified)
        throw new DomainError(403, "Сначала подтвердите почту CityGo");
      if (account.password_hash !== input.expectedPasswordHash)
        throw new DomainError(401, "Подтвердите пароль CityGo заново");

      await consumeLaunch(tx, proof);
      const inserted = await tx.query(
        `insert into messenger_accounts(provider,subject,user_id)
         values($1,$2,$3) on conflict do nothing returning provider`,
        [proof.provider, proof.subject, account.id],
      );
      if (!inserted.rows.length)
        throw new DomainError(409, "Этот мессенджер уже привязан");
    });
  }

  async signIn({
    proof,
    newSessionTokenHash,
  }: {
    proof: VerifiedMessengerLaunch;
    newSessionTokenHash: string;
  }): Promise<{ id: string; email: string }> {
    checkProof(proof);
    checkTokenHash(newSessionTokenHash);
    return this.db.transaction(async (tx) => {
      await lockAccountSecurity(tx);
      const account = (
        await tx.query<ActiveAccount>(
          `select ${accountFields} from messenger_accounts l
           join users u on u.id=l.user_id join user_credentials c on c.user_id=u.id
           where l.provider=$1 and l.subject=$2 and u.status='active'
           for update of u`,
          [proof.provider, proof.subject],
        )
      ).rows[0];
      if (!account?.email_verified || account.must_change_password)
        throw new DomainError(401, "Войдите в CityGo по почте и паролю");
      await consumeLaunch(tx, proof);
      await tx.query(
        `insert into sessions(token_hash,user_id,expires_at,messenger_provider)
         values($1,$2,clock_timestamp()+interval '7 days',$3)`,
        [newSessionTokenHash, account.id, proof.provider],
      );
      return { id: account.id, email: account.email };
    });
  }

  async unlink(input: OwnerSession & { provider: MessengerProvider }) {
    checkProvider(input.provider);
    await this.db.transaction(async (tx) => {
      const account = await activeOwner(tx, input);
      await tx.query(
        "delete from messenger_accounts where user_id=$1 and provider=$2",
        [account.id, input.provider],
      );
    });
  }

  async revoke(input: OwnerSession & { provider: MessengerProvider }) {
    checkProvider(input.provider);
    await this.db.transaction(async (tx) => {
      const account = await activeOwner(tx, input);
      await tx.query(
        "delete from sessions where user_id=$1 and messenger_provider=$2",
        [account.id, input.provider],
      );
    });
  }
}
