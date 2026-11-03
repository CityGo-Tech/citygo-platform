export const PDF_MATERIAL_MAX_BYTES = 8 * 1024 * 1024;
export const PDF_MATERIAL_MAX_PAGES = 50;
export const PDF_MATERIAL_MAX_TEXT = 200_000;
export const PDF_MATERIAL_TIMEOUT_MS = 20_000;
export class PdfMaterialError extends Error {}
export type PdfMaterialText = { text: string; pages: number };

export function abortableMaterialRead<T>(
  value: Promise<T>,
  signal: AbortSignal,
) {
  return new Promise<T>((resolve, reject) => {
    const aborted = () => {
      signal.removeEventListener("abort", aborted);
      reject(
        signal.reason ?? new DOMException("Reading cancelled", "AbortError"),
      );
    };
    if (signal.aborted) {
      aborted();
      // A file read may already have started; consume its late rejection too.
      void value.catch(() => {});
      return;
    }
    signal.addEventListener("abort", aborted, { once: true });
    value.then(
      (result) => {
        signal.removeEventListener("abort", aborted);
        if (signal.aborted) aborted();
        else resolve(result);
      },
      (cause) => {
        signal.removeEventListener("abort", aborted);
        reject(cause);
      },
    );
  });
}
