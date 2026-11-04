import assert from "node:assert/strict";
import test from "node:test";
import {
  createTextMaterialResource,
  type TextMaterialContext,
  type TextMaterialView,
} from "./text-material-state";
import {
  PDF_MATERIAL_MAX_BYTES,
  PDF_MATERIAL_TIMEOUT_MS,
  type PdfMaterialText,
} from "./pdf-material-limits";
import {
  extractMaterialPdfText,
  type MaterialPdfDocument,
} from "./pdf-material-text";

function pdfFile(size = 8) {
  return {
    name: "resume.pdf",
    size,
    arrayBuffer: async () => new TextEncoder().encode("%PDF-1.7").buffer,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { resolve, promise };
}
function fixture(
  readPdf: (
    buffer: ArrayBuffer,
    signal: AbortSignal,
  ) => Promise<PdfMaterialText>,
) {
  const controller = new AbortController();
  let context: TextMaterialContext = {
    userId: "101",
    threadId: "9007199254740993",
    sessionSignal: controller.signal,
    enabled: true,
    draft: "Мой вопрос",
  };
  const scope = context;
  const views: TextMaterialView[] = [];
  const applied: string[] = [];
  const resource = createTextMaterialResource({
    scope,
    current: () => context,
    publish: (v) => views.push(v),
    apply: (v) => applied.push(v),
    readPdf,
  });
  return {
    controller,
    resource,
    views,
    applied,
    change: (next: Partial<TextMaterialContext>) => {
      context = { ...context, ...next };
    },
  };
}

test("a long PDF stays complete and editable; confirmation refuses overflow until the user chooses an excerpt", async () => {
  const text = "Материал для переезда ".repeat(5000);
  const f = fixture(async () => ({ text, pages: 2 }));
  await f.resource.select(pdfFile());
  assert.deepEqual(f.views.at(-1), {
    phase: "preview",
    filename: "resume.pdf",
    text,
    format: "pdf",
    pages: 2,
  });
  assert.equal(f.resource.confirm(), false);
  assert.equal(f.views.at(-1)?.phase, "preview");
  assert.deepEqual(f.applied, []);
  f.change({ draft: "Последний вопрос" });
  f.resource.edit("Я выбрал этот фрагмент");
  const edited = f.views.at(-1);
  assert.ok(
    edited?.phase === "preview" &&
      edited.format === "pdf" &&
      edited.pages === 2,
  );
  assert.equal(edited.error, undefined);
  assert.equal(f.resource.confirm(), true);
  assert.equal(f.resource.confirm(), false);
  assert.deepEqual(f.applied, [
    "Последний вопрос\n\nМатериал:\nЯ выбрал этот фрагмент",
  ]);
  f.resource.dispose();
});

test("oversize metadata and a false PDF header never start the parser", async () => {
  let calls = 0,
    reads = 0;
  const f = fixture(async () => {
    calls++;
    return { text: "unused", pages: 1 };
  });
  await f.resource.select({
    ...pdfFile(PDF_MATERIAL_MAX_BYTES + 1),
    arrayBuffer: async () => {
      reads++;
      return new ArrayBuffer(0);
    },
  });
  assert.equal(reads, 0);
  await f.resource.select({
    ...pdfFile(),
    arrayBuffer: async () => new TextEncoder().encode("not PDF!").buffer,
  });
  assert.equal(calls, 0);
  assert.deepEqual(f.applied, []);
  f.resource.dispose();
});

for (const replacement of [
  "back",
  "dispose",
  "abort",
  "owner",
  "thread",
  "session",
  "disabled",
] as const) {
  test(
    "PDF parser cancellation/late completion cannot cross " + replacement,
    async () => {
      const pending = deferred<PdfMaterialText>();
      let signal: AbortSignal | undefined;
      const started = deferred<void>();
      const f = fixture(async (_bytes, nextSignal) => {
        signal = nextSignal;
        started.resolve();
        return pending.promise;
      });
      const reading = f.resource.select(pdfFile());
      await started.promise;
      if (replacement === "back") f.resource.back();
      if (replacement === "dispose") f.resource.dispose();
      if (replacement === "abort") f.controller.abort();
      if (replacement === "owner") f.change({ userId: "202" });
      if (replacement === "thread") f.change({ threadId: "300" });
      if (replacement === "session")
        f.change({ sessionSignal: new AbortController().signal });
      if (replacement === "disabled") f.change({ enabled: false });
      if (["back", "dispose", "abort"].includes(replacement))
        assert.equal(signal?.aborted, true);
      const count = f.views.length;
      pending.resolve({ text: "PRIVATE_OLD_OWNER", pages: 1 });
      await reading;
      assert.equal(f.views.length, count);
      assert.equal(f.resource.confirm(), false);
      assert.deepEqual(f.applied, []);
      f.resource.dispose();
    },
  );
}

test("the 20-second deadline cancels a stuck PDF, reports a local error and never appends late text", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = deferred<PdfMaterialText>();
  const started = deferred<void>();
  let signal: AbortSignal | undefined;
  const f = fixture(async (_bytes, nextSignal) => {
    signal = nextSignal;
    started.resolve();
    return pending.promise;
  });
  const reading = f.resource.select(pdfFile());
  await started.promise;
  t.mock.timers.tick(PDF_MATERIAL_TIMEOUT_MS);
  await reading;
  assert.equal(signal?.aborted, true);
  const last = f.views.at(-1);
  assert.ok(last?.phase === "select" && last.error?.includes("20 секунд"));
  pending.resolve({ text: "LATE_PRIVATE_TEXT", pages: 1 });
  await Promise.resolve();
  assert.deepEqual(f.applied, []);
  f.resource.dispose();
});

function document(pages: number, texts: string[][]) {
  let opened = 0,
    cleaned = 0,
    cancelled = 0;
  const document: MaterialPdfDocument = {
    numPages: pages,
    getPage: async (number) => {
      opened++;
      return {
        streamTextContent: () =>
          new ReadableStream({
            start(controller) {
              for (const text of texts[number - 1] ?? [])
                controller.enqueue({ items: [{ str: text, hasEOL: true }] });
              controller.close();
            },
            cancel() {
              cancelled++;
            },
          }),
        cleanup: () => {
          cleaned++;
        },
      };
    },
  };
  return { document, counts: () => ({ opened, cleaned, cancelled }) };
}

test("streamed text preserves Cyrillic and page order; >50 pages are refused before opening any page", async () => {
  const f = document(2, [["Москва", "Бюджет 50 000 ₽"], ["Опыт работы"]]);
  const result = await extractMaterialPdfText(
    f.document,
    new AbortController().signal,
  );
  assert.equal(result.pages, 2);
  assert.equal(result.text, "Москва\nБюджет 50 000 ₽\n\n\nОпыт работы");
  assert.equal(f.counts().cleaned, 2);
  const tooMany = document(51, []);
  await assert.rejects(
    extractMaterialPdfText(tooMany.document, new AbortController().signal),
    /больше 50/,
  );
  assert.equal(tooMany.counts().opened, 0);
});

test("no-text scans and extracted expansion above 200k produce errors instead of a truncated preview", async () => {
  const blank = document(1, [[]]);
  await assert.rejects(
    extractMaterialPdfText(blank.document, new AbortController().signal),
    /Возможно, это скан/,
  );
  const large = document(2, [["А".repeat(150_000)], ["Б".repeat(60_000)]]);
  await assert.rejects(
    extractMaterialPdfText(large.document, new AbortController().signal),
    /больше 200 000/,
  );
  assert.equal(large.counts().cleaned, 2);
});
