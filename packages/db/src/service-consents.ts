import { randomUUID } from "node:crypto";
import {
  serviceConsentChoiceSchema,
  serviceConsentPolicy,
  serviceConsentPolicySchema,
  aiModesConsentChoiceSchema,
  type ServiceConsentChoice,
  type ServiceConsentPolicy,
  type ServiceConsentState,
} from "@citygo/contracts";
import type { Database, Sql } from "./index.js";
import { DomainError } from "./errors.js";
import {
  consentPolicyHash,
  readServiceConsentContext,
  type ServiceAiPolicyResolver,
  type ServiceConsentContext,
} from "./service-consent-context.js";
import {
  legacyBalancedGrant,
  consentGrantEvidence,
  type LegacyBalancedConsentCompatibility,
} from "./ai-consent-compatibility.js";
export { consentPolicyHash } from "./service-consent-context.js";

export function validateServiceConsent(
  raw: unknown,
  policy: ServiceConsentPolicy = serviceConsentPolicy,
): ServiceConsentChoice {
  const choice = serviceConsentChoiceSchema.safeParse(raw);
  if (!choice.success)
    throw new DomainError(
      400,
      "Для регистрации необходимо явное согласие на обработку персональных данных",
    );
  if (choice.data.policyVersion !== policy.version)
    throw new DomainError(
      409,
      "Текст согласия изменился. Ознакомьтесь с текущей версией и подтвердите выбор заново.",
      "SERVICE_CONSENT_POLICY_CHANGED",
    );
  return choice.data;
}

async function state(
  tx: Sql,
  userId: string,
  context: ServiceConsentContext,
): Promise<ServiceConsentState & { currentAiConsentRequired: boolean }> {
  const { policy } = context;
  const latest = (
    await tx.query<{
      decision: string;
      policy_version: string;
      policy_hash: string;
      policy_snapshot: ServiceConsentPolicy;
    }>(
      `select decision,policy_version,policy_hash,policy_snapshot from service_consent_events
     where user_id=$1 and purpose='personal-data' order by id desc limit 1`,
      [userId],
    )
  ).rows[0];
  const currentEvidence = context.aiPolicy
    ? await consentGrantEvidence(tx, userId, context.aiPolicy)
    : undefined;
  const currentPersonalDataGranted = Boolean(
    latest?.decision === "granted" &&
    latest.policy_version === policy.version &&
    latest.policy_hash === consentPolicyHash(policy) &&
    consentPolicyHash(latest.policy_snapshot) === latest.policy_hash,
  );
  // Read the newest actual decision; never search past a withdrawal. The AI
  // choice cannot implicitly opt in/out of the unchanged marketing document.
  const marketing = (
    await tx.query<{
      decision: string;
      policy_snapshot: unknown;
      policy_hash: string;
    }>(
      "select decision,policy_snapshot,policy_hash from service_consent_events where user_id=$1 and purpose='marketing' order by id desc limit 1",
      [userId],
    )
  ).rows[0];
  const marketingSnapshot = serviceConsentPolicySchema.safeParse(
    marketing?.policy_snapshot,
  );
  const marketingGranted = Boolean(
    marketing?.decision === "granted" &&
    marketingSnapshot.success &&
    consentPolicyHash(marketingSnapshot.data) === marketing.policy_hash &&
    consentPolicyHash({
      ...policy,
      marketing: marketingSnapshot.data.marketing,
    }) === consentPolicyHash(policy),
  );
  const aiGranted = !context.aiPolicy || Boolean(currentEvidence);
  const currentGranted = currentPersonalDataGranted && aiGranted;
  // This is read-only access to the EXACT old Balanced scope, not acceptance
  // of current/new processing. Max/Min still require a real explicit choice.
  const legacy =
    !currentGranted && context.aiPolicy
      ? await legacyBalancedGrant(
          tx,
          userId,
          context.legacyBalanced,
          context.aiPolicy.id,
        )
      : undefined;
  return {
    policy,
    personalDataGranted: currentPersonalDataGranted || Boolean(legacy),
    marketingGranted,
    serviceConsentRequired: !currentGranted && !legacy,
    currentAiConsentRequired: Boolean(context.aiPolicy && !currentGranted),
  };
}

// Called inside the transaction which creates/locks the account. Email choices
// are captured before delivery and copied unchanged when the OTP is consumed.
export async function recordServiceConsent(
  tx: Sql,
  input: {
    userId: string;
    email: string;
    choice: ServiceConsentChoice;
    source: "signup" | "email-registration" | "existing-account";
    registrationId?: string;
    choiceRecordedAt?: string;
  },
  context: ServiceConsentContext,
) {
  const { policy } = context;
  const choice = validateServiceConsent(input.choice, policy);
  const previous = await state(tx, input.userId, context);
  const priorMarketing = (
    await tx.query<{ decision: string }>(
      `select decision from service_consent_events where user_id=$1 and policy_version=$2
     and policy_hash=$3 and purpose='marketing' order by id desc limit 1`,
      [input.userId, choice.policyVersion, consentPolicyHash(policy)],
    )
  ).rows[0];
  const decisions: [string, string][] = [];
  if (previous.serviceConsentRequired || previous.currentAiConsentRequired)
    decisions.push(["personal-data", "granted"]);
  if (!priorMarketing || previous.marketingGranted !== choice.marketing)
    decisions.push([
      "marketing",
      choice.marketing
        ? "granted"
        : previous.marketingGranted
          ? "withdrawn"
          : "declined",
    ]);
  for (const [purpose, decision] of decisions)
    await tx.query(
      `insert into service_consent_events(user_id,subject_email,registration_id,policy_version,policy_snapshot,policy_hash,purpose,decision,source,choice_recorded_at)
       values($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,coalesce($10::timestamptz,clock_timestamp()))`,
      [
        input.userId,
        input.email,
        input.registrationId ?? null,
        choice.policyVersion,
        JSON.stringify(policy),
        consentPolicyHash(policy),
        purpose,
        decision,
        input.source,
        input.choiceRecordedAt ?? null,
      ],
    );
  if (
    context.aiPolicy &&
    decisions.some(([purpose]) => purpose === "personal-data")
  ) {
    await tx.query(
      "insert into ai_consents(user_id,policy_id,granted) values ($1,$2,true) on conflict (user_id) do update set policy_id=$2,granted=true,updated_at=now()",
      [input.userId, context.aiPolicy.id],
    );
    await tx.query(
      "insert into consent_events(user_id,consent_key,action,policy_version,details) values ($1,'ai-recipient','granted',$2,$3::jsonb)",
      [input.userId, context.aiPolicy.id, JSON.stringify(context.aiPolicy)],
    );
  }
  return state(tx, input.userId, context);
}

export class ServiceConsents {
  constructor(
    private db: Database,
    private resolveAiPolicy?: ServiceAiPolicyResolver,
    private legacyBalanced?: LegacyBalancedConsentCompatibility,
  ) {}
  async policy() {
    return this.db.transaction(
      async (tx) =>
        (
          await readServiceConsentContext(
            tx,
            this.resolveAiPolicy,
            this.legacyBalanced,
          )
        ).policy,
    );
  }
  async state(userId: string) {
    return this.db.transaction(async (tx) => {
      const context = await readServiceConsentContext(
        tx,
        this.resolveAiPolicy,
        this.legacyBalanced,
      );
      return state(tx, userId, context);
    });
  }
  async choose(userId: string, raw: unknown) {
    return this.db.transaction(async (tx) => {
      const context = await readServiceConsentContext(
        tx,
        this.resolveAiPolicy,
        this.legacyBalanced,
      );
      const choice = validateServiceConsent(raw, context.policy);
      const user = (
        await tx.query<{ email: string }>(
          `select c.email from users u join user_credentials c on c.user_id=u.id
         where u.id=$1 and u.status='active' for update of u`,
          [userId],
        )
      ).rows[0];
      if (!user) throw new DomainError(401, "Войдите в аккаунт");
      return recordServiceConsent(
        tx,
        {
          userId,
          email: user.email,
          choice,
          source: "existing-account",
        },
        context,
      );
    });
  }
  async acceptAiModes(userId: string, raw: unknown) {
    const input = aiModesConsentChoiceSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      if (input.expectedUserId !== userId)
        throw new DomainError(
          409,
          "Аккаунт изменился. Обновите страницу.",
          "ACCOUNT_CHANGED",
        );
      const context = await readServiceConsentContext(
        tx,
        this.resolveAiPolicy,
        this.legacyBalanced,
      );
      if (
        !context.aiPolicy ||
        context.aiPolicy.version !== "ai-assistant-modes-v1" ||
        context.aiPolicy.id !== input.policyId ||
        context.policy.version !== input.policyVersion
      )
        throw new DomainError(
          409,
          "Условия режимов изменились. Обновите страницу.",
          "SERVICE_CONSENT_POLICY_CHANGED",
        );
      const user = (
        await tx.query<{ email: string }>(
          "select c.email from users u join user_credentials c on c.user_id=u.id where u.id=$1 and u.status='active' for update of u",
          [userId],
        )
      ).rows[0];
      if (!user) throw new DomainError(401, "Войдите в аккаунт");
      const before = await state(tx, userId, context);
      if (!before.currentAiConsentRequired) return before;
      // Only an actual user confirmation reaches here. No marketing event.
      await tx.query(
        `insert into service_consent_events(user_id,subject_email,policy_version,policy_snapshot,policy_hash,purpose,decision,source)
        values($1,$2,$3,$4::jsonb,$5,'personal-data','granted','existing-account')`,
        [
          userId,
          user.email,
          context.policy.version,
          JSON.stringify(context.policy),
          consentPolicyHash(context.policy),
        ],
      );
      await tx.query(
        "insert into ai_consents(user_id,policy_id,granted) values($1,$2,true) on conflict(user_id) do update set policy_id=$2,granted=true,updated_at=now()",
        [userId, context.aiPolicy.id],
      );
      await tx.query(
        "insert into consent_events(user_id,consent_key,action,policy_version,details) values($1,'ai-recipient','granted',$2,$3::jsonb)",
        [userId, context.aiPolicy.id, JSON.stringify(context.aiPolicy)],
      );
      return state(tx, userId, context);
    });
  }
  // Legacy email/password signup still requires the same explicit choices.
  // Account, consent evidence and initial session commit or roll back together.
  async register(
    email: string,
    passwordHash: string,
    sessionHash: string,
    raw: unknown,
  ) {
    return this.db.transaction(async (tx) => {
      const context = await readServiceConsentContext(tx, this.resolveAiPolicy);
      const choice = validateServiceConsent(raw, context.policy);
      await tx.query(
        "select id from account_security_state where id=1 for update",
      );
      if (
        (
          await tx.query(
            "select user_id from user_credentials where email=$1",
            [email],
          )
        ).rows.length
      )
        throw new DomainError(409, "Аккаунт с этой почтой уже существует");
      const user = (
        await tx.query<{ id: string }>(
          "insert into users(auth_subject) values ($1) returning id::text",
          [randomUUID()],
        )
      ).rows[0]!;
      await tx.query(
        "insert into user_credentials(user_id,email,password_hash) values ($1,$2,$3)",
        [user.id, email, passwordHash],
      );
      await recordServiceConsent(
        tx,
        {
          userId: user.id,
          email,
          choice,
          source: "signup",
        },
        context,
      );
      await tx.query(
        "insert into sessions(token_hash,user_id,expires_at) values ($1,$2,clock_timestamp()+interval '7 days')",
        [sessionHash, user.id],
      );
      return {
        id: user.id,
        email,
        username: null,
        role: "user" as const,
        mustChangePassword: false,
        serviceConsentRequired: false,
      };
    });
  }
}
