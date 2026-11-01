"use client";
import { BalanceHistoryPanel } from "../components/balance-history";
import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
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
  ConversationSummary,
  ConversationFilters,
  ServiceConsentChoice,
  AiModeId,
} from "@citygo/contracts";
import { Button, Card, Field, Badge } from "@citygo/ui-web";
import {
  currentResultDiscussionInput,
  resultDiscussionDraft,
  type ResultDiscussionInput,
} from "../components/result-discussion-state";
import { Journey } from "../components/journey";
import { createConversationListRequests } from "../components/conversation-list-requests";
import { ConversationHome } from "../components/conversation-home";
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

export default function Home() {
  const [session] = useState(createSessionGuard);
  const [formVersion, setFormVersion] = useState(0);
  const [logoutUnconfirmed, setLogoutUnconfirmed] = useState(false);
  const refreshVersion = useRef(0);
  const [board, setBoard] = useState<Dashboard | null>(null);
  const chatSubmitting = useRef(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"register" | "login" | "recover">(
    "register",
  );
  const [registration, setRegistration] =
    useState<PendingEmailRegistration | null>(null);
  const registrationAnalytics = useRef<RegistrationAnalyticsFlow | null>(null);
  const authPending = useRef(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [receiptsOpen, setReceiptsOpen] = useState(false);
  const [favoritesOpen, setFavoritesOpen] = useState(false);
  const [conversationNavigation, setConversationNavigation] = useState(0);
  const [phoneOpen, setPhoneOpen] = useState(false);
  const [balanceOpen, setBalanceOpen] = useState(false);
  const [conversationView, setConversationView] = useState(false);
  const [text, setText] = useState("");
  const [draftRecovered, setDraftRecovered] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState("");
  const [streamAgent, setStreamAgent] = useState<AgentKey | null>(null);
  const [selectedAiMode, setSelectedAiMode] = useState<AiModeId>("balanced");
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
  const analytics = useProductAnalytics({
    config: parseProductAnalyticsConfig({
      enabled: process.env.NEXT_PUBLIC_CITYGO_METRIKA_ENABLED,
      counterId: process.env.NEXT_PUBLIC_CITYGO_METRIKA_COUNTER_ID,
      webvisor: process.env.NEXT_PUBLIC_CITYGO_METRIKA_WEBVISOR,
    }),
    ownerId: board?.user.id ?? null,
    role: board?.user.role,
    blocked:
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
  });
  const history = useConversationHistory({
    board: board?.user.serviceConsentRequired ? null : board,
    sessionSignal: session.capture().signal,
    onAccessDenied: requireLogin,
  });
  function requireLogin() {
    if (session.hasOwner()) notifyBrowserSessionChange();
    clearUserState();
    setNotice("Сессия завершилась. Войдите снова.");
  }
  function clearUserState(owner?: string) {
    clearChatDrafts(draftStorage());
    setDraftRecovered(false);
    session.reset(owner);
    abort.current?.abort();
    abort.current = null;
    setBoard(null);
    setSelectedAiMode("balanced");
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
    setPasswordOpen(false);
    setRegistration(null);
    registrationAnalytics.current = null;
    authPending.current = false;
    setReceiptsOpen(false);
    setFavoritesOpen(false);
    setPhoneOpen(false);
    setBalanceOpen(false);
    setConversationView(false);
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
  async function refresh(ticket = session.capture()) {
    ticket.check();
    let version = ++refreshVersion.current;
    let next = await api.dashboard();
    ticket.check();
    if (version !== refreshVersion.current) return false;
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
      setConversationView(false);
      next = { ...next, thread: null };
    }
    const preferred =
      selectedConversation.current?.owner === next.user.id
        ? selectedConversation.current.id
        : readConversationSelection(next.user.id, conversationStorage());
    if (
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
        if (!(
          error &&
          typeof error === "object" &&
          "status" in error &&
          error.status === 404
        ))
          throw error;
        selectedConversation.current = null;
        writeConversationSelection(next.user.id, null, conversationStorage());
        writeChatDraft(next.user.id, preferred, "", draftStorage());
        conversationDrafts.current.delete(preferred);
        // A removed/inaccessible selection cannot carry its draft into the
        // legacy fallback. Never reinterpret unsent text as a different chat.
        setText("");
      }
    }
    ticket.check();
    if (version !== refreshVersion.current) return false;
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
      session.capture().signal.aborted
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
    const email = String(data.get("email"));
    let password = String(data.get("password"));
    data.delete("password");
    notifyBrowserSessionChange();
    clearUserState();
    if (authMode === "register")
      registrationAnalytics.current = analytics.beginRegistration(
        session.capture().signal,
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
            );
            ticket.check();
            setRegistration(
              pendingEmailRegistration(email, challenge, Date.now(), consents!),
            );
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
        await refresh(ticket);
      } catch (cause) {
        if (ticket.active() && !accepted)
          trackProductEvent(
            authMode === "register" ? "registration_failed" : "login_failed",
            { surface: authMode },
          );
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
    clearUserState();
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
        setRegistration(
          pendingEmailRegistration(
            current.email,
            challenge,
            Date.now(),
            current.consents,
          ),
        );
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
        setBusy(true);
        try {
          await refresh(confirmed);
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
        await refresh(rotated);
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
  async function chat(event: FormEvent) {
    event.preventDefault();
    if (
      !board?.thread ||
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
  ) {
    if (
      chatSubmitting.current ||
      !ticket.active() ||
      epoch !== conversationEpoch.current ||
      !snapshot.thread ||
      visibleThread.current !== snapshot.thread.id ||
      !snapshot.aiAccess.granted
    )
      return;
    let mode: ReturnType<typeof captureAiModeSelection>;
    try {
      mode = captureAiModeSelection(snapshot.aiAccess.modes, selectedAiMode);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Режим сейчас недоступен.",
      );
      return;
    }
    const requestId = crypto.randomUUID();
    const submittedMode = mode?.aiMode ?? selectedAiMode;
    let answerCompleted = false;
    let responseStarted = false;
    trackProductEvent("ai_request_submitted", {
      surface: "chat",
      mode: submittedMode,
      assistant: snapshot.thread.agentKey,
    });
    chatSubmitting.current = true;
    const threadId = snapshot.thread.id;
    conversationDrafts.current.delete(threadId);
    writeChatDraft(snapshot.user.id, threadId, "", draftStorage());
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
        await api.stream(
          threadId,
          message,
          requestId,
          (event) => {
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
          },
          controller.signal,
          snapshot.aiAccess.policy?.id,
          snapshot.aiAccess.credit?.reservationMode,
          mode,
        );
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
    if (!succeeded && !answerCompleted && !responseStarted) {
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
    board?.profile && !board.thread?.assistantKey && !conversationView
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
    trackProductEvent("wallet_opened", { surface: "wallet" });
    setPhoneOpen(false);
    setReceiptsOpen(false);
    setFavoritesOpen(false);
    setBalanceOpen(true);
  }
  function openPhone() {
    trackProductEvent("phone_opened", { surface: "phone" });
    setBalanceOpen(false);
    setFavoritesOpen(false);
    setReceiptsOpen(false);
    setPhoneOpen(true);
  }
  function returnToApp() {
    setBalanceOpen(false);
    setPhoneOpen(false);
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLButtonElement>("#citygo-account-overview button")
        ?.focus(),
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
      document.getElementById(chatBalanceTarget) ??
      document.getElementById("citygo-wallet-view");
    target?.scrollIntoView({ block: "start" });
    target?.focus({ preventScroll: true });
  }, [balanceOpen]);
  return (
    <div
      className={
        "shell" +
        (board?.profile ? " shell-journey" : board ? " shell-onboarding" : "") +
        (!board && (mode === "register" || mode === "recover")
          ? " " + registrationStyles.registrationShell
          : "") +
        (!board && mode === "recover" ? " " + recoveryStyles.recoveryShell : "")
      }
    >
      <header className="topbar">
        <Link className="wordmark" href="/" aria-label="CityGo — главная">
          <span className="citygo-brand-symbol" aria-hidden="true" />
          <span className="citygo-brand-wordmark" aria-hidden="true" />
        </Link>
        <span className="header-caption">Новый город. Ваша история.</span>
        {board ? (
          <div className="account ym-hide-content">
            <Badge>{board.xp} XP</Badge>
            {board.profile &&
              !board.user.mustChangePassword &&
              !board.user.serviceConsentRequired &&
              !passwordOpen && (
                <Button
                  variant="ghost"
                  disabled={busy || sending}
                  onClick={() => {
                    setConversationView(true);
                    setPhoneOpen(false);
                    setBalanceOpen(false);
                    setFavoritesOpen(false);
                    setReceiptsOpen(false);
                  }}
                >
                  Диалоги и помощники
                </Button>
              )}
            {!board.user.mustChangePassword &&
              !board.user.serviceConsentRequired &&
              !passwordOpen && (
                <Button
                  variant="ghost"
                  disabled={busy || sending}
                  onClick={() => {
                    setReceiptsOpen(false);
                    setPhoneOpen(false);
                    setBalanceOpen(false);
                    setFavoritesOpen(true);
                  }}
                >
                  Избранное
                </Button>
              )}
            {!board.user.mustChangePassword &&
              !board.user.serviceConsentRequired &&
              !passwordOpen && (
                <Button
                  variant="ghost"
                  disabled={busy || sending}
                  onClick={() => {
                    setFavoritesOpen(false);
                    setPhoneOpen(false);
                    setBalanceOpen(false);
                    setReceiptsOpen(true);
                  }}
                >
                  Мои чеки
                </Button>
              )}
            <Button variant="ghost" onClick={() => setPasswordOpen(true)}>
              Пароль
            </Button>
            <Button variant="ghost" onClick={() => void logout()}>
              Выйти
            </Button>
          </div>
        ) : mode === "register" || mode === "recover" ? (
          <div className={registrationStyles.headerActions}>
            <Button variant="secondary" onClick={() => changeAuthMode("login")}>
              Войти
            </Button>
            <Button onClick={() => changeAuthMode("register")}>
              Начать разговор
            </Button>
          </div>
        ) : (
          <Badge>Личный помощник по переезду</Badge>
        )}
      </header>
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
              notifyBrowserSessionChange();
              clearUserState();
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
            <section className="welcome">
              <Badge>ПЕРЕЕЗД НАЧИНАЕТСЯ С ВАС</Badge>
              <h1>
                Новый город.
                <br />
                <em>Знакомое чувство дома.</em>
              </h1>
              <p>
                Соберите личный маршрут переезда — от первых планов до ключей от
                квартиры. Рядом будет команда AI-помощников.
              </p>
              <Image
                className="welcome-art"
                src="/characters/housing-640.webp"
                alt="Housing Navigator — помощница CityGo с планом квартиры"
                width={640}
                height={349}
                priority
              />
              <div className="welcome-foot">
                <span>01 · Расскажите о себе</span>
                <span>02 · Получите план</span>
                <span>03 · Двигайтесь по шагам</span>
              </div>
            </section>
            <Card className="auth-card">
              <span className="eyebrow">ВАШ CITYGO</span>
              <h2>
                {mode === "register" ? "Начнём вашу историю" : "С возвращением"}
              </h2>
              <p>Сохраним план, диалоги и каждый завершённый шаг.</p>
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
        ) : (
          <>
            <AccountOverview
              access={board.aiAccess}
              disabled={busy || sending}
              onBalance={openBalance}
              onPhone={openPhone}
            />
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
            {phoneOpen ? (
              <PhoneVerificationPanel
                key={board.user.id + ":phone:" + formVersion}
                userId={board.user.id}
                sessionSignal={session.capture().signal}
                onAccessDenied={requireLogin}
                onGranted={() =>
                  void refresh(session.capture()).catch(() => {})
                }
                onClose={returnToApp}
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
            <div
              className={accountStyles.experience}
              hidden={balanceOpen || phoneOpen || favoritesOpen || receiptsOpen}
            >
              <Experience
                key={board.user.id + ":" + conversationNavigation}
                board={history.board ?? board}
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
                onPassword={() => setPasswordOpen(true)}
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
