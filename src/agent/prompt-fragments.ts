// Shared, dependency-free prompt fragments appended to BOTH main-agent stable
// prompts (alfred.ts) and sub-agent tool notes (sub-agent-runner.ts). Keeping
// them here (no imports) avoids a circular dependency on alfred.ts and keeps
// the strings deterministic so they live happily inside the prompt-cache prefix.

/**
 * Research discipline: exhaust the tool ladder before telling the user you
 * couldn't find something. Added after a real incident where an agent, faced
 * with a blocked web_search, gave up and repeatedly asked the user to supply
 * facts it could have researched — while perplexity / deep_research were up the
 * whole time. Names the tools explicitly so the model reaches for them by name
 * via call_tool instead of relying on discovery.
 */
export const RESEARCH_DISCIPLINE =
  '\n\n## Research discipline — work the ladder before giving up\n' +
  'NEVER tell the user you "could not find" something, ask them to supply facts you could look up, or fall back to ' +
  'your own training data as if it were verified — until you have actually worked the research ladder below. A tool ' +
  'returning nothing, junk, or an error is a signal to try the NEXT rung, not to stop. Use ' +
  '`search_tools`/`get_tool_schema`/`call_tool` to reach any of these by name:\n' +
  '1. `web_search` — live web. It already self-escalates internally (Brave API → SearXNG → headless browser), so a ' +
  '0-result here means the open web genuinely refused; move on, do not retry it verbatim.\n' +
  '2. `perplexity_search` / `perplexity_research` — answer a synthesized question directly (best for "list/compare/' +
  'who-is" questions). Usually the fastest path when web_search is thin.\n' +
  '3. `deep_research`, `crawl4ai`, `web_research`, or `gemini_web` / `grok_web` — deeper multi-source synthesis.\n' +
  '4. `browser_agent` (or `browserless_fetch`) — open a specific known source URL and read it, when you need one page.\n' +
  'Only after rungs 1–4 genuinely come up empty may you tell the user you could not find it — and then say exactly ' +
  'which tools you tried and what each returned, never a bare "I couldn\'t find it."\n' +
  'This applies to identification too (e.g. naming what is in an image): describe what you can observe, then RESEARCH ' +
  'the identification with the ladder above. Do not repeatedly ask the user to name things you can verify yourself.';
