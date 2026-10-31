import {
  personalPlanExportSchema,
  type PersonalPlanExport,
} from "@citygo/contracts";
import { ApiError } from "@citygo/api-client";

export function planExportText(value: PersonalPlanExport): string {
  const snapshot = personalPlanExportSchema.parse(value);
  return [
    "CityGo · Мой план",
    "Снимок: " + snapshot.generatedAt,
    "",
    ...(snapshot.items.length
      ? snapshot.items.flatMap((item, index) => [
          index +
            1 +
            ". [" +
            (item.status === "completed" ? "x" : " ") +
            "] " +
            item.title,
          ...(item.details ? [item.details] : []),
          ...item.checklist.flatMap((entry) => [
            "  [" + (entry.completed ? "x" : " ") + "] " + entry.title,
            ...(entry.details ? [entry.details] : []),
          ]),
          "",
        ])
      : ["В плане пока нет сохранённых шагов.", ""]),
  ].join("\n");
}
export type PlanExportState = { busy: boolean; error: string };
export function createPlanExportAction(options: {
  userId: string;
  signal: AbortSignal;
  read: (signal: AbortSignal) => Promise<PersonalPlanExport>;
  download: (text: string) => void;
  publish: (state: PlanExportState) => void;
  onAccessDenied: () => void;
}) {
  let disposed = false,
    controller: AbortController | null = null;
  const live = () => !disposed && !options.signal.aborted;
  const publish = (state: PlanExportState) => {
    if (live()) options.publish(state);
  };
  const cancel = () => {
    controller?.abort();
    controller = null;
    publish({ busy: false, error: "" });
  };
  options.signal.addEventListener("abort", cancel);
  return {
    async run() {
      if (!live() || controller) return;
      const request = new AbortController();
      controller = request;
      publish({ busy: true, error: "" });
      let message = "";
      try {
        const snapshot = personalPlanExportSchema.parse(
          await options.read(request.signal),
        );
        if (!live() || controller !== request || request.signal.aborted) return;
        if (snapshot.userId !== options.userId) {
          disposed = true;
          options.onAccessDenied();
          return;
        }
        const text = planExportText(snapshot);
        if (live() && controller === request && !request.signal.aborted)
          options.download(text);
      } catch (error) {
        if (!live() || controller !== request || request.signal.aborted) return;
        if (error instanceof ApiError && [401, 403].includes(error.status)) {
          disposed = true;
          options.onAccessDenied();
        } else message = "Не удалось скачать весь план. Попробуйте ещё раз.";
      } finally {
        if (controller === request) {
          controller = null;
          publish({ busy: false, error: message });
        }
      }
    },
    cancel,
    dispose() {
      disposed = true;
      controller?.abort();
      controller = null;
      options.signal.removeEventListener("abort", cancel);
    },
  };
}
