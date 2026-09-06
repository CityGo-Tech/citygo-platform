# Design and image provenance

## Verified export — 2026-09-06

File: https://www.figma.com/design/XCWQDLWLHO68J11CtA8ivB
Desktop questionnaire: https://www.figma.com/design/XCWQDLWLHO68J11CtA8ivB?node-id=261-1905
Mobile questionnaire: https://www.figma.com/design/XCWQDLWLHO68J11CtA8ivB?node-id=269-150

The old link targeted canvas 3:2 (landing), not a concrete frame. Access is now
working. get_design_context was obtained for both questionnaire frames.

All 37 local variables were exported read-only: Primitives (13), Semantic (10),
Dimensions (14). Each collection currently has one "Mode 1". IDs, aliases, mode
names and original codeSyntax are preserved in packages/design-tokens/figma.snapshot.json.
The selected V2 frames have no bound variables; an empty node-variable response
does NOT mean the document has no variable collections.

figma.mapping.json maps 28 public application tokens to exact exported variables.
The generator resolves aliases, checks that mapped values have not drifted,
and emits tokens.css, tokens and all 37 resolved figmaTokens in index.ts.
It needs no network, Figma session, token or build-time secret.
New modes fail closed until a deliberate mapping strategy is reviewed.

## Screen-specific differences

| Property            | Library         | Selected V2 desktop frame |
| ------------------- | --------------- | ------------------------- |
| Foreground          | #17192B         | #182033                   |
| Border              | #E3E5EC         | #E2E5EC                   |
| Card radius         | 24px            | 32px                      |
| Field radius        | 12px            | 14px                      |
| CTA radius / height | 12px / min 48px | 16px / 64px               |

The V2 values are scoped to the questionnaire. Other raw screen colors (soft
primary/success, control border and progress track) are recorded in tokens.json
as screen-derived, not falsely attributed to variable IDs. Manrope, desktop 48px
and mobile 32px headings are taken from the two design-context exports.
Rounded vector containers are implemented as CSS/semantic controls, not pictures
of a form. All image content uses the exact Figma asset.

The functional form intentionally retains the required monthly budget, exact
move date, household, explicit unchecked AI consent, session/logout and server
errors. The housing route is the only supported goal; job/documents choices are
visibly disabled with an explanation. No new API fields or fake persisted goals.
The form is scrollable rather than clipped to the static 844px mobile canvas.
Header remains the working application header; desktop hero is hidden on mobile
as in its source frame. The dashboard, chat and completion layouts are not yet
visually reconciled to their Figma frames.

## Shared Web components

Seven primitives: Button, Card, Field, SelectField, RadioGroup, Badge, Progress.
The package owns component styles, including focus/disabled/error states.
Web only owns product layout and questionnaire-specific sizing.
RadioGroup uses native radios, a fieldset and legend; arrow keys work without
custom event simulation. Field associates hint/error text with the native input.
States absent from Figma (hover/error/disabled) are documented adaptations.
Visit /design-system for the independent component gallery.

## Assets and fonts

apps/web/public/figma/questionnaire-support.png is the exact exported asset for
node 261:1932. SHA-256:
d290b949d35ff71baa7a1dde190806f7b075ce99046f1adeeaf669c2d0bf8efd.
It is identical to the original Support Assistant in the user-provided archive.
Next Image optimizes delivery; the expiring Figma asset URL is not used at runtime.

Manrope variable TTF (200–800) is bundled with its SIL OFL 1.1 license, including
Cyrillic, from https://github.com/google/fonts/tree/main/ofl/manrope.
SHA-256: d0639be45d0af36e798172419d7bd173c4bd4f29e2b76cbb69db1d11bf8b0a40.
The Web build uses next/font/local; no runtime request to Google Fonts.
Expo keeps its existing font behavior; native font loading is a separate step.

Nine existing character sets retain their original provenance and optimized
192/640px WebP derivatives in packages/assets/manifest.json. No originals deleted.

## Verification

Run pnpm check and pnpm test:e2e. Token tests cover all 37 values, drift,
alias failure/cycles, unreviewed modes and readable text contrast.
Browser checks cover field descriptions, error/disabled states, radio keyboard
navigation, minimum 48px buttons, narrow layout, questionnaire consent and
selected household submission, then the complete chat → +60 XP route.
Review screenshots from both browser projects before visual sign-off.
