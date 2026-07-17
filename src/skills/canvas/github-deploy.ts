/**
 * Deploy a self-contained HTML artifact (Canvas design / Game / WebApp) to a
 * GitHub repository, entirely over the GitHub REST API — no local git clone,
 * no working tree. The PAT is resolved from the broker (SHARED_GITHUB_PAT) and
 * never persisted to disk or a git config.
 *
 * Flow: resolve owner → create (or reuse) repo → commit index.html (+README) →
 * optionally enable GitHub Pages so the artifact is instantly live.
 */
import { broker } from '../../broker';
import { logger } from '../../utils/logger';

const GH_API = 'https://api.github.com';

export interface DeployResult {
  repoUrl:   string;
  owner:     string;
  repo:      string;
  pagesUrl?: string;
  created:   boolean;   // true = new repo, false = updated an existing one
}

/** Normalize a user-supplied repo name to GitHub's allowed charset. */
export function sanitizeRepoName(name: string): string {
  const cleaned = (name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')   // GitHub allows [A-Za-z0-9._-]
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);
  return cleaned || `neuroclaw-artifact-${Date.now()}`;
}

async function gh(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${GH_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'neuroclaw-studio',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json: any = null;
  try { json = await res.json(); } catch { /* 204 / empty */ }
  return { status: res.status, json };
}

/**
 * Deploy the given HTML as `index.html` in a GitHub repo.
 * @throws Error with a clear message on any GitHub API failure.
 */
export async function deployHtmlToGithub(opts: {
  html: string;
  repoName: string;
  title?: string;
  description?: string;
  isPrivate?: boolean;
  enablePages?: boolean;
}): Promise<DeployResult> {
  const html = opts.html || '';
  if (!html.trim()) throw new Error('nothing to deploy — the artifact is empty');
  const repo = sanitizeRepoName(opts.repoName);
  const isPrivate = opts.isPrivate !== false;   // default private (safe)
  // Pages can only serve from a PUBLIC repo on free plans → force public if Pages.
  const wantPages = !!opts.enablePages;
  const priv = wantPages ? false : isPrivate;
  const description = (opts.description || opts.title || 'Built with NeuroClaw Studio').slice(0, 200);

  return broker.withSecrets(['SHARED_GITHUB_PAT'], async (env) => {
    const token = env['SHARED_GITHUB_PAT'];
    if (!token) throw new Error('SHARED_GITHUB_PAT not resolvable from broker');

    // 1) owner
    const me = await gh(token, 'GET', '/user');
    if (me.status !== 200 || !me.json?.login) {
      throw new Error(`GitHub auth failed (${me.status}) — check SHARED_GITHUB_PAT scope (needs "repo")`);
    }
    const owner: string = me.json.login;

    // 2) create repo (or reuse if it already exists)
    let created = true;
    const mk = await gh(token, 'POST', '/user/repos', {
      name: repo, description, private: priv, auto_init: true,
      has_issues: false, has_projects: false, has_wiki: false,
    });
    if (mk.status === 201) {
      created = true;
    } else if (mk.status === 422) {
      // Name already taken on this account → reuse it (redeploy).
      const existing = await gh(token, 'GET', `/repos/${owner}/${repo}`);
      if (existing.status !== 200) {
        throw new Error(`repo "${repo}" already exists but is not accessible (${existing.status})`);
      }
      created = false;
    } else {
      const msg = mk.json?.message || `HTTP ${mk.status}`;
      throw new Error(`could not create repo "${repo}": ${msg}`);
    }

    const defaultBranch: string = (created ? mk.json?.default_branch : undefined) || 'main';
    const contentB64 = Buffer.from(html, 'utf8').toString('base64');

    // 3) commit index.html (fetch sha first if it already exists → update)
    let sha: string | undefined;
    const cur = await gh(token, 'GET', `/repos/${owner}/${repo}/contents/index.html?ref=${encodeURIComponent(defaultBranch)}`);
    if (cur.status === 200 && cur.json?.sha) sha = cur.json.sha;
    const put = await gh(token, 'PUT', `/repos/${owner}/${repo}/contents/index.html`, {
      message: created ? 'Deploy from NeuroClaw Studio' : 'Update from NeuroClaw Studio',
      content: contentB64,
      branch: defaultBranch,
      ...(sha ? { sha } : {}),
    });
    if (put.status !== 200 && put.status !== 201) {
      throw new Error(`failed to commit index.html: ${put.json?.message || 'HTTP ' + put.status}`);
    }

    const result: DeployResult = {
      repoUrl: `https://github.com/${owner}/${repo}`,
      owner, repo, created,
    };

    // 4) optionally enable GitHub Pages (public repos only)
    if (wantPages) {
      const pg = await gh(token, 'POST', `/repos/${owner}/${repo}/pages`, {
        source: { branch: defaultBranch, path: '/' },
      });
      // 201 = enabled now; 409 = already enabled. Either way Pages will serve.
      if (pg.status === 201 || pg.status === 409) {
        result.pagesUrl = `https://${owner}.github.io/${repo}/`;
      } else {
        logger.warn('github-deploy: Pages enable failed (repo still deployed)', { status: pg.status, msg: pg.json?.message });
      }
    }

    logger.info('github-deploy: deployed', { repo: `${owner}/${repo}`, created, pages: !!result.pagesUrl });
    return result;
  });
}
