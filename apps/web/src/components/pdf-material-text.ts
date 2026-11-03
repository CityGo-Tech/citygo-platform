import {
  abortableMaterialRead,
  PDF_MATERIAL_MAX_PAGES,
  PDF_MATERIAL_MAX_TEXT,
  PdfMaterialError,
  type PdfMaterialText,
} from "./pdf-material-limits";

type TextChunk = { items: ({ str: string; hasEOL?: boolean } | object)[] };
export type MaterialPdfDocument = {
  numPages: number;
  getPage: (number: number) => Promise<{
    streamTextContent: (options: {
      includeMarkedContent: boolean;
    }) => ReadableStream<TextChunk>;
    cleanup: () => void;
  }>;
};

/** Stream text only. Never render annotations, links, images, forms or scripts. */
export async function extractMaterialPdfText(
  document: MaterialPdfDocument,
  signal: AbortSignal,
): Promise<PdfMaterialText> {
  if (!Number.isSafeInteger(document.numPages) || document.numPages < 1)
    throw new PdfMaterialError("В PDF нет страниц с текстом.");
  if (document.numPages > PDF_MATERIAL_MAX_PAGES)
    throw new PdfMaterialError(
      "В PDF больше 50 страниц. Выберите меньший документ.",
    );
  const parts: string[] = [];
  let length = 0;
  const append = (text: string) => {
    if (length + text.length > PDF_MATERIAL_MAX_TEXT)
      throw new PdfMaterialError(
        "В PDF больше 200 000 символов. Выберите меньший документ.",
      );
    parts.push(text);
    length += text.length;
  };
  for (let number = 1; number <= document.numPages; number++) {
    signal.throwIfAborted();
    const page = await abortableMaterialRead(document.getPage(number), signal);
    const reader = page
      .streamTextContent({ includeMarkedContent: false })
      .getReader();
    try {
      if (number > 1) append("\n\n");
      let lineHasText = false;
      while (true) {
        const chunk = await abortableMaterialRead(reader.read(), signal);
        if (chunk.done) break;
        for (const item of chunk.value.items) {
          if (!("str" in item) || typeof item.str !== "string") continue;
          if (item.str) {
            if (lineHasText) append(" ");
            append(item.str);
            lineHasText = true;
          }
          if ("hasEOL" in item && item.hasEOL) {
            append("\n");
            lineHasText = false;
          }
        }
      }
    } finally {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
      page.cleanup();
    }
  }
  signal.throwIfAborted();
  const text = parts.join("").trim();
  if (!text)
    throw new PdfMaterialError(
      "В PDF не найден текст. Возможно, это скан. Выберите PDF с текстом или вставьте его вручную.",
    );
  return { text, pages: document.numPages };
}
