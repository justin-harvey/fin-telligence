# CivicChain E2E — automated screen driver

A Playwright harness that signs in and **walks the app** to catch dead ends,
blank pages, console errors, JS crashes, and 4xx/5xx responses. Built to run
**where the site is reachable** — your laptop, or any environment whose network
policy can reach the app host. (It was authored in a sandbox that can't reach
`civic-chin.com`, so it's ready-to-run rather than already-run.)


## Easiest way to run it (no terminal)

Double-click the launcher for your machine:

- **Mac / Linux:** `run.command`
- **Windows:** `run.bat`

It installs everything the first time, then opens Playwright's **graphical test
runner** — you click a test and watch a real browser drive through your app.

First launch creates a `.env` file and asks you to set one thing: `BASE_URL`
(your site's address). Open `.env` in any text editor, set it, and double-click
the launcher again.

> On Mac, the first time you may need to right-click `run.command` -> Open to get
> past the "unidentified developer" prompt. After that, double-click works.

## What it does

| Spec | Purpose | Login? |
|------|---------|--------|
| `tests/smoke.spec.ts`  | Each role lands on a healthy, non-blank page with a clean console | yes |
| `tests/crawl.spec.ts`  | Breadth-first walk of every in-app link per role; reports dead ends / errors | yes |
| `tests/verify.spec.ts` | Public verify page resolves the known record ids/hashes without erroring | no |

The crawl is **read-only** — it navigates and follows links, it does not submit
forms or mutate data. It skips `logout` links so it doesn't kill its own session.

## Setup

```bash
cd civic-chin-e2e
npm install
npx playwright install chromium     # first time only
cp .env.example .env                 # then edit BASE_URL + creds
```

Point `BASE_URL` at wherever the app is served (a localhost port on your laptop,
or the app host).

## Run

```bash
# 1. Capture a signed-in session per role (reused by the specs)
npm run auth

# 2a. Everything, headless
npm test

# 2b. Watch it drive (headed) — this is the "screen driver" view
npm run test:headed

# 2c. Interactive UI mode, pick/inspect individual walks
npm run test:ui

# Just the crawler, wider budget:
CRAWL_MAX=80 npx playwright test crawl

# Open the last HTML report (per-role problem lists attached)
npm run report
```

## "You sign in, I drive"

If you'd rather sign in yourself than put passwords in `.env`:

```bash
npx playwright open $BASE_URL          # sign in by hand in the window that opens
# then save the session it captured:
#   in that window's console:  await context.storageState({ path: '.auth/muniAdmin.json' })
```

Any `.auth/<role>.json` that already exists is reused, so the specs pick up your
hand-made session and skip the login step entirely.

## Adjusting selectors

Login/verify selectors are resilient best-effort (label → placeholder → role →
name attribute). If a page differs, lock exact locators fast:

```bash
npm run codegen        # opens the app, records your clicks into copy-pasteable code
```

Paste the recorded locators over the fallbacks in `helpers/login.ts` /
`tests/verify.spec.ts`.

## Notes

- `.env` and `.auth/` are gitignored — sessions and secrets stay local.
- `KEY_PASSPHRASE` + the `*.enc` key backups are only needed if you later add a
  signing step; there's no decrypt helper committed because the backups use the
  app's own (non-standard) encryption format — wire it in once that format is known.
