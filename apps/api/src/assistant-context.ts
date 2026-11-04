import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  DomainError,
  type Repository,
  type ConversationMemory,
} from "@citygo/db";
import { instructions, profileContext, routeAgent } from "@citygo/agents";
import {
  assistantContextInputSchema,
  assistantContextPreviewSchema,
  profileSchema,
  type AssistantContextInput,
} from "@citygo/contracts";
import { buildConversationContext } from "./conversation-context.js";
import { previewModelConversationContext } from "./model-conversation-context.js";

/** Preview only: no provider, lease, hold, message insert, grant or AI quota. */
export function registerAssistantContext(
  app: FastifyInstance,
  repo: Repository,
  authenticate: (
    request: FastifyRequest,
  ) => Promise<{ id: string; currentAiConsentRequired?: boolean }>,
  maxInputBytes: number,
  modelContext?: {
    memory: ConversationMemory;
    resolve: (
      user: { id: string; currentAiConsentRequired?: boolean },
      input: AssistantContextInput,
    ) => {
      mode: "maximum" | "balanced" | "minimum";
      maxInputBytes: number;
      maxOutputTokens: number;
    };
  },
  authenticateBeforeBody = authenticate,
) {
  app.post(
    "/v1/ai/context-preview",
    {
      bodyLimit: 2 * 1024 * 1024,
      preParsing: async (request, _reply, payload) => {
        await authenticateBeforeBody(request);
        return payload;
      },
      config: { rateLimit: { max: 30, timeWindow: 60_000 } },
    },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const user = await authenticate(request);
      const parsed = assistantContextInputSchema.safeParse(request.body);
      if (!parsed.success)
        throw new DomainError(400, "Проверьте данные выбранного диалога");
      const snapshot = await repo.conversationContextSnapshot(
        user.id,
        parsed.data.threadId,
        modelContext && parsed.data.contextVersion ? 8388608 : undefined,
      );
      const profile = profileSchema.nullable().safeParse(snapshot.profile);
      if (!profile.success)
        throw new Error("Invalid stored relocation profile");
      const draft = parsed.data.draft.trim();
      // Empty draft means a provisional view, never an invented saved question.
      // The marker is used only for byte budgeting and is removed from the result.
      const question = draft || "Следующий вопрос";
      const routing = routeAgent(
        question,
        snapshot.thread?.agentKey ?? "support",
      );
      const agentKey = snapshot.thread?.assistantKey ?? routing.to;
      const nextId = (
        BigInt(snapshot.messages.at(-1)?.id ?? "0") + 1n
      ).toString();
      const contextInput = {
        instructions: instructions(agentKey),
        profile: profileContext(profile.data),
        history: [
          ...snapshot.messages,
          { id: nextId, role: "user", content: question, status: "complete" },
        ],
        currentQuestion: question,
        maxInputBytes,
      };
      const selection = modelContext?.resolve(user, parsed.data);
      const extended =
        selection && modelContext && parsed.data.contextVersion
          ? previewModelConversationContext({
              ...contextInput,
              ...selection,
              memory: snapshot.thread
                ? await modelContext.memory.snapshot(
                    user.id,
                    snapshot.thread.id,
                    question,
                    { readOnly: true },
                  )
                : {
                    fragments: [],
                    complete: true,
                    indexComplete: true,
                    indexedMessages: 0,
                  },
            })
          : null;
      const context = extended ?? buildConversationContext(contextInput);
      const result = assistantContextPreviewSchema.parse({
        userId: user.id,
        threadId: snapshot.thread?.id ?? null,
        generatedAt: new Date().toISOString(),
        profile: {
          targetCity: profile.data?.targetCity ?? null,
          monthlyBudget: profile.data?.monthlyBudget ?? null,
          moveTargetDate: profile.data?.moveTargetDate ?? null,
          household: profile.data?.household ?? null,
        },
        agentKey,
        closed: snapshot.thread?.closed ?? false,
        draftIncluded: Boolean(draft),
        messages: extended?.recentMessages ?? context.messages.slice(1, -1),
        ...(extended
          ? { memory: extended.memory, contextBudget: extended.budget }
          : {}),
      });
      // Do not publish text to a session revoked while the snapshot read waited.
      const current = await authenticate(request);
      if (current.id !== user.id)
        throw new DomainError(401, "Войдите в аккаунт заново");
      return result;
    },
  );
}
