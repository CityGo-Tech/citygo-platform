"use client";
import type { ReactNode } from "react";
import Image from "next/image";
import type { AgentKey } from "@citygo/contracts";
import { Button, Card } from "@citygo/ui-web";
import { agentNames } from "./agent-names";
import { assistantTitle } from "./assistant-conversations";
import { assistantPortrait } from "./assistant-portrait";

const journeyTopics = [
  ["Понять и спланировать", "Не понимаю, с чего начать переезд в Москву."],
  ["Найти жильё", "Хочу обсудить поиск жилья в Москве."],
  ["Работа и резюме", "Как подготовиться к поиску работы в Москве?"],
  ["Переезд и вещи", "Как подготовить поездку и перевозку вещей?"],
  [
    "Освоиться в городе",
    "Как разобраться в транспорте и городских сервисах Москвы?",
  ],
  ["Свои люди", "Как найти своё окружение после переезда?"],
] as const;

/** Shared Figma 6:24 frame; state and operations stay with its calling view. */
export function WorkspaceFrame({
  children,
  sidebar,
  rail,
}: {
  children: ReactNode;
  sidebar: ReactNode;
  rail: ReactNode;
}) {
  return (
    <div className="conversation-workspace">
      {sidebar}
      <div className="conversation-main">{children}</div>
      {rail}
    </div>
  );
}

/** Topic actions prepare a draft only; this component never sends a message. */
export function JourneySidebar({
  disabled,
  onSuggest,
  onSupport,
}: {
  disabled: boolean;
  onSuggest: (text: string) => void;
  onSupport: () => void;
}) {
  return (
    <aside className="conversation-topics">
      <Card>
        <span className="eyebrow">ВАШ ПУТЬ В МОСКВУ</span>
        {journeyTopics.map(([label, text]) => (
          <Button
            key={label}
            variant="secondary"
            disabled={disabled}
            onClick={() => onSuggest(text)}
          >
            {label}
          </Button>
        ))}
        <div className="conversation-note">
          <strong>В вашем темпе</strong>
          <p>Можно начать с любой задачи. Необязательно знать срок и бюджет.</p>
        </div>
        <Image
          src="/figma/support-assistant.png"
          width={64}
          height={64}
          alt="Координатор переезда CityGo"
        />
        <Button variant="secondary" disabled={disabled} onClick={onSupport}>
          Помощь человека
        </Button>
      </Card>
    </aside>
  );
}

/** Displays the actual selected assistant, never a fabricated account context. */
export function AssistantContextRail({
  agent,
  disabled,
  onHelpers,
  modeSelector,
  onKnowledge,
  knowledgeAvailable,
  city,
}: {
  agent: AgentKey;
  disabled: boolean;
  onHelpers: () => void;
  modeSelector?: ReactNode;
  onKnowledge?: () => void;
  knowledgeAvailable?: boolean;
  city?: string | null;
}) {
  return (
    <aside className="conversation-context">
      <Card>
        <span className="eyebrow">ВАШ AI-ПОМОЩНИК</span>
        <Image
          src={assistantPortrait(agent)}
          width={240}
          height={240}
          alt={agentNames[agent]}
        />
        <h2>{agentNames[agent]}</h2>
        <p className="assistant-specialty">{assistantTitle(agent)}</p>
        {city && <p>Ваш переезд: {city}</p>}
        <p>Начните с вопроса. Помощник уточнит нужное по ходу разговора.</p>
        {modeSelector}
        {onKnowledge && (
          <Button
            variant="secondary"
            disabled={disabled || !knowledgeAvailable}
            onClick={onKnowledge}
          >
            Что помощники знают
          </Button>
        )}
        <Button variant="secondary" disabled={disabled} onClick={onHelpers}>
          Сменить помощника
        </Button>
      </Card>
    </aside>
  );
}
