"use client";
import Image from "next/image";
import type { FormEventHandler } from "react";
import {
  Badge,
  Button,
  Card,
  Field,
  Progress,
  RadioGroup,
} from "@citygo/ui-web";

export function QuestionnaireForm({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: FormEventHandler<HTMLFormElement>;
}) {
  return (
    <div className="onboarding">
      <section className="onboarding-intro">
        <Badge>ШАГ 1 ИЗ 3</Badge>
        <h1>
          <span className="onboarding-desktop-title">
            Начнём ваш
            <br />
            <em>переезд как квест</em>
          </span>
          <span className="onboarding-mobile-title">
            Ваш переезд
            <br />
            <em>начинается здесь</em>
          </span>
        </h1>
        <p>
          Ответьте на несколько вопросов — соберём персональный маршрут и
          подключим нужных агентов.
        </p>
        <figure className="onboarding-guide">
          <Image
            src="/figma/questionnaire-support.png"
            alt="Support Assistant — координатор переезда CityGo"
            width={400}
            height={400}
            sizes="400px"
            priority
          />
          <figcaption>
            <small>SUPPORT ASSISTANT</small>
            <strong>Координатор переезда</strong>
          </figcaption>
        </figure>
      </section>
      <Card className="onboarding-card">
        <h2>Расскажите о переезде</h2>
        <p>План можно будет изменить позже</p>
        <Progress value={100 / 3} label="Прогресс маршрута — шаг 1 из 3" />
        <form onSubmit={onSubmit} aria-busy={busy}>
          <fieldset className="onboarding-fields" disabled={busy}>
            <legend className="sr-only">Данные о переезде</legend>
            <div className="form-grid">
              <Field
                label="Откуда переезжаете"
                name="originCity"
                minLength={2}
                maxLength={100}
                required
                placeholder="Казань"
                autoComplete="off"
              />
              <Field
                label="Город назначения"
                name="targetCity"
                minLength={2}
                maxLength={100}
                required
                placeholder="Москва"
                autoComplete="off"
              />
            </div>
            <div className="form-grid">
              <Field
                label="Планируемая дата переезда"
                name="moveTargetDate"
                type="date"
                min={new Date().toISOString().slice(0, 10)}
                required
              />
              <Field
                label="Бюджет аренды в месяц, ₽"
                name="monthlyBudget"
                type="number"
                min={5000}
                max={1000000}
                step={1000}
                required
                placeholder="65000"
              />
            </div>
            <RadioGroup
              label="Кто переезжает"
              name="household"
              defaultValue="solo"
              options={[
                { value: "solo", label: "Один" },
                { value: "couple", label: "С партнёром" },
                { value: "family", label: "С семьёй" },
              ]}
            />
            <RadioGroup
              label="Главная цель сейчас"
              name="goal"
              defaultValue="housing"
              tone="success"
              options={[
                { value: "housing", label: "Найти жильё" },
                { value: "job", label: "Найти работу", disabled: true },
                { value: "documents", label: "Документы", disabled: true },
              ]}
              hint="Сейчас доступен жилищный маршрут. Остальные направления появятся позже."
            />
            <label className="check">
              <input type="checkbox" name="aiConsent" required />
              <span>
                Разрешаю передавать город, бюджет, дату и состав семьи
                AI-провайдеру для персональных рекомендаций. Не буду отправлять
                документы и платёжные данные.
              </span>
            </label>
            <Button disabled={busy} type="submit">
              {busy ? "Строим ваш план…" : "Построить план переезда"}
            </Button>
          </fieldset>
          <small className="onboarding-note">Это займёт около минуты</small>
        </form>
      </Card>
    </div>
  );
}
