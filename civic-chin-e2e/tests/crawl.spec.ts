import { test, expect } from '../helpers/fixtures';
import { crawl } from '../helpers/crawl';
import { watchForProblems, looksLikeErrorPage } from '../helpers/errors';
import { BASE_URL } from '../playwright.config';
import type { Role } from '../helpers/accounts';

const origin = new URL(BASE_URL).origin;

/**
 * The screen driver. For each role: sign in, then breadth-first walk every
 * in-app link, capturing dead ends, blank pages, console errors, JS crashes,
 * and 4xx/5xx responses. Read-only — it navigates and clicks links, it does not
 * submit forms or mutate data.
 *
 * Results are attached to the HTML report per role. Set CRAWL_MAX to change the
 * page budget (default 40).
 */
const maxPages = Number(process.env.CRAWL_MAX ?? 40);
const roles: Role[] = ['civicAdmin', 'muniAdmin', 'acmeAdmin', 'tyrellAdmin'];

for (const role of roles) {
  test(`crawl: ${role}`, async ({ asRole }, testInfo) => {
    test.slow(); // crawling many pages takes a while
    const page = await asRole(role);
    const { problems: runtime } = watchForProblems(page, origin);

    const result = await crawl(page, origin, {
      maxPages,
      checkRendered: () => looksLikeErrorPage(page),
    });

    const report = {
      role,
      pagesVisited: result.visited.length,
      navigationProblems: result.problems,
      runtimeProblems: runtime,
    };
    await testInfo.attach(`crawl-${role}.json`, {
      body: JSON.stringify(report, null, 2),
      contentType: 'application/json',
    });

    console.log(
      `\n[${role}] visited ${result.visited.length} pages, ` +
        `${result.problems.length} navigation/render problems, ` +
        `${runtime.length} console/network problems`
    );
    for (const p of result.problems) console.log(`  DEAD END  ${p.url}  <- ${p.from}  (${p.reason})`);
    for (const p of runtime) console.log(`  RUNTIME   [${p.type}] ${p.url}  ${p.detail}`);

    // The crawl is a report, not a gate — but a JS crash or a 5xx is a hard fail.
    const hardFails = [
      ...result.problems.filter((p) => /threw|navigation 5\d\d/.test(p.reason)),
      ...runtime.filter((p) => p.type === 'pageerror' || /^5\d\d/.test(p.detail)),
    ];
    expect(hardFails, `hard failures found:\n${JSON.stringify(hardFails, null, 2)}`).toHaveLength(0);
  });
}
