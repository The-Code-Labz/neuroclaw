// Brave Search API client — the datacenter-resilient PRIMARY backend for the
// web_search tool. Unlike SearXNG's scraper engines (which get CAPTCHA'd /
// rate-limited from datacenter IPs) this is an official JSON API keyed by a
// subscription token, so it isn't bot-challenged. Gated by config.brave.enabled
// (presence of BRAVE_SEARCH_API_KEY). Free tier covers 2,000 queries/month.
//
// Docs: https://api-dashboard.search.brave.com/app/documentation/web-search

import { config } from '../config';

export interface WebResult {
  title:      string;
  url:        string;
  snippet:    string;
  engine:     string;
  published?: string;
}

// Our time_range enum → Brave `freshness` codes (past day/month/year).
const FRESHNESS: Record<string, string> = { day: 'pd', month: 'pm', year: 'py' };

/**
 * Query the Brave Search API and return normalised {title,url,snippet} rows.
 * Throws on HTTP error (caller falls through to the SearXNG ladder); returns
 * [] when Brave is unconfigured or genuinely has no results.
 */
export async function braveSearch(
  query: string,
  opts: { count?: number; timeRange?: string } = {},
): Promise<WebResult[]> {
  if (!config.brave.enabled) return [];
  const { apiKey, baseUrl, timeoutMs } = config.brave;

  const params = new URLSearchParams({ q: query, count: String(Math.min(opts.count ?? 8, 20)) });
  if (opts.timeRange && FRESHNESS[opts.timeRange]) params.set('freshness', FRESHNESS[opts.timeRange]);

  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/web/search?${params.toString()}`, {
    signal:  AbortSignal.timeout(timeoutMs),
    headers: {
      'Accept':              'application/json',
      'Accept-Encoding':     'gzip',
      'X-Subscription-Token': apiKey,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Brave Search HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = await res.json() as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (data?.web?.results ?? []) as any[];
  return rows.map(r => ({
    title:   r.title ?? '',
    // Brave highlights matched terms with <strong> tags in title/description.
    url:     r.url ?? '',
    snippet: typeof r.description === 'string' ? r.description.replace(/<[^>]+>/g, '').slice(0, 300) : '',
    engine:  'brave-api',
    ...(r.page_age ? { published: r.page_age } : {}),
  })).filter(r => r.title && r.url);
}
