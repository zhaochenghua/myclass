# ExpandAnimations vendored source

Upstream: https://github.com/monperrus/ExpandAnimations

Pinned revision: `77fb4c592676ef6435a05ddeef726bb5abf4ee47` (2026-06-27).
Source: `src/ExpandAnimations.bas`, LGPL-3.0-or-later; see LICENSE.
Original source SHA-256: `02d28fc23d5eabede64812ef1b23464e1930950249c5c5393a3501e5c61da720`.

MyClass changes (2026-09-21):

- `MyClass.bas` supplies a headless entry point with document macros/updates
  disabled, genuine ODP intermediate conversion, state limit and completion report.
  The report includes each state’s original slide number, retaining gaps for hidden slides.
- Paragraph visibility removes only the targeted paragraph, not every subsequent
  paragraph. Blank lines preserve the existing text layout.
- Animation type initialization is exposed for the adapter's preflight checks.

The server generates an isolated Basic library/profile per job; there is no
global extension installation and no need to lower the user's macro security.
Keep this source and license with server deployments. On updates, retain the
local changes and bump the conversion profile to invalidate cached previews.
