import type { FastifyInstance, FastifyRequest } from "fastify";
import { DomainError, PhoneContacts, type Database } from "@citygo/db";
import {
  adminPhoneContactsQuerySchema,
  adminPhoneContactsResponseSchema,
} from "@citygo/contracts";
import type { readConfig } from "@citygo/config";
import { protectedPhoneCodec } from "./protected-phone.js";

export function registerAdminPhoneContacts(
  app: FastifyInstance,
  options: {
    db: Database;
    config: ReturnType<typeof readConfig>;
    context: (
      request: FastifyRequest,
    ) => Promise<{ userId: string; sessionTokenHash: string }>;
  },
) {
  const contacts = new PhoneContacts(options.db);
  app.get("/v1/admin/phone-contacts", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const actor = await options.context(request);
    const input = adminPhoneContactsQuerySchema.parse(request.query);
    // The database rechecks the current super-admin role under the account
    // security lock. HTTP middleware alone is not the disclosure authority.
    const page = await contacts.listForAdmin(
      actor.userId,
      input.afterUserId,
      actor.sessionTokenHash,
    );
    const secret = options.config.PHONE_VERIFICATION_SECRET;
    if (!secret)
      throw new DomainError(503, "Хранилище контактов пока недоступно");
    const codec = protectedPhoneCodec(secret);
    return adminPhoneContactsResponseSchema.parse({
      contacts: page.contacts.map((row) => ({
        userId: row.userId,
        email: row.email,
        username: row.username,
        phone: codec.reveal(row.protectedPhone, {
          proofUserId: row.proofUserId,
          phoneKey: row.phoneKey,
          sourceChallengeId: row.sourceChallengeId,
        }),
        verifiedAt: row.verifiedAt,
      })),
      nextAfterUserId: page.nextAfterUserId,
    });
  });
}
