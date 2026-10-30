export const TEXT_MATERIAL_MAX_BYTES = 64 * 1024;
export const TEXT_MESSAGE_MAX_LENGTH = 4000;

export type TextMaterialScope = {
  userId: string;
  threadId: string;
  sessionSignal: AbortSignal;
};
export type TextMaterialContext = TextMaterialScope & {
  enabled: boolean;
  draft: string;
};
export type TextMaterialFile = Pick<File, "name" | "size" | "arrayBuffer">;
export type TextMaterialView =
  | { phase: "select"; error?: string }
  | { phase: "reading"; filename: string }
  | { phase: "preview"; filename: string; text: string; error?: string }
  | { phase: "closed" };

export function sameTextMaterialScope(
  left: TextMaterialScope,
  right: TextMaterialScope,
) {
  return (
    left.userId === right.userId &&
    left.threadId === right.threadId &&
    left.sessionSignal === right.sessionSignal
  );
}

function validText(text: string) {
  if (!text.trim())
    throw new Error("В материале нет текста. Выберите другой TXT-файл.");
  for (const point of text) {
    const code = point.charCodeAt(0);
    if ((code < 32 && ![9, 10, 13].includes(code)) || code === 127)
      throw new Error(
        "В файле есть нетекстовые данные. Выберите обычный TXT-файл в UTF-8.",
      );
  }
  if (text.length > TEXT_MESSAGE_MAX_LENGTH)
    throw new Error(
      "В материале больше 4000 символов. Сократите текст материала.",
    );
}

export function composeTextMaterial(draft: string, material: string) {
  validText(material);
  const result = (draft ? draft + "\n\n" : "") + "Материал:\n" + material;
  if (result.length > TEXT_MESSAGE_MAX_LENGTH)
    throw new Error(
      "Вопрос и материал вместе превышают 4000 символов. Сократите текст перед добавлением.",
    );
  return result;
}

/** Local reader only. No upload, persistence or AI request belongs to this resource. */
export function createTextMaterialResource(options: {
  scope: TextMaterialScope;
  current: () => TextMaterialContext;
  publish: (view: TextMaterialView) => void;
  apply: (draft: string) => void;
}) {
  let disposed = false;
  let generation = 0;
  let view: TextMaterialView = { phase: "select" };
  const active = () =>
    !disposed &&
    !options.scope.sessionSignal.aborted &&
    sameTextMaterialScope(options.scope, options.current()) &&
    options.current().enabled;
  const publish = (next: TextMaterialView) => {
    view = next;
    if (active()) options.publish(next);
  };
  const stop = () => {
    generation++;
    disposed = true;
    view = { phase: "closed" };
  };
  options.scope.sessionSignal.addEventListener("abort", stop, { once: true });
  return {
    async select(file: TextMaterialFile) {
      if (!active()) return;
      const selected = ++generation;
      try {
        // Metadata must pass before allocating a file buffer.
        if (!/\.txt$/iu.test(file.name))
          throw new Error("Поддерживаются только TXT-файлы в UTF-8.");
        if (!Number.isSafeInteger(file.size) || file.size < 1)
          throw new Error("Файл пуст. Выберите TXT-файл с текстом.");
        if (file.size > TEXT_MATERIAL_MAX_BYTES)
          throw new Error("Файл больше 64 КБ. Выберите меньший TXT-файл.");
        publish({ phase: "reading", filename: file.name });
        const buffer = await file.arrayBuffer();
        if (!active() || selected !== generation) return;
        if (buffer.byteLength > TEXT_MATERIAL_MAX_BYTES)
          throw new Error("Файл больше 64 КБ. Выберите меньший TXT-файл.");
        let text: string;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
        } catch {
          throw new Error(
            "Не удалось прочитать UTF-8. Сохраните файл как обычный TXT в UTF-8.",
          );
        }
        validText(text);
        publish({ phase: "preview", filename: file.name, text });
      } catch (cause) {
        if (!active() || selected !== generation) return;
        publish({
          phase: "select",
          error:
            cause instanceof Error
              ? cause.message
              : "Не удалось прочитать файл. Выберите его ещё раз.",
        });
      }
    },
    edit(text: string) {
      if (!active() || view.phase !== "preview") return;
      publish({ phase: "preview", filename: view.filename, text });
    },
    back() {
      if (!active()) return;
      generation++;
      publish({ phase: "select" });
    },
    confirm() {
      // Check live scope, availability and draft again at the action boundary,
      // before React commits a close, logout or conversation replacement.
      if (!active() || view.phase !== "preview") return false;
      const preview = view;
      let combined: string;
      try {
        combined = composeTextMaterial(options.current().draft, preview.text);
      } catch (cause) {
        publish({
          ...preview,
          error:
            cause instanceof Error
              ? cause.message
              : "Не удалось добавить материал.",
        });
        return false;
      }
      stop(); // A second synchronous click cannot append the material twice.
      options.apply(combined);
      return true;
    },
    dispose() {
      stop();
      options.scope.sessionSignal.removeEventListener("abort", stop);
    },
  };
}
