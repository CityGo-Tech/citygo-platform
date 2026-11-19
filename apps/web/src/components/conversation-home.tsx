"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { createPortal } from "react-dom";
import {
  JourneySidebar,
  AssistantContextRail,
  WorkspaceFrame,
} from "./workspace-frame";
import { Button, Card, Badge, AssistantMessage } from "@citygo/ui-web";
import { agentNames, type JourneyProps } from "./journey";
import { FavoriteButton } from "./message-favorites";
import { EmptyAiCreditHint, messageInterruptionLabel } from "./chat-readiness";
import { chatTextProblem, type AgentKey } from "@citygo/contracts";
import { ChatTextarea } from "./chat-textarea";
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
import { AssistantContextPanel } from "./assistant-context";
import contextStyles from "./assistant-context.module.css";
import { AssistantHandoffDialog } from "./assistant-handoff";
import {
  currentAssistantHandoffSource,
  type AssistantHandoffSource,
} from "./assistant-handoff-state";
import { MessageTextActions } from "./message-text-actions";
import { ConversationMessageSearch } from "./conversation-message-search";
import { ConversationExportAction } from "./conversation-export";
import { HousingPlanLaunch, HousingStarterPlan } from "./housing-starter-plan";
import miniStyles from "./mini-app/mini-workspace.module.css";

const greeting =
  "Здравствуйте! Я координатор CityGo. Помогу разложить переезд на понятные шаги. Можно просто рассказать, что сейчас волнует — даже если бюджет и дата ещё неизвестны.";

const workspaceTabs = [
  { name: "Мой план", miniLabel: "План", icon: "plan" },
  { name: "Диалоги", miniLabel: "Диалоги", icon: "messages" },
  { name: "Помощники", miniLabel: "Помощники", icon: "spark" },
  { name: "Результаты" },
  { name: "Профиль", miniLabel: "Профиль", icon: "profile" },
] as const;

/** Conversation home and user-selected plan, from Figma 6:14 / 6:24. */
export function ConversationHome(props: JourneyProps) {
  const miniNavigation = props.miniAppNavigation;
  const miniApp = !!miniNavigation;
  const workspace = useRef<HTMLElement>(null);
  const [tab, setTab] = useState(
    miniNavigation && !props.board.thread ? "Мой план" : "Диалоги",
  );
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
    setHousingJourney(null);
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
  useEffect(() => {
    if (miniApp) workspace.current?.scrollIntoView({ block: "start" });
  }, [miniApp, tab, showList]);
  const [supportReturnTab, setSupportReturnTab] = useState("Диалоги");
  const [contextSource, setContextSource] = useState<{
    userId: string;
    threadId: string | null;
    draft: string;
    signal: AbortSignal;
    tab: string;
  } | null>(null);
  const contextOpener = useRef<HTMLElement | null>(null);
  const [planSource, setPlanSource] = useState<PlanMessageSource | null>(null);
  const [planGeneration, setPlanGeneration] = useState(0);
  const [housingJourney, setHousingJourney] = useState<{
    userId: string;
    threadId: string;
    signal: AbortSignal;
  } | null>(null);
  const housingLaunch = useRef<HTMLElement>(null);
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
  const housingThread =
    board.thread &&
    !board.thread.closed &&
    (board.thread.assistantKey ?? board.thread.agentKey) === "housing"
      ? board.thread
      : null;
  const currentHousingJourney =
    !props.sessionSignal.aborted &&
    !props.history?.detached &&
    housingJourney?.userId === board.user.id &&
    housingJourney?.signal === props.sessionSignal &&
    housingJourney?.threadId === housingThread?.id
      ? housingJourney
      : null;
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
    setHousingJourney(null);
    props.onText(text);
    setTab("Диалоги");
    setShowList(false);
  };
  const begin = async (key?: AgentKey) => {
    const started = await props.onBegin?.(key);
    if (started) {
      setPlanSource(null);
      setHousingJourney(null);
      setTab("Диалоги");
      setShowList(false);
    }
    return !!started;
  };
  const open = async (id: string) => {
    const opened = await props.onOpenConversation?.(id);
    if (opened) {
      setPlanSource(null);
      setHousingJourney(null);
      setTab("Диалоги");
      setShowList(false);
    }
    return !!opened;
  };
  const currentContext =
    contextSource &&
    !props.sessionSignal.aborted &&
    contextSource.userId === board.user.id &&
    contextSource.signal === props.sessionSignal &&
    contextSource.threadId === (board.thread?.id ?? null)
      ? contextSource
      : null;
  const closeContext = useCallback(() => {
    setTab(contextSource?.tab ?? "Диалоги");
    setContextSource(null);
    requestAnimationFrame(() => {
      if (contextOpener.current?.isConnected) contextOpener.current.focus();
    });
  }, [contextSource]);
  const openConversationList = useCallback(() => {
    setShowList(true);
    props.onConversations?.();
  }, [props.onConversations]);
  const registerBack = miniNavigation?.registerBack;
  useEffect(() => {
    if (!registerBack) return;
    registerBack(() => {
      if (busy || sending) return true;
      if (handoffSource) setHandoffSource(null);
      else if (planSource) setPlanSource(null);
      else if (currentHousingJourney) setHousingJourney(null);
      else if (tab === "Контекст") closeContext();
      else if (tab === "Помощь человека") setTab(supportReturnTab);
      else if (tab === "Диалоги" && !showList) openConversationList();
      else if (tab !== "Мой план") setTab("Мой план");
      else return false;
      return true;
    });
    return () => registerBack(null);
  }, [
    registerBack,
    busy,
    sending,
    handoffSource,
    planSource,
    currentHousingJourney,
    tab,
    showList,
    supportReturnTab,
    closeContext,
    openConversationList,
  ]);
  const sidebar = !miniNavigation && (
    <JourneySidebar
      disabled={busy || sending || tab === "Контекст"}
      onSuggest={suggest}
      onSupport={() => {
        setHousingJourney(null);
        setTab("Помощь человека");
      }}
    />
  );
  const openContext = () => {
    if (
      busy ||
      sending ||
      props.sessionSignal.aborted ||
      tab === "Контекст" ||
      board.assistantContextAvailable !== true
    )
      return;
    contextOpener.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setContextSource({
      userId: board.user.id,
      threadId: board.thread?.id ?? null,
      draft: props.text,
      signal: props.sessionSignal,
      tab: tab === "Контекст" ? "Диалоги" : tab,
    });
    setHousingJourney(null);
    setTab("Контекст");
  };
  const rail = !miniNavigation && (
    <AssistantContextRail
      agent={contextAgent}
      disabled={busy || sending}
      city={board.profile?.targetCity}
      onHelpers={() => {
        setHousingJourney(null);
        setTab("Помощники");
      }}
      modeSelector={
        <AiModeSelector
          modes={board.aiAccess.modes}
          selected={props.aiMode ?? "balanced"}
          disabled={busy || sending || !props.onAiMode}
          onSelect={(mode) => props.onAiMode?.(mode)}
        />
      }
      knowledgeAvailable={board.assistantContextAvailable === true}
      onKnowledge={openContext}
    />
  );
  const navigation = (
    <nav
      aria-label="Личный кабинет CityGo"
      className={
        miniNavigation
          ? `mini-app-tabs ${miniStyles.tabs}`
          : "conversation-tabs"
      }
    >
      {workspaceTabs.map((item) => {
        if (miniNavigation && !("miniLabel" in item)) return null;
        const { name } = item;
        const selected =
          tab === name ||
          (!!miniNavigation && tab === "Результаты" && name === "Мой план");
        return (
          <Button
            key={name}
            className="ym-show-content"
            variant={
              miniNavigation ? "ghost" : selected ? "primary" : "secondary"
            }
            aria-pressed={selected}
            disabled={busy || sending}
            onClick={() => {
              props.onNavigateWorkspace?.();
              setHousingJourney(null);
              setTab(name);
              if (name === "Мой план")
                trackProductEvent("plan_opened", { surface: "plan" });
              if (name === "Профиль")
                trackProductEvent("profile_opened", { surface: "profile" });
              if (
                name === "Диалоги" &&
                (!miniNavigation || tab !== "Диалоги" || !showList)
              ) openConversationList();
            }}
          >
            {miniNavigation && "miniLabel" in item ? (
              <>
                <Image
                  src={`/mini-app/${item.icon}-${selected ? "blue" : "muted"}.svg`}
                  width={20}
                  height={20}
                  alt=""
                />
                {item.miniLabel}
              </>
            ) : (
              name
            )}
          </Button>
        );
      })}
    </nav>
  );
  return (
    <section
      ref={workspace}
      className={`conversation-home${miniNavigation ? ` ${miniStyles.workspace}` : ""}`}
    >
      {!miniNavigation &&
        (navigationHost
          ? createPortal(navigation, navigationHost)
          : navigation)}
      {(!miniNavigation ||
        (tab === "Диалоги" && !showList && board.thread && board.assistantContextAvailable === true)) && (
        <div
          className={
            miniNavigation ? miniStyles.context : contextStyles.mobileContext
          }
        >
          <Button
            variant="secondary"
            disabled={
              busy || sending || board.assistantContextAvailable !== true
            }
            onClick={openContext}
          >
            Что помощники знают
          </Button>
        </div>
      )}
      {board.supportUpdatesAvailable === true && (
        <SupportUpdatesNotice
          userId={board.user.id}
          sessionSignal={props.sessionSignal}
          onAccessDenied={props.onAccessDenied}
          disabled={busy || sending}
          onOpen={(id) => {
            setHousingJourney(null);
            setSupportSelection({
              owner: board.user.id,
              signal: props.sessionSignal,
              id,
            });
            if (tab !== "Помощь человека") setSupportReturnTab(tab);
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
      {tab === "Контекст" ? (
        <div className="conversation-workspace">
          {sidebar}
          <div className="conversation-main">
            {currentContext ? (
              <AssistantContextPanel
                key={
                  currentContext.userId +
                  ":" +
                  (currentContext.threadId ?? "none")
                }
                userId={currentContext.userId}
                threadId={currentContext.threadId}
                draft={currentContext.draft}
                aiMode={
                  board.aiAccess.modes
                    ? (props.aiMode ?? board.aiAccess.modes.defaultMode)
                    : undefined
                }
                aiModeCatalogId={board.aiAccess.modes?.catalogId}
                sessionSignal={currentContext.signal}
                onAccessDenied={props.onAccessDenied}
                onClose={closeContext}
                onCorrect={() => {
                  if (!currentContext || props.sessionSignal.aborted) return;
                  if (!props.text.trim())
                    props.onText("Хочу уточнить сведения о переезде: ");
                  setContextSource(null);
                  setTab("Диалоги");
                  setShowList(false);
                  requestAnimationFrame(() =>
                    document
                      .querySelector<HTMLTextAreaElement>(
                        "#conversation-message",
                      )
                      ?.focus(),
                  );
                }}
              />
            ) : (
              <Card>
                <p>Выбранный разговор изменился. Откройте контекст заново.</p>
                <Button onClick={closeContext}>Вернуться назад</Button>
              </Card>
            )}
          </div>
          {rail}
        </div>
      ) : tab === "Помощь человека" ? (
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
              onClose={() =>
                setTab(miniNavigation ? supportReturnTab : "Диалоги")
              }
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
                setTab(
                  miniNavigation && !board.thread ? "Помощники" : "Диалоги",
                );
                setShowList(false);
              }}
              onHelpers={() => setTab("Помощники")}
              miniApp={
                miniNavigation
                  ? {
                      targetCity: board.profile?.targetCity,
                      onResults: () => setTab("Результаты"),
                    }
                  : undefined
              }
            />
          </div>
          {rail}
        </div>
      ) : tab === "Помощники" || (tab === "Диалоги" && showList) ? (
        <div className="conversation-workspace">
          {sidebar}
          <div className="conversation-main">
            {tab === "Помощники" ? (
              <AssistantCatalog
                busy={busy || sending}
                onBegin={begin}
                miniApp={!!miniNavigation}
              />
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
                miniApp={!!miniNavigation}
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
              onResults={
                miniNavigation ? undefined : () => setTab("Результаты")
              }
              miniApp={miniNavigation}
              onPassword={props.onPassword}
              onSupport={() => {
                setSupportSelection(null);
                setSupportReturnTab("Профиль");
                setTab("Помощь человека");
              }}
            />
          </div>
          {rail}
        </div>
      ) : tab === "Диалоги" && currentHousingJourney ? (
        <WorkspaceFrame sidebar={sidebar} rail={rail}>
          <HousingStarterPlan
            key={board.user.id + ":" + currentHousingJourney.threadId}
            userId={board.user.id}
            sessionSignal={props.sessionSignal}
            onAccessDenied={props.onAccessDenied}
            onExit={() => {
              setHousingJourney(null);
              requestAnimationFrame(() =>
                housingLaunch.current?.querySelector("button")?.focus(),
              );
            }}
            onOpenSavedPlan={() => {
              setHousingJourney(null);
              setPlanGeneration((current) => current + 1);
              setTab("Мой план");
            }}
          />
        </WorkspaceFrame>
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
                    onClick={openConversationList}
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
                      <AssistantMessage
                        content={message.content}
                        webSources={
                          message.status === "complete"
                            ? message.generation?.webSources
                            : undefined
                        }
                      />
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
                              tab === "Контекст" ||
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
              {housingThread && (
                <HousingPlanLaunch
                  launchRef={housingLaunch}
                  disabled={
                    busy ||
                    sending ||
                    !!planSource ||
                    !!handoffSource ||
                    !!props.history?.detached ||
                    props.sessionSignal.aborted
                  }
                  onStart={() =>
                    setHousingJourney({
                      userId: board.user.id,
                      threadId: housingThread.id,
                      signal: props.sessionSignal,
                    })
                  }
                />
              )}
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
                  <ChatTextarea
                    className="ym-disable-keys ym-hide-content"
                    id="conversation-message"
                    value={props.text}
                    onChange={(e) => props.onText(e.target.value)}
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
                        disabled={
                          !canSend ||
                          !props.text.trim() ||
                          chatTextProblem(props.text) !== null
                        }
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
      {miniNavigation && navigation}
    </section>
  );
}
