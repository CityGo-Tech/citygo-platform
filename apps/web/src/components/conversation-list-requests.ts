import type { ConversationFilters } from "@citygo/contracts";

/** A new query/page or owner reset invalidates every earlier list response. */
export function createConversationListRequests() {
  let revision = 0;
  let filterKey = "";
  return {
    reset() {
      revision++;
      filterKey = "";
    },
    begin(filters: ConversationFilters) {
      filterKey = JSON.stringify([
        filters.search ?? "",
        filters.assistantKey ?? "",
        filters.status ?? "",
      ]);
      const ticket = { revision: ++revision, filterKey };
      return () =>
        ticket.revision === revision && ticket.filterKey === filterKey;
    },
  };
}
