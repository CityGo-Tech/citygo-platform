# Design and image provenance

Figma target: https://www.figma.com/design/XCWQDLWLHO68J11CtA8ivB?node-id=3-2

Figma MCP returned the Starter-plan tool quota error on 2026-09-06.
No Figma variables or component screenshot were available. Therefore this change
is NOT a verified Figma synchronization.

The temporary canonical source is packages/design-tokens/tokens.json, adapted from
the user's CITYGO_THEME_PACK.md. source.json records provenance and the few
contrast-oriented adaptations. The package generates CSS and typed native tokens.
Manrope is the requested font; the current UI uses system fallback if it is not
installed. Bundle a licensed local font before final visual sign-off.

Once access is restored, export the Figma variables (including modes/aliases),
compare against tokens.json, review changes, regenerate tokens, and run Web/native
checks. Do not change verifiedAgainstFigma to true without that comparison.

Nine character illustrations came from the user-provided CityGo archive.
packages/assets/manifest.json records source filenames, SHA-256 hashes, original
sizes, and 192/640px WebP variants. Originals are not deleted or committed.
pnpm assets:optimize <source-directory> regenerates derivatives.
Web build/dev copies derivatives into its ignored public directory.
