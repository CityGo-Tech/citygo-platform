# Web UI

Executable React components: Button (primary/secondary/ghost), Card, Field,
SelectField, RadioGroup, Badge (primary/success), Progress, AssistantMessage.
Field supports associated hints/errors and native input props; RadioGroup uses
native radios with a fieldset/legend and works with arrow keys. Prefer these over
app-specific copies. Pass disabled during submissions and keep consent unchecked.

Import @citygo/design-tokens/tokens.css, then @citygo/ui-web/styles.css.
Layout and product orchestration remain in apps/web; primitives make no API calls.
See /design-system in Web for states and keyboard testing. The library uses
verified Figma tokens; questionnaire-specific layout remains consumer-owned.
For export scope and intentional adaptations, see docs/design/token-status.md.

AssistantMessage accepts a content string for untrusted assistant Markdown. Use it
for both streamed drafts and persisted replies, not user messages. It supports
paragraphs, emphasis, headings (styled paragraphs to preserve the page outline),
lists, quotes and code. Images become text placeholders and raw HTML is ignored.
Only absolute credential-free HTTPS links are clickable; their host is displayed.
No raw-HTML or other Markdown plugins are enabled. See the upstream
[react-markdown security guidance](https://github.com/remarkjs/react-markdown#security).
