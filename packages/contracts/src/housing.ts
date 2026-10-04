// Current public contract. A future storage version belongs in a new module;
// changing this facade must not change readers of already persisted version 1.
export * from "./housing-v1.js";
// These explicit exports must remain attached to v1 even when the unversioned
// public input contract moves on. Commands, helpers and stored data form one
// protocol: pinning the reader alone does not preserve writers or replay.
export {
  createR1HousingAnswers as createR1HousingAnswersV1,
  r1HousingAnswerCommandSchema as r1HousingAnswerCommandV1Schema,
  r1HousingBriefCreateCommandSchema as r1HousingBriefCreateCommandV1Schema,
  r1HousingBriefDraftSchema as r1HousingBriefDraftV1Schema,
  r1HousingIdSchema as r1HousingIdV1Schema,
  r1HousingRevisionSchema as r1HousingRevisionV1Schema,
} from "./housing-v1.js";
