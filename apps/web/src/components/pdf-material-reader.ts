import {
  abortableMaterialRead,
  PDF_MATERIAL_MAX_BYTES,
  PdfMaterialError,
  type PdfMaterialText,
} from "./pdf-material-limits";
import { extractMaterialPdfText } from "./pdf-material-text";

class NoExternalPdfData {
  async fetch() {
    throw new PdfMaterialError(
      "Для чтения этого PDF нужны внешние шрифты. Выберите другой PDF или вставьте текст вручную.",
    );
  }
}

/** The only PDF input is local bytes; the real worker is bundled with this app. */
export async function readPdfMaterial(
  buffer: ArrayBuffer,
  signal: AbortSignal,
): Promise<PdfMaterialText> {
  signal.throwIfAborted();
  if (buffer.byteLength > PDF_MATERIAL_MAX_BYTES)
    throw new PdfMaterialError("PDF больше 8 МБ. Выберите меньший документ.");
  if (!/^%PDF-\d\.\d/.test(new TextDecoder("ascii").decode(buffer.slice(0, 8))))
    throw new PdfMaterialError(
      "Не удалось прочитать PDF. Проверьте формат файла.",
    );
  const { getDocument, PDFWorker } = await abortableMaterialRead(
    import("pdfjs-dist"),
    signal,
  );
  signal.throwIfAborted();
  // An explicit port prevents PDF.js from silently falling back to parsing on
  // the UI thread. No CDN URL, viewer or scripting sandbox is loaded.
  const port = new Worker(
    new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url),
    { type: "module", name: "citygo-local-pdf" },
  );
  let worker: InstanceType<typeof PDFWorker> | undefined;
  let task: ReturnType<typeof getDocument> | undefined;
  let workerFailed!: (reason: Error) => void;
  const failure = new Promise<never>((_, reject) => {
    workerFailed = reject;
  });
  const failed = () =>
    workerFailed(
      new Error("Не удалось запустить чтение PDF. Попробуйте другой файл."),
    );
  port.addEventListener("error", failed);
  const terminate = () => {
    // Explicitly owned port is always terminated, including initialization errors.
    void task?.destroy().catch(() => {});
    worker?.destroy();
    port.terminate();
  };
  signal.addEventListener("abort", terminate, { once: true });
  try {
    worker = PDFWorker.create({ port });
    task = getDocument({
      data: new Uint8Array(buffer),
      worker,
      // PDF.js 6.5 removed eval support and its former isEvalSupported option.
      // Keep the supported API only; do not load any viewer/scripting module.
      BinaryDataFactory: NoExternalPdfData,
      disableWorkerRendering: true,
      isOffscreenCanvasSupported: false,
      isImageDecoderSupported: false,
      enableXfa: false,
      disableFontFace: true,
      useSystemFonts: false,
      useWorkerFetch: false,
      useWasm: false,
      disableAutoFetch: true,
      disableStream: true,
      disableRange: true,
      stopAtErrors: true,
      maxImageSize: 0,
      verbosity: 0,
    });
    const document = await abortableMaterialRead(
      Promise.race([task.promise, failure]),
      signal,
    );
    return await abortableMaterialRead(
      Promise.race([extractMaterialPdfText(document, signal), failure]),
      signal,
    );
  } catch (cause) {
    if (signal.aborted) throw signal.reason;
    if (cause instanceof Error && cause.name === "PasswordException")
      throw new PdfMaterialError(
        "PDF защищён паролем. Сохраните копию без пароля и выберите её.",
      );
    if (
      cause instanceof Error &&
      ["InvalidPDFException", "UnknownErrorException", "FormatError"].includes(
        cause.name,
      )
    )
      throw new PdfMaterialError(
        "Не удалось прочитать PDF. Файл повреждён или не поддерживается.",
      );
    if (cause instanceof PdfMaterialError) throw cause;
    throw new PdfMaterialError(
      "Не удалось прочитать PDF. Файл повреждён или не поддерживается.",
    );
  } finally {
    signal.removeEventListener("abort", terminate);
    port.removeEventListener("error", failed);
    terminate();
  }
}
