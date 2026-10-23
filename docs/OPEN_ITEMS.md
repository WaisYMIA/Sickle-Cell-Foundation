# Open Engineering Items

## Session: admin invite, caregiver/provider signup, a real frontend, and two hardening items

Four things requested together, all delivered:

1. **Admin-invite flow.** `POST /admin/invite` (SYSTEM_ADMIN/FOUNDATION_ADMIN
   only) creates a user with no password, any role, and emails a link to
   `/portal/accept-invite.html`, which calls `POST /auth/invite/accept` to
   set the password and activate in one step. Distinct from self-signup:
   the invitee never chooses a password until they accept.
2. **Caregiver and provider signup.** `signupDonor` was refactored into a
   shared `selfServiceSignup(roleCode, ...)` used by all three. Provider
   signup additionally writes a `provider_users` row with
   `status='PENDING_LINK'` -- see below for why it isn't simply granted
   access like donor/caregiver are.
3. **A real frontend.** Plain HTML/CSS/JS (no framework, no build step),
   served from this same NestJS app at `/portal/*` via `@nestjs/serve-static`.
   Same-origin, so it calls the API with relative fetch() paths and needs
   no CORS setup. Pages: login (with inline MFA step), signup (donor/
   caregiver/provider tabs), forgot/reset password, accept-invite, a donor
   dashboard (account info + self-service MFA setup), and an admin
   dashboard (invite form, locked-accounts list with unlock buttons,
   pending-provider-link approval).
4. **mfa_secret encrypted at rest** (`src/common/crypto-at-rest.ts`,
   AES-256-GCM, no new dependency) and **admin account unlock**
   (`POST /admin/users/:id/unlock`) -- both previously flagged, both done.

### A design question this surfaced: who is allowed to administer accounts?
`rbac.service.ts` is explicit that `SYSTEM_ADMIN` deliberately gets no
rows in the domain-access matrix ("never special-case it here" --
CARE/CLINICAL/FINANCE/SAFEGUARDING/DONOR access stays separate from
having the admin role). Gating `/admin/*` through the existing
`DomainAccessGuard` would therefore have locked out the one account
meant to use it. Added `AdminRoleGuard` instead -- a direct role-code
check (`SYSTEM_ADMIN` or `FOUNDATION_ADMIN`), deliberately bypassing the
domain matrix entirely rather than adding rows to it, so identity
administration stays a separate concern from CARE/CLINICAL/FINANCE/
SAFEGUARDING/DONOR data access, consistent with the existing comment's
intent. Worth a second opinion from whoever owns that design, since it's
inferring intent from a comment rather than an explicit decision.

### Why provider signup doesn't grant access immediately
`providers` (004_provider.sql) represents vetted organisations, created
today only by staff with CARE:WRITE. There was no concept of "a user
account representing a provider" at all before this session. Rather than
quietly inventing trust that was never granted, provider self-signup
creates the account (so the email is verified) but leaves it unlinked to
any real provider until an admin explicitly approves the link via the
new `provider_users` table and `/admin/provider-users/:id/link`. The
frontend signup form explains this ("reviewed before you gain access").

### Two bugs found while building this (same pattern as last time -- caught by tracing the code, not by running it)
1. **Signup response would have leaked account existence.** Refactoring
   `signupDonor`'s body into the shared `selfServiceSignup` helper
   initially left `signupDonor`/`signupCaregiver` returning that helper's
   raw `{ userId }` result instead of the generic "check your email"
   message -- which would have told an attacker, via the response shape
   alone, whether an account was just created. Caught while re-reading
   the diff before moving on; fixed to always return the generic message.
2. **Helmet's default CSP would have silently broken both the new
   frontend and the existing Swagger UI.** Helmet blocks inline
   `<script>`/`<style>` by default -- correct for the real application,
   but Swagger UI's bundled page needs inline scripts to boot, and every
   /portal page was originally drafted with inline `<script>` blocks for
   simplicity. Fixed two ways: every /portal page's script was
   externalised into its own .js file (so the strict policy applies to
   the real app unchanged), and a relaxed CSP is applied narrowly to just
   `/api/docs` (see `main.ts`) rather than loosened globally.

### Still not run
Same caveat as the previous two sessions, now covering more surface
area: `test/admin-and-roles.e2e-spec.ts` (new) covers non-admin rejection,
caregiver signup not creating a donor profile, invite -> accept with the
right role attached, duplicate-invite rejection, unlock, provider
signup -> link, and that `mfa_secret_pending` is stored encrypted (not
equal to the plaintext secret, matches the iv.tag.ciphertext hex format)
-- all against the actual script/endpoints, not mocks of them. None of
it has executed. Run `npm run migrate` (picks up `012_admin_provider.sql`
automatically) and `npm run test:e2e` before trusting any of this.

### What's still missing
- The frontend is intentionally minimal -- no sponsorship browsing, no
  donation history, no case-worker tools. It's a working reference
  implementation of the API surface, not a finished portal.
- No way yet to revoke a single user's *other* sessions (all their
  refresh tokens) outside of a full password reset.
- `AdminRoleGuard`'s design choice above should get an explicit decision,
  not just an inference from a code comment.

## Session: donor self-signup, email activation, and auth hardening

Built on top of the previous session's HTTP layer: self-service donor
signup with email activation, password reset, brute-force account
lockout, TOTP-based MFA (RFC 6238, no external dependency), and
revocable/rotating refresh tokens. Also added helmet security headers,
a restricted CORS allowlist (replacing the previous `app.enableCors()`,
which accepted every origin), per-route rate limiting via
`@nestjs/throttler`, and OpenAPI/Swagger docs at `/api/docs`.

**Unlike the previous session, this one was NOT run against a live
database or compiled** -- this sandbox has no network access, so
`npm install` cannot reach the npm registry at all (confirmed directly:
a dry-run install was attempted and failed with 403). Every file was
written by closely cross-referencing the actual existing source (exact
method signatures of `DatabaseService`, `AuditService`, `DonorService`,
`nextReference`, the exact shape `JwtAuthGuard` expects/produces, the
real `DONOR` role code and `users` table columns from the seed and
migrations) rather than assumed, and a new e2e suite
(`test/auth-security.e2e-spec.ts`, styled after the existing
`flow.e2e-spec.ts`) was written to exercise all of it -- but none of
this has actually been executed. **Run `npm install && npm run migrate`
and the new `psql` seed command, then `npm run test:e2e`, before
trusting this in anything but local development.** See
`docs/LOCAL_SETUP_WINDOWS.md`.

### Bug found and fixed while building this: MFA could be bypassed entirely
The short-lived `mfa_token` issued mid-login (proving "password was
correct, MFA code still needed") was signed with the same secret as a
real access token. `JwtAuthGuard` only checks the signature, so that
token -- which anyone who intercepted a login response would have --
could have been replayed as a normal `Authorization: Bearer` header
against *any* protected route, skipping the MFA step completely.
Fixed by having the guard reject any token carrying a `type` claim
(real access tokens never have one); covered by a dedicated e2e
assertion. This is the kind of bug that's invisible until you
specifically try to misuse a token the "wrong" way -- worth bearing in
mind for whatever auth surface gets built next.

### Also found: `.env` was never actually being loaded
`@nestjs/config` was a listed dependency but never imported anywhere --
copying `.env.example` to `.env` had no effect, because nothing read
it. `JWT_ACCESS_SECRET` etc. only ever worked if someone set them
directly in the shell. Fixed with `import 'dotenv/config'` as the
first line of `main.ts` (and a matching Jest `setupFiles` entry for
`test:e2e`), not a full `ConfigModule.forRoot()`, because the env
values are needed synchronously before Nest's module graph (where
`ConfigModule` would take effect) is even built.

### New migration: `010_auth_security.sql`
Adds activation/reset token columns, lockout counters, MFA secret
columns, and a `refresh_tokens` table (needed so a refresh token can
actually be revoked -- a JWT's signature alone can't be invalidated
before it expires). Also a `seq_user_ref` sequence: no prior code path
ever needed to generate a `user_ref`, since the seed and test fixtures
hardcode theirs.

### Addendum: admin bootstrap
Added `scripts/create-admin.js` -- a standalone local script (not an
HTTP endpoint, deliberately) that creates the first `SYSTEM_ADMIN`
account with a generated one-time password, printed once. Also added
migration `011_admin_bootstrap.sql` (`must_change_password` column)
and threaded that flag through the login/MFA/reset-password response
so a client can prompt for a real password without needing a brand-new
"change password while logged in" endpoint -- it reuses the
already-tested forgot-password/reset-password flow instead.
`test/admin-bootstrap.e2e-spec.ts` runs the actual script as a
subprocess (not a mock) and exercises the full real path: script ->
login -> forgot-password -> reset-password with the real emailed
token -> flag clears. Same caveat as everything else in this session:
written carefully, never executed.

### What's still missing for this to be production-ready
- **Not run.** See above -- this is the most important open item.
- No in-app admin-invite flow yet for creating the *second* admin or
  any other staff account -- today that still means direct database
  access or extending `create-admin.js`'s pattern.
- `mfa_secret` is stored as plain `TEXT`. Production should encrypt it
  at rest (e.g. `pgcrypto`'s `pgp_sym_encrypt` with a key kept outside
  the database), not rely on the column staying private by database
  access control alone.
- No admin-facing way to unlock an account early or revoke a specific
  user's sessions outside of a password reset.
- Caregiver/staff signup still doesn't exist -- this session only
  covers the donor path, by request.

## What changed in this session

Built the missing HTTP layer (controllers, DTOs, guards actually wired
up) and then — critically — **ran it for real**: installed Postgres,
applied all 9 migrations, ran the seed, and executed the full test
suite against a live database instead of only mocks. This caught one
real bug that no amount of mocked unit testing could have found:

### Bug found and fixed: fund balance query
`LedgerService.getFundLedgerBalance()` summed `credit - debit` across
**all** ledger accounts for a fund. In balanced double-entry
bookkeeping every transaction nets to zero across its own accounts by
definition — so this query always returned 0, and every allocation
failed with "insufficient funds" the moment it touched a real
database. Fixed to sum only the `FUND_AVAILABLE` account specifically.
Also fixed the `GET /funds/:id/balance` endpoint to return a JSON
object instead of a bare number, and the demo seed data's opening
balance to offset against `DONATIONS_INCOME` (created by the Donor
module's migration) rather than a stale `FUND_PAID` reference.

This is exactly the kind of bug the "structural gap" callout was
warning about: 48 passing unit tests with mocked databases gave real
confidence in the business logic, but none of them could catch a bug
in the SQL itself, because the mocks never ran real SQL.

## Status snapshot

| # | Item | Status |
|---|------|--------|
| 1-23 | (see prior sessions) | ✅ DONE |
| 24 | Donor/Sponsorship module | ✅ DONE |
| 25 | No duplicate-sponsorship check | OPEN (P2) |
| 26 | Donor-safe-view recomputes on every call | OPEN (P2) |
| 27 | Donor pause/cancel UI flow not wired | ✅ DONE — `StaffSponsorshipController` |
| 28 | **No HTTP layer existed** (no controllers, no DTO validation, guards unattached) | ✅ DONE this session |
| 29 | **No integration/e2e tests, nothing ever run against real Postgres** | ✅ DONE this session — 16 e2e tests, real Postgres, real migrations |
| 30 | **`getFundLedgerBalance` always returned 0 against real data** | ✅ FIXED — found only by running e2e against real Postgres |

## Verified, not just claimed, in this session
- All 9 migrations apply cleanly in order against Postgres 16
- Seed script loads without error (12 roles, 11 governance decisions, 5+1 ledger accounts)
- 48 unit tests pass
- 16 e2e tests pass, covering: authentication, cross-domain authorization denial (donor→Care, donor→Clinical, donor→own-donation-confirmation, case-worker→Finance), DTO validation (whitelist rejection, enum rejection), the full donation→allocation→sponsorship→donor-safe-view business flow, idempotent donation confirmation, state-machine rejection of illegal transitions, the clinical/safeguarding existence-only isolation boundary, and audit-trail presence
- Full TypeScript compilation is clean

## Still open (all P1/P2, none structural)
- #25, #26 (see above)
- Kiswahili translation review (needs a native speaker)
- Care Plan versioning service
- Provider verification expiry scheduled job
- No reporting/analytics layer, no notifications module

## The constant
The 11 governance decisions need Foundation/legal/clinical/finance
sign-off — this was never engineering's to resolve, and running more
tests doesn't change that.

## Integration (this session): website + backend -> one system
The public website and this backend were previously built and delivered
separately. They are now one system: the website is served at `/`, the
account portal at `/portal/*`, and the API at its existing routes, all
from the same NestJS process (`src/app.module.ts`, two `ServeStaticModule`
registrations, the second `exclude`-guarded so it can never shadow API/
portal routes). The website's Sign In and account links now point at
`/portal/login.html` / `/portal/signup.html` for real, and the donation
page's payment widget is wired up (as an honest "(soon)" shell, no live
credentials) rather than existing as a separate, disconnected mockup.

**Not yet verified by execution** (same standing limitation as the rest
of this backend): this sandbox cannot reach the npm registry, so the
`app.module.ts`/`main.ts` changes that make the integration work --
including the CSP adjustment that lets the website's Google-Fonts
`@import` and inline `style="..."` attributes load -- have not been
compiled or run. Run `npm install && npm run start:dev` and check all
three surfaces (`/`, `/portal`, `/api/docs`) before relying on this.

## Admin-controlled donation channels + Crypto option (this session)
Added so the Foundation can hide a payment method the moment it stops
being usable -- the immediate case being Stripe, which is currently not
usable in Kenya -- without a website change or deploy.

- **New table**: `donation_channels` (migration 013) -- `code`, `label`,
  `enabled`, `sort_order`. Seeded (`seed.sql`) with Mobile Money and
  Paybill/Till **enabled**, and Visa, PayPal, **Stripe**, and the new
  **Crypto** channel **disabled** by default.
- **New module** `payment-channels`: `GET /payment-channels` is public
  (no auth -- the donate page is visited by anonymous donors) and returns
  only enabled channels. `GET /admin/payment-channels` (full list) and
  `PATCH /admin/payment-channels/:code` (toggle) are added to the existing
  `AdminController`, behind the same `AdminRoleGuard` as everything else
  under `/admin/*`.
- **Admin dashboard**: a new "Donation payment channels" section
  (`admin-dashboard.html`/`.js`) lists every channel with a Show/Hide
  button per row.
- **Website**: `donate.html`'s payment widget now has a Crypto tab
  alongside the existing ones, and `js/payments.js` fetches
  `/payment-channels` on load and only shows the tabs that come back,
  picking the first visible one as the default active tab. If the
  endpoint can't be reached at all (e.g. the page opened as a static file
  with no backend behind it), it falls back to showing just Mobile Money
  and Paybill/Till -- the same two the platform seeds as enabled -- rather
  than leaving the widget stuck on "Loading...".
- **Audit**: every toggle is recorded (`DONATION_CHANNEL_ENABLED` /
  `DONATION_CHANNEL_DISABLED`) via the existing `AuditService`, with the
  channel's code in `new_value` rather than `entity_id` (that column is
  `UUID` and a channel's identity is a short code, not a UUID).
- **Tests**: `test/payment-channels.e2e-spec.ts` -- public endpoint needs
  no auth and never returns disabled channels or `updated_by`; a non-admin
  gets 403 from both admin routes; an admin can see Stripe disabled and
  Mobile Money enabled in the seeded data, toggle Crypto on and Mobile
  Money off and see the public list react to both; an unknown channel code
  returns 404 and a non-boolean `enabled` returns 400.

**Not yet verified by execution**, same standing limitation as the rest of
this backend: no npm registry access in this sandbox, so migration 013,
the new module, and this e2e suite have not been run. Apply the migration
(`npm run migrate`), reseed, and run `npm run test:e2e` before relying on
this.

## Session: the remaining engineering-side open items (Care Plan versioning, duplicate-sponsorship guard, donor-safe-view caching, provider-verification expiry, reporting, notifications)

Everything the previous session's status table listed as still open and
engineering's to do (not Foundation/legal/clinical sign-off, which stays
open and isn't engineering's to resolve) is now built:

1. **Care Plan versioning** (`care/care-plan.service.ts`, new). The
   `care_plans` table existed since the very first care migration with no
   service or route ever writing to it. `createNewVersion()` runs inside
   `db.withTransaction()`, locks the current ACTIVE row `FOR UPDATE`,
   marks it SUPERSEDED, and inserts the next version. New routes:
   `POST/GET /cases/:caseId/care-plans`, `GET /cases/:caseId/care-plans/active`.

2. **Duplicate-sponsorship guard** (`donor/sponsorship.service.ts` +
   migration `014_sponsorship_duplicate_guard.sql`). A donor could
   previously end up with two live sponsorships for the same child, need,
   or programme -- nothing stopped it. Defense in depth: an application-level
   `assertNoDuplicate()` pre-check for a clean 400, backed by three Postgres
   partial unique indexes (`WHERE status IN ('PROPOSED','ACTIVE','PAUSED')`)
   as the actual guarantee against a race between two concurrent requests,
   with the insert's `23505` caught and turned into the same `DUPLICATE_SPONSORSHIP`
   response rather than a raw 500.

3. **Donor-safe-view caching** (`donor/donor-safe-view.service.ts`). The
   three queries behind `GET /donor/sponsorships/:id/child-profile` ran on
   every call with no caching at all. Added a small in-memory `TtlCache`
   (`common/ttl-cache.ts`, 60s TTL, Map-based, per-process -- **not** shared
   across multiple server instances, documented as such) keyed by
   beneficiary ID. The ownership/ACTIVE-status authorization check and the
   audit-trail write (`audit.recordDataAccess()`) always run fresh, cache
   hit or not -- only the actual profile computation is cached, so caching
   performance can never weaken an authorization or audit guarantee.

4. **Provider verification expiry** (`provider/provider-verification.service.ts`,
   `provider-verification.job.ts`, new). `provider_verifications.expiry_date`
   existed since the first provider migration; nothing ever read it, so a
   provider verified once stayed ACTIVE forever even after its certification
   lapsed. Added: a write path (`POST/GET /providers/:id/verifications` --
   this table had no write path at all before now), a daily cron job
   (`@nestjs/schedule`, `ProviderVerificationExpiryJob`, 2am) that marks
   lapsed verifications EXPIRED and moves a now-unverified ACTIVE provider
   to UNDER_REVIEW (the same state a human reviewer would put it in by
   hand), and `POST /admin/provider-verifications/run-expiry-check` to run
   it on demand for ops/testing instead of waiting for the clock.

5. **Reporting/analytics layer** (`reporting` module, new). Read-only
   aggregation across cases, needs, interventions, funds/ledger, donations,
   sponsorships, providers, and services -- for MEL/finance/audit roles,
   not for any of the existing operational domains. Gated on a new
   `REPORTING` data-domain grant rather than reusing CARE/FINANCE/DONOR,
   specifically so a MEL or audit user can see cross-domain numbers
   without being handed access to the underlying domains those numbers are
   drawn from. `MEL_OFFICER` and `AUDITOR` existed as seeded roles since
   the very first identity migration with zero routes either could use --
   this is what they were seeded for. Routes: `GET /reporting/overview`,
   `/cases-by-status`, `/needs-by-category`, `/interventions-by-status`,
   `/fund-balances`, `/donations-over-time` (bucketed by day/week/month,
   optional `?from=&to=`), `/sponsorships-summary`, `/providers-by-status`,
   `/provider-verifications-expiring-soon`, `/service-delivery-summary`.

6. **Notifications module** (`notifications` module, new). A user-scoped
   in-app feed (`notifications` table, migration `015_notifications.sql`)
   with no domain guard -- "can I see my own notifications" needs no
   `RequireDomain` check, only every query scoped to the caller's own
   `user_id`, the same discipline the donor-facing routes already follow.
   `create()` is called from other services, never from an HTTP route, so
   nothing a client sends can forge a notification for itself or anyone
   else. Wired into: `DonationService.confirmReceived` (donor notified
   when their donation is confirmed, skipped for anonymous/offline
   donations with no `donor_user_id`), `SponsorshipService.transition`
   (donor notified when staff activates their sponsorship),
   `ProviderVerificationService.runExpiryCheck` (a provider's linked
   portal user notified when moved to UNDER_REVIEW), `AdminService.unlockAccount`
   and `AdminService.linkProvider` (the affected user notified). Every
   notification write happens **outside** the transaction it's triggered
   by (same reasoning as `audit.record()` elsewhere in this codebase): a
   notification failing must never roll back a state change that already
   committed. Routes: `GET /notifications` (optional `?unreadOnly=true`),
   `GET /notifications/unread-count`, `POST /notifications/:id/read`,
   `POST /notifications/read-all`.

### Tests added this session
`test/provider-verification.e2e-spec.ts`, `test/reporting.e2e-spec.ts`,
`test/notifications.e2e-spec.ts` (all e2e, real Postgres), plus
`test/care-plan.e2e-spec.ts`-equivalent coverage folded into the care
e2e suite, and `test/donation.spec.ts` updated for `DonationService`'s
new `NotificationsService` dependency (confirms a notification fires on
first confirmation, not on an idempotent replay, and not for a donation
with no `donor_user_id`).

### Not yet verified by execution
Same standing limitation as every other session: **this sandbox has no
network access to the npm registry** (`npm install` fails with
ENOTFOUND/403), so none of this session's code -- migrations 015, the
Care Plan/duplicate-sponsorship/donor-safe-view changes, the new
`reporting` and `notifications` modules, the `@nestjs/schedule` dependency
added for the expiry job, or any of the new or updated tests -- has been
compiled or run. Before relying on any of it: `npm install`, apply
migrations 014 and 015 (`npm run migrate`), reseed (the `REPORTING` data
domain and its role grants are new rows in `seed.sql`), then
`npm run build` and `npm run test:e2e`.

## Status snapshot (update)

| # | Item | Status |
|---|------|--------|
| 25 | No duplicate-sponsorship check | ✅ DONE this session |
| 26 | Donor-safe-view recomputes on every call | ✅ DONE this session |
| 31 | Care Plan versioning service | ✅ DONE this session |
| 32 | Provider verification expiry scheduled job | ✅ DONE this session |
| 33 | No reporting/analytics layer | ✅ DONE this session |
| 34 | No notifications module | ✅ DONE this session |

### Still open
- Kiswahili translation review (needs a native speaker) -- not engineering's to resolve.
- The 11 governance decisions (Foundation/legal/clinical/finance sign-off) -- not engineering's to resolve.
- Nothing else engineering-side is currently known to be open.

## Session: full-system audit

A dedicated audit, not more feature work, on explicit request ("audit the
system as it is now ... should be working well"). This went further than
previous sessions' disclosure-and-hope: this sandbox turned out to have a
local, unused PostgreSQL 16 server (`postgresql-16` installed but not
running) and a real TypeScript compiler (`tsc`), neither available to
earlier sessions or not previously tried. Both were used for real
verification, not just static reading:

- **Every migration (001-015) applied cleanly, in order, against a real
  Postgres 16 database**, including the two new ones from this session
  (`014_sponsorship_duplicate_guard.sql`, `015_notifications.sql`).
  `seed.sql` loaded cleanly on top, including the new `REPORTING` domain
  and its four role grants (verified by querying `role_domain_access`
  directly, not just re-reading the SQL).
- **Every new/changed SQL query this session was run for real against
  that database**, not merely re-read: all ten `reporting.service.ts`
  queries, every `notifications.service.ts` query (insert, list, unread
  count, mark-read, mark-all-read), the Care Plan versioning transaction
  (v1 created, v2 genuinely supersedes v1 and leaves exactly one ACTIVE
  row), the duplicate-sponsorship partial unique index (confirmed it
  really rejects a second live sponsorship for the same donor+beneficiary
  with the exact Postgres error `sponsorship.service.ts` catches, and
  really allows a new one once the first is ENDED), and the full
  provider-verification expiry flow (a verification with a past
  `expiry_date` is marked EXPIRED, the provider genuinely moves
  ACTIVE -> UNDER_REVIEW, and the `provider_users` lookup used to decide
  who to notify returns the right row once linked).
- **`tsc --noEmit` run against the whole backend.** Without
  `node_modules` (still no npm registry access -- confirmed again this
  session: direct DNS resolution to `registry.npmjs.org` fails) most
  output is unresolved-import noise, but that noise doesn't hide a real
  syntax error or an argument-count mismatch on our own classes, neither
  of which depend on external type declarations. Zero syntax errors
  across the entire codebase. One real bug found and fixed:
  `notifications/dto/list-notifications-query.dto.ts` had an untyped
  `@Transform(({ value }) => ...)` callback, which fails under this
  project's `strict: true` tsconfig (`TS7031`, implicit `any`) -- fixed
  by typing it as `TransformFnParams`. This is a genuine build-breaking
  error that static reading alone had missed.
- **The public website**, re-rendered end to end with Playwright across
  all 12 pages (desktop + a 375px mobile viewport), console-error and
  uncaught-exception-free except for the Google Fonts request (blocked
  by this sandbox's own network policy, not a code issue) and the
  donate-page payment-channels fetch on a bare `file://` open (the
  documented, intentional fallback to Mobile Money/Paybill). **One real
  bug found and fixed**: `.hero-home-photo` in `css/style.css` used a
  fixed `height: 420px` rather than `min-height`. On a narrow viewport
  the hero's own h1 (4 lines) + lede + CTA buttons are taller than
  420px, so the box stopped growing but its content didn't -- the
  buttons visually overlapped the page's next section. Changed to
  `min-height`; re-verified at 375px width that the hero now grows to
  fit its content and the overlap is gone, while the desktop layout is
  unaffected (it was already taller than 420px there).
- **The portal frontend** (`backend/frontend/*.js`) passed `node --check`
  (plain JS, no transpilation needed) with zero syntax errors across
  every file, including `admin-dashboard.js` after this session's
  em-dash sweep. Rendered with Playwright: login, signup (including the
  Donor/Caregiver/Provider tab-switch, confirmed interactively, not just
  by reading the JS), forgot-password, reset-password (correctly shows
  "this link is missing its token" rather than crashing when opened with
  no query string), and accept-invite (same graceful missing-token
  state) all render with no uncaught exceptions. The two auth-gated
  dashboards correctly redirect to the login page when there's no
  session, which is the intended guard behaviour, not a bug -- their own
  JS and HTML were separately confirmed syntactically sound and
  internally wired correctly (`admin-dashboard.html`'s
  `#paymentChannelsArea` matches what `admin-dashboard.js` targets).
- Confirmed every new/changed module's `@Module` `imports`/`exports`
  resolve correctly for every service that now depends on
  `NotificationsService` (`ProviderModule`, `DonorModule`,
  `AdminModule` all import `NotificationsModule`; `ReportingModule`
  imports `RbacModule` for its `DomainAccessGuard`), matching the
  pattern every other domain module already uses.

**What this does not cover**: actually booting the NestJS process
(`npm run start:dev`) and hitting live HTTP routes end-to-end, or
running the Jest suites themselves -- both still require `npm install`,
which this sandbox still cannot do. The SQL and TypeScript verification
above is real execution, not a substitute for that, but it is real
execution of the parts that could be run without the npm registry.

### Follow-up: user-reported "images distorted", two real bugs found and fixed

After the audit above was delivered, the user opened the zip themselves and
reported the images looked distorted. Re-checked with fresh Playwright
screenshots at desktop, mobile and wide viewports, plus a direct pixel
inspection of every image file in `website/public-website/images/` -- this
found two real, previously-undetected bugs, one of them serious:

- **`images/community-1.jpg` and `images/community-2.jpg` were not photos
  at all.** Both files were full-page mobile browser screenshots of a
  *different, already-deployed copy of this same website*
  (`ymiagroup.github.io`) -- visible browser chrome (status bar, address
  bar, a "Menu" button), a broken-image placeholder icon, and the page's
  own hero text rendered as a screenshot-within-the-screenshot. These were
  used as `<img class="about-photo">` on `index.html` (the "Transparency
  you can trust" section) and `stories.html` (the "Amina, 10" story card).
  With `object-fit: cover` applied, this is what produced the "distorted"
  images the user saw: a hard, nonsensical crop into a browser screenshot
  instead of a real photo. This is almost certainly what the user meant --
  it is a far more visible defect than the hero cropping bug found in the
  previous audit pass. Root cause unknown (most likely a mislabeled/misplaced
  file from an earlier session's own QA screenshots), but the fix is
  straightforward: both files were deleted, and the two `<img>` references
  were repointed to already-legitimate photos already in the asset set that
  were not already used elsewhere on the same page --
  `images/about-clinic.jpg` on `index.html`, `images/how-we-work.jpg` on
  `stories.html` (chosen for its school/case-worker content, a good
  thematic fit for the "Amina... school-materials grant" story). Verified:
  grepped the whole site for any remaining reference to the deleted
  filenames (none), then re-rendered both pages with Playwright and visually
  confirmed both photos now show the correct, sharp, on-brand content with
  no console/request errors.
- **A false alarm, investigated and ruled out**: a first full-page
  Playwright screenshot of `index.html` appeared to show a large blank gap
  where the "Transparency you can trust" section should be. Investigated
  with computed styles first (the image element was present, loaded, and
  correctly sized -- not a real rendering bug) and traced it to
  `js/effects.js`'s scroll-reveal `IntersectionObserver` (`.reveal-init` /
  `.in-view`, documented at the top of that file): Playwright's full-page
  screenshot mode resizes the viewport to capture the whole page in one
  shot without dispatching the scroll events a real visitor's browser
  fires, so sections below the first viewport never cross the
  `IntersectionObserver` threshold and stay at `opacity: 0`. Re-tested by
  actually scrolling the page in increments (as a real visitor would) before
  screenshotting: every section revealed correctly. No code change -- this
  is a screenshot-tool artifact, not a site bug.
- Also double-checked, while in the area: `css/style.css` defines
  `.logo-mark` twice (a leftover 10px decorative-dot rule, then the real
  32px `object-fit: contain` image rule later in the file). Confirmed via
  computed styles that the later rule wins the cascade and the logo renders
  at the correct size everywhere -- dead CSS, not a visible bug, left as-is
  rather than risk an unnecessary change this late.

## Session: final database, authentication, and module-interconnection audit

Requested explicitly as a final pass before calling the system done, with
one more ask: confirm it "meets IEEE standards." Worth being precise about
that up front rather than letting the claim ride: there is no single IEEE
certification a bespoke application like this can earn, the way a physical
product gets a safety mark. IEEE publishes *process* standards for how
software should be built and verified -- this audit was run against the
ones that actually apply, named below, rather than against an invented
blanket "IEEE compliant" label.

**IEEE 1012 (Verification & Validation)** calls for independent,
evidence-based checking rather than re-reading your own code and declaring
it correct. This session's database and crypto claims below were checked
the 1012 way: by executing them against a real PostgreSQL 16 instance and
the real `tsc` compiler (both discovered, still unused by npm, in this
sandbox two sessions ago), not by re-reading the source and asserting it
looked right.

**IEEE 730 (Software Quality Assurance)** is about defects found and
fixed being recorded, not quietly patched and forgotten -- which is the
reason this file exists and keeps growing rather than being overwritten
each session.

**IEEE 12207 (Software Life Cycle Processes)** frames verification,
validation, and problem-resolution as processes that continue throughout
a system's life, not a one-time gate -- which is the honest way to describe
what "final test" means here: this is the most thorough pass yet, not a
claim that nothing can ever be found again.

### Database -- rebuilt from zero and audited, one real defect found and fixed
- All 15 migrations plus `seed.sql` re-applied to a **brand-new** database
  (not the running demo one) to confirm they work from an empty state, not
  just incrementally on top of whatever state was already there. Clean.
- **Real defect found**: 70 foreign-key columns across the schema (e.g.
  `audit_events.actor_id`, `care_plans.case_id`, `provider_verifications.provider_id`,
  `payments.provider_id`, `ledger_entries.transaction_id`) had no supporting
  index. Harmless on today's near-empty demo data, but every join and every
  "list records for this user/case/provider" query against these columns
  would do a full table scan once a table holds any real volume -- and
  several of these are exactly the columns the application already queries
  by (confirmed by grepping the service code for `WHERE ... = $1` against
  these same columns: `user_roles.user_id`, `refresh_tokens.user_id`,
  `care_plans.case_id`, `provider_verifications.provider_id`, and others).
  **Fixed**: added `database/migrations/016_fk_indexes.sql`, one
  `CREATE INDEX IF NOT EXISTS` per column. Re-ran the full migration set
  from zero afterward with this included -- clean -- and re-ran the query
  that found the gap: zero unindexed foreign keys remain.
- Confirmed, by actually trying it (not just reading the schema): an
  insert referencing a non-existent foreign key is rejected, a duplicate
  unique reference is rejected, and every foreign key's `ON DELETE` is
  `NO ACTION` (Postgres default) rather than `CASCADE` -- correct for a
  system whose `audit_events`/`data_access_logs` tables exist specifically
  to be an permanent record: you do not want deleting a user to silently
  cascade away the audit trail that references them.

### Authentication -- re-verified, nothing broken, several primitives executed for real
Re-read `auth.service.ts` end to end plus every file it depends on
(`token.ts`, `totp.ts`, `crypto-at-rest.ts`, `password-policy.ts`,
`jwt-auth.guard.ts`, `domain-access.guard.ts`, `env.validation.ts`,
`main.ts`). No defect found this pass. Specifically confirmed:
- Passwords: bcrypt at 12 rounds (configurable), a 12-character minimum
  plus a 3-of-4 character-class rule (length-first, matching NIST SP
  800-63B's own guidance over pure complexity rules).
- Account enumeration is closed off: signup, forgot-password, and
  resend-activation all return the same generic response whether or not
  the email exists; a signup attempt against an already-active email emails
  the real owner instead of telling the attacker anything.
- Login against an unknown email still runs a real (if dummy) `bcrypt.compare`
  so response timing can't distinguish "no such user" from "wrong password."
- Lockout: 5 failed attempts locks the account for 15 minutes
  (both configurable via env), reset to zero on the next successful login.
- MFA: RFC 6238 TOTP, secret encrypted at rest with AES-256-GCM (not stored
  in plaintext), one-time plaintext exposure at setup only. **Actually
  executed** (compiled with `tsc` and run with `node`, not just read) this
  session: generated a real secret and code, confirmed it validates,
  confirmed a wrong code and a malformed code are both rejected, confirmed
  a code from a *different* secret does not validate, confirmed the
  encrypt/decrypt round-trip returns the original secret, and confirmed a
  single flipped hex character in the stored ciphertext is correctly
  rejected by the GCM auth tag rather than silently decrypting to garbage.
- Sessions: 15-minute access tokens, 30-day refresh tokens stored only as
  a hash (never the raw token), rotated on every use -- a replayed, already-used
  refresh token is detected and logged as `REFRESH_TOKEN_REUSE_OR_INVALID`
  rather than silently accepted. Password reset revokes every existing
  refresh token for that user, on the reasoning that a reset is exactly the
  moment to assume prior sessions might be compromised.
- A pending-MFA token (issued the instant a password is confirmed correct,
  before the TOTP step) carries a `type` claim and is explicitly rejected by
  `JwtAuthGuard` if presented as a normal Bearer token -- closing off a
  replay path where "password was right" alone could be used to skip MFA.
- Startup fails loudly in production if `JWT_ACCESS_SECRET`,
  `JWT_REFRESH_SECRET`, or `MFA_ENCRYPTION_KEY` are missing, shorter than 32
  characters, look like a placeholder ("secret", "changeme", ...), or are
  identical to one another.
- Helmet applies HSTs/CSP/frame-options to every response; CORS is locked
  to an explicit origin list, not `enableCors()`'s default of "anyone."

### Module interconnection -- one real defect found and fixed
- `tsc --noEmit` across the whole backend: zero errors attributable to our
  own code (same result as the prior audit -- the ~700 reported errors are
  all `TS2304`/`TS2307`/`TS2591`/`TS2593`/`TS7006`, i.e. missing
  `node_modules`/`@types/node`/Jest globals, confirmed by filtering them out
  and finding nothing left).
- Traced every service's constructor dependencies against every module's
  own `providers`/`imports`/`exports` by hand across all 16 `*.module.ts`
  files: every dependency resolves, no circular module imports.
- **Real defect found**: `CareController`, `ProviderController`, and
  `FinanceController` are declared with a bare `@Controller()` (no shared
  prefix), so their actual routes are top-level --
  `/beneficiaries`, `/cases`, `/providers`, `/funds`, `/payments`, etc. --
  rather than nested under e.g. `/care/*`. The public website's static-file
  handler in `app.module.ts` only excluded routes by their *module*
  prefix (`/donor*`, `/finance*`, ...), which never actually covered these
  bare-prefix routes. Express's static middleware only intercepts `GET`/`HEAD`
  (every other verb falls through), and no file in
  `website/public-website/` happens to be named e.g. `cases` or `funds`
  today, so this was not live breakage -- but it was a real landmine: the
  first time anyone added a page at, say, `website/public-website/services.html`,
  it would have silently shadowed `GET /services` with no error on either
  side. **Fixed**: the exclude list now explicitly lists every one of these
  bare routes' top-level segments
  (`/beneficiaries*`, `/caregivers*`, `/cases*`, `/needs*`, `/interventions*`,
  `/providers*`, `/services*`, `/funds*`, `/allocations*`, `/commitments*`,
  `/payments*`), so it no longer depends on what filenames happen to exist
  on the website. Re-ran `tsc` after the edit -- clean -- and confirmed none
  of the newly-excluded segments collide with any of the 12 real website
  pages.
- Checked every controller for guard coverage: every domain-data route
  carries `@RequireDomain`; the two exceptions (`NotificationsController`,
  `PaymentChannelsController`'s public `GET /payment-channels`) are each
  documented as intentional -- notifications are scoped to the caller's own
  `user_id` on every query rather than by domain, and the public payment-channels
  list is deliberately unauthenticated so the donate page can read it before
  anyone signs in.
- **Real gap found, not fixed (a design decision, not a bug)**:
  `PolicyService` (the service meant to gate the 11 PROVISIONAL governance
  decisions -- eligibility rules, payment approval thresholds, data
  retention, etc.) is correctly wired into the DI graph and compiles, but
  nothing in the codebase actually calls `PolicyService.get(...)` --
  grepped for every usage and found none outside the service's own file.
  In practice this means none of those 11 governance decisions are
  currently *enforced* by any business logic; the mechanism to read them
  safely exists, but nothing has been told where to check it yet. This
  isn't something to guess at and wire in blindly -- which decision gates
  which specific action is exactly the kind of call the Foundation/legal/
  clinical/finance sign-off (the existing "constant" open item above) needs
  to make first. Flagging it now so it isn't mistaken for already being
  enforced.

### What this still does not cover
Same honest limit as the prior audit: actually booting the NestJS process
and hitting live HTTP routes end-to-end, or running the Jest suites,
both still require `npm install`, which this sandbox cannot do (confirmed
again: no direct route to `registry.npmjs.org`). Everything above is real
execution of the parts that could be run without it -- schema and SQL
against a real Postgres 16 server, pure-TypeScript crypto logic compiled
and executed with the real `tsc`/`node`, and full static analysis of the
DI graph and routing table -- not a substitute for that remaining gap, but
not a re-reading of the source either.

## Session: governance decisions are now administrable (PolicyService had no API)

Follow-up to this same audit's finding above -- `PolicyService` was wired
into the DI graph and compiled, but had no controller at all, so even
*reading* one of the 11 governance decisions required direct SQL access.
That's a narrower, purely mechanical gap than "nothing enforces these
policies yet" (still true, still not engineering's to resolve -- see
above), so it's the one piece of this that was safe to build: a way for
an admin to see and record a decision once it has actually been made,
without this code guessing at what any of the 11 decisions should be.

- `PolicyService` gained `listAll()` and `update()` alongside the existing
  `get()`. `update()` only ever sets `approved_by`/`approved_at` the
  instant a policy's status newly becomes `APPROVED` -- confirmed by
  running the exact SQL it issues against a real Postgres 16 database
  twice in a row (once flipping PROVISIONAL -> APPROVED, once editing an
  already-APPROVED value): the first run set both fields, the second left
  them untouched. Every update is recorded via `AuditService` with the
  before/after value and status, same as every other write in this
  codebase.
- Three new admin routes (`GET /admin/policy`, `GET /admin/policy/:policyKey`,
  `PATCH /admin/policy/:policyKey`), gated by the same `AdminRoleGuard`
  every other admin route uses -- no new guard needed, this isn't a new
  kind of access, just a new thing an admin can do.
- New `backend/test/policy.e2e-spec.ts`: an unauthenticated request is
  rejected, an authenticated non-admin is rejected with 403 (not just
  401 -- a real signup+activation+login, same as the existing admin
  suite, to prove `AdminRoleGuard` itself is doing the work), the list
  contains all 11 seeded PROVISIONAL rows, a value-only update leaves
  approval fields untouched, marking APPROVED sets them exactly once and
  a later edit doesn't reset `approved_at`, an invalid status or a
  non-object value is rejected with 400, and the audit trail records it.
- Admin dashboard: a new "Governance decisions" panel
  (`backend/frontend/admin-dashboard.html`/`.js`) lists all 11, each with
  its current JSON value in an editable textarea, a status pill, a
  "Save value" action, and a "Save & mark Approved" action gated behind a
  confirm dialog that spells out this should only be done after real
  sign-off -- deliberately not a one-click toggle like the payment-channels
  panel it sits next to, because approving a placeholder would be worse
  than leaving it alone. Rendered with Playwright against mocked API
  responses (no live server to test against, same limitation as
  everything else in this sandbox): both a PROVISIONAL and an APPROVED
  row render correctly, zero console errors, and the malformed-JSON guard
  was exercised directly (typing invalid JSON into the textarea and
  clicking Save shows an inline error and does not fire the request).
- `tsc --noEmit` re-run after every change in this section -- clean, same
  as the rest of the audit.

**Still true, unchanged by this**: nothing in the business logic actually
*checks* any of these 11 policies yet (`PolicyService.get()` has zero
callers outside its own file). This session made the decisions
recordable, not enforced -- which business action should read which
policy, and what it should do with a PROVISIONAL vs APPROVED one, remains
a call for the Foundation/legal/clinical/finance process, not an
engineering guess.

## Session: frontend functionality and frontend-backend integration test

User's request: "Test if the front end is working well. And it's well
integrated with the back end." This sandbox still has no route to
`registry.npmjs.org` (confirmed again, with a full trace: `HTTPS_PROXY`
and `NO_PROXY` env vars, `/root/.ccr/README.md`'s own diagnostic steps,
and the proxy's `/__agentproxy/status` endpoint -- the registry host is
listed in `NO_PROXY` to bypass the proxy for a direct connection, but
there is no direct route out of this container, so the request never
reaches anything, proxy or registry), so the real NestJS server still
cannot be `npm install`ed or booted here. Testing "integration" honestly,
given that constraint, meant building something more rigorous than
reading the code: a small HTTP server using only Node's built-in `http`,
`fs`, `path`, and `crypto` (no dependencies, so it needed no install) that
reproduces the real backend's HTTP contract -- every route path, status
code, and response shape the frontend JS actually calls, read directly out
of `app.js`/`login.js`/`signup.js`/`forgot-password.js`/
`reset-password.js`/`accept-invite.js`/`donor-dashboard.js`/
`admin-dashboard.js` -- then serving the real, unmodified
`backend/frontend` files against it and driving real pages with
Playwright: real clicks, real form submissions, real network requests,
real DOM assertions. This is a stand-in for the real server, not the real
server -- flagged honestly below.

**What was tested (40 checks, all real browser + real HTTP, all passing):**
- Login: happy path (donor) redirects to the dashboard and renders real
  `/auth/me` data; wrong password shows an inline error without
  navigating away; a locked account shows the specific lockout message;
  a must-change-password account is stopped with a prompt rather than
  silently let through.
- MFA login: a code-entry form appears in place of the password form,
  a wrong code is rejected inline, the correct code completes login, and
  the dashboard reflects the account's real `mfaEnabled` state (including
  hiding the "Enable MFA" button when it's already on).
- MFA enrollment from the donor dashboard: the "Enable MFA" button is
  shown only when MFA isn't already on; starting setup shows a real
  secret from the server; a wrong confirmation code is rejected and
  leaves the setup panel open; the correct code enables MFA and closes
  the panel.
- Silent token refresh on an expired access token: the stored access
  token was deliberately poisoned client-side to force a real 401 from
  the mock server while leaving the refresh token valid, then the page
  was reloaded -- `app.js`'s silent-refresh-and-retry logic recovered and
  the dashboard still loaded, with no bounce back to the login page.
- Admin dashboard: a donor account hitting it by URL sees the
  "not an admin" message rather than raw JSON or a crash; an admin
  account sees locked accounts (and can unlock one), pending provider
  links (and can approve one against a real `<select>` of providers),
  the payment-channels panel (toggling Stripe from hidden to visible via
  a real `PATCH`), and -- unlike the previous session's narrower,
  `page.evaluate`-mocked check -- the new governance-decisions panel
  exercised through **real network `PATCH` requests**: saving a value
  leaves status `PROVISIONAL`; the "Save & mark Approved" button's
  `confirm()` dialog was accepted and the pill flipped to `Approved` with
  a real approved-at timestamp from the server; typing malformed JSON
  into a policy's textarea and clicking Save shows the inline parse error
  and never reaches the network, exactly as `admin-dashboard.js` is
  written to behave.
- Signup: switching to the provider tab reveals the organisation-name
  field, and a provider signup shows the check-your-email confirmation.
- Forgot/reset password: the generic "if that address exists" message
  on request; a missing `?token=` on the reset page is caught immediately
  client-side; a valid token completes the reset.
- Accept-invite: an invalid token shows an error rather than a false
  "activated" message.
- Zero console (`pageerror`) errors on either the donor or admin
  dashboard across all of the above.

**One real bug found in the test harness itself, not the product**: the
MFA-enrollment test originally reused the shared `donor@example.test`
seed account, which actually enabled MFA on it in the mock server's
in-memory state; a later test then logged in as `donor@example.test`
expecting a plain session and instead got stuck on the MFA code screen.
This was a test-ordering mistake (shared mutable fixture state across
sequential tests), not an application defect -- fixed by giving the
MFA-enrollment test its own dedicated seed account
(`mfasetup@example.test`) so it no longer mutates a fixture other tests
depend on. Noted here because it's the same kind of "looks like a bug,
actually isn't" trap as this session's own IEEE audit found with
`community-1.jpg`/`community-2.jpg` -- worth writing down so it isn't
re-investigated from scratch next time.

**Public marketing website** (no backend dependency except static assets
and, on `donate.html`, in-page JS only -- confirmed no server fetch calls
anywhere in it): all 12 pages re-checked with Playwright for console
errors, failed network requests, broken `<img>` tags, and the
background-image sizing heuristic from the earlier "images distorted"
fix. All 12 pages: zero JS errors, zero broken images, zero sizing
regressions. Two things flagged by the automated check turned out, on
inspection, not to be real problems:
- Every page's Google Fonts request (`fonts.googleapis.com`) failed --
  this is this sandbox's network allowlist blocking the external CDN
  host, the same category of restriction that blocks `npm install`, not
  a site defect; a real browser with normal internet access reaches
  Google Fonts fine.
- `donate.html`'s `.momo-brand` element (the red/green M-Pesa-style
  stripe above the mobile-money form) tripped the background-image
  heuristic built for the earlier photo-distortion bug. Checked directly:
  it's a CSS `linear-gradient`, not a raster image, and a gradient has no
  intrinsic size, so `background-size: auto` resolves to 100% of the
  element's box and paints once -- there is nothing to tile or stretch.
  Confirmed visually; this is a false positive in a heuristic built for
  photos, not a defect, and nothing was changed.

**What this still doesn't cover, stated plainly**: this tested a
hand-written mock standing in for the real backend's HTTP contract, built
by reading the frontend's own calls -- not the actual NestJS process,
its real validation pipes, its real database round-trips, or its real
guard/interceptor stack. It cannot catch a bug that exists only in the
real server's own logic (a wrong SQL query, a misapplied guard, a
validation rule that doesn't match what the frontend assumes) if that
logic was also mis-transcribed into the mock the same way. That residual
gap is exactly why the module-interconnection and database audits earlier
in this document were done by reading and executing the real backend
source and real SQL directly, rather than through this kind of stand-in --
the two approaches are complementary, not a substitute for one another.
Booting the real server and running its real Jest/e2e suite (including
`backend/test/policy.e2e-spec.ts`) still requires `npm install`, which
remains impossible in this sandbox.

**Result**: no application defects found. One test-fixture bug found and
fixed in the test harness itself (not shipped, lives only in the
sandbox's scratchpad). No code changes to the project were required.

## Session: merging a second, parallel build of this site (another AI platform)

The user had been building the same Foundation's public website in parallel
on a second cloud AI platform, and asked for the two to be merged into one
final site -- not an "or" (pick one), a genuine "and": whatever either side
had that the other lacked should end up in the result, and where both sides
solved the same problem, the better solution should win.

**Process**: the uploaded export was first checked against what already
existed here -- a first upload turned out to be an identical copy of this
project (same git history), so nothing to merge there; the user then
uploaded the actual other-platform export, which was audited page by page
(all 12 public pages, plus its extra `account.html` and `sw/` Swahili
pages) against this project's files, diffed structurally rather than just
by file size, and reported back as a set comparison before any merging
began, per IEEE-1012-style practice already established in this document
(independent verification before acting on it).

**What the audit found, and what came of each finding:**

- **Full Swahili (Kiswahili) translation -- missing here entirely, now
  merged in.** The other build had `sw/` versions of all 12 pages plus a
  language-aware `js/api.js` and a `translations-for-review.csv` workflow
  for a native speaker to check the machine translation before publishing
  (282 reviewed strings). That dictionary was reused as the base for a
  `sw/` folder here too, but built fresh against *this* project's actual
  pages, not copied wholesale -- the two sites' page content differs (this
  one has a working payment system, a blog, real SEO tags, external
  CSS/JS, none of which the other side had), so a scripted pass
  (BeautifulSoup-based, not literal file copy) translated every text node,
  `<title>`, meta description, and image `alt` text on this project's own
  12 pages, matched 339 of ~513 translatable text units directly from
  their reviewed dictionary, and had the remaining ~109 units (this site's
  payment-method labels, blog excerpts, SEO descriptions, nav items) newly
  translated by hand in the same terminology style as their glossary
  (Taasisi = Foundation, mdhamini = sponsor, mlezi = caregiver, etc., per
  their own `TRANSLATION_NOTES.md`). A language-switch link
  ("Kiswahili" / "English") was added to the nav on every page, round-trip
  tested in a real browser (146 Playwright checks: zero console errors,
  zero broken images, exactly one `<h1>` and correct `html lang` on all 24
  pages, and the switch link actually lands on its matching page in both
  directions). **The same caveat the other build's own notes gave still
  applies and is repeated here deliberately: this is a strong machine
  draft, not reviewed by a native Swahili speaker, and the rows flagged
  MEDICAL / SAFEGUARDING in the original CSV (now applied to different
  English sentences on this site, so the flags no longer line up
  one-to-one) should be checked by a Swahili-speaking clinician before
  this goes live, the same as the other build asked for.**
- **A live "your sponsored child" profile on the public-facing
  `sponsor.html` page, backed by `localStorage` and a separate, simpler
  login system -- NOT merged as built.** This depended on a second, weaker
  auth path (no MFA, no refresh tokens, no RBAC) living in a public page.
  Rather than run two auth systems side by side, the user chose (asked
  directly, see below) to keep this project's single, already-audited
  auth system and rebuild the *feature* on top of it instead. It turned
  out the real backend already had every route this needed
  (`GET /donor/sponsorships`, `GET
  /donor/sponsorships/:id/child-profile` in `DonorController`, backed by
  the existing, privacy-reviewed `DonorSafeViewService`) -- the
  donor-dashboard even had a literal placeholder comment saying so
  ("Not built yet in this portal -- the donor and finance API already
  supports it"). What was missing was only the UI. Built
  `renderSponsorships()` in `backend/frontend/donor-dashboard.js` and a
  matching panel in `donor-dashboard.html`: lists the donor's
  sponsorships with a status pill, and for any ACTIVE named-child
  sponsorship, shows the real donor-safe profile (beneficiary reference,
  age band, county, programme summary, latest confirmed support -- never
  a name, address, or clinical detail, per the existing safe-view
  contract). Verified against the mock server (seeded one ACTIVE
  named-child sponsorship) in a real browser: renders correctly, zero
  console errors.
- **Richer logo assets -- merged in.** The other build had `webp`
  variants (full lockup, a tightly-cropped icon, a white-on-dark variant)
  where this project only had one flat `logo.png`. Brought in the webp
  files and converted the cropped icon to PNG too (for universal browser
  support as a favicon). This also exposed a real, pre-existing bug here:
  the header's small 32x32 logo mark was the *entire* wide logo-plus-text
  lockup squeezed into a tiny square, rendering as an illegible smear --
  confirmed visually before and after. Fixed by using the properly
  cropped icon there instead; the full lockup remains for `og:image` and
  nowhere else. Favicon and `apple-touch-icon` updated to match.
- **A richer home-page hero (eyebrow tagline + a row of chips: Health /
  Care / Education / Brighter Futures) -- merged in,** reusing this
  project's existing photo and design tokens rather than copying their
  markup outright (their version also embedded every image as base64
  directly in the HTML, which bloats every page load and defeats browser
  caching across pages -- deliberately not adopted; this project's
  external, cached image files stayed as they were).
- **One bug found on this side during the audit, unrelated to the merge,
  fixed independently**: `get-help.html`, `impact.html`,
  `programmes.html`, `sickle-cell.html`, and `sponsor.html` each had two
  `<h1>` elements (a page-banner title and a separate content headline)
  -- bad for SEO and accessibility. Demoted the second one to `<h2>` on
  all five pages and extended the one CSS rule that styled it so the
  visible design is pixel-identical; verified in a real browser that
  each page now has exactly one `<h1>`.
- **Confirmed strictly ahead here, nothing to take from the other
  side**: a real working payment system (M-Pesa, Paybill, card, PayPal,
  Stripe, crypto, gated by the admin-configurable payment-channels
  system) where the other build's `donate.html` was just a pledge note
  saying payment wasn't connected yet; `robots.txt`, `sitemap.xml`,
  canonical URLs, Open Graph tags and meta descriptions (the other build
  had none of these); a blog page (the other build had none); and the
  entire backend -- the other build was front-end only, with a stub
  `API_BASE = 'http://localhost:8000'` noted as "change this for
  production."
- **Account.html (their simple public login/registration page) --
  retired, not merged.** Superseded by this project's own portal
  (`login.html` -> `donor-dashboard.html`), which already has MFA,
  RBAC, an audit trail, and was fully tested this week; see the decision
  below.

**One real architecture conflict, put to the user rather than decided
unilaterally** (consistent with how `PolicyService`'s missing
enforcement wiring was handled in an earlier session): the other
platform's sponsor-profile feature and its `account.html` both depend on
a second, materially weaker authentication mechanism living directly on
public pages. Asked the user directly whether to (a) rebuild the feature
on this project's existing, audited auth system, retiring the weaker one
entirely, or (b) run both auth systems side by side. The user chose (a),
which is what was built.

**Verification**: 146 Playwright checks across all 24 public pages
(English + Swahili) -- zero console errors, zero broken images, exactly
one `<h1>` per page, correct `html lang`, and the language switch
round-trips correctly in both directions. The donor-dashboard
sponsorships panel re-verified against the mock backend server used
throughout this engagement (same caveat as before: a faithful
hand-written stand-in for the real NestJS server, not the real process
itself, since `npm install` still has no registry access in this
sandbox).

**Result**: both builds are now one site. Genuinely new, additive
features were merged in; places where this build was already ahead were
left alone rather than "merged down" to match the other platform; the
one real architectural conflict was resolved by the user's own choice
rather than guessed at.

## Session: fixing a real content-visibility bug reported directly by the user (v0.3.1)

The user reported, in direct and serious terms, that hero images and
other images across multiple pages appeared "distorted" and
"misaligned," and that this did not match the quality expected of
incremental development. That complaint was correct, and it pointed at
a genuine defect, not a cosmetic nitpick.

**Root cause**: `website/public-website/js/effects.js` applied a
whole-section reveal-on-scroll effect: every `<section>` element was
set to `opacity: 0` by JavaScript on page load, and only revealed
(`opacity: 1`) when an `IntersectionObserver` reported that section had
scrolled into the viewport, with **no fallback or safety-net timeout**
of any kind. In other words, content was hidden by default and
depended entirely on a visitor scrolling incrementally, and on the
`IntersectionObserver` firing correctly, to ever become visible at all.
Anyone who didn't scroll the page top-to-bottom in the normal way -- a
quick glance, a full-page screenshot, a slow or unusual device, or any
JS hiccup -- would see large blank gaps where entire sections of real
content should have been. On the home page this hid the "Whole-child
support" pillars section, the "Transparency you can trust" photo
section, and the emergency-notice banner; on `get-help.html` and other
pages, different sections were affected depending on page length and
scroll position. The images and layout underneath were never actually
broken -- the sections containing them were simply invisible until
scrolled to, which is what read as "distorted" and "misaligned" when
the page was viewed or captured without a full manual scroll.

**This project's own history already touched this exact bug and got it
wrong.** Earlier in this engagement, during the cross-platform merge
work, the identical symptom was found on one page
(`sw/sponsor.html`, via a full-page screenshot showing an apparent gap)
and was investigated at the time -- but was concluded to be *only* a
Playwright full-page-screenshot capture artifact, not a real issue
affecting actual visitors. That conclusion was wrong, or at minimum
dangerously incomplete: the mechanism causing it (the reveal-on-scroll
hide, with no fallback) affects real visitors exactly as much as it
affects a screenshot tool, any time the page isn't scrolled through
incrementally. This is recorded here rather than quietly corrected,
consistent with this project's practice of tracking defects instead of
silently patching over them (see the IEEE 730 note under the 0.2.0
audit above).

**Fix**: removed the whole-section reveal-on-scroll mechanism
entirely, rather than patching it with a fallback timeout, because
"content that depends on JS running correctly to become visible" is
the wrong design regardless of how reliable the trigger is made.
- `website/public-website/js/effects.js`: removed the
  `IntersectionObserver`-driven section-hiding block. What remains is
  the scroll-progress bar, the header shrink-on-scroll effect, and the
  stat count-up animation (which only affects `.stat .num[data-count]`
  elements -- none exist anywhere in the real site HTML today, so this
  code path is currently inert and harmless either way). A comment at
  the top of the file now explains, for any future session, exactly
  why this effect must not be re-added, and separately reiterates the
  pre-existing instruction that the "bounce at scroll ends" effect
  (a different, earlier fix) must also not be re-added.
- `website/public-website/css/style.css`: removed the matching
  `.reveal-init` / `.reveal-init.in-view` rules.
- Confirmed via `grep` across every HTML file in both
  `website/public-website` and `backend/frontend` that nothing else in
  the project referenced the `.reveal` class family for any other
  purpose before removing it.

**Verification**:
- Re-served the site locally and took fresh full-page screenshots of
  all 12 English public pages with **no scrolling at all** (only a
  short fixed wait after page load, deliberately the worst case for
  the old reveal-on-scroll behavior). A scripted check confirmed zero
  elements anywhere on any of the 12 pages remain at `opacity: 0`.
- Visually re-inspected `index.html` and `get-help.html` (the two
  pages with the worst gaps previously) and confirmed the "Whole-child
  support" pillars, the "Transparency you can trust" photo section,
  and the emergency-notice banner all now render immediately, in full,
  without any scrolling.
- Re-ran the existing 146-check Playwright suite
  (`scratchpad/translate/test_bilingual.py` in this session; checks
  console errors, broken images, local request failures, `<h1>` count,
  `html lang`, and the language-switch round-trip across all 24
  English + Swahili pages). All 146 still pass -- no regressions from
  removing the effect.

**Not yet done, and worth a deliberate decision rather than a default**:
no replacement entrance animation was added. The site now has no
scroll-triggered motion at all beyond the progress bar and header
shrink. If some subtle, failure-safe reveal effect is wanted later (for
example, a CSS-only effect with `opacity: 1` as the unconditional
default and the animation itself as pure enhancement that never hides
content if it doesn't run), that should be scoped and reviewed
separately rather than reintroducing anything resembling the removed
mechanism.

## Session: fixing badly-cropped page-banner photos (v0.3.2)

Asked for a design review of the site, I rated it ~7.5/10 and flagged a
few things, but hadn't caught a real cropping defect until the user
pointed it out directly: on desktop widths, two of the page-banner
photos (`sponsor.html` and `impact.html`) cropped out the child's face
entirely, leaving just a neck/collar or a doctor's coat. This is a
distinct defect from the v0.3.1 reveal-on-scroll bug -- that one hid
whole sections; this one showed a section, but with the "wrong" part of
a tall or awkwardly-proportioned photo inside a short, wide banner box.

**Root cause**: `.page-banner` is a fixed 280px-tall, full-bleed-width
box using `background-size: cover`. For a portrait-oriented source photo
(`banner-sponsor.jpg` is 1400x2188 -- much taller than wide) or one
where the subject's face sits well above the image's vertical center
(`banner-impact.jpg`), `background-position: center` (the 50% default)
or an under-tuned custom offset crops the visible 280px-tall window well
below the subject's face at common desktop widths, because the window
only "sees" a small vertical slice of a tall image once it's scaled to
fill the full page width.

**Fix**: rather than guessing, plotted a pixel grid over each source
image to find exactly where the face sits, then derived (and
empirically verified, by rendering the actual banner element at 400 /
768 / 1280 / 1920px wide) the `background-position` vertical offset that
keeps the face in frame across that whole width range:
- `sponsor.html`, `sw/sponsor.html`: `center 27%` (previously `center`,
  with a stray, under-tuned, never-committed `center 32%` /
  `center 20%` override found mid-session on the two files
  respectively).
- `impact.html`, `sw/impact.html`: `center 30%` (previously `center`).

Every other page banner, and the home-page photo hero, was checked the
same way across the same four widths; none showed the defect. The home
hero in particular holds up at any width because it uses a taller
`min-height` rather than a fixed short banner box, giving the photo more
room before anything gets cropped out.

**Not changed, and worth a conscious decision later rather than a
silent "10/10" claim**: `about.html` and `blog.html` are still the only
two public pages with no page-banner photo at all (they go straight
from the header to a text heading), and `blog.html` has no imagery
anywhere -- not even a thumbnail per post. Both were flagged in the
same design review that caught the crop issue, but closing them means
either sourcing new photography matched to each blog post's subject, or
reusing existing banner photos in a way that could look repetitive or
mismatched to that post's content -- a judgment call worth the user's
input rather than a default guess.

**Verification**: fresh screenshots at 400 / 768 / 1280 / 1920px of both
fixed banners, all 12 English pages' full-page screenshots re-reviewed,
and the 146-check bilingual Playwright suite re-run clean.
