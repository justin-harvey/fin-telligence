import { Page, TestInfo } from '@playwright/test';

export interface PageProblem {
  type: 'console' | 'pageerror' | 'response';
  url: string;      // page where it happened
  detail: string;   // message / failing request
}

/**
 * Attaches listeners that record the classes of failure a smoke crawl cares
 * about: uncaught JS errors, console.error output, and HTTP responses >= 400
 * for same-origin requests (ignores analytics/third-party noise).
 *
 * Returns a live array you can inspect after navigation, plus a detach fn.
 */
export function watchForProblems(page: Page, origin: string) {
  const problems: PageProblem[] = [];

  const onConsole = (msg: import('@playwright/test').ConsoleMessage) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    // Filter well-known noise that isn't an app defect.
    if (/favicon|ResizeObserver loop|Download the React DevTools/i.test(text)) return;
    problems.push({ type: 'console', url: page.url(), detail: text });
  };

  const onPageError = (err: Error) => {
    problems.push({ type: 'pageerror', url: page.url(), detail: `${err.name}: ${err.message}` });
  };

  const onResponse = (res: import('@playwright/test').Response) => {
    if (res.status() < 400) return;
    if (!res.url().startsWith(origin)) return; // same-origin only
    if (/\.(png|jpg|jpeg|svg|gif|ico|woff2?)($|\?)/i.test(res.url())) return;
    problems.push({ type: 'response', url: page.url(), detail: `${res.status()} ${res.url()}` });
  };

  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  page.on('response', onResponse);

  const detach = () => {
    page.off('console', onConsole);
    page.off('pageerror', onPageError);
    page.off('response', onResponse);
  };

  return { problems, detach };
}

/** Heuristic: does the rendered page look like an error / dead end? */
export async function looksLikeErrorPage(page: Page): Promise<string | null> {
  const body = (await page.locator('body').innerText().catch(() => '')) ?? '';
  const patterns: [RegExp, string][] = [
    [/\b404\b|not found/i, 'looks like 404'],
    [/\b500\b|internal server error/i, 'looks like 500'],
    [/something went wrong|unexpected error|application error/i, 'generic error text'],
    [/access denied|permission denied|forbidden|unauthorized/i, 'access denied'],
    [/cannot read propert(y|ies) of (undefined|null)/i, 'unhandled JS error text'],
  ];
  for (const [re, why] of patterns) if (re.test(body)) return why;
  // Blank / near-empty main content is a dead end too.
  if (body.trim().length < 20) return 'page is essentially blank';
  return null;
}

export async function attachProblems(testInfo: TestInfo, name: string, problems: PageProblem[]) {
  if (problems.length === 0) return;
  await testInfo.attach(name, {
    body: JSON.stringify(problems, null, 2),
    contentType: 'application/json',
  });
}
