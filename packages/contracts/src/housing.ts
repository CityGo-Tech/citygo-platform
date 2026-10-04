// Current public contract. A future storage version belongs in a new module;
// changing this facade must not change readers of already persisted version 1.
export * from "./housing-v1.js";
export { r1HousingBriefDraftSchema as r1HousingBriefDraftV1Schema } from "./housing-v1.js";
