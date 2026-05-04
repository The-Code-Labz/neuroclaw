// Zod schemas for every tool input. Single source of truth — OpenAI shape
// derives JSON Schema from these (zod-to-json-schema), Claude SDK's tool()
// helper accepts the raw zod shape, MCP server returns derived JSON Schema.

import { z } from 'zod';

export const searchMemoryShape = {
  query: z.string().describe('What to look up (2-8 keywords).'),
  limit: z.number().int().min(1).max(50).optional().describe('Max hits (default 20).'),
};
export const searchMemorySchema = z.object(searchMemoryShape);

export const searchVaultShape = {
  query: z.string(),
  limit: z.number().int().min(1).max(50).optional(),
  vault: z.string().optional().describe('Vault name (defaults to NEUROVAULT_DEFAULT_VAULT).'),
};
export const searchVaultSchema = z.object(searchVaultShape);

export const writeVaultNoteShape = {
  title:      z.string().describe('4-8 words.'),
  type:       z.string().describe('episodic | semantic | procedural | preference | insight | project | session_summary'),
  summary:    z.string().describe('1-2 sentence distilled lesson.'),
  content:    z.string().optional().describe('Optional richer body.'),
  tags:       z.array(z.string()).optional(),
  importance: z.number().min(0).max(1).optional().describe('0-1, default 0.7.'),
};
export const writeVaultNoteSchema = z.object(writeVaultNoteShape);

export const saveSessionSummaryShape = {
  summary:    z.string().describe('Distilled summary of what happened in the session.'),
  title:      z.string().optional(),
  tags:       z.array(z.string()).optional(),
  importance: z.number().min(0).max(1).optional(),
};
export const saveSessionSummarySchema = z.object(saveSessionSummaryShape);

export const compactContextShape = {
  conversation: z.string().describe('Serialized recent turns to compact.'),
};
export const compactContextSchema = z.object(compactContextShape);

export const messageAgentShape = {
  to:      z.string().describe('Name of the agent to message.'),
  message: z.string(),
  context: z.string().optional(),
};
export const messageAgentSchema = z.object(messageAgentShape);

export const assignTaskShape = {
  to:          z.string().describe('Agent name to assign the task to.'),
  title:       z.string(),
  description: z.string().optional(),
  priority:    z.number().min(0).max(100).optional(),
  execute_now: z.boolean().optional().describe('Run immediately and return the result.'),
};
export const assignTaskSchema = z.object(assignTaskShape);

export const listAgentsShape = {
  include_inactive: z.boolean().optional(),
  include_temp:     z.boolean().optional(),
};
export const listAgentsSchema = z.object(listAgentsShape);

export const spawnAgentShape = {
  name:            z.string().describe('Unique name for the temporary agent.'),
  role:            z.string().describe('Role tag, e.g. "specialist", "analyst".'),
  description:     z.string().describe('One-line description.'),
  systemPrompt:    z.string().describe('Full system prompt for the spawn.'),
  taskDescription: z.string().describe('The specific task the spawn should execute now.'),
  capabilities:    z.array(z.string()).optional(),
  modelTier:       z.enum(['pinned','auto','low','mid','high']).optional(),
  model:           z.string().optional(),
};
export const spawnAgentSchema = z.object(spawnAgentShape);

export const listTempAgentsShape = {} as Record<string, never>;
export const listTempAgentsSchema = z.object(listTempAgentsShape);

export const logHandoffShape = {
  from:    z.string(),
  to:      z.string(),
  summary: z.string(),
};
export const logHandoffSchema = z.object(logHandoffShape);

export const createCheckpointShape = {
  summary: z.string(),
};
export const createCheckpointSchema = z.object(createCheckpointShape);

export const getContextPackShape = {} as Record<string, never>;
export const getContextPackSchema = z.object(getContextPackShape);

export const bashRunShape = {
  command:    z.string().describe('Full shell command (bash -lc).'),
  cwd:        z.string().optional(),
  timeout_ms: z.number().int().optional(),
};
export const bashRunSchema = z.object(bashRunShape);

export const fsReadShape  = { path: z.string() };
export const fsReadSchema = z.object(fsReadShape);

export const fsWriteShape = {
  path:    z.string(),
  content: z.string(),
  mode:    z.enum(['create','overwrite','append']).optional(),
};
export const fsWriteSchema = z.object(fsWriteShape);

export const fsListShape  = { path: z.string() };
export const fsListSchema = z.object(fsListShape);

export const fsSearchShape = {
  pattern:     z.string(),
  path:        z.string().optional(),
  max_results: z.number().int().optional(),
};
export const fsSearchSchema = z.object(fsSearchShape);

// ── Discord channel setup (agent self-setup, OpenClaw-style) ───────────────

export const discordRegisterBotShape = {
  name:           z.string().describe('Display name for this bot configuration (e.g. "Coder Bot", "Team Server").'),
  token:          z.string().describe('Discord bot token from the Developer Portal. Sensitive — never echo it back to the user.'),
  default_agent:  z.string().optional().describe('Agent name or id that handles mentions when no per-channel route matches.'),
  application_id: z.string().optional().describe('Optional Discord application id (skips a startup REST call when set).'),
};
export const discordRegisterBotSchema = z.object(discordRegisterBotShape);

export const discordAddRouteShape = {
  bot_id:          z.string().describe('Discord bot id (from discord_list_bots).'),
  channel_id:      z.string().describe('Discord channel id (right-click channel → Copy ID with Developer Mode on).'),
  agent:           z.string().describe('Agent name or id to handle messages in this channel.'),
  require_mention: z.boolean().optional().describe('When true, override any guild-level auto-reply for this specific channel — bot will only respond to @mentions here, even if the server is otherwise on auto-reply. Useful when multiple bots share a server.'),
};
export const discordAddRouteSchema = z.object(discordAddRouteShape);

export const discordListBotsShape = {} as Record<string, never>;
export const discordListBotsSchema = z.object(discordListBotsShape);

export const discordRemoveBotShape = {
  bot_id: z.string(),
};
export const discordRemoveBotSchema = z.object(discordRemoveBotShape);

export const discordSetAutoReplyShape = {
  bot_id:    z.string().describe('Discord bot id (from discord_list_bots).'),
  guild_ids: z.array(z.string()).describe('Array of Discord guild (server) ids where the bot should respond to every non-bot message without requiring an @mention. Empty array disables auto-reply everywhere.'),
};
export const discordSetAutoReplySchema = z.object(discordSetAutoReplyShape);

export const discordListGuildsShape = {
  bot_id: z.string(),
};
export const discordListGuildsSchema = z.object(discordListGuildsShape);

export const discordReactShape = {
  bot_id:             z.string().describe('Discord bot id (from discord_list_bots).'),
  channel_id:         z.string().describe('Discord channel id where the message lives.'),
  emoji:              z.string().describe('Emoji to react with — unicode like "👍" "🔥" "❤️", or custom guild emoji as <:name:id>.'),
  message_id:         z.string().optional().describe('Specific message id to react to. Right-click message → Copy ID with Developer Mode on.'),
  last_user_message:  z.boolean().optional().describe('If true and message_id is omitted, react to the most recent non-bot message in the channel. Convenient for "react to what the user just said".'),
};
export const discordReactSchema = z.object(discordReactShape);

// ── Audio (TTS + STT) self-setup tools ───────────────────────────────────
// Let agents configure voice in conversation: pick a provider + voice for an
// agent, flip the per-bot voice toggle, and inspect current state. Designed
// so a user can say "set me up with voice" and the agent walks them through.

export const audioListVoicesShape = {
  provider: z.enum(['voidai', 'elevenlabs']).optional().describe('Filter to one provider. Omit to get both. ElevenLabs is empty unless ELEVENLABS_API_KEY is configured.'),
};
export const audioListVoicesSchema = z.object(audioListVoicesShape);

export const audioStatusShape = {
  agent: z.string().optional().describe('Optional agent name or id to inspect. When omitted, returns voice config for ALL agents that have TTS on, plus the voice toggle for every Discord bot.'),
};
export const audioStatusSchema = z.object(audioStatusShape);

export const audioConfigureAgentShape = {
  agent:    z.string().describe('Agent name or id to configure.'),
  enabled:  z.boolean().describe('Turn TTS on or off for this agent. When off, the speaker button is hidden in the dashboard and Discord skips the audio attachment.'),
  provider: z.enum(['voidai', 'elevenlabs']).optional().describe('TTS backend. Defaults to voidai when first enabling. ElevenLabs requires ELEVENLABS_API_KEY.'),
  voice:    z.string().optional().describe('Voice id for the chosen provider. VoidAI: alloy / echo / fable / onyx / nova / shimmer. ElevenLabs: a voice_id from audio_list_voices. Pass empty string to clear and use the env default.'),
};
export const audioConfigureAgentSchema = z.object(audioConfigureAgentShape);

export const audioConfigureDiscordBotShape = {
  bot:     z.string().describe('Discord bot name or id (from discord_list_bots).'),
  enabled: z.boolean().describe('Master switch for whether this bot attaches synthesized .mp3s to its replies. Inbound voice transcription always works regardless of this flag.'),
};
export const audioConfigureDiscordBotSchema = z.object(audioConfigureDiscordBotShape);

export const discordSetUserVoiceShape = {
  bot_id:  z.string().describe('Discord bot id (from the system context — "bot_id" in your Discord context block).'),
  user_id: z.string().describe('Discord user id of the person whose preference you are setting (the "author id" in your context block).'),
  enabled: z.boolean().describe('Whether this user should receive .mp3 audio attachments on replies from this bot. Pass false when the user asks you to stop sending audio / voice / mp3s; pass true to re-enable.'),
  reason:  z.string().optional().describe('Short note for the audit log explaining why the toggle was flipped. Optional but recommended.'),
};
export const discordSetUserVoiceSchema = z.object(discordSetUserVoiceShape);

// ── Archon port (v1.9): projects + tasks find_/manage_ tools ─────────────
// Signatures match the external Archon MCP byte-for-byte so prompts in
// CLAUDE.md and existing agent system prompts that reference find_tasks /
// manage_task / find_projects / manage_project keep working unchanged after
// the external Archon MCP is removed from settings.

export const findProjectsShape = {
  query:      z.string().optional().describe('Keyword search across project title + description (case-insensitive).'),
  project_id: z.string().optional().describe('Get a specific project by id; returns full record including docs/features/data.'),
  include_archived: z.boolean().optional().describe('Include archived projects in the result. Default false.'),
  page:       z.number().int().optional().describe('1-based page number. Default 1.'),
  per_page:   z.number().int().optional().describe('Items per page. Default 10, max 100.'),
};
export const findProjectsSchema = z.object(findProjectsShape);

export const manageProjectShape = {
  action:      z.enum(['create', 'update', 'delete']).describe('"create" | "update" | "delete". Delete is soft (archive) by default.'),
  project_id:  z.string().optional().describe('Project id; required for update/delete.'),
  title:       z.string().optional().describe('Display title (required on create).'),
  description: z.string().optional().describe('Goals and scope.'),
  github_repo: z.string().optional().describe('GitHub repo URL.'),
  pinned:      z.boolean().optional().describe('Pin to top of project list.'),
  hard:        z.boolean().optional().describe('On delete: when true, permanently remove the row instead of archiving. Tasks are reassigned to the default NeuroClaw project. Cannot delete the default project.'),
  docs:        z.unknown().optional().describe('JSON array. Optional. Replaces existing docs.'),
  features:    z.unknown().optional().describe('JSON array. Optional. Replaces existing features.'),
  data:        z.unknown().optional().describe('JSON object. Optional. Replaces existing data.'),
};
export const manageProjectSchema = z.object(manageProjectShape);

export const findTasksShape = {
  query:        z.string().optional().describe('Keyword search across title + description.'),
  task_id:      z.string().optional().describe('Get a specific task by id (returns full record including sources + code_examples).'),
  filter_by:    z.enum(['status', 'project', 'assignee', 'parent']).optional().describe('Field to filter on. Pair with filter_value.'),
  filter_value: z.string().optional().describe('Value for the chosen filter — status name, project id, assignee string, or parent task id.'),
  project_id:   z.string().optional().describe('Restrict to a single project (in addition to filter_by). Often used with filter_by=status.'),
  include_closed: z.boolean().optional().describe('Include archived/done tasks. Default true (matches Archon\'s default).'),
  page:         z.number().int().optional().describe('1-based page number. Default 1.'),
  per_page:     z.number().int().optional().describe('Items per page. Default 10, max 100.'),
};
export const findTasksSchema = z.object(findTasksShape);

export const manageTaskShape = {
  action:        z.enum(['create', 'update', 'delete']).describe('"create" | "update" | "delete". Delete archives the task by default (use hard=true to remove).'),
  task_id:       z.string().optional().describe('Task id; required for update/delete.'),
  project_id:    z.string().optional().describe('Project id (required on create unless using default project).'),
  parent_task_id: z.string().optional().describe('Parent task id for subtasks.'),
  title:         z.string().optional().describe('Task title (required on create).'),
  description:   z.string().optional().describe('Detailed task description with completion criteria.'),
  status:        z.enum(['todo', 'doing', 'review', 'done']).optional().describe('Workflow status.'),
  assignee:      z.string().optional().describe('Free-text assignee. Accepts agent names, "User", "AI IDE Agent", or anything else. Defaults to "User" on create.'),
  priority_level: z.enum(['low', 'medium', 'high', 'critical']).optional().describe('Priority enum used by the Kanban UI.'),
  task_order:    z.number().int().optional().describe('Drag-reorder position within the (status) column. Lower numbers float up.'),
  feature:       z.string().optional().describe('Free-text feature label that cuts across projects (e.g. "auth", "billing").'),
  sources:       z.unknown().optional().describe('JSON array of citations. Each entry typically {url, title, relevance}. Hooks NeuroVault retrievals onto the task.'),
  code_examples: z.unknown().optional().describe('JSON array of code snippet references. Each entry typically {file, line, summary}.'),
  hard:          z.boolean().optional().describe('On delete: when true, permanently remove. Default false (archive).'),
};
export const manageTaskSchema = z.object(manageTaskShape);

// ── Skills v2: scoped script execution + agent-authored skills ───────────
// Skills now ship optional executable scripts (Python / Bash / Node / TS) under
// .claude/skills/<name>/scripts/. Any active agent can run them via
// run_skill_script. Agents can also author new skills end-to-end with
// manage_skill / manage_skill_script — useful when an MCP server is too heavy
// for a one-off API integration. New skills land in the project's .claude/skills/
// folder and become immediately visible to every agent.

export const runSkillScriptShape = {
  skill_name: z.string().describe('Name of the skill that owns the script (must already exist; create one with manage_skill first).'),
  script:     z.string().describe('Filename of the script inside that skill\'s scripts/ folder, e.g. "extract.py". Single segment — no path components.'),
  args:       z.array(z.string()).optional().describe('Argv passed to the script. Each element is one CLI argument; no shell interpolation.'),
  stdin:      z.string().optional().describe('Optional input piped to the script\'s stdin (capped at 1 MB).'),
  cwd:        z.string().optional().describe('Working directory for the script. Defaults to the script\'s folder.'),
  timeout_ms: z.number().int().optional().describe('Hard timeout in ms. Capped at 2× EXEC_TIMEOUT_MS.'),
};
export const runSkillScriptSchema = z.object(runSkillScriptShape);

export const manageSkillShape = {
  action:      z.enum(['create', 'update', 'delete']).describe('"create" | "update" | "delete". Skills must live in the project (.claude/skills/) to be edited or deleted; user-global skills are read-only.'),
  name:        z.string().describe('Skill name. On create: sanitized to lowercase + dashes. On update/delete: must match an existing skill.'),
  description: z.string().optional().describe('One-line summary the agent\'s system prompt will display.'),
  body:        z.string().optional().describe('Markdown body — instructions to the agent on when/how to use the skill. Required on create.'),
  triggers:    z.array(z.string()).optional().describe('Keywords or phrases that hint when the skill applies. Currently informational (no auto-routing).'),
  tools:       z.array(z.string()).optional().describe('Allowed tool names — informational metadata for now.'),
  scripts:     z.array(z.object({
    filename: z.string(),
    content:  z.string(),
  })).optional().describe('Optional list of scripts to bundle on create. Each {filename, content} writes to scripts/<filename>. Use manage_skill_script to add later.'),
};
export const manageSkillSchema = z.object(manageSkillShape);

export const manageSkillScriptShape = {
  action:     z.enum(['create', 'update', 'delete']).describe('"create" | "update" | "delete". create and update use the same code path (writeSkillScript) — both overwrite if present.'),
  skill_name: z.string().describe('Skill that owns the script.'),
  filename:   z.string().describe('Single-segment filename, e.g. "extract.py", "transform.sh". Validated against [a-zA-Z0-9_.-].'),
  content:    z.string().optional().describe('Full file contents. Required on create/update.'),
};
export const manageSkillScriptSchema = z.object(manageSkillScriptShape);

export const listSkillsShape = {
  include_body: z.boolean().optional().describe('When true, return each skill\'s full markdown body. Default false (just metadata + scripts list).'),
};
export const listSkillsSchema = z.object(listSkillsShape);
