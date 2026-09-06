"use client";
import Link from "next/link";
import { useState } from "react";
import {
  Badge,
  Button,
  Card,
  Field,
  Progress,
  RadioGroup,
  SelectField,
} from "@citygo/ui-web";
import { tokens } from "@citygo/design-tokens";

export default function DesignSystem() {
  const [household, setHousehold] = useState("solo");
  return (
    <main className="design-system">
      <Link href="/">← В CityGo</Link>
      <h1>Компоненты CityGo</h1>
      <p>
        Токены Figma и элементы анкеты. Демонстрационные данные не сохраняются.
      </p>
      <div className="design-system-grid">
        <Card className="design-system-stack">
          <h2>Действия и состояния</h2>
          <Button>Основное действие</Button>
          <Button variant="secondary">Вторичное действие</Button>
          <Button variant="ghost">Текстовое действие</Button>
          <Button disabled>Недоступное действие</Button>
          <div className="design-system-row">
            <Badge>ШАГ 1 ИЗ 3</Badge>
            <Badge tone="success">Выполнено</Badge>
          </div>
          <Progress value={100 / 3} label="Прогресс — 33%" />
          <Progress value={100} label="Завершено" />
        </Card>
        <Card className="design-system-stack">
          <h2>Поля</h2>
          <Field
            label="Город"
            placeholder="Казань"
            hint="Название города отправления"
          />
          <Field
            label="Поле с ошибкой"
            defaultValue="К"
            error="Введите минимум два символа"
          />
          <Field label="Недоступное поле" defaultValue="Позже" disabled />
          <SelectField label="Направление" defaultValue="housing">
            <option value="housing">Жильё</option>
            <option value="job">Работа</option>
          </SelectField>
        </Card>
        <Card className="design-system-stack">
          <h2>Выбор вариантов</h2>
          <RadioGroup
            name="demo-household"
            label="Кто переезжает"
            value={household}
            onChange={setHousehold}
            options={[
              { value: "solo", label: "Один" },
              { value: "couple", label: "С партнёром" },
              { value: "family", label: "С семьёй" },
            ]}
          />
          <p role="status">Выбрано: {household}</p>
          <RadioGroup
            name="demo-goal"
            label="Цель"
            defaultValue="housing"
            tone="success"
            options={[
              { value: "housing", label: "Найти жильё" },
              { value: "job", label: "Найти работу", disabled: true },
            ]}
            hint="Недоступные направления исключены из выбора."
          />
        </Card>
        <Card className="design-system-stack">
          <h2>Цвета</h2>
          {(
            [
              "background",
              "foreground",
              "primary",
              "primaryStrong",
              "accentStrong",
              "success",
              "danger",
            ] as const
          ).map((key) => (
            <div key={key}>
              <div
                className="design-system-swatch"
                style={{ background: tokens.color[key] }}
              />
              <small>
                {key} · {tokens.color[key]}
              </small>
            </div>
          ))}
        </Card>
      </div>
    </main>
  );
}
