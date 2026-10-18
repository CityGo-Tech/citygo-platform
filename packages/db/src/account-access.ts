import { randomUUID } from "node:crypto";
import type { Database, Sql } from "./index.js";
import { DomainError } from "./errors.js";

export type AccountRole = "user" | "admin" | "super_admin";
export type AccountInfo = {
  id: string;
  email: string;
  username: string | null;
  role: AccountRole;
  mustChangePassword: boolean;
};
export type AccountCredentials = AccountInfo & { password_hash: string };

const fields = `u.id::text,c.email,u.username,u.role,
  u.must_change_password as "mustChangePassword"`;
const validId = (value: string) => {
  if (!/^[1-9]\d{0,18}$/.test(value) || BigInt(value) > 9223372036854775807n)
    throw new DomainError(400, "Некорректный идентификатор аккаунта");
};
function validHash(value: string) {
  if (!value || value.length > 2048)
    throw new DomainError(400, "Некорректный хэш пароля");
}
async function lockSecurity(tx: Sql) {
  const state = (
    await tx.query<{ bootstrap_completed: boolean }>(
      "select bootstrap_completed from account_security_state where id=1 for update",
    )
  ).rows[0];
  if (!state) throw new DomainError(503, "Хранилище аккаунтов не готово");
  return state;
}
async function account(tx: Sql, userId: string) {
  return (
    await tx.query<AccountInfo>(
      `select ${fields} from users u join user_credentials c on c.user_id=u.id
       where u.id=$1 and u.status='active'`,
      [userId],
    )
  ).rows[0];
}
function requireSuperAdmin(actor: AccountInfo | undefined) {
  if (!actor || actor.role !== "super_admin" || actor.mustChangePassword)
    throw new DomainError(
      403,
      "Требуются права супер-администратора и смена временного пароля",
    );
}
async function audit(
  tx: Sql,
  actorId: string,
  action: string,
  targetId: string,
  payload: Record<string, unknown>,
) {
  await tx.query(
    "insert into audit_log(actor_user_id,action,entity_type,entity_id,payload) values ($1,$2,'account',$3,$4::jsonb)",
    [actorId, action, targetId, JSON.stringify(payload)],
  );
}

export class AccountAccess {
  constructor(private db: Database) {}

  async info(userId: string): Promise<AccountInfo | undefined> {
    validId(userId);
    return account(this.db, userId);
  }

  async credentials(
    identifier: string,
  ): Promise<AccountCredentials | undefined> {
    const login = identifier.trim().toLowerCase();
    if (!login || login.length > 254) return undefined;
    return (
      await this.db.query<AccountCredentials>(
        `select ${fields},c.password_hash from users u
         join user_credentials c on c.user_id=u.id
         where u.status='active' and (u.username=$1 or c.email=$1)`,
        [login],
      )
    ).rows[0];
  }

  // Password verification is intentionally outside the transaction (scrypt can
  // be expensive). Recheck the exact verified hash under the same lock used by
  // password rotation so an already-revoked password cannot open a new session.
  async createVerifiedSession(
    userId: string,
    expectedOldHash: string,
    newTokenHash: string,
  ): Promise<AccountInfo> {
    validId(userId);
    validHash(expectedOldHash);
    if (!/^[a-f0-9]{64}$/.test(newTokenHash))
      throw new DomainError(400, "Некорректная новая сессия");
    return this.db.transaction(async (tx) => {
      await lockSecurity(tx);
      await tx.query("select id from users where id=$1 for update", [userId]);
      const current = (
        await tx.query<AccountCredentials>(
          `select ${fields},c.password_hash from users u
           join user_credentials c on c.user_id=u.id
           where u.id=$1 and u.status='active'`,
          [userId],
        )
      ).rows[0];
      if (!current || current.password_hash !== expectedOldHash)
        throw new DomainError(401, "Неверный логин или пароль");
      await tx.query(
        "insert into sessions(token_hash,user_id,expires_at) values ($1,$2,now()+interval '7 days')",
        [newTokenHash, userId],
      );
      return {
        id: current.id,
        email: current.email,
        username: current.username,
        role: current.role,
        mustChangePassword: current.mustChangePassword,
      };
    });
  }

  async list(actorId: string): Promise<AccountInfo[]> {
    validId(actorId);
    return this.db.transaction(async (tx) => {
      await lockSecurity(tx);
      await tx.query("select id from users where id=$1 for update", [actorId]);
      requireSuperAdmin(await account(tx, actorId));
      return (
        await tx.query<AccountInfo>(
          `select ${fields} from users u join user_credentials c on c.user_id=u.id
           where u.status='active' order by u.id desc limit 200`,
        )
      ).rows;
    });
  }

  async setRole(
    actorId: string,
    targetId: string,
    role: AccountRole,
  ): Promise<AccountInfo> {
    validId(actorId);
    validId(targetId);
    if (!["user", "admin", "super_admin"].includes(role))
      throw new DomainError(400, "Неизвестная роль аккаунта");
    return this.db.transaction(async (tx) => {
      await lockSecurity(tx);
      await tx.query(
        "select id from users where id=$1 or id=$2 order by id for update",
        [actorId, targetId],
      );
      requireSuperAdmin(await account(tx, actorId));
      const target = await account(tx, targetId);
      if (!target) throw new DomainError(404, "Аккаунт не найден");
      if (target.role === role) return target;
      if (target.role === "super_admin" && role !== "super_admin") {
        const count = (
          await tx.query<{ total: number }>(
            "select count(*)::int as total from users where status='active' and role='super_admin'",
          )
        ).rows[0]!.total;
        if (count <= 1)
          throw new DomainError(
            409,
            "Нельзя понизить последнего супер-администратора",
          );
      }
      if (actorId === targetId)
        throw new DomainError(
          409,
          "Свою роль должен менять другой супер-администратор",
        );
      await tx.query("update users set role=$2,updated_at=now() where id=$1", [
        targetId,
        role,
      ]);
      // Force the target to authenticate again after any privilege change.
      await tx.query("delete from sessions where user_id=$1", [targetId]);
      await audit(tx, actorId, "account-role-changed", targetId, {
        previousRole: target.role,
        role,
      });
      return { ...target, role };
    });
  }

  async changePassword(
    userId: string,
    expectedOldHash: string,
    newHash: string,
    newTokenHash: string,
  ): Promise<AccountInfo> {
    validId(userId);
    validHash(expectedOldHash);
    validHash(newHash);
    if (!/^[a-f0-9]{64}$/.test(newTokenHash))
      throw new DomainError(400, "Некорректная новая сессия");
    return this.db.transaction(async (tx) => {
      await lockSecurity(tx);
      await tx.query("select id from users where id=$1 for update", [userId]);
      const user = await account(tx, userId);
      if (!user) throw new DomainError(401, "Войдите в аккаунт");
      const changed = await tx.query(
        "update user_credentials set password_hash=$3 where user_id=$1 and password_hash=$2 returning user_id",
        [userId, expectedOldHash, newHash],
      );
      if (changed.rows.length !== 1)
        throw new DomainError(
          409,
          "Пароль уже изменён. Войдите в аккаунт заново",
        );
      await tx.query(
        "update users set must_change_password=false,updated_at=now() where id=$1",
        [userId],
      );
      await tx.query("delete from sessions where user_id=$1", [userId]);
      await tx.query(
        "insert into sessions(token_hash,user_id,expires_at) values ($1,$2,now()+interval '7 days')",
        [newTokenHash, userId],
      );
      await audit(tx, userId, "account-password-changed", userId, {
        sessionsRevoked: true,
      });
      return { ...user, mustChangePassword: false };
    });
  }

  // Operator command only. No password hashing, network I/O or automatic startup
  // call belongs inside this transaction. The caller enforces a closed bootstrap.
  async bootstrapAdmin(passwordHash: string): Promise<AccountInfo> {
    validHash(passwordHash);
    return this.db.transaction(async (tx) => {
      const state = await lockSecurity(tx);
      if (state.bootstrap_completed)
        throw new DomainError(
          409,
          "Первичная настройка администратора уже выполнена",
        );
      // Registration does not use the singleton. This short table lock makes the
      // empty check and initial insert atomic relative to ordinary registration.
      await tx.exec("lock table users in share row exclusive mode");
      if ((await tx.query("select 1 from users limit 1")).rows.length)
        throw new DomainError(
          409,
          "Первичная настройка разрешена только для пустой базы аккаунтов",
        );
      const user = (
        await tx.query<{ id: string }>(
          "insert into users(auth_subject,username,role,must_change_password) values ($1,'admin','super_admin',true) returning id::text",
          [randomUUID()],
        )
      ).rows[0]!;
      await tx.query(
        "insert into user_credentials(user_id,email,password_hash) values ($1,'admin@citygo.invalid',$2)",
        [user.id, passwordHash],
      );
      await tx.query(
        "update account_security_state set bootstrap_completed=true where id=1",
      );
      await audit(tx, user.id, "account-bootstrap-completed", user.id, {
        role: "super_admin",
        username: "admin",
        mustChangePassword: true,
      });
      return (await account(tx, user.id))!;
    });
  }
}
