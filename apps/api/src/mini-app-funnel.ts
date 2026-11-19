import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { DomainError, type Database } from "@citygo/db";
import type { MiniAppLaunchProvider } from "./mini-app-launch/verify.js";

const providerParams = z.strictObject({
  provider: z.enum(["telegram", "max"]),
});
const gesture = z.strictObject({ event: z.enum(["launch", "task_selected"]) });
const empty = z.strictObject({});
type Event =
  | z.infer<typeof gesture>["event"]
  | "sign_in_confirmed"
  | "step_saved"
  | "answer_succeeded"
  | "payment_confirmed";

export function registerMiniAppFunnel(app: FastifyInstance, db: Database) {
  // Aggregate counters only. No person, task, launch, payment or message IDs.
  async function record(
    provider: MiniAppLaunchProvider | null,
    event: Event,
    request?: FastifyRequest,
  ) {
    if (
      !provider ||
      request?.headers.dnt === "1" ||
      request?.headers["sec-gpc"] === "1"
    )
      return;
    try {
      await db.query("insert into analytics_events(name) values ($1)", [
        `mini_${provider}_${event}`,
      ]);
    } catch {
      app.log.warn("Mini-app funnel event unavailable");
    }
  }

  app.post(
    "/v1/mini-apps/:provider/funnel",
    {
      bodyLimit: 128,
      config: { rateLimit: { max: 30, timeWindow: 60_000 } },
    },
    async (request, reply) => {
      const params = providerParams.safeParse(request.params);
      const body = gesture.safeParse(request.body);
      if (
        !params.success ||
        !body.success ||
        !empty.safeParse(request.query).success
      )
        throw new DomainError(400, "Недопустимое событие.");
      await record(params.data.provider, body.data.event, request);
      return reply.code(204).send();
    },
  );
  return record;
}
