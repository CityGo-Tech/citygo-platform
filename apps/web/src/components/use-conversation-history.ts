"use client";
import { useEffect, useRef, useState } from "react";
import { createClient } from "@citygo/api-client";
import type { Dashboard, Message } from "@citygo/contracts";
import {
  createConversationHistoryResource,
  projectConversationHistory,
  type ConversationHistoryState,
} from "./conversation-history-state";

export function useConversationHistory({
  board,
  sessionSignal,
  onAccessDenied,
}: {
  board: Dashboard | null;
  sessionSignal: AbortSignal;
  onAccessDenied: () => void;
}) {
  const userId = board?.user.id,
    threadId = board?.thread?.id;
  const [snapshot, setSnapshot] = useState<{
    userId: string;
    threadId: string;
    signal: AbortSignal;
    state: ConversationHistoryState;
  } | null>(null);
  const current = useRef<{
    userId: string;
    threadId: string;
    signal: AbortSignal;
    latestInput: readonly Message[];
    latestCursor?: string | null;
    resource: ReturnType<typeof createConversationHistoryResource>;
  } | null>(null);
  const denied = useRef(onAccessDenied);
  useEffect(() => {
    denied.current = onAccessDenied;
  }, [onAccessDenied]);
  useEffect(() => {
    if (!userId || !threadId || !board?.thread || sessionSignal.aborted) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, sessionSignal]);
    const publish = (state: ConversationHistoryState) =>
      setSnapshot({ userId, threadId, signal: sessionSignal, state });
    const resource = createConversationHistoryResource({
      userId,
      threadId,
      initialMessages: board.thread.messages,
      initialNextCursor: board.thread.messagesNextCursor,
      sessionSignal: signal,
      load: (before, requestSignal) =>
        createClient("/api", {
          signal: () => requestSignal,
        }).conversationMessages(threadId, before),
      publish,
      onAccessDenied: () => denied.current(),
    });
    current.current = {
      userId,
      threadId,
      signal: sessionSignal,
      latestInput: board.thread.messages,
      latestCursor: board.thread.messagesNextCursor,
      resource,
    };
    publish(resource.snapshot());
    return () => {
      resource.dispose();
      controller.abort();
      if (current.current?.resource === resource) current.current = null;
    };
    // Initial data belongs to the selected lifetime. Same-thread refreshes are
    // merged below, not used to recreate and discard its loaded older pages.
  }, [userId, threadId, sessionSignal]);
  function activeResource() {
    const value = current.current;
    return !sessionSignal.aborted &&
      value !== null &&
      value.userId === userId &&
      value.threadId === threadId &&
      value.signal === sessionSignal
      ? value.resource
      : null;
  }
  useEffect(() => {
    if (
      board?.thread &&
      activeResource() &&
      (current.current!.latestInput !== board.thread.messages ||
        current.current!.latestCursor !== board.thread.messagesNextCursor)
    ) {
      current.current!.latestInput = board.thread.messages;
      current.current!.latestCursor = board.thread.messagesNextCursor;
      current.current!.resource.acceptLatest(
        board.thread.messages,
        board.thread.messagesNextCursor,
      );
    }
  }, [
    board?.thread?.messages,
    board?.thread?.messagesNextCursor,
    userId,
    threadId,
    sessionSignal,
  ]);
  const matched =
    !sessionSignal.aborted &&
    snapshot !== null &&
    snapshot.userId === userId &&
    snapshot.threadId === threadId &&
    snapshot.signal === sessionSignal
      ? snapshot.state
      : null;
  const state =
    matched &&
    board?.thread &&
    activeResource() &&
    (current.current!.latestInput !== board.thread.messages ||
      current.current!.latestCursor !== board.thread.messagesNextCursor)
      ? projectConversationHistory(
          matched,
          board.thread.messages,
          1000,
          board.thread.messagesNextCursor,
        )
      : matched;
  return {
    state,
    board:
      board && board.thread && state
        ? {
            ...board,
            thread: {
              ...board.thread,
              messages: [...state.messages],
              messagesNextCursor: state.nextCursor,
            },
          }
        : board,
    detached: state?.detached ?? false,
    loadOlder: async () => {
      await activeResource()?.loadOlder();
    },
    returnToLatest: () => activeResource()?.returnToLatest(),
    patchFavorite: (result: { messageId: string; saved: boolean }) =>
      activeResource()?.patchFavorite(result),
  };
}
