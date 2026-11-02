import type { FastifyInstance, FastifyRequest } from "fastify";
import { DomainError, type Repository } from "@citygo/db";
import { instructions, profileContext, routeAgent } from "@citygo/agents";
import {
  assistantContextInputSchema,
  assistantContextPreviewSchema,
  profileSchema,
} from "@citygo/contracts";
import { buildConversationContext } from "./conversation-context.js";

/** Preview only: no provider, lease, hold, message insert, grant or AI quota. */
export function registerAssistantContext(
  app: FastifyInstance,
  repo: Repository,
  authenticate: (request: FastifyRequest) => Promise<{ id: string }>,
  maxInputBytes: number,
) {
  app.post(
    "/v1/ai/context-preview",
    { config: { rateLimit: { max: 30, timeWindow: 60_000 } } },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const user = await authenticate(request);
      const parsed = assistantContextInputSchema.safeParse(request.body);
      if (!parsed.success)
        throw new DomainError(400, "Проверьте данные выбранного диалога");
      const snapshot = await repo.conversationContextSnapshot(
        user.id,
        parsed.data.threadId,
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
      const context = buildConversationContext({
        instructions: instructions(agentKey),
        profile: profileContext(profile.data),
        history: [
          ...snapshot.messages,
          { id: nextId, role: "user", content: question, status: "complete" },
        ],
        currentQuestion: question,
        maxInputBytes,
      });
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
        messages: context.messages.slice(1, -1),
      });
      // Do not publish text to a session revoked while the snapshot read waited.
      const current = await authenticate(request);
      if (current.id !== user.id)
        throw new DomainError(401, "Войдите в аккаунт заново");
      return result;
    },
  );
}
