import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { pdfMaterialFixture } from "./pdf-material-fixture";

const entry = (page: Page) =>
  page.getByRole("button", { name: "Прикрепить материал", exact: true });
const upload = (page: Page) =>
  page.getByLabel("TXT до 64 КБ или PDF с текстом до 8 МБ и 50 страниц", {
    exact: true,
  });
const preview = (page: Page) =>
  page.getByLabel("Текст из PDF-файла", { exact: true });
const composer = (page: Page) =>
  page.getByLabel("Сообщение помощнику", { exact: true });
const pdf = (name: string) => resolve(process.cwd(), "e2e/fixtures/pdf", name);

test("a real local PDF worker extracts Cyrillic without executing PDF actions or sending bytes, and terminates after preview", async ({
  page,
  context,
}, info) => {
  const state = await pdfMaterialFixture(context);
  const workers: string[] = [];
  page.on("worker", (worker) => workers.push(worker.url()));
  await page.goto("/");
  await composer(page).fill("Помогите оценить резюме");
  await entry(page).click();
  await upload(page).setInputFiles(pdf("active-content.pdf"));
  await expect(preview(page)).toHaveValue(/Резюме для переезда/);
  await expect(preview(page)).toHaveValue(
    /Город: Москва[\s\S]*Опыт работы: инженер[\s\S]*Ищу жильё рядом с метро/,
  );
  await expect(page.getByText("PDF: 2 стр.", { exact: false })).toBeVisible();
  await expect.poll(() => workers.length).toBe(1);
  expect(new URL(workers[0]!).origin).toBe(new URL(page.url()).origin);
  expect(new URL(workers[0]!).pathname).toContain("/_next/");
  await expect.poll(() => page.workers().length).toBe(0);
  expect(
    await page.evaluate(() => "CITYGO_PDF_SCRIPT_EXECUTED" in globalThis),
  ).toBe(false);
  expect(state.sends).toEqual([]);
  expect(state.external).toBe(0);
  expect(state.unexpected).toEqual([]);
  await expect(
    page.getByRole("dialog", { name: "Предпросмотр материала", exact: true }),
  ).toHaveClass(/ym-hide-content/);
  await expect(preview(page)).toHaveClass(/ym-disable-keys/);
  await preview(page).fill("Выбранный мною фрагмент резюме");
  await expect(preview(page)).toHaveValue("Выбранный мною фрагмент резюме");
  await expect(page.getByText("PDF: 2 стр.", { exact: false })).toBeVisible();
  expect(
    await page
      .getByRole("dialog", { name: "Предпросмотр материала", exact: true })
      .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
  ).toBe(true);
  await page.screenshot({ path: info.outputPath("pdf-text-preview.png") });
  await page
    .getByRole("button", { name: "Добавить в сообщение", exact: true })
    .click();
  await expect(composer(page)).toHaveValue(
    "Помогите оценить резюме\n\nМатериал:\nВыбранный мною фрагмент резюме",
  );
  expect(state.sends).toEqual([]);
});

test("PDF text above 4000 is not truncated: the user must explicitly choose an excerpt", async ({
  page,
  context,
}) => {
  const state = await pdfMaterialFixture(context);
  await page.goto("/");
  await composer(page).fill("Мой вопрос");
  await entry(page).click();
  await upload(page).setInputFiles(pdf("long-text.pdf"));
  await expect(preview(page)).toHaveValue(/Строка 000:[\s\S]*Строка 089:/);
  const fullText = await preview(page).inputValue();
  expect(fullText.length).toBeGreaterThan(4000);
  await page
    .getByRole("button", { name: "Добавить в сообщение", exact: true })
    .click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "больше 4000",
  );
  await expect(preview(page)).toHaveValue(fullText);
  await expect(composer(page)).toHaveValue("Мой вопрос");
  expect(state.sends).toEqual([]);
  await preview(page).fill("Пользователь выбрал только этот фрагмент");
  await page
    .getByRole("button", { name: "Добавить в сообщение", exact: true })
    .click();
  await expect(composer(page)).toHaveValue(
    "Мой вопрос\n\nМатериал:\nПользователь выбрал только этот фрагмент",
  );
  expect(state.sends).toEqual([]);
  expect(state.external).toBe(0);
  expect(state.unexpected).toEqual([]);
});

test("passwords, scans, too many pages, malformed bytes and oversize PDFs give local actionable errors and no upload", async ({
  page,
  context,
}) => {
  const state = await pdfMaterialFixture(context);
  await page.goto("/");
  await composer(page).fill("Сохранённый вопрос");
  await entry(page).click();
  for (const [name, error] of [
    ["password.pdf", "защищён паролем"],
    ["scan-no-text.pdf", "Возможно, это скан"],
    ["too-many-pages.pdf", "больше 50 страниц"],
  ] as const) {
    await upload(page).setInputFiles(pdf(name));
    await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
      error,
    );
    await expect(preview(page)).toHaveCount(0);
    await expect.poll(() => page.workers().length).toBe(0);
  }
  for (const [buffer, error] of [
    [Buffer.from("%PDF-1.7\nmalformed objects"), "Не удалось прочитать PDF"],
    [Buffer.alloc(8 * 1024 * 1024 + 1), "больше 8 МБ"],
  ] as const) {
    await upload(page).setInputFiles({
      name: "invalid.pdf",
      mimeType: "application/pdf",
      buffer,
    });
    await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
      error,
    );
    await expect(preview(page)).toHaveCount(0);
    await expect.poll(() => page.workers().length).toBe(0);
  }
  await expect(composer(page)).toHaveValue("Сохранённый вопрос");
  expect(state.sends).toEqual([]);
  expect(state.external).toBe(0);
  expect(state.unexpected).toEqual([]);
});

test("back and account replacement terminate an actual stalled worker before old PDF text can appear", async ({
  page,
  context,
}) => {
  const state = await pdfMaterialFixture(context);
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    const state = { hold: true, created: 0, terminated: 0 };
    Object.assign(window, { pdfWorkerTest: state });
    window.Worker = class extends NativeWorker {
      private pdfWorker: boolean;
      private stopped = false;
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.pdfWorker = options?.name === "citygo-local-pdf";
        if (this.pdfWorker) state.created++;
      }
      postMessage(
        message: unknown,
        transfer?: Transferable[] | StructuredSerializeOptions,
      ) {
        // Keep the real worker waiting for its document, rather than substituting
        // an extraction mock. Termination is still the real browser operation.
        if (this.pdfWorker && state.hold) return;
        Reflect.apply(NativeWorker.prototype.postMessage, this, [
          message,
          transfer,
        ]);
      }
      terminate() {
        if (this.pdfWorker && !this.stopped) {
          this.stopped = true;
          state.terminated++;
        }
        super.terminate();
      }
    };
  });
  const workerState = () =>
    page.evaluate(
      () =>
        (
          window as typeof window & {
            pdfWorkerTest: {
              hold: boolean;
              created: number;
              terminated: number;
            };
          }
        ).pdfWorkerTest,
    );
  await page.goto("/");
  await composer(page).fill("Исходный вопрос");
  await entry(page).click();
  await upload(page).setInputFiles(pdf("cyrillic.pdf"));
  await expect.poll(async () => (await workerState()).created).toBe(1);
  await expect(page.getByText("Читаем текст…", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Назад к выбору", exact: true })
    .click();
  await expect.poll(async () => (await workerState()).terminated).toBe(1);
  await expect(preview(page)).toHaveCount(0);
  await upload(page).setInputFiles(pdf("cyrillic.pdf"));
  await expect.poll(async () => (await workerState()).created).toBe(2);
  state.owner = "202";
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    page
      .getByRole("log", { name: "История диалога", exact: true })
      .getByText("НОВЫЙ_ВЛАДЕЛЕЦ_МАТЕРИАЛА", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(async () => (await workerState()).terminated).toBe(2);
  await expect.poll(() => page.workers().length).toBe(0);
  await expect(composer(page)).toHaveValue("");
  await expect(
    page.getByText("Резюме для переезда", { exact: true }),
  ).toHaveCount(0);
  expect(state.sends).toEqual([]);
  expect(state.external).toBe(0);
  expect(state.unexpected).toEqual([]);
});
