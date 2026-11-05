import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AssistantMessage } from "./assistant-message.js";
import type { WebSources } from "@citygo/contracts";

const render = (content: string) =>
  renderToStaticMarkup(<AssistantMessage content={content} />);

test("renders headings, emphasis, lists, quotes and code without page-level headings", () => {
  const html = render(
    "# План\n\n**Важно** и *спокойно*, `65 000 ₽`.\n\n1. Бюджет\n2. Район\n\n- Метро\n- Магазины\n\n> Сравните варианты\n\n```text\nпроверка\n```",
  );
  for (const fragment of [
    "cg-assistant-heading",
    "<strong>Важно</strong>",
    "<em>спокойно</em>",
    "<code>65 000 ₽</code>",
    "<ol>",
    "<ul>",
    "<blockquote>",
    "<pre><code",
  ])
    assert.ok(html.includes(fragment), fragment);
  assert.doesNotMatch(html, /<h[1-6]/);
});

test("external HTTPS links display destination and prevent opener/referrer access", () => {
  const html = render(
    '[Проверить](https://example.com/housing?q=1 "Источник")',
  );
  assert.match(html, /href="https:\/\/example.com\/housing\?q=1"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer nofollow"/);
  assert.match(html, /referrerPolicy="no-referrer"/i);
  assert.match(html, /\(example.com\)/);
});

for (const url of [
  "javascript:alert%281%29",
  "JaVaScRiPt:alert%281%29",
  "javascript&#58;alert%281%29",
  "data:text/html,hello",
  "vbscript:hello",
  "file:///etc/passwd",
  "mailto:test@example.test",
  "http://example.com",
  "/api/v1/logout",
  "../settings",
  "#complete",
  "//example.com",
  "https://user:password@example.com",
  "https://",
  "https://example.com&#10;@evil.test",
]) {
  test(`unsafe or app-navigation link remains text: ${url}`, () => {
    const html = render(`[Подпись](<${url}>)`);
    assert.match(html, /Подпись/);
    assert.doesNotMatch(html, /<a\b|href=/);
  });
}

test("raw HTML, scripts, iframe and model images cannot load resources or handlers", () => {
  const html = render(
    'Безопасный текст\n\n<script>alert(1)</script>\n\n<iframe src="https://tracker.test"></iframe>\n\n<img src="https://tracker.test/pixel" onerror="alert(1)">\n\n![План комнаты](https://tracker.test/image.png)\n\n![SVG](data:image/svg+xml,hello)',
  );
  assert.match(html, /Безопасный текст/);
  assert.match(html, /Изображение не загружено: План комнаты/);
  assert.doesNotMatch(
    html,
    /<(script|iframe|img|link|object)\b|src=|onerror=|tracker\.test/,
  );
});

test("incomplete stream fragments remain renderable and converge to the saved reply", () => {
  const content =
    "## План\n\n**Бюджет**: 65 000 ₽\n\n- [Источник](https://example.com)\n\n```text\nметро\n```";
  for (let length = 0; length <= content.length; length++) {
    assert.doesNotThrow(() => render(content.slice(0, length)));
  }
  assert.match(render(content), /<strong>Бюджет<\/strong>/);
});

test("large replies bypass the parser without losing content or interpreting HTML", () => {
  const content = "x".repeat(32_001) + "**конец**<img src=x>";
  const html = render(content);
  assert.match(html, /cg-assistant-plain/);
  assert.ok(html.includes("x".repeat(32_001)));
  assert.match(html, /\*\*конец\*\*&lt;img src=x&gt;/);
  assert.doesNotMatch(html, /<img|<strong>/);
});

const webSources: WebSources = {
  version: "routerai_native_v1",
  citations: [
    {
      url: "https://example.com/housing?q=1",
      title: '<img src=x onerror="alert(1)"> Источник 🏠',
    },
  ],
};

test("saved tool sources survive JSON readback as prominent escaped external links with visible destination", () => {
  const saved = JSON.parse(
    JSON.stringify({ content: "Ответ с источником.", webSources }),
  );
  const html = renderToStaticMarkup(<AssistantMessage {...saved} />);
  assert.match(
    html,
    /<section class="cg-assistant-sources ym-hide-content" aria-label="Источники">/,
  );
  assert.match(html, /href="https:\/\/example.com\/housing\?q=1"/);
  assert.match(
    html,
    /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt; Источник 🏠/,
  );
  assert.match(html, /cg-assistant-source-host">example.com/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer nofollow"/);
  assert.match(html, /referrerPolicy="no-referrer"/i);
  assert.doesNotMatch(
    html,
    /<(img|script|iframe)\b|Проверено|preload|prefetch/i,
  );
});

test("Markdown source claims never become a source receipt and malformed receipts never hide the answer", () => {
  const content =
    '## Источники\n\n[Заявленный источник](https://example.com/claim)\n\n{"version":"routerai_native_v1","citations":[]}';
  assert.doesNotMatch(
    render(content),
    /cg-assistant-sources|aria-label="Источники"/,
  );
  for (const invalid of [
    { ...webSources, version: "model_markdown" },
    {
      ...webSources,
      citations: [{ url: "javascript:alert(1)", title: "Источник" }],
    },
    {
      ...webSources,
      citations: [{ url: "https://localhost/private", title: "Источник" }],
    },
    {
      ...webSources,
      citations: [{ ...webSources.citations[0], title: "x\ny" }],
    },
  ]) {
    const html = renderToStaticMarkup(
      <AssistantMessage
        content="Точный сохранённый ответ"
        webSources={invalid as WebSources}
      />,
    );
    assert.match(html, /Точный сохранённый ответ/);
    assert.doesNotMatch(html, /cg-assistant-sources|<a\b|href=/);
  }
});

test("sources remain separate from the large-answer parser fallback and absent from empty or legacy answers", () => {
  const content = "x".repeat(32_001) + "**конец**<img src=x>";
  const html = renderToStaticMarkup(
    <AssistantMessage content={content} webSources={webSources} />,
  );
  assert.match(html, /cg-assistant-plain/);
  assert.match(html, /cg-assistant-sources/);
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(
    renderToStaticMarkup(
      <AssistantMessage content="" webSources={webSources} />,
    ),
    /cg-assistant-sources/,
  );
  assert.doesNotMatch(render("Новый ответ без поиска"), /cg-assistant-sources/);
});
