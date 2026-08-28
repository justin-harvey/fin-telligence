import { Page } from '@playwright/test';

export interface CrawlProblem { url: string; from: string; reason: string; }
export interface CrawlResult {
  visited: string[];
  problems: CrawlProblem[];
}

/** Normalize a URL to same-origin path for dedupe; return null if off-site/unwanted. */
function keep(href: string, origin: string): string | null {
  let u: URL;
  try { u = new URL(href, origin); } catch { return null; }
  if (u.origin !== origin) return null;                 // stay on this app
  if (/^(mailto|tel|javascript):/i.test(href)) return null;
  if (/\.(pdf|zip|csv|png|jpe?g|svg|gif|woff2?)($|\?)/i.test(u.pathname)) return null;
  if (/\/(logout|signout|sign-out)\b/i.test(u.pathname)) return null; // don't kill our session
  u.hash = '';
  return u.pathname + u.search;
}

/**
 * Breadth-first crawl of in-app links starting from the current page.
 * Pure navigation + link discovery — it does not submit forms or mutate data.
 *
 * `checkRendered` is invoked after each page settles and should return a reason
 * string if the page looks broken (dead end / blank / error), else null. The
 * crawl records those into `result.problems` itself, so callers never touch a
 * half-built result object.
 */
export async function crawl(
  page: Page,
  origin: string,
  opts: {
    maxPages?: number;
    checkRendered?: (path: string) => Promise<string | null>;
  } = {}
): Promise<CrawlResult> {
  const maxPages = opts.maxPages ?? 40;
  const start = keep(page.url(), origin) ?? '/';
  const queue: { path: string; from: string }[] = [{ path: start, from: '(start)' }];
  const seen = new Set<string>([start]);
  const result: CrawlResult = { visited: [], problems: [] };

  while (queue.length && result.visited.length < maxPages) {
    const { path, from } = queue.shift()!;
    try {
      const resp = await page.goto(origin + path, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle').catch(() => {});
      result.visited.push(path);
      if (resp && resp.status() >= 400) {
        result.problems.push({ url: path, from, reason: `navigation ${resp.status()}` });
      }
      if (opts.checkRendered) {
        const bad = await opts.checkRendered(path);
        if (bad) result.problems.push({ url: path, from: '(rendered)', reason: bad });
      }

      // discover more links
      const hrefs = await page.locator('a[href]').evaluateAll((as) =>
        as.map((a) => (a as HTMLAnchorElement).getAttribute('href') || '')
      );
      for (const h of hrefs) {
        const norm = keep(h, origin);
        if (norm && !seen.has(norm)) {
          seen.add(norm);
          queue.push({ path: norm, from: path });
        }
      }
    } catch (e) {
      result.problems.push({ url: path, from, reason: `threw: ${(e as Error).message}` });
    }
  }
  return result;
}
