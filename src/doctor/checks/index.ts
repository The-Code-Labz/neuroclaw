// Side-effect imports — each module registers itself with the registry on load.
// Order is informational only; runner.ts uses listChecks() which preserves
// registration order, so this file controls the default display order.

import './discord-placeholders';
import './alert-dispatcher-targets';
import './voidai-rate-limit-state';
import './forge-mount-paths';
import './kimi-context-budget';
import './mcp-build-stamps';
