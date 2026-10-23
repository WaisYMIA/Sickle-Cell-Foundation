# Changelog

All notable changes to the Sickle Cell Child Care Foundation platform are
recorded here. Versions follow [Semantic Versioning](https://semver.org/)
as best this applies to an application that has not yet had a public
release: a 0.y.z version means the platform is still pre-release and its
shape can still change; the minor number (y) is bumped for new features,
the patch number (z) for fixes and documentation-only work.

Each entry below maps to a specific git commit; run `git log --oneline`
in this repository to see the exact diff for any version.

## [0.3.2] - 2026-10-24

### Fixed
- **Two page-banner photos were badly cropped on desktop/wide screens**,
  reported directly by the user as hero/header images being "so much
  cropped":
  - `sponsor.html` / `sw/sponsor.html`: the banner used a tall portrait
    photo in a short, wide banner box with `background-position: center`
    (later an uncommitted, under-tuned override), which showed only the
    child's neck and collar -- no face at all. Re-tuned the crop
    (`background-position: center 27%`) so the child's eyes and smile
    stay in frame from mobile widths up through ultra-wide desktop.
  - `impact.html` / `sw/impact.html`: the banner photo lost the child's
    eyes entirely above roughly 1440px wide, leaving only her collar and
    the doctor's coat. Re-tuned (`background-position: center 30%`) so
    her face stays the focal point at every width tested (400 / 768 /
    1280 / 1920px).
  - Verified every other page banner and the home-page hero photo across
    the same width range; none showed the same defect (the home hero in
    particular scales cleanly at any width thanks to its taller
    `min-height`).
  - Re-ran the 146-check bilingual Playwright suite after the change:
    no regressions.

## [0.3.1] - 2026-10-22

### Fixed
- **Content on every public page could silently fail to appear at all.**
  `js/effects.js` hid every `<section>` (`opacity: 0`) by default and only
  revealed it when the section scrolled into view, via an
  `IntersectionObserver` with no fallback timeout. Anyone who didn't
  scroll through a page incrementally -- a quick glance, a screenshot, a
  slow device, or any hiccup in the observer -- saw large blank gaps
  where real content (the "Whole-child support" pillars, the
  "Transparency you can trust" photo section, notice banners, and more,
  depending on the page) should have been. This is what was reported as
  hero/content images being "distorted" and "misaligned": the images and
  layout were never actually broken, the sections containing them were
  just invisible until scrolled to.
  - Removed the whole-section reveal-on-scroll mechanism entirely from
    `website/public-website/js/effects.js` and the matching
    `.reveal-init` / `.reveal-init.in-view` rules from
    `website/public-website/css/style.css`. Content is visible
    immediately on load; only the (harmless, cosmetic) scroll-progress
    bar, header shrink-on-scroll, and stat count-up animation remain.
  - **Correction to this project's own history**: an earlier session had
    investigated the identical symptom on one page
    (`sw/sponsor.html`, found via a full-page screenshot) and concluded
    it was only a Playwright screenshot-capture artifact, not a real
    defect. That conclusion was wrong, or at least incomplete -- the
    same code path genuinely hid content from real visitors whenever a
    page wasn't scrolled through top to bottom. Recorded here rather
    than quietly corrected, per this project's "defects tracked, not
    silently patched" practice (see the 0.2.0 audit entry below).
  - Verified: full-page screenshots of all 12 English pages re-taken
    with no scrolling at all, confirming zero elements remain at
    `opacity: 0`; the existing 146-check bilingual Playwright suite
    re-run against the change with no regressions.

## [0.3.0] - 2026-10-22

Merged in features from a parallel build of this site built on another
AI platform, after an independent, page-by-page audit of both (see
`docs/OPEN_ITEMS.md` for the full comparison).

### Added
- Full Kiswahili (Swahili) translation of all 12 public pages
  (`website/public-website/sw/`), with a language-switch link in the
  nav of every page. Machine-translated and mechanically verified
  (146 real-browser checks); **not yet reviewed by a native speaker** --
  see `docs/OPEN_ITEMS.md` for what still needs a native-speaker and
  clinician check before this goes live.
- A "your sponsored child" live profile panel on the donor dashboard
  (`backend/frontend/donor-dashboard.html`/`.js`), backed by the
  existing, privacy-reviewed `DonorSafeViewService` backend routes --
  the UI was the only missing piece.
- Richer logo assets (`website/public-website/images/logo/`): webp
  variants and a properly cropped icon, used to fix a pre-existing bug
  where the header's small logo mark rendered as an illegible smear.
- A home-page hero refresh (eyebrow tagline + a row of chips).

### Fixed
- Five pages (`get-help.html`, `impact.html`, `programmes.html`,
  `sickle-cell.html`, `sponsor.html`) each had two `<h1>` elements,
  found during the audit above and unrelated to it; demoted the
  second to `<h2>` on all five, with identical visible styling.

## [0.2.1] - 2026-10-16

### Verified
- Frontend functionality and frontend-backend integration tested end
  to end with a real browser (Playwright) against a faithful,
  zero-dependency mock of the backend's HTTP contract -- the real
  NestJS server still cannot be `npm install`ed in this sandbox (no
  registry access). 40 checks, all passing; no application defects
  found. Documented in `docs/OPEN_ITEMS.md`.

## [0.2.0] - 2026-10-14

### Added
- Governance-decisions admin API and UI: `PolicyService` previously had
  no HTTP surface at all. Added list/get/update endpoints
  (`backend/src/modules/policy/`), an admin-dashboard panel, and a full
  e2e test suite (`backend/test/policy.e2e-spec.ts`).

### Fixed
- 70 foreign-key columns across the schema had no supporting index;
  added them all (`database/migrations/016_fk_indexes.sql`), verified
  against a rebuilt-from-zero database.
- A latent static-route-shadowing gap in `app.module.ts`: several real
  API routes (`/beneficiaries`, `/cases`, `/providers`, etc.) were not
  excluded from the public-website static file handler, because those
  controllers use a bare `@Controller()` with no shared prefix.

### Audited
- Full database, authentication, and module-interconnection audit
  against IEEE 1012 (independent verification), IEEE 730 (defects
  tracked, not silently patched), and IEEE 12207 (continuous
  verification) as a framework. See `docs/OPEN_ITEMS.md` for the full
  write-up, including what this sandbox's lack of `npm install` access
  means the audit could and couldn't cover.

## [0.1.0] - 2026-10-12

### Added
- Initial commit: the full platform as it stood after the preceding
  build sessions -- NestJS + PostgreSQL backend (RBAC, MFA, audit
  trail, donor/care/finance/provider domains) and the public marketing
  website, served from one process.
