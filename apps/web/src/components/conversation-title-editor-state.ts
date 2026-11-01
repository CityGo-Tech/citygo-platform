import type { ConversationTitle } from "@citygo/contracts";
import { ApiError, type createClient } from "@citygo/api-client";
export type TitleEditorState = {
  pending: boolean;
  value: ConversationTitle | null;
  error: string;
  conflict: boolean;
};
type Client = Pick<
  ReturnType<typeof createClient>,
  "conversationTitle" | "updateConversationTitle"
>;
export function createConversationTitleEditor(
  client: Client,
  ownerId: string,
  threadId: string,
  signal: AbortSignal,
  changed: (state: TitleEditorState) => void,
  denied: () => void,
) {
  let closed = false,
    locked = false;
  let state: TitleEditorState = {
    pending: false,
    value: null,
    error: "",
    conflict: false,
  };
  const active = () => !closed && !signal.aborted;
  const publish = (patch: Partial<TitleEditorState>) => {
    if (active()) {
      state = { ...state, ...patch };
      changed(state);
    }
  };
  const execute = async (
    work: () => Promise<ConversationTitle>,
  ): Promise<ConversationTitle | false> => {
    if (!active() || locked) return false;
    locked = true;
    publish({ pending: true, error: "", conflict: false });
    try {
      const value = await work();
      if (!active()) return false;
      if (value.userId !== ownerId || value.threadId !== threadId)
        throw Error("owner mismatch");
      publish({ value });
      return value;
    } catch (error) {
      if (!active()) return false;
      if (error instanceof ApiError && [401, 403].includes(error.status)) {
        denied();
        return false;
      }
      publish({
        error:
          error instanceof ApiError && error.status === 409
            ? "Название уже изменилось. Обновите его перед сохранением."
            : "Не удалось сохранить название. Проверьте связь и попробуйте ещё раз.",
        conflict: error instanceof ApiError && error.status === 409,
      });
      return false;
    } finally {
      locked = false;
      publish({ pending: false });
    }
  };
  return {
    load: () => execute(() => client.conversationTitle(threadId)),
    save: (title: string | null): Promise<ConversationTitle | false> => {
      if (!state.value || state.conflict) return Promise.resolve(false);
      return execute(() =>
        client.updateConversationTitle(threadId, {
          title,
          expectedRevision: state.value!.revision,
        }),
      );
    },
    close: () => {
      closed = true;
    },
  };
}
