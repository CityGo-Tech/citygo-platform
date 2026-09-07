import { memo, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";

// Treat model output as untrusted content, never as app navigation or HTML.
function externalUrl(value: string): string | undefined {
  if (
    !/^https:\/\//i.test(value) ||
    /[\s\\]/.test(value) ||
    Array.from(value).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password)
      return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function MessageHeading({ children }: { children?: ReactNode }) {
  return (
    <p className="cg-assistant-heading">
      <strong>{children}</strong>
    </p>
  );
}

const components: Components = {
  h1: MessageHeading,
  h2: MessageHeading,
  h3: MessageHeading,
  h4: MessageHeading,
  h5: MessageHeading,
  h6: MessageHeading,
  a: ({ children, href }) =>
    href ? (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer nofollow"
        referrerPolicy="no-referrer"
      >
        {children}
        <span className="cg-assistant-link-host"> ({new URL(href).host})</span>
      </a>
    ) : (
      <span>{children}</span>
    ),
  // No img element or source: model-provided media must not make tracking requests.
  img: ({ alt }) => (
    <span className="cg-assistant-image">
      [Изображение не загружено{alt ? `: ${alt}` : ""}]
    </span>
  ),
};

const allowedElements = [
  "p",
  "strong",
  "em",
  "a",
  "ul",
  "ol",
  "li",
  "blockquote",
  "br",
  "hr",
  "code",
  "pre",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "img",
];

/** Shared by live, saved and interrupted replies. User messages stay plain text. */
export const AssistantMessage = memo(function AssistantMessage({
  content,
}: {
  content: string;
}) {
  return (
    <div className="cg-assistant-message">
      {content.length > 32_000 ? (
        // Bound parser work without silently truncating an unusually large reply.
        <p className="cg-assistant-plain">{content}</p>
      ) : (
        <Markdown
          skipHtml
          allowedElements={allowedElements}
          components={components}
          urlTransform={(url, key) =>
            key === "href" ? externalUrl(url) : undefined
          }
        >
          {content}
        </Markdown>
      )}
    </div>
  );
});
