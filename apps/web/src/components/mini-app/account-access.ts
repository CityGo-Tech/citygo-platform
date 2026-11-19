import type {
  HousingWorkspaceCriteria,
  MessengerProvider,
} from "@citygo/contracts";
import type { LandingTask } from "../landing/landing-task";

export const messengerNames = {
  telegram: "Telegram",
  max: "MAX",
} satisfies Record<MessengerProvider, string>;

export type MiniAppAccountAccess = {
  provider: MessengerProvider;
  initData: string;
  task?: LandingTask;
  housingCriteria?: Pick<HousingWorkspaceCriteria, "commute" | "budgetRub">;
  resumeHousingOwner?: string;
};
