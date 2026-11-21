import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applicationComparison,
  applicationDraft,
  resumeEvidence,
  vacancyRequirements,
} from "./career-application-state";

test("uses only selected text from the saved résumé and exposes unmatched vacancy requirements", () => {
  const evidence = resumeEvidence(
    "Цель: работа с данными.\r\n\r\nОпыт: Настраивал выгрузку.\nОпыт: Настраивал выгрузку.\nВёл отчёты.",
  );
  const requirements = vacancyRequirements(
    "Отчётность\n Владение Rust \r\nОтчётность",
  );
  assert.deepEqual(evidence, ["Настраивал выгрузку.", "Вёл отчёты."]);
  const comparison = applicationComparison(
    requirements,
    evidence,
    new Map([
      ["Отчётность", "Настраивал выгрузку."],
      ["Владение Rust", "Знаю Rust."],
    ]),
  );
  assert.deepEqual(comparison, {
    supported: ["Настраивал выгрузку."],
    missing: ["Владение Rust"],
  });
  assert.match(
    applicationDraft("Аналитик", comparison.supported)!,
    /«Аналитик».*Настраивал выгрузку\./s,
  );
  assert.doesNotMatch(
    applicationDraft("Аналитик", comparison.supported)!,
    /Rust|Вёл отчёты/,
  );
});

test("does not create a draft from a title or from unconfirmed requirements", () => {
  assert.equal(applicationDraft("Аналитик", []), null);
  assert.equal(applicationDraft(" ", ["Вёл отчёты."]), null);
  assert.deepEqual(
    applicationComparison(["__proto__", "Нужно обучение"], ["Факт"], new Map()),
    {
      supported: [],
      missing: ["__proto__", "Нужно обучение"],
    },
  );
});
