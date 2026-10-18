"use client";
import { useState } from "react";
import {
  accountRoleSchema,
  type AccountRole,
  type AccountUser,
} from "@citygo/contracts";
import { Button, Card, SelectField } from "@citygo/ui-web";

const roleNames: Record<AccountRole, string> = {
  user: "Пользователь",
  admin: "Администратор",
  super_admin: "Super admin",
};

export function AccountsControl({
  users,
  viewerId,
  busy,
  onSave,
}: {
  users: AccountUser[];
  viewerId: string;
  busy: boolean;
  onSave: (userId: string, role: AccountRole) => void;
}) {
  return (
    <Card>
      <h2>Аккаунты и роли</h2>
      <p>
        Только super admin может выдавать и отзывать роли. Показаны первые 200
        аккаунтов.
      </p>
      <p>
        Последнего super admin нельзя понизить. Права проверяются сервером при
        каждом действии.
      </p>
      {users.length ? (
        users.map((user) => (
          <AccountRoleRow
            key={user.id}
            user={user}
            own={user.id === viewerId}
            busy={busy}
            onSave={onSave}
          />
        ))
      ) : (
        <p>Аккаунтов нет.</p>
      )}
    </Card>
  );
}

function AccountRoleRow({
  user,
  own,
  busy,
  onSave,
}: {
  user: AccountUser;
  own: boolean;
  busy: boolean;
  onSave: (userId: string, role: AccountRole) => void;
}) {
  const [role, setRole] = useState(user.role ?? "");
  const [confirmed, setConfirmed] = useState(false);
  const parsed = accountRoleSchema.safeParse(role);
  return (
    <div>
      <h3>
        {user.username ?? user.email}
        {own ? " · ваш аккаунт" : ""}
      </h3>
      <p>
        ID {user.id} · {user.email} ·{" "}
        {user.role ? roleNames[user.role] : "Роль не указана сервером"}
      </p>
      {user.mustChangePassword && <p>Требуется смена временного пароля.</p>}
      <SelectField
        label={`Новая роль для ${user.username ?? user.email}`}
        value={role}
        disabled={busy || own}
        onChange={(event) => {
          const value = event.target.value;
          if (!accountRoleSchema.safeParse(value).success) return;
          setRole(value as AccountRole);
          setConfirmed(false);
        }}
      >
        {!user.role && (
          <option value="" disabled>
            Выберите роль
          </option>
        )}
        {accountRoleSchema.options.map((value) => (
          <option key={value} value={value}>
            {roleNames[value]}
          </option>
        ))}
      </SelectField>
      {own && <p>Вашу роль может изменить только другой super admin.</p>}
      <label className="check">
        <input
          type="checkbox"
          disabled={busy || own || !parsed.success || role === user.role}
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
        />
        Подтверждаю изменение роли аккаунта {user.id}
      </label>
      <Button
        disabled={
          busy || own || !confirmed || !parsed.success || role === user.role
        }
        onClick={() => {
          if (confirmed && parsed.success && parsed.data !== user.role)
            onSave(user.id, parsed.data);
        }}
      >
        Сохранить роль
      </Button>
    </div>
  );
}
