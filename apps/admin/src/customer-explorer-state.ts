// Exact display of signed CityGo microroubles, including small charges/debt.
export function customerMoney(value: number) {
  if (!Number.isSafeInteger(value)) return "—";
  const micros = BigInt(value);
  const absolute = micros < 0n ? -micros : micros;
  const fraction = String(absolute % 1_000_000n)
    .padStart(6, "0")
    .replace(/0+$/, "");
  return `${micros < 0n ? "−" : ""}${(absolute / 1_000_000n).toLocaleString("ru-RU")}${fraction ? "," + fraction : ""} ₽`;
}

export function customerDate(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("ru-RU") : "—";
}

export const customerAgentNames: Record<string, string> = {
  housing: "Жильё",
  "job-search": "Работа",
  "resume-builder": "Резюме",
  "digital-mentor": "Город",
  support: "Поддержка",
  bubble: "Bubble",
};

export const customerRoleNames: Record<string, string> = {
  user: "Пользователь",
  admin: "Администратор",
  super_admin: "Super admin",
};

export const customerPlanStatus: Record<string, string> = {
  pending: "Нужно сделать",
  todo: "Нужно сделать",
  planned: "Запланировано",
  in_progress: "В работе",
  done: "Выполнено",
  completed: "Выполнено",
  skipped: "Пропущено",
};
