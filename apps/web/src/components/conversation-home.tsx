"use client";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { JourneySidebar, AssistantContextRail } from "./workspace-frame";
import { Button, Card, Badge, AssistantMessage } from "@citygo/ui-web";
import { agentNames, type JourneyProps } from "./journey";
import { FavoriteButton } from "./message-favorites";
import { EmptyAiCreditHint, messageInterruptionLabel } from "./chat-readiness";
import type { AgentKey } from "@citygo/contracts";
import {
  AssistantCatalog,
  ConversationList,
  assistantTitle,
} from "./assistant-conversations";
import {
  ConversationHistoryControls,
  conversationHistoryStyles,
  useHistoryScrollAnchor,
} from "./conversation-history";
import {
  PersonalPlanPanel,
  PlanStepComposer,
  type PlanMessageSource,
} from "./personal-plan";
import planStyles from "./personal-plan.module.css";
import { AccountProfile } from "./account-profile";
import { HumanSupportPanel } from "./human-support";
import { SupportUpdatesNotice } from "./support-updates";
import { ResultsLibrary } from "./results-library";
import { AiModeSelector } from "./ai-mode-selector";
import { isAiModeAvailable } from "@citygo/api-client";
import { trackProductEvent } from "./product-analytics";
import { TextMaterialPreview } from "./text-material-preview";
import { AssistantHandoffDialog } from "./assistant-handoff";
import {
  currentAssistantHandoffSource,
  type AssistantHandoffSource,
} from "./assistant-handoff-state";
import { MessageTextActions } from "./message-text-actions";
import { ConversationMessageSearch } from "./conversation-message-search";
import { ConversationExportAction } from "./conversation-export";

const greeting =
  "Здравствуйте! Я координатор CityGo. Помогу разложить переезд на понятные шаги. Можно просто рассказать, что сейчас волнует — даже если бюджет и дата ещё неизвестны.";

/** Conversation home and user-selected plan, from Figma 6:14 / 6:24. */
export function ConversationHome(props: JourneyProps) {
  const [tab, setTab] = useState("Диалоги");
  const [navigationHost, setNavigationHost] = useState<HTMLElement | null>(
    null,
  );
  useEffect(() => {
    setNavigationHost(
      props.headerNavigationId
        ? document.getElementById(props.headerNavigationId)
        : null,
    );
  }, [props.headerNavigationId]);
  useEffect(() => {
    if (!props.workspaceRequest) return;
    setTab(props.workspaceRequest.tab);
    setShowList(false);
    props.onWorkspaceRequestHandled?.(props.workspaceRequest.sequence);
  }, [props.workspaceRequest, props.onWorkspaceRequestHandled]);
  const [supportSelection, setSupportSelection] = useState<{
    owner: string;
    signal: AbortSignal;
    id: string;
  } | null>(null);
  const supportRequestId =
    !props.sessionSignal.aborted &&
    supportSelection?.owner === props.board.user.id &&
    supportSelection.signal === props.sessionSignal
      ? supportSelection.id
      : null;
  const [showList, setShowList] = useState(false);
  const [planSource, setPlanSource] = useState<PlanMessageSource | null>(null);
  const [planGeneration, setPlanGeneration] = useState(0);
  const [handoffSource, setHandoffSource] =
    useState<AssistantHandoffSource | null>(null);
  const { board, busy, sending } = props;
  const log = useRef<HTMLDivElement>(null);
  const historyScroll = useHistoryScrollAnchor(
    log,
    board.thread?.messages ?? [],
    {
      threadId: board.thread?.id,
      detached: props.history?.detached,
      draft: props.draft,
      pending: props.pending,
    },
  );
  const agent = props.streamAgent ?? board.thread?.agentKey ?? "support";
  const contextAgent = ["Мой план", "Результаты", "Помощь человека"].includes(
    tab,
  )
    ? "support"
    : agent;
  const canSend =
    !!board.thread &&
    isAiModeAvailable(
      board.aiAccess.modes,
      props.aiMode ?? "balanced",
      board.provider !== "unconfigured",
    ) &&
    !board.thread.closed &&
    !props.history?.detached &&
    !busy;
  const suggest = (text: string) => {
    props.onText(text);
    setTab("Диалоги");
    setShowList(false);
  };
  const begin = async (key?: AgentKey) => {
    const started = await props.onBegin?.(key);
    if (started) {
      setPlanSource(null);
      setTab("Диалоги");
      setShowList(false);
    }
    return !!started;
  };
  const open = async (id: string) => {
    const opened = await props.onOpenConversation?.(id);
    if (opened) {
      setPlanSource(null);
      setTab("Диалоги");
      setShowList(false);
    }
    return !!opened;
  };
  const sidebar = (
    <JourneySidebar
      disabled={busy || sending}
      onSuggest={suggest}
      onSupport={() => setTab("Помощь человека")}
    />
  );
  const rail = (
    <AssistantContextRail
      agent={contextAgent}
      disabled={busy || sending}
      city={board.profile?.targetCity}
      onHelpers={() => setTab("Помощники")}
    />
  );
  const navigation = (
    <nav aria-label="Личный кабинет CityGo" className="conversation-tabs">
      {["Мой план", "Диалоги", "Помощники", "Результаты", "Профиль"].map(
        (name) => (
          <Button
            key={name}
            className="ym-show-content"
            variant={tab === name ? "primary" : "secondary"}
            aria-pressed={tab === name}
            disabled={busy || sending}
            onClick={() => {
              props.onNavigateWorkspace?.();
              setTab(name);
              if (name === "Мой план")
                trackProductEvent("plan_opened", { surface: "plan" });
              if (name === "Профиль")
                trackProductEvent("profile_opened", { surface: "profile" });
              if (name === "Диалоги") {
                setShowList(true);
                props.onConversations?.();
              }
            }}
          >
            {name}
          </Button>
        ),
      )}
    </nav>
  );
  return (
    <section className="conversation-home">
      {navigationHost ? createPortal(navigation, navigationHost) : navigation}
      {board.supportUpdatesAvailable === true && (
        <SupportUpdatesNotice
          userId={board.user.id}
          sessionSignal={props.sessionSignal}
          onAccessDenied={props.onAccessDenied}
          disabled={busy || sending}
          onOpen={(id) => {
            setSupportSelection({
              owner: board.user.id,
              signal: props.sessionSignal,
              id,
            });
            setTab("Помощь человека");
          }}
        />
      )}
      {handoffSource &&
        props.onHandoff &&
        currentAssistantHandoffSource(
          handoffSource,
          board,
          props.sessionSignal,
        ) && (
          <AssistantHandoffDialog
            key={
              handoffSource.userId +
              ":" +
              handoffSource.threadId +
              ":" +
              handoffSource.messageId
            }
            source={handoffSource}
            board={board}
            sessionSignal={props.sessionSignal}
            disabled={busy || sending}
            onPrepare={async (input) => {
              const prepared = await props.onHandoff!(input);
              if (prepared && !input.source.sessionSignal.aborted) {
                setTab("Диалоги");
                setShowList(false);
                setPlanSource(null);
                setHandoffSource(null);
              }
              return prepared;
            }}
            onClose={() => setHandoffSource(null)}
          />
        )}
      {planSource && (
        <PlanStepComposer
          key={board.user.id + ":" + planSource.messageId}
          userId={board.user.id}
          sessionSignal={props.sessionSignal}
          onAccessDenied={props.onAccessDenied}
          source={planSource}
          onSaved={() => {
            setPlanSource(null);
            setPlanGeneration((current) => current + 1);
            setTab("Мой план");
          }}
          onCancel={(checkPlan) => {
            setPlanSource(null);
            if (checkPlan) {
              setPlanGeneration((current) => current + 1);
              setTab("Мой план");
            }
          }}
        />
      )}
      {tab === "Помощь человека" ? (
        <div className="conversation-workspace">
          {sidebar}
          <div className="conversation-main">
            <HumanSupportPanel
              key={board.user.id + ":" + (supportRequestId ?? "list")}
              initialRequestId={supportRequestId}
              canManageStatus={board.supportManagementAvailable === true}
              userId={board.user.id}
              sessionSignal={props.sessionSignal}
              onAccessDenied={props.onAccessDenied}
              onClose={() => setTab("Диалоги")}
            />
          </div>
          {rail}
        </div>
      ) : tab === "Результаты" ? (
        <div className={"conversation-workspace " + planStyles.workspace}>
          {sidebar}
          <div className="conversation-main">
            <ResultsLibrary
              key={board.user.id}
              userId={board.user.id}
              sessionSignal={props.sessionSignal}
              onAccessDenied={props.onAccessDenied}
              navigationBusy={busy || sending}
              onOpenConversation={open}
              onPlan={() => setTab("Мой план")}
              onFavorites={props.onFavorites}
              onDiscuss={
                props.onDiscussResult
                  ? async (input) => {
                      const prepared = await props.onDiscussResult!(input);
                      if (prepared && !props.sessionSignal.aborted) {
                        setTab("Диалоги");
                        setShowList(false);
                      }
                      return prepared;
                    }
                  : undefined
              }
              onContinue={() => {
                setTab("Диалоги");
                setShowList(false);
              }}
            />
          </div>
          {rail}
        </div>
      ) : tab === "Мой план" ? (
        <div className={"conversation-workspace " + planStyles.workspace}>
          {sidebar}
          <div className="conversation-main">
            <PersonalPlanPanel
              key={board.user.id + ":plan:" + planGeneration}
              userId={board.user.id}
              sessionSignal={props.sessionSignal}
              onAccessDenied={props.onAccessDenied}
              navigationBusy={busy || sending}
              onOpenConversation={open}
              onContinue={() => {
                setTab("Диалоги");
                setShowList(false);
              }}
              onHelpers={() => setTab("Помощники")}
            />
          </div>
          {rail}
        </div>
      ) : tab === "Помощники" || (tab === "Диалоги" && showList) ? (
        <div className="conversation-workspace">
          {sidebar}
          <div className="conversation-main">
            {tab === "Помощники" ? (
              <AssistantCatalog busy={busy || sending} onBegin={begin} />
            ) : (
              <ConversationList
                userId={board.user.id}
                sessionSignal={props.sessionSignal}
                onAccessDenied={props.onAccessDenied}
                conversations={props.conversations ?? null}
                nextCursor={props.conversationNextCursor ?? null}
                busy={busy || sending}
                onOpen={open}
                filters={props.conversationFilters ?? {}}
                onLoad={(before, filters) =>
                  props.onConversations?.(before, filters)
                }
                onHelpers={() => setTab("Помощники")}
                onFavorites={props.onFavorites}
              />
            )}
          </div>
          {rail}
        </div>
      ) : tab === "Профиль" ? (
        <div className="conversation-workspace">
          {sidebar}
          <div className="conversation-main">
            <AccountProfile
              key={board.user.id}
              userId={board.user.id}
              sessionSignal={props.sessionSignal}
              onAccessDenied={props.onAccessDenied}
              access={board.aiAccess}
              disabled={busy || sending}
              admin={["admin", "super_admin"].includes(board.user.role ?? "")}
              onBalance={props.onBalance}
              onPhone={props.onPhone}
              onFavorites={props.onFavorites}
              onResults={() => setTab("Результаты")}
              onPassword={props.onPassword}
              onSupport={() => {
                setSupportSelection(null);
                setTab("Помощь человека");
              }}
            />
          </div>
          {rail}
        </div>
      ) : (
        <div className="conversation-workspace">
          {sidebar}
          <div className="conversation-main">
            <Card
              className="conversation-chat-card"
              data-has-messages={!!board.thread?.messages.length}
            >
              {board.thread && (
                <div className="conversation-mode-bar">
                  <AiModeSelector
                    modes={board.aiAccess.modes}
                    selected={props.aiMode ?? "balanced"}
                    disabled={busy || sending || !props.onAiMode}
                    onSelect={(mode) => props.onAiMode?.(mode)}
                  />
                </div>
              )}
              <div className="conversation-heading">
                <Badge>ДИАЛОГ С ПОМОЩНИКОМ</Badge>
                <h1>
                  {board.thread?.assistantKey
                    ? assistantTitle(board.thread.assistantKey)
                    : "Давайте начнём с того, что волнует"}
                </h1>
                <p>
                  Можно начать с любого вопроса. Уточним нужное по ходу
                  разговора.
                </p>
                <div className="conversation-toolbar">
                  <Button
                    variant="ghost"
                    disabled={busy || sending}
                    onClick={() => {
                      setShowList(true);
                      props.onConversations?.();
                    }}
                  >
                    Все диалоги
                  </Button>
                  <details className="conversation-tools">
                    <summary>Действия с диалогом</summary>
                    {board.thread && (
                      <ConversationExportAction
                        key={board.user.id + ":" + board.thread.id + ":export"}
                        userId={board.user.id}
                        threadId={board.thread.id}
                        sessionSignal={props.sessionSignal}
                        disabled={busy || sending}
                        onAccessDenied={props.onAccessDenied}
                      />
                    )}
                    {board.thread && (
                      <ConversationMessageSearch
                        key={board.user.id + ":" + board.thread.id}
                        userId={board.user.id}
                        threadId={board.thread.id}
                        sessionSignal={props.sessionSignal}
                        onAccessDenied={props.onAccessDenied}
                        disabled={busy || sending}
                      />
                    )}
                  </details>
                </div>
              </div>
              <ConversationHistoryControls
                state={props.history}
                disabled={busy || sending}
                onOlder={() => historyScroll.loadOlder(props.onOlderMessages)}
                onLatest={() =>
                  historyScroll.returnToLatest(props.onLatestMessages)
                }
              />
              <div
                ref={log}
                className={
                  "conversation-messages ym-hide-content " +
                  conversationHistoryStyles.viewport +
                  " " +
                  conversationHistoryStyles.chatViewport
                }
                aria-label="История диалога"
                role="log"
                aria-live="polite"
                aria-busy={props.history?.phase === "loading"}
              >
                {!board.thread?.messages.length && (
                  <article className="conversation-message assistant">
                    <strong>AI-ПОМОЩНИК</strong>
                    <AssistantMessage
                      content={
                        board.thread?.assistantKey &&
                        board.thread.assistantKey !== "support"
                          ? `Здравствуйте! Я ${assistantTitle(board.thread.assistantKey).toLowerCase()}. Расскажите, с чем нужна помощь. Можно начать без известного бюджета и срока.`
                          : greeting
                      }
                    />
                  </article>
                )}
                {board.thread?.messages.map((message) => (
                  <article
                    key={message.id}
                    data-history-message={message.id}
                    className={"conversation-message " + message.role}
                  >
                    <strong>
                      {message.role === "user"
                        ? "Вы"
                        : agentNames[message.agentKey]}
                    </strong>
                    {message.role === "user" ? (
                      <p>{message.content}</p>
                    ) : (
                      <AssistantMessage content={message.content} />
                    )}
                    {message.status === "interrupted" && (
                      <small>
                        {messageInterruptionLabel(message, "Ответ прерван")}
                      </small>
                    )}
                    <FavoriteButton
                      saved={message.favorite}
                      disabled={busy || sending}
                      onClick={() =>
                        props.onFavorite?.(message.id, !message.favorite)
                      }
                    />
                    <details className="conversation-message-extras">
                      <summary>Ещё</summary>
                      {message.status === "complete" && props.onHandoff && (
                        <Button
                          variant="ghost"
                          disabled={
                            busy ||
                            sending ||
                            !!planSource ||
                            !!handoffSource ||
                            props.sessionSignal.aborted
                          }
                          onClick={() => {
                            if (
                              busy ||
                              sending ||
                              props.sessionSignal.aborted ||
                              !board.thread
                            )
                              return;
                            setHandoffSource({
                              userId: board.user.id,
                              threadId: board.thread.id,
                              messageId: message.id,
                              assistantKey:
                                board.thread.assistantKey ??
                                board.thread.agentKey,
                              content: message.content,
                              sessionSignal: props.sessionSignal,
                            });
                          }}
                        >
                          Другому помощнику
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        disabled={busy || sending || !!planSource}
                        onClick={() =>
                          setPlanSource({
                            messageId: message.id,
                            threadId: board.thread!.id,
                            role: message.role,
                            content: message.content,
                          })
                        }
                      >
                        Добавить шаг в план
                      </Button>
                      {message.status === "complete" && (
                        <MessageTextActions
                          key={
                            board.user.id +
                            ":" +
                            board.thread!.id +
                            ":" +
                            message.id
                          }
                          userId={board.user.id}
                          threadId={board.thread!.id}
                          messageId={message.id}
                          text={message.content}
                          sessionSignal={props.sessionSignal}
                          disabled={busy || sending}
                        />
                      )}
                    </details>
                  </article>
                ))}
                {props.pending && (
                  <article className="conversation-message user">
                    <strong>Вы</strong>
                    <p>{props.pending}</p>
                  </article>
                )}
                {props.draft && (
                  <article className="conversation-message assistant">
                    <strong>{agentNames[agent]}</strong>
                    <AssistantMessage content={props.draft} />
                  </article>
                )}
              </div>
              {!board.thread ? (
                <Button disabled={busy} onClick={() => void begin()}>
                  Начать диалог
                </Button>
              ) : board.thread.closed ? (
                <p>
                  Это завершённый разговор. История и избранное доступны; новый
                  вопрос можно задать в открытом диалоге помощника.
                </p>
              ) : (
                <form className="conversation-composer" onSubmit={props.onChat}>
                  <EmptyAiCreditHint
                    access={board.aiAccess}
                    onBalance={props.onBalance}
                  />
                  <label htmlFor="conversation-message">
                    Сообщение помощнику
                  </label>
                  {props.draftRecovered && (
                    <div className="conversation-notice" role="status">
                      <p>
                        Восстановлен неотправленный текст. Проверьте его перед
                        отправкой.
                      </p>
                      <Button
                        variant="ghost"
                        type="button"
                        onClick={props.onDiscardDraft}
                      >
                        Удалить черновик
                      </Button>
                    </div>
                  )}
                  <textarea
                    className="ym-disable-keys ym-hide-content"
                    id="conversation-message"
                    value={props.text}
                    onChange={(e) => props.onText(e.target.value)}
                    maxLength={4000}
                    rows={2}
                    placeholder="Напишите сообщение…"
                    disabled={!canSend || sending}
                  />
                  <TextMaterialPreview
                    userId={board.user.id}
                    threadId={board.thread.id}
                    sessionSignal={props.sessionSignal}
                    draft={props.text}
                    disabled={!canSend || sending}
                    onDraft={props.onText}
                  />
                  <div className="conversation-send-action">
                    {sending ? (
                      <Button
                        className="ym-show-content"
                        type="button"
                        onClick={props.onStop}
                      >
                        Остановить ответ
                      </Button>
                    ) : (
                      <Button
                        className="ym-show-content"
                        type="submit"
                        aria-label="Отправить"
                        disabled={!canSend || !props.text.trim()}
                      >
                        <span aria-hidden="true">↑</span>
                      </Button>
                    )}
                  </div>
                </form>
              )}
            </Card>
          </div>
          {rail}
        </div>
      )}
    </section>
  );
}
