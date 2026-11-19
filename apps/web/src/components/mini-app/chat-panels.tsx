import {
  aiModeLabels,
  type AiModeId,
  type AiModes,
  type WebSources,
} from "@citygo/contracts";
import { AssistantAnswerSources, Button, Card } from "@citygo/ui-web";
import type { JourneyProps } from "../journey";
import { selectableAiMode } from "../ai-mode-picker-state";
import styles from "./mini-workspace.module.css";

const modeDescriptions: Record<AiModeId, string> = {
  maximum: "Подробный ответ и поиск свежей информации, когда он нужен.",
  balanced: "Для повседневных задач и разговора.",
  minimum: "Короткий ответ.",
};

export function MiniChatModes({
  modes,
  selected,
  disabled,
  available,
  onSelect,
}: {
  modes?: AiModes;
  selected: AiModeId;
  disabled: boolean;
  available: boolean;
  onSelect: (mode: AiModeId) => void;
}) {
  return (
    <section className={styles.chatScreen} data-mini-chat-screen>
      <h1 tabIndex={-1}>Режим работы</h1>
      <p>Режим применяется к следующим ответам.</p>
      <div
        className={styles.modeOptions}
        role="group"
        aria-label="Выберите режим"
      >
        {(Object.keys(modeDescriptions) as AiModeId[]).map((mode) => {
          const enabled =
            !disabled &&
            (!available || selectableAiMode(modes, mode, disabled));
          return (
            <Button
              key={mode}
              className={styles.chatRow}
              variant="secondary"
              aria-label={aiModeLabels[mode]}
              aria-pressed={mode === selected}
              disabled={!enabled}
              onClick={() => enabled && onSelect(mode)}
            >
              <strong>{aiModeLabels[mode]}</strong>
              <small>{modeDescriptions[mode]}</small>
            </Button>
          );
        })}
      </div>
      {available && <p>Стоимость списывается после успешного ответа.</p>}
    </section>
  );
}

export function MiniChatSources({
  content,
  sources,
  onClose,
}: {
  content: string;
  sources: WebSources;
  onClose: () => void;
}) {
  return (
    <section className={styles.chatScreen} data-mini-chat-screen>
      <h1 tabIndex={-1}>Источники ответа</h1>
      <p>Проверьте сведения на сайтах источников.</p>
      <AssistantAnswerSources content={content} webSources={sources} />
      <Button variant="ghost" onClick={onClose}>
        Вернуться к ответу
      </Button>
    </section>
  );
}

type Recovery = NonNullable<NonNullable<JourneyProps["miniChat"]>["recovery"]>;
const recoveryCopy: Record<Recovery["status"], string> = {
  unchecked:
    "Состояние запроса неизвестно. Проверьте, появился ли ответ в диалоге.",
  checking: "Проверяем состояние запроса.",
  missing: "Запрос не найден в истории.",
  running: "Запрос уже принят. Проверьте диалог позже.",
  complete: "Ответ сохранён в диалоге.",
  interrupted: "Запрос сохранён с отметкой о прерванном ответе.",
};

export function MiniChatRecovery({
  recovery,
  disabled,
}: {
  recovery: Recovery;
  disabled: boolean;
}) {
  const { status } = recovery;
  const checkedResult =
    status === "missing" || status === "complete" || status === "interrupted";
  return (
    <section className={styles.chatScreen} data-mini-chat-screen>
      <h1 tabIndex={-1}>
        {status === "complete" ? "Ответ найден" : "Проверьте диалог"}
      </h1>
      <Card className={styles.recoveryNote}>
        <p role="status">{recoveryCopy[status]}</p>
      </Card>
      {!checkedResult && (
        <Button
          disabled={disabled || status === "checking"}
          onClick={recovery.onCheck}
        >
          Проверить диалог
        </Button>
      )}
      {status === "missing" && recovery.canRetry && (
        <Button disabled={disabled} onClick={recovery.onRetry}>
          Повторить отправку
        </Button>
      )}
      {checkedResult && recovery.canDismiss && (
        <Button
          variant="secondary"
          disabled={disabled}
          onClick={recovery.onDismiss}
        >
          {status === "missing" ? "Удалить черновик" : "Вернуться к диалогу"}
        </Button>
      )}
    </section>
  );
}
