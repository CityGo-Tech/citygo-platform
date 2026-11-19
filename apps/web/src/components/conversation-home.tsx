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
import {
  aiModeLabels,
  chatTextProblem,
  type AgentKey,
} from "@citygo/contracts";
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
import {
  appendReviewedTextMaterial,
  sameTextMaterialScope,
  type ReviewedTextMaterial,
  type TextMaterialScope,
} from "./text-material-state";
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
import { HousingWorkspaceView } from "./housing-workspace";
import { assistantPortrait } from "./assistant-portrait";
import {
  MiniChatModes,
  MiniChatRecovery,
  MiniChatSources,
} from "./mini-app/chat-panels";
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
  const [housingView, setHousingView] = useState<"plan" | "checklist" | null>(
    null,
  );
  const [modeOpen, setModeOpen] = useState(false);
  const [sourceMessageId, setSourceMessageId] = useState<string | null>(null);
  const [material, setMaterial] = useState<
    (ReviewedTextMaterial & TextMaterialScope) | null
  >(null);
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
    const openHousing = miniApp && props.workspaceRequest.tab === "Жильё";
    setTab(openHousing ? "Диалоги" : props.workspaceRequest.tab);
    setHousingView(openHousing ? "plan" : null);
    setShowList(false);
    setHousingJourney(null);
    setModeOpen(false);
    setSourceMessageId(null);
    props.onWorkspaceRequestHandled?.(props.workspaceRequest.sequence);
  }, [miniApp, props.workspaceRequest, props.onWorkspaceRequestHandled]);
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
  }, [miniApp, tab, showList, housingView]);
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
  const chatOpen =
    tab === "Диалоги" && !showList && !housingView && !housingJourney;
  const miniRecovery =
    miniApp && chatOpen ? props.miniChat?.recovery : undefined;
  const openSources =
    miniApp && chatOpen && sourceMessageId
      ? board.thread?.messages.find(
          (message) =>
            message.id === sourceMessageId &&
            message.role === "assistant" &&
            message.status === "complete",
        )
      : undefined;
  const sourceReceipt = openSources?.generation?.webSources;
  const modes = board.aiAccess.modes;
  const currentMode = props.aiMode ?? modes?.defaultMode ?? "balanced";
  const showModes = miniApp && chatOpen && modeOpen;
  const showChatPanel = !!(showModes || sourceReceipt || miniRecovery);
  useEffect(() => {
    if (showChatPanel)
      workspace.current
        ?.querySelector<HTMLElement>("[data-mini-chat-screen] h1")
        ?.focus();
  }, [showChatPanel, showModes, sourceReceipt]);
  const renderMiniSourceAction = useCallback(
    (messageId: string) => (
      <Button
        variant="ghost"
        disabled={busy || sending}
        onClick={() => setSourceMessageId(messageId)}
      >
        Источники ответа
      </Button>
    ),
    [busy, sending],
  );
  const activeMaterial =
    miniApp &&
    board.thread &&
    material &&
    !props.sessionSignal.aborted &&
    sameTextMaterialScope(material, {
      userId: board.user.id,
      threadId: board.thread.id,
      sessionSignal: props.sessionSignal,
    }) &&
    (props.text === material.block ||
      props.text.endsWith("\n\n" + material.block))
      ? material
      : null;
  const editorText = activeMaterial
    ? props.text === activeMaterial.block
      ? ""
      : props.text.slice(0, -activeMaterial.block.length - 2)
    : props.text;
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
  const canEdit =
    !!board.thread &&
    !board.thread.closed &&
    !props.history?.detached &&
    !props.sessionSignal.aborted &&
    !busy;
  const canSend =
    canEdit &&
    (!miniApp ||
      (props.miniChat?.available === true && !props.miniChat.offline)) &&
    isAiModeAvailable(
      board.aiAccess.modes,
      props.aiMode ?? "balanced",
      board.provider !== "unconfigured",
    );
  const messageField = (
    <ChatTextarea
      className="ym-disable-keys ym-hide-content"
      id="conversation-message"
      value={editorText}
      validationText={props.text}
      onChange={(event) => {
        const value = event.target.value;
        props.onText(
          activeMaterial
            ? appendReviewedTextMaterial(value, activeMaterial.block)
            : value,
        );
      }}
      rows={2}
      placeholder="Напишите сообщение…"
      disabled={!(miniApp ? canEdit : canSend) || sending}
    />
  );
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
      setHousingView(null);
      setSourceMessageId(null);
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
      else if (showModes) setModeOpen(false);
      else if (sourceReceipt) setSourceMessageId(null);
      else if (housingView) setHousingView(null);
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
    showModes,
    sourceReceipt,
    currentHousingJourney,
    housingView,
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
              setHousingView(null);
              setModeOpen(false);
              setSourceMessageId(null);
              setTab(name);
              if (name === "Мой план")
                trackProductEvent("plan_opened", { surface: "plan" });
              if (name === "Профиль")
                trackProductEvent("profile_opened", { surface: "profile" });
              if (
                name === "Диалоги" &&
                (!miniNavigation || tab !== "Диалоги" || !showList)
              )
                openConversationList();
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
  const housingLinks = miniApp && (
    <div
      className={miniStyles.housingLinks}
      aria-label="Результаты поиска жилья"
    >
      <Button
        variant="secondary"
        disabled={busy || sending}
        onClick={() => setHousingView("plan")}
      >
        Стартовый план поиска жилья
      </Button>
      <Button
        variant="secondary"
        disabled={busy || sending}
        onClick={() => setHousingView("checklist")}
      >
        Чек-лист просмотра
      </Button>
    </div>
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
      {!miniNavigation && (
        <div className={contextStyles.mobileContext}>
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
      {showModes ? (
        <MiniChatModes
          modes={modes}
          selected={currentMode}
          disabled={busy || sending || !props.onAiMode}
          available={props.miniChat?.available === true}
          onSelect={(mode) => {
            setModeOpen(false);
            props.onAiMode?.(mode);
          }}
        />
      ) : openSources && sourceReceipt ? (
        <MiniChatSources
          content={openSources.content}
          sources={sourceReceipt}
          onClose={() => setSourceMessageId(null)}
        />
      ) : miniRecovery && !sending ? (
        <MiniChatRecovery
          recovery={miniRecovery}
          disabled={busy || props.miniChat?.offline === true}
        />
      ) : housingView ? (
        <HousingWorkspaceView
          key={board.user.id + ":housing:" + housingView}
          userId={board.user.id}
          threadId={housingThread?.id}
          sessionSignal={props.sessionSignal}
          onAccessDenied={props.onAccessDenied}
          onExit={() => setHousingView(null)}
          onOpenSource={(threadId) => void open(threadId)}
          onChooseAssistant={() => {
            setHousingView(null);
            setTab("Помощники");
          }}
          initialView={housingView}
          initialCriteria={miniNavigation?.housingCriteria}
          defaultCity={board.profile?.targetCity}
        />
      ) : tab === "Контекст" ? (
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
              miniReturnLabel={
                miniNavigation
                  ? supportReturnTab === "Профиль"
                    ? "К профилю"
                    : "К диалогам"
                  : undefined
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
              housingResults={housingLinks}
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
              housingResults={housingLinks}
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
              revision={props.profileRevision}
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
        <div
          className={
            "conversation-workspace" +
            (miniApp ? ` ${miniStyles.chatWorkspace}` : "")
          }
        >
          {sidebar}
          <div className="conversation-main">
            <Card
              className="conversation-chat-card"
              data-has-messages={!!board.thread?.messages.length}
            >
              {!miniApp && board.thread && (
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
                {!miniApp && <Badge>ДИАЛОГ С ПОМОЩНИКОМ</Badge>}
                <h1>
                  {board.thread?.assistantKey
                    ? assistantTitle(board.thread.assistantKey)
                    : "Давайте начнём с того, что волнует"}
                </h1>
                {miniApp && board.thread ? (
                  <div className={miniStyles.chatAssistant}>
                    <Image
                      src={assistantPortrait(
                        board.thread.assistantKey ?? board.thread.agentKey,
                      )}
                      width={48}
                      height={48}
                      alt=""
                    />
                    <Button
                      className={miniStyles.modeTrigger}
                      aria-label="Режим работы"
                      variant="ghost"
                      disabled={busy || sending || !props.onAiMode}
                      onClick={() => setModeOpen(true)}
                    >
                      {aiModeLabels[currentMode]}
                      <Image
                        src="/mini-app/right-blue.svg"
                        width={20}
                        height={20}
                        alt=""
                      />
                    </Button>
                  </div>
                ) : (
                  <p>
                    Можно начать с любого вопроса. Уточним нужное по ходу
                    разговора.
                  </p>
                )}
                <div className="conversation-toolbar">
                  <Button
                    variant="ghost"
                    disabled={busy || sending}
                    onClick={openConversationList}
                  >
                    Все диалоги
                  </Button>
                  {miniApp &&
                    board.thread &&
                    board.assistantContextAvailable === true && (
                      <Button
                        variant="ghost"
                        disabled={busy || sending}
                        onClick={openContext}
                      >
                        Что помощники знают
                      </Button>
                    )}
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
              {activeMaterial && (
                <Card
                  className={miniStyles.attachment + " ym-hide-content"}
                  aria-label="Вложение"
                >
                  <strong>{activeMaterial.filename}</strong>
                  <small>
                    {activeMaterial.pages
                      ? `PDF · ${activeMaterial.pages} стр.`
                      : "TXT"}{" "}
                    · Текст добавлен к сообщению
                  </small>
                </Card>
              )}
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
                        sourceActionKey={miniApp ? message.id : undefined}
                        renderSourceAction={
                          miniApp ? renderMiniSourceAction : undefined
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
                    {miniApp &&
                      message.role === "assistant" &&
                      message.status === "complete" && (
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
                          Сохранить в план
                        </Button>
                      )}
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
                      {(!miniApp || message.role !== "assistant") && (
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
                      )}
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
                  onStart={() => {
                    if (miniApp) {
                      setHousingView("plan");
                      return;
                    }
                    setHousingJourney({
                      userId: board.user.id,
                      threadId: housingThread.id,
                      signal: props.sessionSignal,
                    });
                  }}
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
                <form
                  className={
                    "conversation-composer" +
                    (miniApp ? ` ${miniStyles.chatComposer}` : "")
                  }
                  onSubmit={(event) => {
                    if (canSend && !sending) props.onChat(event);
                    else event.preventDefault();
                  }}
                >
                  {(!miniApp || props.miniChat?.available === true) && (
                    <EmptyAiCreditHint
                      access={board.aiAccess}
                      onBalance={props.onBalance}
                    />
                  )}
                  {miniApp && props.miniChat?.available !== true && (
                    <p className={miniStyles.chatAvailability}>
                      Отправка в мини-приложении пока недоступна. Здесь можно
                      подготовить черновик.
                    </p>
                  )}
                  {!miniApp && (
                    <label htmlFor="conversation-message">
                      Сообщение помощнику
                    </label>
                  )}
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
                  {miniApp ? (
                    <div className={miniStyles.chatEditor}>
                      <label htmlFor="conversation-message">
                        Сообщение помощнику
                      </label>
                      {messageField}
                    </div>
                  ) : (
                    messageField
                  )}
                  {activeMaterial ? (
                    <span>
                      <Button
                        type="button"
                        variant="secondary"
                        disabled={!canEdit || sending}
                        onClick={() => {
                          setMaterial(null);
                          props.onText(editorText);
                        }}
                      >
                        Удалить вложение
                      </Button>
                    </span>
                  ) : (
                    <TextMaterialPreview
                      userId={board.user.id}
                      threadId={board.thread.id}
                      sessionSignal={props.sessionSignal}
                      draft={props.text}
                      disabled={!(miniApp ? canEdit : canSend) || sending}
                      miniApp={miniApp}
                      onDraft={(text, reviewed) => {
                        if (miniApp && board.thread)
                          setMaterial({
                            ...reviewed,
                            userId: board.user.id,
                            threadId: board.thread.id,
                            sessionSignal: props.sessionSignal,
                          });
                        props.onText(text);
                      }}
                    />
                  )}
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
                        {miniApp ? (
                          "Отправить"
                        ) : (
                          <span aria-hidden="true">↑</span>
                        )}
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
      {miniNavigation && !showModes && !sourceReceipt && navigation}
    </section>
  );
}
