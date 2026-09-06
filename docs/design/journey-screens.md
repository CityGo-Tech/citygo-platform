# Web journey — Figma V2

Read-only design context was obtained on 2026-09-06 for these nodes in
https://www.figma.com/design/XCWQDLWLHO68J11CtA8ivB:

| Screen                | Desktop node      | Mobile node |
| --------------------- | ----------------- | ----------- |
| Quest map             | 304:23 (editable) | 269:235     |
| Housing chat          | 269:105           | 269:165     |
| Chat / reply selected | 269:124           | 269:174     |
| Quest complete        | 269:145           | 269:187     |

The implementation reuses the local Manrope font, canonical design tokens and
Button, Card, Badge and Progress from `@citygo/ui-web`. `journey.css` owns responsive
product layouts, not a second component library. No Figma nodes were changed.
The original single dashboard is replaced by navigable plan, chat and completion
views. Hash navigation preserves browser back/forward and chat/completion views
on reload; a completion URL is valid only for an actually completed server quest.

## Functional adaptations

- All titles, quest states, rewards and total XP come from Dashboard. The static
  map's five/eight quests, sample 40/100 XP, levels, districts and job unlock are
  not fabricated. This release has two real housing quests, each worth 60 XP.
- The plan uses the editable desktop frame's list/detail layout and the mobile
  frame's stacked cards and path map. Cards grow for actual titles and content.
- Chat preserves streaming, history and agent handoffs. It identifies assistants
  as AI, not a human realtor or an unverified "online" person. Stop is available
  while waiting for the first token as well as during a reply.
- Quick replies prepare editable text; they do not silently send a message or
  complete a criterion. Support also prepares a message, then the existing
  server orchestrator routes it after the user sends it.
- The checklist stays explicit and unchecked. Completion still requires all
  confirmations in the UI and the server's per-quest Housing Navigator reply
  validation. A rejected completion never opens the success view.
- The existing API does not expose per-quest reply eligibility to the client.
  It remains authoritative; the UI explains this instead of guessing from an
  old message in the shared history. No API or database contract changed.
- Completion shows the actual finished quest, stored reward and unlocked next
  housing quest. Completing the second quest shows the terminal state without
  an invented third quest. Reloading a result does not call completion again.
- The existing CityGo wordmark, logout and working navigation are retained.
  Links for unimplemented Documents/Profile destinations are not introduced.
  Mobile content scrolls rather than clipping to Figma's fixed 844px canvas;
  the composer and checklist stay in normal flow so they cannot cover content
  or each other when the keyboard or text size changes.
- Buttons retain 48px minimum touch size and readable primaryStrong/success
  colors. Small-screen typography and card layout use the mobile reference;
  unsupported visual levels are omitted.

## Assets

`apps/web/public/figma/housing-navigator.png` is the exact exported PNG used by
the editable desktop map. SHA-256:
`a55678e7259b13e1ef033f62507634bf272bfc107bcfbed0061217d1a86618ba`.
This equals the original housing character hash in `packages/assets/manifest.json`.
Next Image handles optimized delivery. Other specialists reuse existing local
character derivatives; no runtime Figma URL, new remote host or secret is required.
The screen's vector containers/paths are semantic cards, lists and CSS connectors;
the completion tick is the source design's text glyph, not a fabricated SVG.

## Verification

`pnpm test:e2e` checks the real API-backed two-quest journey, exactly 60 then 120
total XP, reloads, next-quest and terminal states. Additional browser tests use
isolated Dashboard/network fixtures for 320/768/1440px layouts, back navigation,
invalid completion URLs, unconfigured AI, failed completion, recoverable message
errors, cancellation before a token, handoff and interrupted-history rendering.
Fixtures are test-only: production still uses the existing API and provider.
Screenshots cover map, chat, ready-to-complete, completion and narrow layouts.
Browser mobile emulation is not a real iOS/Android device test, and the test
provider does not verify a live OpenAI key or model.
