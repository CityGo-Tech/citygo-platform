"use client";
import { initialWebAiMode } from "../components/ai-mode-preference";
import {
  readBrowserLandingAttribution,
  clearBrowserLandingAttribution,
  consumeLandingLoginIntent,
  consumeLandingAnalyticsEntry,
  browserAcquisitionAllowed,
} from "../components/landing/landing-attribution";
import {
  consumeLandingTask,
  landingTaskAgents,
  landingTaskMaxAgeMs,
  type LandingTask,
} from "../components/landing/landing-task";
import { BalanceHistoryPanel } from "../components/balance-history";
import { MiniAppProfileBalance } from "../components/mini-app/profile-balance";
import { TelegramStarsPanel } from "../components/mini-app/telegram-stars";
import type { OpenMiniAppInvoice } from "../components/mini-app/host";
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  createClient,
  createSessionGuard,
  notifyBrowserSessionChange,
  subscribeBrowserSessionChange,
  type SessionTicket,
  ApiError,
  captureAiModeSelection,
  isAiModeAvailable,
} from "@citygo/api-client";
import type {
  AgentKey,
  Dashboard,
  LandingAttribution,
  ConversationSummary,
  ConversationFilters,
  ServiceConsentChoice,
  AiModeId,
  StreamEvent,
} from "@citygo/contracts";
import { chatTextError } from "@citygo/contracts";
import { Button, Card, Field, Badge } from "@citygo/ui-web";
import {
  currentResultDiscussionInput,
  resultDiscussionDraft,
  type ResultDiscussionInput,
} from "../components/result-discussion-state";
import { Journey } from "../components/journey";
import { LogoutConfirmation } from "../components/logout-confirmation";
import {
  currentLogoutConfirmation,
  type LogoutConfirmationIntent,
} from "../components/logout-confirmation-state";
import { createConversationListRequests } from "../components/conversation-list-requests";
import { ConversationHome } from "../components/conversation-home";
import {
  WorkspaceFrame,
  JourneySidebar,
  AssistantContextRail,
} from "../components/workspace-frame";
import {
  assistantHandoffDraft,
  currentAssistantHandoffSource,
  assistantHandoffTarget,
  type AssistantHandoffInput,
} from "../components/assistant-handoff-state";
import { OwnerReceiptsPanel } from "../components/owner-receipts";
import { MessageFavoritesPanel } from "../components/message-favorites";
import { EmailRegistration } from "../components/email-registration";
import { ServiceConsentsPanel } from "../components/service-consents";
import { AiModeConsentDialog } from "../components/ai-mode-consent";
import { PasswordRecovery } from "../components/password-recovery";
import { PhoneVerificationPanel } from "../components/phone-verification";
import { MessengerAccountsPanel } from "../components/mini-app/messenger-accounts-panel";
import {
  messengerNames,
  type MiniAppAccountAccess,
} from "../components/mini-app/account-access";
import {
  clearMiniChatMarkers,
  miniChatMarkerKey,
  readMiniChatMarker,
  writeMiniChatMarker,
  type MiniChatMarker,
  type MiniChatRecovery,
} from "../components/mini-app/chat-recovery";
import { AccountOverview, accountStyles } from "../components/account-overview";
import { AiAccessPanel } from "../components/ai-access";
import { chatBalanceTarget } from "../components/chat-readiness";
import { useConversationHistory } from "../components/use-conversation-history";
import {
  parseProductAnalyticsConfig,
  trackProductEvent,
  type RegistrationAnalyticsFlow,
} from "../components/product-analytics";
import { useProductAnalytics } from "../components/use-product-analytics";
import {
  pendingEmailRegistration,
  type PendingEmailRegistration,
} from "../components/email-registration-state";
import registrationStyles from "../components/email-registration.module.css";
import recoveryStyles from "../components/password-recovery.module.css";
import {
  clearChatDrafts,
  readChatDraft,
  writeChatDraft,
} from "../components/chat-drafts";
import {
  readConversationSelection,
  writeConversationSelection,
} from "../components/conversation-selection";

function conversationStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function draftStorage() {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

type TaskSelection = {
  task: LandingTask;
  housingCriteria?: MiniAppAccountAccess["housingCriteria"];
};
type RegistrationTask = TaskSelection & { ownerId: string };
type RegistrationChallenge = PendingEmailRegistration & {
  selection?: TaskSelection;
};

export default function CityGoHome({
  miniApp,
  miniAppOpenInvoice,
  registerMiniAppBack,
  rememberHousingOwner,
}: {
  miniApp?: MiniAppAccountAccess;
  miniAppOpenInvoice?: OpenMiniAppInvoice;
  registerMiniAppBack?: (handler: (() => boolean) | null) => void;
  rememberHousingOwner?: (ownerId: string | null) => void;
}) {
  const [session] = useState(createSessionGuard);
  const [formVersion, setFormVersion] = useState(0);
  const [logoutUnconfirmed, setLogoutUnconfirmed] = useState(false);
  const [logoutIntent, setLogoutIntent] =
    useState<LogoutConfirmationIntent | null>(null);
  const refreshVersion = useRef(0);
  const [board, setBoard] = useState<Dashboard | null>(null);
  const chatSubmitting = useRef(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"register" | "login" | "recover">(
    miniApp ? "login" : "register",
  );
  const [registration, setRegistration] =
    useState<RegistrationChallenge | null>(null);
  const landingTask = useRef<(TaskSelection & { expiresAt: number }) | null>(
    miniApp?.task
      ? {
          task: miniApp.task,
          expiresAt: Date.now() + landingTaskMaxAgeMs,
          housingCriteria: miniApp.housingCriteria,
        }
      : null,
  );
  const pendingOwnerTask = useRef<RegistrationTask | undefined>(undefined);
  const resumeHousingOwner = useRef(miniApp?.resumeHousingOwner);
  const [launchHousing, setLaunchHousing] = useState<{
    ownerId: string;
    criteria: MiniAppAccountAccess["housingCriteria"];
  } | null>(null);
  const miniRetryTask = useRef<RegistrationTask | undefined>(undefined);
  const [miniOffline, setMiniOffline] = useState(false);
  const [miniRefreshFailed, setMiniRefreshFailed] = useState(false);
  const workspaceBack = useRef<(() => boolean) | null>(null);
  const registerWorkspaceBack = useCallback(
    (handler: (() => boolean) | null) => {
      workspaceBack.current = handler;
    },
    [],
  );
  const landingAssistantEvent = useRef<{
    ownerId: string;
    signal: AbortSignal;
    assistant: (typeof landingTaskAgents)[LandingTask];
    threadId: string;
  } | null>(null);
  const landingAnalyticsEntry = useRef<LandingAttribution | undefined>(
    undefined,
  );
  useEffect(() => {
    if (miniApp) return;
    const task = consumeLandingTask();
    const login = consumeLandingLoginIntent();
    if (task) {
      landingTask.current = {
        task,
        expiresAt: Date.now() + landingTaskMaxAgeMs,
      };
    } else if (login) {
      setMode("login");
    }
    if (!browserAcquisitionAllowed()) clearBrowserLandingAttribution();
    landingAnalyticsEntry.current ??= consumeLandingAnalyticsEntry();
  }, []);
  const registrationAnalytics = useRef<RegistrationAnalyticsFlow | null>(null);
  const authPending = useRef(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [receiptsOpen, setReceiptsOpen] = useState(false);
  const [favoritesOpen, setFavoritesOpen] = useState(false);
  const [conversationNavigation, setConversationNavigation] = useState(0);
  const [phoneOpen, setPhoneOpen] = useState(false);
  const [profileRevision, setProfileRevision] = useState(0);
  const miniAccountDetailTrigger = useRef<HTMLElement | null>(null);
  const [messengerOpen, setMessengerOpen] = useState(!!miniApp?.initData);
  const [balanceOpen, setBalanceOpen] = useState(false);
  const [telegramStarsOpen, setTelegramStarsOpen] = useState(false);
  const [telegramStarsOwner, setTelegramStarsOwner] = useState<string | null>(
    null,
  );
  const [conversationView, setConversationView] = useState(true);
  const [workspaceRequest, setWorkspaceRequest] = useState<{
    tab: string;
    sequence: number;
  } | null>(null);
  const workspaceRequestSequence = useRef(0);
  const [text, setText] = useState("");
  const [draftRecovered, setDraftRecovered] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState("");
  const [streamAgent, setStreamAgent] = useState<AgentKey | null>(null);
  const [miniChatCapability, setMiniChatCapability] = useState<{
    ownerId: string;
    version: number;
    available: boolean;
  } | null>(null);
  const [miniChatRecovery, setMiniChatRecovery] =
    useState<MiniChatRecovery | null>(null);
  const miniChatMarkers = useRef(new Map<string, MiniChatMarker>());
  const miniChatOwner =
    miniApp &&
    !board?.user.serviceConsentRequired &&
    !board?.user.mustChangePassword
      ? board?.user.id
      : undefined;
  const miniChatThread = miniChatOwner ? board?.thread?.id : undefined;
  const canSendMiniChat =
    !!miniChatCapability &&
    miniChatCapability.ownerId === miniChatOwner &&
    miniChatCapability.version === formVersion &&
    miniChatCapability.available;
  const currentMiniRecovery =
    miniChatRecovery?.ownerId === miniChatOwner &&
    miniChatRecovery?.threadId === miniChatThread
      ? miniChatRecovery
      : null;
  const canDismissMiniChat =
    currentMiniRecovery?.status === "complete" ||
    currentMiniRecovery?.status === "interrupted" ||
    currentMiniRecovery?.status === "missing";
  const [selectedAiMode, setSelectedAiMode] =
    useState<AiModeId>(initialWebAiMode);
  const aiModeChoiceSequence = useRef(0);
  const [aiModeConsent, setAiModeConsent] = useState<{
    mode: AiModeId;
    owner: string;
    sequence: number;
    ticket: SessionTicket;
  } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const selectedConversation = useRef<{ owner: string; id: string } | null>(
    null,
  );
  const visibleThread = useRef<string | null>(null);
  const conversationEpoch = useRef(0);
  const conversationSwitch = useRef(false);
  const conversationDrafts = useRef(new Map<string, string>());
  const conversationListRequests = useRef(createConversationListRequests());
  const [conversationFilters, setConversationFilters] =
    useState<ConversationFilters>({});
  const [conversations, setConversations] = useState<
    ConversationSummary[] | null
  >(null);
  const [conversationNextCursor, setConversationNextCursor] = useState<
    string | null
  >(null);
  const api = useMemo(
    () =>
      createClient("/api", {
        signal: () => session.capture().signal,
        onUnauthorized: requireLogin,
      }),
    [session],
  );
  const analyticsClient = useMemo(
    () =>
      createClient("/api", {
        signal: () => session.capture().signal,
      }),
    [session],
  );
  const miniProvider = miniApp?.provider;
  const telegramStarsAvailable =
    miniProvider === "telegram" &&
    !!miniAppOpenInvoice &&
    !!miniChatOwner &&
    telegramStarsOwner === miniChatOwner;
  useEffect(() => {
    if (miniProvider !== "telegram" || !miniAppOpenInvoice || !miniChatOwner)
      return;
    const ticket = session.capture();
    const controller = new AbortController();
    const signal = AbortSignal.any([ticket.signal, controller.signal]);
    void createClient("/api", { signal: () => signal })
      .telegramStars()
      .then(() => {
        if (!signal.aborted && ticket.active())
          setTelegramStarsOwner(miniChatOwner);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [miniProvider, miniAppOpenInvoice, miniChatOwner, session]);
  useEffect(() => {
    if (!miniProvider || !miniChatOwner) return;
    const ticket = session.capture();
    let current = true;
    void api
      .miniAppChat(miniProvider)
      .then(({ available }) => {
        if (current && ticket.active())
          setMiniChatCapability({
            ownerId: miniChatOwner,
            available,
            version: formVersion,
          });
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [api, session, miniProvider, miniChatOwner, formVersion]);
  useEffect(() => {
    if (!miniChatOwner || !miniChatThread) {
      setMiniChatRecovery(null);
      return;
    }
    const marker = findMiniChatMarker(miniChatOwner, miniChatThread);
    setMiniChatRecovery(
      marker
        ? {
            ...marker,
            ownerId: miniChatOwner,
            threadId: miniChatThread,
            status: "unchecked",
          }
        : null,
    );
  }, [miniChatOwner, miniChatThread, formVersion]);
  const analytics = useProductAnalytics({
    config: parseProductAnalyticsConfig({
      enabled: process.env.NEXT_PUBLIC_CITYGO_METRIKA_ENABLED,
      counterId: process.env.NEXT_PUBLIC_CITYGO_METRIKA_COUNTER_ID,
      webvisor: process.env.NEXT_PUBLIC_CITYGO_METRIKA_WEBVISOR,
      paidPixelsEnabled: process.env.NEXT_PUBLIC_CITYGO_AD_PIXELS_ENABLED,
      vkPixelId: process.env.NEXT_PUBLIC_CITYGO_VK_PIXEL_ID,
      avitoCounterId: process.env.NEXT_PUBLIC_CITYGO_AVITO_COUNTER_ID,
    }),
    ownerId: board?.user.id ?? null,
    role: board?.user.role,
    blocked:
      !!miniApp ||
      messengerOpen ||
      loading ||
      passwordOpen ||
      mode === "recover" ||
      !!board?.user.mustChangePassword ||
      !!board?.user.serviceConsentRequired,
    surface: !board
      ? mode === "login"
        ? "login"
        : "register"
      : balanceOpen
        ? "wallet"
        : phoneOpen
          ? "phone"
          : favoritesOpen
            ? "favorites"
            : conversationView
              ? "chat"
              : "profile",
    sessionSignal: session.capture().signal,
    client: analyticsClient,
    landingAnalyticsEntry,
  });
  useEffect(() => {
    const opened = landingAssistantEvent.current;
    if (
      !opened ||
      board?.user.id !== opened.ownerId ||
      board.thread?.id !== opened.threadId
    )
      return;
    landingAssistantEvent.current = null;
    if (!opened.signal.aborted)
      trackProductEvent(
        "assistant_opened",
        { surface: "chat", assistant: opened.assistant },
        opened.threadId,
      );
  }, [board]);
  const history = useConversationHistory({
    board: board?.user.serviceConsentRequired ? null : board,
    sessionSignal: session.capture().signal,
    onAccessDenied: requireLogin,
  });
  function requireLogin() {
    const hadOwner = session.hasOwner();
    if (hadOwner) notifyBrowserSessionChange();
    clearUserState(undefined, !hadOwner);
    if (hadOwner) setNotice("Сессия завершилась. Войдите снова.");
  }
  function clearUserState(owner?: string, keepAnonymousTask = false) {
    if (!keepAnonymousTask) landingTask.current = null;
    resumeHousingOwner.current = undefined;
    rememberHousingOwner?.(null);
    pendingOwnerTask.current = undefined;
    setLaunchHousing(null);
    miniRetryTask.current = undefined;
    setMiniRefreshFailed(false);
    landingAssistantEvent.current = null;
    clearChatDrafts(draftStorage());
    clearMiniChatMarkers(draftStorage());
    miniChatMarkers.current.clear();
    setMiniChatRecovery(null);
    setMiniChatCapability(null);
    setDraftRecovered(false);
    session.reset(owner);
    abort.current?.abort();
    abort.current = null;
    setBoard(null);
    setSelectedAiMode(initialWebAiMode);
    cancelAiModeChoice();
    chatSubmitting.current = false;
    setText("");
    setDraft("");
    setPending("");
    setStreamAgent(null);
    setSending(false);
    setBusy(false);
    setError("");
    setNotice("");
    setLoading(false);
    setLogoutUnconfirmed(false);
    setLogoutIntent(null);
    setPasswordOpen(false);
    setRegistration(null);
    registrationAnalytics.current = null;
    authPending.current = false;
    setReceiptsOpen(false);
    setFavoritesOpen(false);
    setPhoneOpen(false);
    miniAccountDetailTrigger.current = null;
    setMessengerOpen(false);
    setBalanceOpen(false);
    setTelegramStarsOpen(false);
    setTelegramStarsOwner(null);
    setConversationView(true);
    setWorkspaceRequest(null);
    selectedConversation.current = null;
    visibleThread.current = null;
    conversationDrafts.current.clear();
    conversationSwitch.current = false;
    conversationEpoch.current++;
    refreshVersion.current++;
    conversationListRequests.current.reset();
    setConversationFilters({});
    setConversations(null);
    setConversationNextCursor(null);
    setFormVersion((value) => value + 1);
    window.history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
  }
  async function refresh(
    ticket = session.capture(),
    registrationTask?: RegistrationTask,
  ) {
    ticket.check();
    let version = ++refreshVersion.current;
    let next: Dashboard;
    try {
      next = await api.dashboard();
    } catch (error) {
      if (miniApp && ticket.active() && version === refreshVersion.current) {
        miniRetryTask.current = registrationTask ?? miniRetryTask.current;
        setMiniRefreshFailed(true);
      }
      throw error;
    }
    ticket.check();
    if (version !== refreshVersion.current) return false;
    const entrance = landingTask.current;
    const followTask =
      registrationTask ??
      pendingOwnerTask.current ??
      (miniApp &&
      !session.hasOwner() &&
      entrance &&
      Date.now() < entrance.expiresAt
        ? {
            task: entrance.task,
            ownerId: next.user.id,
            housingCriteria: entrance.housingCriteria,
          }
        : undefined);
    landingTask.current = null;
    if (session.ownerChanged(next.user.id)) {
      notifyBrowserSessionChange();
      clearUserState(next.user.id);
      // The old owner's continuation remains invalid. Only this new ticket may
      // restore the new owner's non-secret selection, after server authorization.
      ticket = session.capture();
      version = ++refreshVersion.current;
    }
    if (next.user.serviceConsentRequired) {
      clearChatDrafts(draftStorage());
      setDraftRecovered(false);
      abort.current?.abort();
      selectedConversation.current = null;
      conversationDrafts.current.clear();
      visibleThread.current = null;
      conversationEpoch.current++;
      writeConversationSelection(next.user.id, null, conversationStorage());
      setText("");
      setDraft("");
      setPending("");
      setSending(false);
      conversationListRequests.current.reset();
      setConversationFilters({});
      setConversations(null);
      setConversationNextCursor(null);
      setConversationView(true);
      next = { ...next, thread: null };
    }
    const preferred =
      selectedConversation.current?.owner === next.user.id
        ? selectedConversation.current.id
        : readConversationSelection(next.user.id, conversationStorage());
    if (miniRetryTask.current?.ownerId !== next.user.id)
      miniRetryTask.current = undefined;
    if (miniApp) setMiniRefreshFailed(false);
    const target =
      followTask?.ownerId === next.user.id &&
      next.user.role === "user" &&
      !next.user.mustChangePassword &&
      !next.user.serviceConsentRequired
        ? landingTaskAgents[followTask.task]
        : undefined;
    pendingOwnerTask.current =
      miniApp &&
      followTask?.ownerId === next.user.id &&
      (next.user.serviceConsentRequired || next.user.mustChangePassword)
        ? followTask
        : undefined;
    if (target) {
      // Focus still probes session ownership while this selection is pending.
      conversationSwitch.current = true;
      try {
        const started = await api.startConversation(target);
        ticket.check();
        if (version !== refreshVersion.current) return false;
        const detail = await api.conversation(started.id);
        ticket.check();
        if (version !== refreshVersion.current) return false;
        if (detail.userId !== next.user.id) {
          clearUserState();
          return false;
        }
        if (detail.thread.closed || detail.thread.assistantKey !== target)
          throw new Error("Unexpected registration task conversation");
        next = { ...next, thread: detail.thread };
        rememberConversation(next.user.id, started.id);
        if (miniApp) {
          miniRetryTask.current = undefined;
          if (followTask?.task === "housing") {
            setLaunchHousing({
              ownerId: next.user.id,
              criteria: followTask.housingCriteria,
            });
            requestWorkspaceTab("Жильё");
            rememberHousingOwner?.(next.user.id);
          } else {
            requestWorkspaceTab("Диалоги");
          }
        }
        landingAssistantEvent.current = {
          ownerId: next.user.id,
          signal: ticket.signal,
          assistant: target,
          threadId: started.id,
        };
      } catch {
        ticket.check();
        if (version !== refreshVersion.current) return false;
        if (miniApp) {
          miniRetryTask.current = followTask;
          setMiniRefreshFailed(true);
        } else {
          setNotice(
            "Не удалось открыть диалог. Выберите помощника и продолжите.",
          );
        }
      } finally {
        if (ticket.active()) conversationSwitch.current = false;
      }
    } else if (
      preferred &&
      !next.user.mustChangePassword &&
      !next.user.serviceConsentRequired
    ) {
      try {
        const detail = await api.conversation(preferred);
        ticket.check();
        if (version !== refreshVersion.current) return false;
        if (detail.userId !== next.user.id) {
          clearUserState();
          return false;
        }
        next = { ...next, thread: detail.thread };
        selectedConversation.current = { owner: next.user.id, id: preferred };
        setConversationView(true);
      } catch (error) {
        ticket.check();
        if (version !== refreshVersion.current) return false;
        if (error instanceof ApiError && error.status === 404) {
          selectedConversation.current = null;
          writeConversationSelection(next.user.id, null, conversationStorage());
          writeChatDraft(next.user.id, preferred, "", draftStorage());
          conversationDrafts.current.delete(preferred);
          // A removed selection cannot carry its draft into a different chat.
          setText("");
        } else if (miniApp) {
          setMiniRefreshFailed(true);
          next = { ...next, thread: null };
        } else {
          throw error;
        }
      }
    }
    ticket.check();
    if (version !== refreshVersion.current) return false;
    if (resumeHousingOwner.current) {
      if (
        resumeHousingOwner.current === next.user.id &&
        !next.user.serviceConsentRequired &&
        !next.user.mustChangePassword
      ) {
        requestWorkspaceTab("Жильё");
        resumeHousingOwner.current = undefined;
      } else if (resumeHousingOwner.current !== next.user.id) {
        resumeHousingOwner.current = undefined;
        rememberHousingOwner?.(null);
      }
    }
    if (next.thread?.closed) {
      writeChatDraft(next.user.id, next.thread.id, "", draftStorage());
      conversationDrafts.current.delete(next.thread.id);
      setText("");
      setDraftRecovered(false);
    }
    if (visibleThread.current !== next.thread?.id && !chatSubmitting.current) {
      const restored =
        next.thread && !next.thread.closed
          ? readChatDraft(next.user.id, next.thread.id, draftStorage())
          : "";
      setText(restored);
      setDraftRecovered(!!restored);
    }
    visibleThread.current = next.thread?.id ?? null;
    setBoard(next);
    return next;
  }
  function cancelAiModeChoice() {
    aiModeChoiceSequence.current++;
    setAiModeConsent(null);
  }
  function chooseAiMode(value: AiModeId) {
    if (
      !board ||
      board.user.serviceConsentRequired ||
      board.user.mustChangePassword ||
      busy ||
      sending ||
      chatSubmitting.current
    )
      return;
    if (miniApp && !canSendMiniChat) {
      setSelectedAiMode(value);
      return;
    }
    const option = board.aiAccess.modes?.options.find(
      (candidate) => candidate.id === value,
    );
    if (!option?.available) return;
    cancelAiModeChoice();
    if (!option.consentRequired) {
      setSelectedAiMode(value);
      trackProductEvent("mode_selected", { surface: "chat", mode: value });
      return;
    }
    setAiModeConsent({
      mode: value,
      owner: board.user.id,
      sequence: aiModeChoiceSequence.current,
      ticket: session.capture(),
    });
  }
  useEffect(() => {
    if (
      board?.user.mustChangePassword ||
      board?.user.serviceConsentRequired ||
      passwordOpen
    )
      cancelAiModeChoice();
  }, [
    board?.user.mustChangePassword,
    board?.user.serviceConsentRequired,
    passwordOpen,
  ]);
  function rememberConversation(owner: string, id: string) {
    selectedConversation.current = { owner, id };
    setConversationView(true);
    writeConversationSelection(owner, id, conversationStorage());
  }
  function changeText(value: string) {
    if (
      !board?.thread ||
      !session.hasOwner() ||
      session.capture().signal.aborted ||
      (miniApp && findMiniChatMarker(board.user.id, board.thread.id))
    )
      return;
    conversationDrafts.current.set(board.thread.id, value);
    writeChatDraft(board.user.id, board.thread.id, value, draftStorage());
    setDraftRecovered(false);
    setText(value);
  }
  function restoreDraft(owner: string, id: string, closed: boolean) {
    if (closed) {
      writeChatDraft(owner, id, "", draftStorage());
      conversationDrafts.current.delete(id);
    }
    const restored = closed
      ? ""
      : (conversationDrafts.current.get(id) ??
        readChatDraft(owner, id, draftStorage()));
    setText(restored);
    setDraftRecovered(!!restored);
  }
  async function beginConversation(
    agentKey?: AgentKey,
    handoff?: AssistantHandoffInput,
    discussion?: ResultDiscussionInput,
  ) {
    if (
      !board ||
      board.user.serviceConsentRequired ||
      busy ||
      aiModeConsent !== null ||
      sending ||
      conversationSwitch.current
    )
      return false;
    if (
      handoff &&
      (agentKey !== handoff.target ||
        !assistantHandoffTarget(handoff.source, handoff.target) ||
        !currentAssistantHandoffSource(
          handoff.source,
          // The displayed history includes authorized older pages. The hook
          // binds this projection to the current owner, thread and session.
          history.board ?? board,
          session.capture().signal,
        ))
    )
      return false;
    if (
      discussion &&
      (handoff ||
        agentKey !== discussion.target ||
        !currentResultDiscussionInput(
          discussion,
          board.user.id,
          session.capture().signal,
        ))
    )
      return false;
    if (discussion) {
      try {
        resultDiscussionDraft(discussion.text);
      } catch {
        return false;
      }
    }
    if (handoff) {
      try {
        assistantHandoffDraft(handoff.text);
      } catch {
        return false;
      }
    }
    conversationSwitch.current = true;
    const epoch = ++conversationEpoch.current;
    const version = ++refreshVersion.current;
    if (board.thread) conversationDrafts.current.set(board.thread.id, text);
    let opened = false;
    try {
      const completed = await act(async (ticket) => {
        const started = await api.startConversation(agentKey);
        ticket.check();
        if (
          epoch !== conversationEpoch.current ||
          version !== refreshVersion.current
        )
          return;
        // Commit the selection only after the authorized history was read.
        // A failed GET must never route the previous thread's draft into this one.
        const detail = await api.conversation(started.id);
        ticket.check();
        if (
          epoch !== conversationEpoch.current ||
          version !== refreshVersion.current
        )
          return;
        if (detail.userId !== board.user.id) {
          clearUserState();
          return;
        }
        if (
          miniApp &&
          (handoff || discussion) &&
          findMiniChatMarker(board.user.id, detail.thread.id)
        ) {
          throw new Error(
            "Сначала проверьте состояние предыдущей отправки в этом диалоге.",
          );
        }
        let preparedDraft: string | null = null;
        if (handoff) {
          if (
            detail.thread.closed ||
            detail.thread.id === handoff.source.threadId ||
            (detail.thread.assistantKey ?? detail.thread.agentKey) !==
              handoff.target
          )
            throw new Error(
              "Handoff target does not match the selected assistant",
            );
          const existing =
            conversationDrafts.current.get(detail.thread.id) ??
            readChatDraft(board.user.id, detail.thread.id, draftStorage());
          preparedDraft = assistantHandoffDraft(handoff.text, existing);
        }
        if (discussion) {
          if (
            detail.thread.closed ||
            (detail.thread.assistantKey ?? detail.thread.agentKey) !==
              discussion.target
          )
            throw new Error("Result discussion target mismatch");
          const existing =
            conversationDrafts.current.get(detail.thread.id) ??
            readChatDraft(board.user.id, detail.thread.id, draftStorage());
          preparedDraft = resultDiscussionDraft(discussion.text, existing);
        }
        rememberConversation(board.user.id, detail.thread.id);
        visibleThread.current = detail.thread.id;
        setBoard((current) =>
          current?.user.id === board.user.id
            ? { ...current, thread: detail.thread }
            : current,
        );
        if (preparedDraft !== null) {
          conversationDrafts.current.set(detail.thread.id, preparedDraft);
          writeChatDraft(
            board.user.id,
            detail.thread.id,
            preparedDraft,
            draftStorage(),
          );
          setText(preparedDraft);
          setDraftRecovered(false);
        } else
          restoreDraft(board.user.id, detail.thread.id, detail.thread.closed);
        setDraft("");
        setPending("");
        setStreamAgent(null);
        opened = true;
        trackProductEvent(
          "assistant_opened",
          { surface: "chat", assistant: detail.thread.agentKey },
          detail.thread.id,
        );
      });
      return completed && opened;
    } finally {
      if (epoch === conversationEpoch.current)
        conversationSwitch.current = false;
    }
  }
  async function openConversation(id: string) {
    if (
      !board ||
      board.user.serviceConsentRequired ||
      busy ||
      sending ||
      conversationSwitch.current
    )
      return false;
    conversationSwitch.current = true;
    const epoch = ++conversationEpoch.current;
    const version = ++refreshVersion.current;
    if (board.thread) conversationDrafts.current.set(board.thread.id, text);
    let opened = false;
    try {
      const completed = await act(async (ticket) => {
        const detail = await api.conversation(id);
        ticket.check();
        if (
          epoch !== conversationEpoch.current ||
          version !== refreshVersion.current
        )
          return;
        if (detail.userId !== board.user.id) {
          clearUserState();
          return;
        }
        rememberConversation(board.user.id, detail.thread.id);
        visibleThread.current = detail.thread.id;
        setBoard((current) =>
          current?.user.id === board.user.id
            ? { ...current, thread: detail.thread }
            : current,
        );
        restoreDraft(board.user.id, id, detail.thread.closed);
        setDraft("");
        setPending("");
        setStreamAgent(null);
        opened = true;
        trackProductEvent("conversation_opened", { surface: "chat" });
      });
      return completed && opened;
    } finally {
      if (epoch === conversationEpoch.current)
        conversationSwitch.current = false;
    }
  }
  function loadConversations(before?: string, filters?: ConversationFilters) {
    if (!board || board.user.serviceConsentRequired || busy || sending) return;
    if (before !== undefined && before !== conversationNextCursor) return;
    const query = filters ?? conversationFilters;
    const currentRequest = conversationListRequests.current.begin(query);
    if (!before) {
      setConversationFilters(query);
      setConversations(null);
      setConversationNextCursor(null);
    }
    void act(async (ticket) => {
      const page = await api.conversations(before, query);
      ticket.check();
      if (!currentRequest()) return;
      if (page.userId !== board.user.id) {
        clearUserState();
        return;
      }
      setConversations((current) =>
        before
          ? [...(current ?? []), ...page.conversations].filter(
              (item, index, all) =>
                all.findIndex((other) => other.id === item.id) === index,
            )
          : page.conversations,
      );
      setConversationNextCursor(page.nextCursor);
    });
  }
  useEffect(() => {
    const unsubscribe = subscribeBrowserSessionChange(() => clearUserState());
    const onFocus = () => {
      // Detect a changed HttpOnly session after returning from another tab,
      // including browsers with disabled storage. Do not auto-restore a logout.
      if (!session.hasOwner()) return;
      if (conversationSwitch.current || abort.current) {
        // A focus event must still detect a replaced HttpOnly session while
        // streaming, but must not overwrite a pending conversation selection.
        const probe = session.capture();
        void api
          .dashboard()
          .then((next) => {
            probe.check();
            if (session.ownerChanged(next.user.id)) {
              notifyBrowserSessionChange();
              clearUserState(next.user.id);
              void refresh(session.capture()).catch(() => {});
            }
          })
          .catch(() => {});
      } else void refresh(session.capture()).catch(() => {});
    };
    window.addEventListener("focus", onFocus);
    const ticket = session.capture();
    void refresh(ticket)
      .catch((e) => {
        if (ticket.active()) setError(e.message);
      })
      .finally(() => {
        if (ticket.active()) setLoading(false);
      });
    return () => {
      unsubscribe();
      window.removeEventListener("focus", onFocus);
      session.reset();
      abort.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!miniApp) return;
    const updateConnection = () => setMiniOffline(!navigator.onLine);
    updateConnection();
    window.addEventListener("offline", updateConnection);
    window.addEventListener("online", updateConnection);
    return () => {
      window.removeEventListener("offline", updateConnection);
      window.removeEventListener("online", updateConnection);
    };
  }, [miniApp]);
  async function act(work: (ticket: SessionTicket) => Promise<void>) {
    const ticket = session.capture();
    setError("");
    setBusy(true);
    try {
      await work(ticket);
      ticket.check();
      return true;
    } catch (e) {
      if (
        ticket.active() &&
        e instanceof ApiError &&
        ["SERVICE_CONSENT_REQUIRED", "AI_POLICY_CHANGED"].includes(
          e.serverCode ?? "",
        )
      )
        await refresh(ticket).catch(() => {});
      if (ticket.active())
        setError(
          e instanceof Error ? e.message : "Не удалось выполнить запрос",
        );
      return false;
    } finally {
      if (ticket.active()) setBusy(false);
    }
  }
  function auth(
    event: FormEvent<HTMLFormElement>,
    consents?: ServiceConsentChoice,
  ) {
    event.preventDefault();
    if (mode === "recover") return;
    if (busy || logoutUnconfirmed || authPending.current) return;
    if (mode === "register" && !consents) return;
    const data = new FormData(event.currentTarget);
    const authMode = mode;
    const landingAttribution =
      authMode === "register" && !miniApp
        ? readBrowserLandingAttribution()
        : undefined;
    const selectedTask = landingTask.current;
    const selection =
      (authMode === "register" || miniApp) &&
      selectedTask &&
      Date.now() < selectedTask.expiresAt
        ? {
            task: selectedTask.task,
            housingCriteria: selectedTask.housingCriteria,
          }
        : undefined;
    const email = String(data.get("email"));
    let password = String(data.get("password"));
    data.delete("password");
    notifyBrowserSessionChange();
    clearUserState();
    if (authMode === "register")
      registrationAnalytics.current = analytics.beginRegistration(
        session.capture().signal,
        landingAttribution?.landingVersion,
      );
    authPending.current = true;
    void act(async (ticket) => {
      let accepted = false;
      try {
        if (authMode === "register") {
          const policy = await api.registrationPolicy();
          ticket.check();
          if (policy.consentPolicy.version !== consents?.policyVersion)
            throw new Error(
              "Согласия обновились. Прочитайте новую версию и выберите согласия заново.",
            );
          if (policy.emailVerification === "unavailable") {
            throw new Error(
              "Регистрация временно недоступна: отправка писем ещё не подключена. Если аккаунт уже есть, войдите.",
            );
          }
          if (policy.emailVerification === "required") {
            const challenge = await api.beginEmailRegistration(
              email,
              password,
              consents!,
              landingAttribution,
            );
            ticket.check();
            setRegistration({
              ...pendingEmailRegistration(
                email,
                challenge,
                Date.now(),
                consents!,
              ),
              selection,
            });
            analytics.registrationCodeSent(
              registrationAnalytics.current,
              challenge.challengeId,
              ticket.signal,
            );
            accepted = true;
            return;
          }
        }
        const authenticated = await api.auth(
          authMode,
          email,
          password,
          consents,
          landingAttribution,
        );
        ticket.check();
        accepted = true;
        const flow =
          authMode === "register"
            ? analytics.prepareRegistrationSuccess(
                registrationAnalytics.current,
                authenticated.user,
                ticket.signal,
              )
            : null;
        analytics.authSuccess(
          authMode === "register"
            ? "registration_completed"
            : "login_completed",
          authenticated.user,
          ticket.signal,
          flow,
        );
        clearBrowserLandingAttribution();
        await refresh(
          ticket,
          selection
            ? { ...selection, ownerId: authenticated.user.id }
            : undefined,
        );
        if (miniApp && ticket.active()) setMessengerOpen(true);
      } catch (cause) {
        if (ticket.active() && !accepted) {
          if (selection) landingTask.current = selectedTask;
          trackProductEvent(
            authMode === "register" ? "registration_failed" : "login_failed",
            { surface: authMode },
          );
        }
        throw cause;
      } finally {
        password = "";
        if (ticket.active()) authPending.current = false;
      }
    });
  }
  function changeAuthMode(next: "register" | "login" | "recover") {
    // Cancel both the network lifetime and the memory-only pending proof.
    const mustConfirmLogout = logoutUnconfirmed;
    clearUserState(undefined, !!miniApp);
    setLogoutUnconfirmed(mustConfirmLogout);
    setMode(next);
  }
  function resendRegistration() {
    if (!registration || busy || logoutUnconfirmed || authPending.current)
      return;
    const current = registration;
    authPending.current = true;
    void act(async (ticket) => {
      try {
        const challenge = await api.resendEmailRegistration(
          current.challengeId,
          current.proof,
        );
        ticket.check();
        setRegistration({
          ...pendingEmailRegistration(
            current.email,
            challenge,
            Date.now(),
            current.consents,
          ),
          selection: current.selection,
        });
        setNotice("Новый код отправлен. Предыдущий код больше не действует.");
      } finally {
        if (ticket.active()) authPending.current = false;
      }
    });
  }
  function confirmRegistration(code: string) {
    if (!registration || busy || logoutUnconfirmed || authPending.current)
      return;
    const current = registration;
    authPending.current = true;
    void act(async (ticket) => {
      try {
        const authenticated = await api.confirmEmailRegistration(
          current.challengeId,
          current.proof,
          code,
        );
        ticket.check();
        const flow = analytics.prepareRegistrationSuccess(
          registrationAnalytics.current,
          authenticated.user,
          ticket.signal,
          current.challengeId,
        );
        notifyBrowserSessionChange();
        clearUserState();
        const confirmed = session.capture();
        analytics.authSuccess(
          "registration_completed",
          authenticated.user,
          confirmed.signal,
          flow,
        );
        clearBrowserLandingAttribution();
        setBusy(true);
        try {
          await refresh(
            confirmed,
            current.selection
              ? { ...current.selection, ownerId: authenticated.user.id }
              : undefined,
          );
          if (miniApp && confirmed.active()) setMessengerOpen(true);
        } catch {
          if (confirmed.active())
            setNotice(
              "Email подтверждён, аккаунт создан. Не удалось загрузить кабинет — войдите с вашим паролем.",
            );
        } finally {
          if (confirmed.active()) setBusy(false);
        }
      } finally {
        if (ticket.active()) authPending.current = false;
      }
    });
  }
  async function signInWithMessenger() {
    if (!miniApp?.initData || busy || logoutUnconfirmed || authPending.current)
      return;
    const selectedTask = landingTask.current;
    let ticket = session.capture();
    authPending.current = true;
    setError("");
    setBusy(true);
    try {
      const result = await createClient("/api", {
        signal: () => ticket.signal,
      }).miniAppSignIn(miniApp.provider, miniApp.initData);
      ticket.check();
      const selection =
        selectedTask && Date.now() < selectedTask.expiresAt
          ? {
              task: selectedTask.task,
              housingCriteria: selectedTask.housingCriteria,
            }
          : result.purpose === "guest"
            ? undefined
            : { task: result.purpose };
      notifyBrowserSessionChange();
      clearUserState();
      ticket = session.capture();
      authPending.current = true;
      setBusy(true);
      await refresh(
        ticket,
        selection ? { ...selection, ownerId: result.user.id } : undefined,
      );
    } catch (cause) {
      if (ticket.active()) {
        const message =
          cause instanceof Error ? cause.message : "Не удалось войти.";
        setError(
          message + " Войдите с паролем или откройте мини-приложение заново.",
        );
      }
    } finally {
      if (ticket.active()) {
        authPending.current = false;
        setBusy(false);
      }
    }
  }
  function requestLogout(trigger: HTMLButtonElement) {
    if (!board) return;
    const ticket = session.capture();
    if (ticket.active())
      setLogoutIntent({ owner: board.user.id, ticket, trigger });
  }
  async function logout() {
    notifyBrowserSessionChange();
    clearUserState();
    const ticket = session.capture();
    setBusy(true);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      // Independent revocation request: closing the UI lifetime must not cancel it.
      await createClient("/api", { signal: () => controller.signal }).logout();
      if (ticket.active()) {
        trackProductEvent("logout_completed");
        setNotice("Вы вышли из аккаунта.");
      }
    } catch {
      if (ticket.active()) {
        setLogoutUnconfirmed(true);
        setError(
          "Не удалось завершить выход. Повторите попытку перед передачей устройства другому человеку.",
        );
      }
    } finally {
      clearTimeout(timer);
      if (ticket.active()) setBusy(false);
    }
  }
  function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const task = pendingOwnerTask.current;
    void act(async (ticket) => {
      await api.changePassword(
        String(data.get("currentPassword")),
        String(data.get("password")),
      );
      ticket.check();
      // Rotation invalidates every old session, including other browser tabs.
      notifyBrowserSessionChange();
      clearUserState();
      const rotated = session.capture();
      try {
        await refresh(rotated, task);
        rotated.check();
        setNotice("Пароль изменён. Другие сессии завершены.");
      } catch {
        if (rotated.active())
          setNotice(
            "Пароль изменён. Не удалось загрузить кабинет — войдите снова с новым паролем.",
          );
      }
    });
  }
  function findMiniChatMarker(ownerId: string, threadId: string) {
    const key = miniChatMarkerKey(ownerId, threadId);
    return key
      ? (miniChatMarkers.current.get(key) ??
          readMiniChatMarker(draftStorage(), key))
      : null;
  }
  function storeMiniChatMarker(
    ownerId: string,
    threadId: string,
    marker: MiniChatMarker | null,
  ) {
    const key = miniChatMarkerKey(ownerId, threadId);
    if (!key) return;
    if (marker) miniChatMarkers.current.set(key, marker);
    else miniChatMarkers.current.delete(key);
    writeMiniChatMarker(draftStorage(), key, marker);
  }

  async function checkMiniChat() {
    const recovery = currentMiniRecovery;
    if (
      !miniProvider ||
      !recovery ||
      miniOffline ||
      busy ||
      sending ||
      recovery.status === "checking"
    )
      return;
    setMiniChatRecovery({ ...recovery, status: "checking" });
    const checked = await act(async (ticket) => {
      const { status } = await api.miniAppChatStatus(
        miniProvider,
        recovery.threadId,
        recovery.requestId,
      );
      ticket.check();
      const current = await refresh(ticket);
      ticket.check();
      if (
        !current ||
        current.user.id !== recovery.ownerId ||
        current.thread?.id !== recovery.threadId
      )
        throw new Error("Снова откройте диалог, чтобы проверить отправку.");
      history.returnToLatest();
      if (status === "complete" || status === "interrupted") {
        storeMiniChatMarker(recovery.ownerId, recovery.threadId, null);
        conversationDrafts.current.delete(recovery.threadId);
        writeChatDraft(recovery.ownerId, recovery.threadId, "", draftStorage());
        setDraftRecovered(false);
        setText("");
      }
      setMiniChatRecovery({ ...recovery, status });
    });
    if (!checked)
      setMiniChatRecovery((current) =>
        current?.requestId === recovery.requestId &&
        current.status === "checking"
          ? { ...current, status: "unchecked" }
          : current,
      );
  }

  function dismissMiniChat() {
    const recovery = currentMiniRecovery;
    if (!recovery || busy || sending) return;
    if (canDismissMiniChat) {
      storeMiniChatMarker(recovery.ownerId, recovery.threadId, null);
      if (recovery.status === "missing") {
        conversationDrafts.current.delete(recovery.threadId);
        writeChatDraft(recovery.ownerId, recovery.threadId, "", draftStorage());
        setDraftRecovered(false);
        setText("");
      }
      setMiniChatRecovery(null);
    }
  }

  async function retryMiniChat() {
    const recovery = currentMiniRecovery;
    if (
      !board?.thread ||
      !recovery ||
      recovery.status !== "missing" ||
      miniOffline ||
      !canSendMiniChat ||
      !text.trim() ||
      busy ||
      sending ||
      aiModeConsent !== null ||
      history.detached ||
      board.thread.closed ||
      conversationSwitch.current
    )
      return;
    const option = board.aiAccess.modes?.options.find(
      (mode) => mode.id === recovery.mode,
    );
    if (option?.consentRequired) {
      chooseAiMode(recovery.mode);
      return;
    }
    await sendChat(
      board,
      text,
      conversationEpoch.current,
      session.capture(),
      recovery,
    );
  }

  async function chat(event: FormEvent) {
    event.preventDefault();
    if (
      !board?.thread ||
      (miniApp &&
        (!canSendMiniChat ||
          miniOffline ||
          currentMiniRecovery ||
          findMiniChatMarker(board.user.id, board.thread.id))) ||
      board.user.serviceConsentRequired ||
      board.thread.closed ||
      board.user.mustChangePassword ||
      !isAiModeAvailable(
        board.aiAccess.modes,
        selectedAiMode,
        board.provider !== "unconfigured",
      ) ||
      history.detached ||
      !text.trim() ||
      busy ||
      aiModeConsent !== null ||
      sending ||
      conversationSwitch.current ||
      chatSubmitting.current
    )
      return;
    if (!board.aiAccess.granted) {
      // Only explicit registration/reacceptance can authorize processing.
      // A stale dashboard may be refreshed, but never grants or sends a draft.
      await act(async (ticket) => {
        await refresh(ticket);
        ticket.check();
        setNotice(
          "Обновлены условия доступа. Отправьте сообщение снова после подтверждения условий.",
        );
      });
      return;
    }
    if (
      board.aiAccess.modes?.options.some(
        (option) => option.id === selectedAiMode && option.consentRequired,
      )
    ) {
      chooseAiMode(selectedAiMode);
      return;
    }
    await sendChat(board, text, conversationEpoch.current, session.capture());
  }
  async function sendChat(
    snapshot: Dashboard,
    message: string,
    epoch: number,
    ticket: SessionTicket,
    miniRetry?: MiniChatMarker,
  ) {
    if (
      chatSubmitting.current ||
      !ticket.active() ||
      epoch !== conversationEpoch.current ||
      !snapshot.thread ||
      visibleThread.current !== snapshot.thread.id ||
      !snapshot.aiAccess.granted ||
      (miniProvider && (!canSendMiniChat || miniOffline))
    )
      return;
    const textError = chatTextError(message);
    if (textError) {
      setError(textError);
      return;
    }
    let mode: ReturnType<typeof captureAiModeSelection>;
    try {
      mode = captureAiModeSelection(
        snapshot.aiAccess.modes,
        miniRetry?.mode ?? selectedAiMode,
      );
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Режим сейчас недоступен.",
      );
      return;
    }
    const requestId = miniRetry?.requestId ?? crypto.randomUUID();
    // The legacy API omits a catalog and keeps its Balanced route.
    const submittedMode = mode?.aiMode ?? "balanced";
    let answerCompleted = false;
    let responseStarted = false;
    trackProductEvent("ai_request_submitted", {
      surface: "chat",
      mode: submittedMode,
      assistant: snapshot.thread.agentKey,
    });
    chatSubmitting.current = true;
    const threadId = snapshot.thread.id;
    const miniMarker: MiniChatRecovery | null = miniProvider
      ? {
          ownerId: snapshot.user.id,
          threadId,
          requestId,
          mode: submittedMode,
          status: "unchecked",
        }
      : null;
    if (miniMarker) {
      storeMiniChatMarker(snapshot.user.id, threadId, miniMarker);
      setMiniChatRecovery(miniMarker);
      conversationDrafts.current.set(threadId, message);
      writeChatDraft(snapshot.user.id, threadId, message, draftStorage());
    } else {
      conversationDrafts.current.delete(threadId);
      writeChatDraft(snapshot.user.id, threadId, "", draftStorage());
    }
    setDraftRecovered(false);
    setText("");
    setDraft("");
    setPending(message);
    setSending(true);
    setStreamAgent(snapshot.thread.agentKey);
    const controller = new AbortController();
    abort.current = controller;
    const succeeded = await act(async () => {
      try {
        const onEvent = (event: StreamEvent) => {
          if (
            !ticket.active() ||
            epoch !== conversationEpoch.current ||
            visibleThread.current !== threadId
          )
            return;
          if (event.type === "delta") {
            responseStarted = true;
            setDraft((value) => value + event.text);
          }
          if (event.type === "handoff") {
            setNotice(event.reason);
            setStreamAgent(event.to);
          }
          if (event.type === "done") {
            answerCompleted = true;
            trackProductEvent(
              "ai_response_completed",
              {
                surface: "chat",
                mode: submittedMode,
                assistant: snapshot.thread!.agentKey,
              },
              requestId,
            );
          }
        };
        const args = [
          threadId,
          message,
          requestId,
          onEvent,
          controller.signal,
          snapshot.aiAccess.policy?.id,
          snapshot.aiAccess.credit?.reservationMode,
          mode,
        ] as const;
        if (miniProvider) await api.miniAppStream(miniProvider, ...args);
        else await api.stream(...args);
      } catch (e) {
        if (!ticket.active()) return;
        if (!controller.signal.aborted) throw e;
        setNotice("Ответ остановлен. Полученная часть останется в истории.");
      } finally {
        if (ticket.active() && epoch === conversationEpoch.current)
          await refresh(ticket);
      }
    });
    if (!ticket.active() || epoch !== conversationEpoch.current) {
      if (ticket.active()) chatSubmitting.current = false;
      return;
    }
    if (!answerCompleted)
      trackProductEvent(
        controller.signal.aborted
          ? "ai_response_stopped"
          : "ai_response_failed",
        {
          surface: "chat",
          mode: submittedMode,
          assistant: snapshot.thread.agentKey,
        },
        requestId,
      );
    if (miniMarker && answerCompleted) {
      storeMiniChatMarker(snapshot.user.id, threadId, null);
      setMiniChatRecovery(null);
      conversationDrafts.current.delete(threadId);
      writeChatDraft(snapshot.user.id, threadId, "", draftStorage());
    } else if (miniMarker) {
      setText(message);
    } else if (!succeeded && !answerCompleted && !responseStarted) {
      setText(message);
      conversationDrafts.current.set(threadId, message);
      writeChatDraft(snapshot.user.id, threadId, message, draftStorage());
    }
    setDraft("");
    setPending("");
    setSending(false);
    setStreamAgent(null);
    abort.current = null;
    chatSubmitting.current = false;
  }
  const Experience =
    !miniApp &&
    board?.profile &&
    !board.thread?.assistantKey &&
    !conversationView
      ? Journey
      : ConversationHome;
  const topups = {
    createTopup: async (input: Parameters<typeof api.createTopup>[0]) => {
      const ticket = session.capture();
      const order = await api.createTopup(input);
      ticket.check();
      return order;
    },
    topupOrder: async (orderId: string) => {
      const ticket = session.capture();
      const order = await api.topupOrder(orderId);
      ticket.check();
      return order;
    },
    topupAttempt: async (requestId: string) => {
      const ticket = session.capture();
      const order = await api.topupAttempt(requestId);
      ticket.check();
      return order;
    },
    reconcileTopup: async (orderId: string) => {
      const ticket = session.capture();
      const order = await api.reconcileTopup(orderId);
      ticket.check();
      return order;
    },
    onCredited: async () => {
      await refresh(session.capture());
    },
  };
  const authViewSignal = session.capture().signal;
  function openBalance() {
    if (miniApp && !phoneOpen && document.activeElement instanceof HTMLElement)
      miniAccountDetailTrigger.current = document.activeElement;
    trackProductEvent("wallet_opened", { surface: "wallet" });
    setPhoneOpen(false);
    setMessengerOpen(false);
    setReceiptsOpen(false);
    setFavoritesOpen(false);
    setBalanceOpen(true);
    if (miniApp) void refresh(session.capture()).catch(() => {});
  }
  function openPhone() {
    if (miniProvider === "max") return;
    if (miniApp && document.activeElement instanceof HTMLElement)
      miniAccountDetailTrigger.current = document.activeElement;
    trackProductEvent("phone_opened", { surface: "phone" });
    setBalanceOpen(false);
    setMessengerOpen(false);
    setFavoritesOpen(false);
    setReceiptsOpen(false);
    setPhoneOpen(true);
  }
  function openTelegramStars() {
    if (!telegramStarsAvailable) return;
    if (document.activeElement instanceof HTMLElement)
      miniAccountDetailTrigger.current = document.activeElement;
    setTelegramStarsOpen(true);
  }
  function refreshPhoneStatus() {
    setProfileRevision((revision) => revision + 1);
    void refresh(session.capture()).catch(() => {});
  }
  function requestWorkspaceTab(tab: string) {
    setWorkspaceRequest({ tab, sequence: ++workspaceRequestSequence.current });
  }
  function returnToWorkspace(tab: string) {
    setMessengerOpen(false);
    setBalanceOpen(false);
    setTelegramStarsOpen(false);
    setPhoneOpen(false);
    setFavoritesOpen(false);
    setReceiptsOpen(false);
    setConversationView(true);
    requestWorkspaceTab(tab);
  }
  function returnToApp() {
    setBalanceOpen(false);
    setPhoneOpen(false);
    setTelegramStarsOpen(false);
    if (miniApp) {
      if (phoneOpen) refreshPhoneStatus();
      const trigger = miniAccountDetailTrigger.current;
      miniAccountDetailTrigger.current = null;
      requestAnimationFrame(() => trigger?.focus());
      return;
    }
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLButtonElement>("#citygo-account-overview button")
        ?.focus(),
    );
  }
  function returnToMiniProfile() {
    returnToApp();
    requestWorkspaceTab("Профиль");
    requestAnimationFrame(() =>
      document.getElementById("account-profile-heading")?.focus(),
    );
  }
  useEffect(() => {
    if (!phoneOpen) return;
    const target = document.getElementById("phone-gift-heading");
    target?.scrollIntoView({ block: "start" });
    target?.focus({ preventScroll: true });
  }, [phoneOpen]);
  useEffect(() => {
    if (!balanceOpen) return;
    const target =
      (!miniProvider && document.getElementById(chatBalanceTarget)) ||
      document.getElementById("citygo-wallet-view");
    target?.scrollIntoView({ block: "start" });
    target?.focus({ preventScroll: true });
  }, [balanceOpen, miniProvider]);
  useEffect(() => {
    if (!registerMiniAppBack) return;
    registerMiniAppBack(() => {
      if (busy || sending) return true;
      if (logoutIntent) setLogoutIntent(null);
      else if (aiModeConsent) cancelAiModeChoice();
      else if (!board && mode !== "login") changeAuthMode("login");
      else if (
        board?.user.mustChangePassword ||
        board?.user.serviceConsentRequired
      )
        return false;
      else if (passwordOpen) setPasswordOpen(false);
      else if (messengerOpen && board) setMessengerOpen(false);
      else if (balanceOpen || phoneOpen || telegramStarsOpen) returnToApp();
      else if (receiptsOpen) setReceiptsOpen(false);
      else if (favoritesOpen) setFavoritesOpen(false);
      else return workspaceBack.current?.() ?? false;
      return true;
    });
    return () => registerMiniAppBack(null);
  });
  const retryTask = miniRetryTask.current;
  const showMiniResume =
    miniApp && (miniOffline || miniRefreshFailed || retryTask);
  return (
    <div
      className={
        "shell prototype-shell" +
        (miniApp ? " mini-home" : "") +
        (board?.profile ? " shell-journey" : board ? " shell-onboarding" : "") +
        (!board && (mode === "register" || mode === "recover")
          ? " " + registrationStyles.registrationShell
          : "") +
        (!board && mode === "recover" ? " " + recoveryStyles.recoveryShell : "")
      }
    >
      {!miniApp && (
        <header className="topbar">
          <Link className="wordmark" href="/" aria-label="CityGo — главная">
            <span className="citygo-brand-symbol" aria-hidden="true" />
            <span className="citygo-brand-wordmark" aria-hidden="true" />
          </Link>
          <span className="header-caption">Новый город. Ваша история.</span>
          {board ? (
            <>
              {!board.user.mustChangePassword &&
                !board.user.serviceConsentRequired &&
                !passwordOpen && (
                  <div
                    id="citygo-workspace-navigation"
                    className="workspace-navigation-slot"
                  />
                )}
              <div className="account ym-hide-content">
                <Badge>{board.xp} XP</Badge>
                {!board.user.mustChangePassword &&
                  !board.user.serviceConsentRequired &&
                  !passwordOpen && (
                    <AccountOverview
                      compact
                      access={board.aiAccess}
                      disabled={busy || sending}
                      onBalance={openBalance}
                      onPhone={openPhone}
                    />
                  )}
                <details
                  className="account-menu"
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.currentTarget.open = false;
                      event.currentTarget.querySelector("summary")?.focus();
                    }
                  }}
                  onClick={(event) => {
                    const action =
                      event.target instanceof Element
                        ? event.target.closest("button")
                        : null;
                    if (action && action.textContent?.trim() !== "Выйти") {
                      event.currentTarget.open = false;
                    }
                  }}
                >
                  <summary>Аккаунт</summary>
                  <div>
                    {!board.user.mustChangePassword &&
                      !board.user.serviceConsentRequired &&
                      !passwordOpen && (
                        <>
                          <Button
                            variant="ghost"
                            disabled={busy || sending}
                            onClick={() => {
                              setMessengerOpen(false);
                              setConversationView(true);
                              setWorkspaceRequest({
                                tab: "Диалоги",
                                sequence: ++workspaceRequestSequence.current,
                              });
                              setPhoneOpen(false);
                              setBalanceOpen(false);
                              setFavoritesOpen(false);
                              setReceiptsOpen(false);
                            }}
                          >
                            Диалоги и помощники
                          </Button>
                          <Button
                            variant="ghost"
                            disabled={busy || sending}
                            onClick={() => {
                              setMessengerOpen(false);
                              setReceiptsOpen(false);
                              setPhoneOpen(false);
                              setBalanceOpen(false);
                              setFavoritesOpen(true);
                            }}
                          >
                            Избранное
                          </Button>
                          <Button
                            variant="ghost"
                            disabled={busy || sending}
                            onClick={() => {
                              setMessengerOpen(false);
                              setFavoritesOpen(false);
                              setPhoneOpen(false);
                              setBalanceOpen(false);
                              setReceiptsOpen(true);
                            }}
                          >
                            Мои чеки
                          </Button>
                          <Button
                            variant="ghost"
                            disabled={busy || sending}
                            onClick={() => {
                              setBalanceOpen(false);
                              setPhoneOpen(false);
                              setFavoritesOpen(false);
                              setReceiptsOpen(false);
                              setMessengerOpen(true);
                            }}
                          >
                            Мессенджеры
                          </Button>
                          {board.profile && !board.thread?.assistantKey && (
                            <Button
                              variant="ghost"
                              disabled={busy || sending}
                              onClick={() => {
                                setMessengerOpen(false);
                                setConversationView(false);
                                setPhoneOpen(false);
                                setBalanceOpen(false);
                                setFavoritesOpen(false);
                                setReceiptsOpen(false);
                              }}
                            >
                              Карта пути
                            </Button>
                          )}
                        </>
                      )}
                    <Button
                      variant="ghost"
                      onClick={() => setPasswordOpen(true)}
                    >
                      Пароль
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={(event) => requestLogout(event.currentTarget)}
                    >
                      Выйти
                    </Button>
                  </div>
                </details>
              </div>
            </>
          ) : (
            <div className={registrationStyles.headerActions}>
              <Button
                variant="secondary"
                aria-label={mode === "login" ? "Вы на экране входа" : undefined}
                onClick={() => changeAuthMode("login")}
              >
                Войти
              </Button>
              <Button onClick={() => changeAuthMode("register")}>
                Начать разговор
              </Button>
            </div>
          )}
        </header>
      )}
      {board &&
        logoutIntent &&
        currentLogoutConfirmation(
          logoutIntent,
          board.user.id,
          session.capture().signal,
        ) && (
          <LogoutConfirmation
            intent={logoutIntent}
            owner={board.user.id}
            sessionSignal={session.capture().signal}
            onClose={() =>
              setLogoutIntent((current) =>
                current === logoutIntent ? null : current,
              )
            }
            onConfirm={() => {
              if (
                currentLogoutConfirmation(
                  logoutIntent,
                  board.user.id,
                  session.capture().signal,
                )
              )
                void logout();
            }}
          />
        )}
      <main className="ym-hide-content" data-citygo-analytics-private>
        {error && (
          <div className="alert" role="alert">
            {error}
            <button aria-label="Закрыть сообщение" onClick={() => setError("")}>
              ×
            </button>
          </div>
        )}
        {notice && (
          <div className="notice" role="status">
            {notice}
          </div>
        )}
        {showMiniResume && (
          <div className="notice" role="status">
            <p>
              {miniOffline
                ? "Нет соединения. Подключитесь к интернету, чтобы продолжить."
                : retryTask
                  ? "Не удалось открыть диалог по выбранной задаче."
                  : "Не удалось загрузить кабинет."}
            </p>
            <Button
              variant="secondary"
              disabled={
                miniOffline || busy || sending || loading || logoutUnconfirmed
              }
              onClick={() =>
                void act(async (ticket) => {
                  const restored = await refresh(ticket, retryTask);
                  if (
                    !retryTask &&
                    miniRefreshFailed &&
                    restored &&
                    restored.thread
                  )
                    requestWorkspaceTab("Диалоги");
                })
              }
            >
              {retryTask
                ? "Продолжить выбранную задачу"
                : "Повторить подключение"}
            </Button>
          </div>
        )}
        {logoutUnconfirmed && (
          <Button disabled={busy} onClick={() => void logout()}>
            Повторить выход
          </Button>
        )}
        {loading ? (
          <Card>
            <p role="status">Загружаем ваш маршрут…</p>
          </Card>
        ) : !board && mode === "recover" ? (
          <PasswordRecovery
            key={formVersion}
            sessionSignal={authViewSignal}
            disabled={logoutUnconfirmed}
            onBack={() => changeAuthMode("login")}
            onRecovered={() => {
              if (authViewSignal.aborted) return;
              const selectedTask = miniApp ? landingTask.current : null;
              notifyBrowserSessionChange();
              clearUserState();
              landingTask.current = selectedTask;
              setMode("login");
              setNotice(
                "Пароль изменён. Все прежние сессии завершены. Войдите с новым паролем.",
              );
            }}
          />
        ) : !board && mode === "register" ? (
          <EmailRegistration
            key={
              registration
                ? registration.challengeId + ":" + registration.resendAt
                : formVersion
            }
            pending={registration}
            busy={busy}
            disabled={logoutUnconfirmed}
            formVersion={formVersion}
            sessionSignal={authViewSignal}
            onRegister={auth}
            onConfirm={confirmRegistration}
            onResend={resendRegistration}
            onBack={() => changeAuthMode(registration ? "register" : "login")}
          />
        ) : !board ? (
          <div className="welcome-grid">
            <Card className="auth-card">
              <span className="eyebrow">CITYGO · ВАШ ПЕРЕЕЗД</span>
              <h1>Рады видеть вас снова</h1>
              <p>
                Вернитесь к своему плану, разговорам и сохранённым результатам.
              </p>
              <form key={formVersion} onSubmit={auth}>
                <Field
                  className="ym-disable-keys"
                  label={
                    mode === "register"
                      ? "Электронная почта"
                      : "Логин или электронная почта"
                  }
                  name="email"
                  type={mode === "register" ? "email" : "text"}
                  autoComplete={mode === "register" ? "email" : "username"}
                  maxLength={254}
                  required
                />
                <Field
                  label="Пароль"
                  className="ym-disable-keys"
                  name="password"
                  type="password"
                  minLength={mode === "register" ? 6 : 1}
                  maxLength={128}
                  autoComplete={
                    mode === "register" ? "new-password" : "current-password"
                  }
                  hint={
                    mode === "register"
                      ? "Не менее 6 любых символов"
                      : undefined
                  }
                  required
                />
                <Button disabled={busy || logoutUnconfirmed} type="submit">
                  {busy
                    ? "Подождите…"
                    : mode === "register"
                      ? "Создать аккаунт"
                      : "Войти"}
                </Button>
              </form>
              {miniApp?.initData && (
                <Button
                  variant="secondary"
                  disabled={busy || logoutUnconfirmed}
                  onClick={() => void signInWithMessenger()}
                >
                  Войти через {messengerNames[miniApp.provider]}
                </Button>
              )}
              <Button
                variant="ghost"
                onClick={() => {
                  changeAuthMode(mode === "register" ? "login" : "register");
                }}
              >
                {mode === "register"
                  ? "Уже есть аккаунт? Войти"
                  : "Впервые здесь? Создать аккаунт"}
              </Button>
              <Button
                variant="ghost"
                disabled={busy || logoutUnconfirmed}
                onClick={() => changeAuthMode("recover")}
              >
                Не помню пароль
              </Button>
              <small>
                AI помогает подготовиться, но не заменяет проверку жилья и
                консультацию специалиста.
              </small>
            </Card>
          </div>
        ) : board.user.mustChangePassword || passwordOpen ? (
          <Card className="auth-card password-card">
            <h1>Изменить пароль</h1>
            <p>
              {board.user.mustChangePassword
                ? "Временный пароль нужно заменить до работы с AI и админкой."
                : "После изменения все остальные сессии завершатся."}
            </p>
            <form
              key={board.user.id + ":password:" + formVersion}
              onSubmit={changePassword}
            >
              <Field
                label="Текущий пароль"
                className="ym-disable-keys"
                name="currentPassword"
                type="password"
                autoComplete="current-password"
                required
                maxLength={128}
              />
              <Field
                label="Новый пароль"
                className="ym-disable-keys"
                name="password"
                type="password"
                autoComplete="new-password"
                minLength={6}
                maxLength={128}
                hint="Не менее 6 любых символов; отличается от текущего"
                required
              />
              <Button type="submit" disabled={busy}>
                Сохранить новый пароль
              </Button>
            </form>
            {!board.user.mustChangePassword && (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => setPasswordOpen(false)}
              >
                Назад
              </Button>
            )}
          </Card>
        ) : board.user.serviceConsentRequired ? (
          <ServiceConsentsPanel
            key={board.user.id + ":consents:" + formVersion}
            sessionSignal={session.capture().signal}
            onAccessDenied={requireLogin}
            onSaved={async () => {
              const ticket = session.capture();
              await refresh(ticket);
              ticket.check();
              setNotice("Условия приняты. Можно продолжить работу.");
            }}
          />
        ) : messengerOpen ? (
          <MessengerAccountsPanel
            key={board.user.id + ":messengers:" + formVersion}
            owner={board.user}
            miniApp={miniApp}
            sessionSignal={session.capture().signal}
            onAccessDenied={requireLogin}
            onSessionRevocation={() => void refresh().catch(() => {})}
            onSwitchAccount={() => {
              setMode("login");
              void logout();
            }}
            onClose={() => setMessengerOpen(false)}
          />
        ) : (
          <>
            <div
              className={miniApp ? "mini-account-detail" : undefined}
              hidden={
                !(
                  balanceOpen ||
                  phoneOpen ||
                  favoritesOpen ||
                  receiptsOpen ||
                  telegramStarsOpen
                )
              }
            >
              <WorkspaceFrame
                sidebar={
                  !miniApp && (
                    <JourneySidebar
                      disabled={busy || sending}
                      onSuggest={(message) => {
                        changeText(message);
                        returnToWorkspace("Диалоги");
                      }}
                      onSupport={() => returnToWorkspace("Помощь человека")}
                    />
                  )
                }
                rail={
                  !miniApp && (
                    <AssistantContextRail
                      agent={board.thread?.agentKey ?? "support"}
                      disabled={busy || sending}
                      city={board.profile?.targetCity}
                      onHelpers={() => returnToWorkspace("Помощники")}
                    />
                  )
                }
              >
                {telegramStarsOpen &&
                  telegramStarsAvailable &&
                  miniAppOpenInvoice && (
                    <TelegramStarsPanel
                      key={board.user.id}
                      sessionSignal={session.capture().signal}
                      openInvoice={miniAppOpenInvoice}
                      onAccessDenied={requireLogin}
                      onClose={returnToMiniProfile}
                    />
                  )}
                {miniApp ? (
                  balanceOpen && (
                    <MiniAppProfileBalance
                      userId={board.user.id}
                      sessionSignal={session.capture().signal}
                      availableMicros={board.aiAccess.credit?.availableMicros}
                      onAccessDenied={requireLogin}
                      onClose={returnToMiniProfile}
                    />
                  )
                ) : (
                  <section
                    id="citygo-wallet-view"
                    tabIndex={-1}
                    className={accountStyles.page}
                    hidden={!balanceOpen}
                    aria-label="Баланс и пополнение"
                  >
                    <span className={accountStyles.eyebrow}>
                      ЛИЧНЫЙ КАБИНЕТ · CITYGO
                    </span>
                    <h1>Баланс и пополнение</h1>
                    <Button variant="secondary" onClick={returnToApp}>
                      Вернуться в приложение
                    </Button>
                    <AiAccessPanel
                      key={board.user.id + ":balance:" + formVersion}
                      access={board.aiAccess}
                      renderHistory={(onClose) => (
                        <BalanceHistoryPanel
                          userId={board.user.id}
                          sessionSignal={session.capture().signal}
                          onAccessDenied={requireLogin}
                          onClose={onClose}
                        />
                      )}
                      userId={board.user.id}
                      busy={busy || sending}
                      topups={topups}
                      onPhone={openPhone}
                    />
                    {!board.aiAccess.credit && (
                      <p role="status">
                        Не удалось загрузить баланс. Обновите страницу.
                      </p>
                    )}
                  </section>
                )}
                {phoneOpen ? (
                  <PhoneVerificationPanel
                    key={board.user.id + ":phone:" + formVersion}
                    userId={board.user.id}
                    sessionSignal={session.capture().signal}
                    onAccessDenied={requireLogin}
                    miniAppProvider={miniProvider}
                    onGranted={refreshPhoneStatus}
                    onClose={returnToApp}
                    onOpenBalance={openBalance}
                    onOpenAssistants={() => returnToWorkspace("Помощники")}
                  />
                ) : favoritesOpen ? (
                  <MessageFavoritesPanel
                    key={board.user.id + ":favorites:" + formVersion}
                    userId={board.user.id}
                    sessionSignal={session.capture().signal}
                    onAccessDenied={requireLogin}
                    onOpenConversation={async (id) => {
                      const opened = await openConversation(id);
                      if (opened) {
                        setFavoritesOpen(false);
                        // Open the conversation tab even when Favorites was entered
                        // from Profile or Plan. Drafts remain owned by Home/thread.
                        setConversationNavigation((current) => current + 1);
                      }
                      return opened;
                    }}
                    onClose={() => {
                      setFavoritesOpen(false);
                      void refresh(session.capture()).catch(() => {});
                    }}
                  />
                ) : receiptsOpen ? (
                  <section aria-label="Чеки личного кабинета">
                    <Button
                      variant="secondary"
                      onClick={() => setReceiptsOpen(false)}
                    >
                      Вернуться в приложение
                    </Button>
                    <OwnerReceiptsPanel
                      key={board.user.id + ":receipts:" + formVersion}
                      userId={board.user.id}
                      sessionSignal={session.capture().signal}
                      onAccessDenied={requireLogin}
                    />
                  </section>
                ) : null}
              </WorkspaceFrame>
            </div>
            <div
              className={
                accountStyles.experience +
                (miniApp ? " mini-workspace-frame" : "")
              }
              hidden={
                balanceOpen ||
                phoneOpen ||
                favoritesOpen ||
                receiptsOpen ||
                telegramStarsOpen
              }
            >
              <Experience
                key={board.user.id + ":" + conversationNavigation}
                board={history.board ?? board}
                headerNavigationId={
                  miniApp ? undefined : "citygo-workspace-navigation"
                }
                miniAppNavigation={
                  miniApp
                    ? {
                        provider: miniApp.provider,
                        registerBack: registerWorkspaceBack,
                        onMessenger: () => {
                          requestWorkspaceTab("Профиль");
                          setMessengerOpen(true);
                        },
                        onReceipts: () => setReceiptsOpen(true),
                        onTelegramStars: telegramStarsAvailable
                          ? openTelegramStars
                          : undefined,
                        onLogout: requestLogout,
                        housingCriteria:
                          launchHousing?.ownerId === board.user.id
                            ? launchHousing.criteria
                            : undefined,
                      }
                    : undefined
                }
                workspaceRequest={workspaceRequest}
                profileRevision={profileRevision}
                onWorkspaceRequestHandled={(sequence) =>
                  setWorkspaceRequest((request) =>
                    request?.sequence === sequence ? null : request,
                  )
                }
                onNavigateWorkspace={() => {
                  setPhoneOpen(false);
                  setBalanceOpen(false);
                  setTelegramStarsOpen(false);
                  setFavoritesOpen(false);
                  setReceiptsOpen(false);
                }}
                sessionSignal={session.capture().signal}
                onAccessDenied={requireLogin}
                history={history.state}
                onOlderMessages={history.loadOlder}
                onLatestMessages={() => {
                  history.returnToLatest();
                  void refresh(session.capture()).catch(() => {});
                }}
                busy={busy || aiModeConsent !== null}
                sending={sending}
                miniChat={
                  miniProvider
                    ? {
                        available: canSendMiniChat,
                        offline: miniOffline,
                        recovery: currentMiniRecovery
                          ? {
                              status: currentMiniRecovery.status,
                              canRetry:
                                canSendMiniChat &&
                                !miniOffline &&
                                !history.detached &&
                                !board.thread?.closed &&
                                !!text.trim(),
                              canDismiss: canDismissMiniChat,
                              onCheck: () => void checkMiniChat(),
                              onRetry: () => void retryMiniChat(),
                              onDismiss: dismissMiniChat,
                            }
                          : undefined,
                      }
                    : undefined
                }
                draft={draft}
                pending={pending}
                streamAgent={streamAgent}
                aiMode={selectedAiMode}
                onAiMode={chooseAiMode}
                text={text}
                draftRecovered={draftRecovered}
                onDiscardDraft={() => changeText("")}
                onText={changeText}
                onChat={chat}
                onStop={() => abort.current?.abort()}
                onPassword={() => {
                  if (miniApp) requestWorkspaceTab("Профиль");
                  setPasswordOpen(true);
                }}
                onBalance={openBalance}
                onPhone={openPhone}
                onFavorites={() => setFavoritesOpen(true)}
                onFavorite={(messageId, saved) =>
                  void act(async (ticket) => {
                    const confirmed = await api.setMessageFavorite(
                      messageId,
                      saved,
                    );
                    ticket.check();
                    trackProductEvent(
                      saved ? "favorite_added" : "favorite_removed",
                      { surface: "favorites" },
                    );
                    history.patchFavorite(confirmed);
                    await refresh(ticket);
                    ticket.check();
                    setNotice(
                      saved
                        ? "Сообщение сохранено в избранное."
                        : "Закладка удалена. Сообщение осталось в диалоге.",
                    );
                  })
                }
                topups={topups}
                onBegin={beginConversation}
                onHandoff={(input) => beginConversation(input.target, input)}
                onDiscussResult={(input) =>
                  beginConversation(input.target, undefined, input)
                }
                conversations={conversations}
                conversationNextCursor={conversationNextCursor}
                onConversations={loadConversations}
                conversationFilters={conversationFilters}
                onOpenConversation={openConversation}
                onStart={(id) =>
                  act(async (ticket) => {
                    await api.start(id);
                    await refresh(ticket);
                    ticket.check();
                    setNotice("");
                  })
                }
                onComplete={(id) =>
                  act(async (ticket) => {
                    const result = await api.complete(id);
                    await refresh(ticket);
                    ticket.check();
                    setNotice(
                      result.awarded
                        ? `+${result.awarded} XP — квест завершён!`
                        : "Этот квест уже завершён",
                    );
                  })
                }
              />
            </div>
            {aiModeConsent && (
              <AiModeConsentDialog
                key={aiModeConsent.owner + ":" + aiModeConsent.sequence}
                userId={aiModeConsent.owner}
                mode={aiModeConsent.mode}
                sessionSignal={aiModeConsent.ticket.signal}
                onAccessDenied={requireLogin}
                onClose={cancelAiModeChoice}
                verifyOwner={async (signal) => {
                  const choice = aiModeConsent;
                  choice.ticket.check();
                  if (choice.sequence !== aiModeChoiceSequence.current)
                    return false;
                  const fresh = await createClient("/api", {
                    signal: () =>
                      AbortSignal.any([signal, choice.ticket.signal]),
                  }).dashboard();
                  choice.ticket.check();
                  if (
                    signal.aborted ||
                    choice.sequence !== aiModeChoiceSequence.current
                  )
                    return false;
                  if (fresh.user.id !== choice.owner) {
                    notifyBrowserSessionChange();
                    clearUserState(fresh.user.id);
                    void refresh(session.capture()).catch(() => {});
                    return false;
                  }
                  if (
                    fresh.user.mustChangePassword ||
                    fresh.user.serviceConsentRequired
                  ) {
                    await refresh(choice.ticket);
                    if (choice.sequence === aiModeChoiceSequence.current)
                      cancelAiModeChoice();
                    return false;
                  }
                  return true;
                }}
                onBaseConsentRequired={async () => {
                  const choice = aiModeConsent;
                  choice.ticket.check();
                  if (choice.sequence !== aiModeChoiceSequence.current) return;
                  await refresh(choice.ticket);
                  choice.ticket.check();
                  if (choice.sequence === aiModeChoiceSequence.current)
                    cancelAiModeChoice();
                }}
                onConfirmed={async (selected) => {
                  const choice = aiModeConsent;
                  choice.ticket.check();
                  if (choice.sequence !== aiModeChoiceSequence.current) return;
                  const next = await refresh(choice.ticket);
                  choice.ticket.check();
                  if (choice.sequence !== aiModeChoiceSequence.current) return;
                  if (
                    !next ||
                    next.user.id !== choice.owner ||
                    next.user.serviceConsentRequired ||
                    !next.aiAccess.modes?.options.some(
                      (option) =>
                        option.id === selected &&
                        option.available &&
                        !option.consentRequired,
                    )
                  )
                    throw new Error("Mode choice needs fresh confirmation");
                  setSelectedAiMode(selected);
                  trackProductEvent("mode_selected", {
                    surface: "chat",
                    mode: selected,
                  });
                  cancelAiModeChoice();
                }}
              />
            )}
          </>
        )}
      </main>
      <footer>
        CityGo · Место для вашего нового начала{" "}
        <span>Помощники по переезду</span>
      </footer>
    </div>
  );
}
