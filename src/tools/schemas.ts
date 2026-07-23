// Zod schemas for every tool input. Single source of truth — OpenAI shape
// derives JSON Schema from these (zod-to-json-schema), Claude SDK's tool()
// helper accepts the raw zod shape, MCP server returns derived JSON Schema.

import { z } from 'zod';

export const searchMemoryShape = {
  query: z.string().describe('What to look up (2-8 keywords).'),
  limit: z.number().int().min(1).max(50).optional().describe('Max hits (default 20).'),
};
export const searchMemorySchema = z.object(searchMemoryShape);

// ── Shared Notepad (agent_notes) ────────────────────────────────────────────
export const writeNoteShape = {
  title:   z.string().describe('Short title for the note (shown in the Notes tab list).'),
  content: z.string().describe('The note body in Markdown. No length limit — use this to hand the user a long, continuous document instead of a truncated Discord message.'),
  pinned:  z.boolean().optional().describe('Pin to the top of the Notes list. Default false.'),
};
export const writeNoteSchema = z.object(writeNoteShape);

export const appendNoteShape = {
  note_id: z.string().optional().describe('Id of the note to append to (from list_notes). Preferred when known.'),
  title:   z.string().optional().describe('Title of the note to append to. If no note with this title exists it is created. Use this to keep building ONE continuous note across turns.'),
  content: z.string().describe('Markdown to append to the end of the note.'),
  attribution: z.boolean().optional().describe('Insert a "— author · timestamp" divider before this block. Default true; set false to append seamlessly into one flowing document.'),
};
export const appendNoteSchema = z.object(appendNoteShape);

export const listNotesShape = {
  include_archived: z.boolean().optional().describe('Include archived notes. Default false.'),
};
export const listNotesSchema = z.object(listNotesShape);

export const readNoteShape = {
  note_id: z.string().optional().describe('Id of the note to read (from list_notes).'),
  title:   z.string().optional().describe('Exact title of the note to read (alternative to note_id).'),
};
export const readNoteSchema = z.object(readNoteShape);

// ── Media gallery (agent_media) ─────────────────────────────────────────────
export const registerMediaShape = {
  url:    z.string().optional().describe('Remote https URL of the generated media to store (e.g. an image/video/audio link returned by a generation tool). Provide this OR base64.'),
  base64: z.string().optional().describe('Base64 (or data: URL) of the media bytes. Provide this OR url.'),
  kind:   z.enum(['image', 'video', 'audio']).optional().describe('Media kind. If omitted it is inferred from the MIME type.'),
  title:  z.string().optional().describe('Short human label shown in the Media gallery card.'),
  prompt: z.string().optional().describe('The prompt or description that produced this media.'),
  mime_type:   z.string().optional().describe('MIME type, e.g. image/png, video/mp4, audio/mpeg. Inferred from the source when omitted.'),
  source_tool: z.string().optional().describe('Which tool/model produced it, e.g. voidai_image, chatgpt_image.'),
};
export const registerMediaSchema = z.object(registerMediaShape);

export const listMediaShape = {
  kind:  z.enum(['image', 'video', 'audio']).optional().describe('Filter to one media kind.'),
  limit: z.number().int().min(1).max(1000).optional().describe('Max items to return (default 100).'),
};
export const listMediaSchema = z.object(listMediaShape);

// ── NeuroArchive (MinIO long-term reusable asset store) ──────────────────────
export const registerArchiveShape = {
  url:         z.string().optional().describe('Remote https URL of the file to archive. Provide this OR base64.'),
  base64:      z.string().optional().describe('Base64 (or data: URL) of the file bytes. Provide this OR url.'),
  category:    z.enum(['video', 'image', 'audio', 'broll', 'code', 'document', 'other']).optional().describe('Archive category. If omitted it is inferred from the MIME type.'),
  title:       z.string().optional().describe('Short human label shown in the archive.'),
  description: z.string().optional().describe('Longer description of the asset and how to use it.'),
  tags:        z.array(z.string()).optional().describe('Reusable tags for finding this asset later, e.g. ["b-roll", "city", "night"].'),
  mime_type:   z.string().optional().describe('MIME type, e.g. video/mp4, image/png, text/markdown. Inferred from the source when omitted.'),
  source_tool: z.string().optional().describe('Which tool/model produced it, e.g. render_remote, abacus_image.'),
};
export const registerArchiveSchema = z.object(registerArchiveShape);

export const listArchiveShape = {
  category:        z.enum(['video', 'image', 'audio', 'broll', 'code', 'document', 'other']).optional().describe('Filter to one archive category.'),
  tag:             z.string().optional().describe('Filter to items that include this exact tag.'),
  include_archived: z.boolean().optional().describe('Include soft-deleted items. Default false.'),
  pinned_first:    z.boolean().optional().describe('Sort pinned items to the top. Default false (newest first).'),
  limit:           z.number().int().min(1).max(1000).optional().describe('Max items to return (default 100).'),
};
export const listArchiveSchema = z.object(listArchiveShape);

export const searchArchiveShape = {
  query:    z.string().describe('Substring to search across title, description, and tags.'),
  category: z.enum(['video', 'image', 'audio', 'broll', 'code', 'document', 'other']).optional().describe('Restrict search to one category.'),
  limit:    z.number().int().min(1).max(1000).optional().describe('Max items to return (default 100).'),
};
export const searchArchiveSchema = z.object(searchArchiveShape);

export const getArchiveItemShape = {
  id: z.string().describe('Archive item id from list_archive or register_archive.'),
};
export const getArchiveItemSchema = z.object(getArchiveItemShape);

export const fetchArchiveBytesShape = {
  id:         z.string().describe('Archive item id to download locally.'),
  dest_path:  z.string().optional().describe('Optional absolute destination path. If omitted, writes to a persistent scratch path under _shared/archive-fetch/.'),
};
export const fetchArchiveBytesSchema = z.object(fetchArchiveBytesShape);

export const pinArchiveItemShape = {
  id:     z.string().describe('Archive item id.'),
  pinned: z.boolean().describe('Pin (true) or unpin (false) the item.'),
};
export const pinArchiveItemSchema = z.object(pinArchiveItemShape);

export const archiveItemDeleteShape = {
  id:        z.string().describe('Archive item id.'),
  permanent: z.boolean().optional().describe('When true, permanently delete the MinIO object and DB row. Default false (soft-delete via archived flag).'),
};
export const archiveItemDeleteSchema = z.object(archiveItemDeleteShape);

// ── Remote render forge (HyperFrames / Remotion → render-node → R2) ──────────
export const renderRemoteShape = {
  engine:       z.enum(['hyperframes', 'remotion']).describe('Which render stack to use. "hyperframes" = an HTML+GSAP composition folder containing index.html (Puppeteer capture → FFmpeg NVENC). "remotion" = a React/TypeScript Remotion project folder.'),
  project_path: z.string().describe('Absolute local path to the composition folder on the app box. For hyperframes: a folder containing index.html. For remotion: the Remotion project root (containing package.json). node_modules/.git are excluded from upload automatically.'),
  title:        z.string().optional().describe('Human label for the resulting video in the Media gallery. Defaults to the folder name.'),
  duration_seconds: z.number().min(0.1).max(600).optional().describe('HyperFrames only: clip length in seconds (default 5).'),
  fps:          z.number().int().min(1).max(120).optional().describe('HyperFrames only: frames per second (default 30).'),
  width:        z.number().int().min(16).max(7680).optional().describe('HyperFrames only: viewport width in px (default 1280).'),
  height:       z.number().int().min(16).max(4320).optional().describe('HyperFrames only: viewport height in px (default 720).'),
  composition_id: z.string().optional().describe('Remotion only: the composition id to render (default "Main").'),
  entry:        z.string().optional().describe('Remotion only: entry file relative to the project root (e.g. src/index.ts). Auto-detected when omitted.'),
  register:     z.boolean().optional().describe('Auto-register the resulting MP4 into the Media gallery (Studio › Media). Default true.'),
};
export const renderRemoteSchema = z.object(renderRemoteShape);

// ── OpenMontage stage-driver exec (agent-driven pipeline, no code orchestrator) ──
// OpenMontage has no single-shot "render" call like hyperframes/remotion — the
// driving agent (e.g. Sachi Komine) IS the orchestrator: it reads project.json /
// checkpoint_<stage>.json via get_next_stage() and calls ToolRegistry tools stage
// by stage. This tool is that primitive: run Python or a shell command inside the
// vendored ~/openmontage venv on the render node, with provider secrets injected
// server-side (never exposed to the agent). Same operator-scoped SSH transport
// render_remote and the Backlot dashboard already use — no render-node SSH needed.
export const OM_ALLOWED_SECRETS = [
  'SHARED_VOIDAI_BG_KEY', 'SHARED_VOID_API_FREE_KEY', 'SHARED_KOKORO_API_KEY',
  'SHARED_FAL_API_KEY', 'SHARED_KIE_API_KEY',
] as const;
export const openmontageExecShape = {
  python_code: z.string().optional().describe('Python source to run via "$HOME/openmontage/.venv/bin/python -c" (base64-wrapped server-side, so no shell-quoting risk). cwd is $HOME/openmontage, so `from lib...`/`from tools...` imports resolve. Provide this OR command, not both.'),
  command:     z.string().optional().describe('Raw shell command to run instead of python_code (e.g. a direct ffmpeg/npx call). cwd is $HOME/openmontage. Provide this OR python_code, not both.'),
  secrets:     z.array(z.enum(OM_ALLOWED_SECRETS)).optional().describe('Provider secret NAMES to inject into the remote process env for this call (values never reach the agent). Allowlisted to OpenMontage provider shims only.'),
  timeout_seconds: z.number().int().min(1).max(3600).optional().describe('Execution ceiling in seconds (default 300). Calls over 480s automatically run DETACHED (launch-and-poll) so they are NOT bound by the ~10m sshd exec ceiling — use this for long multi-stage renders (up to 3600s / 60m).'),
};
export const openmontageExecSchema = z.object(openmontageExecShape);

// run_montage — one-shot trigger that inits (or reuses) an OpenMontage project
// on the render node and hands it to Sachi (the orchestrator agent) to drive to
// its next awaiting_human gate. This is the ENTRY POINT for the agent-driven
// pipeline; Sachi then loops stages via openmontage_exec per the stage-loop skill.
export const runMontageShape = {
  brief:         z.string().min(1).describe('The creative brief for the montage — what the video should be about. Sachi reasons over this to author each stage. Persisted on the node so gate-resumes can re-read it.'),
  pipeline_type: z.string().optional().describe('OpenMontage pipeline manifest id (default "mvp_zero_key"). mvp_zero_key = 4 tool-exec stages (assets→edit→compose→publish). explainer/cinematic/animation add reasoning stages (verify vendored first).'),
  project_id:    z.string().optional().describe('Reuse an existing project id, or omit to auto-generate (nc-montage-<ts>). Must match ^[a-zA-Z0-9._-]{1,64}$.'),
  priority:      z.number().int().min(1).max(100).optional().describe('Task priority for the Sachi assignment (default 55).'),
  image_provider: z.string().optional().describe('Override the assets-stage image provider (e.g. "kie", "fal", "voidai" — or the tool id "fal_image"). Written to project overrides at init BEFORE Sachi runs, so the assets stage honors it deterministically. Omit to use the pipeline default (KIE primary → fal → VoidAI).'),
  image_model:   z.string().optional().describe('Override the image model paired with image_provider (e.g. "google/nano-banana-pro", "fal-ai/flux/schnell"). May carry a namespace slash.'),
  tts_voice:     z.string().optional().describe('Override the Kokoro narration voice for the assets stage (e.g. "am_michael", "af_heart"). Omit for the pipeline default voice.'),
};
export const runMontageSchema = z.object(runMontageShape);

export const gameBuildShape = {
  brief: z.string().min(1).describe('A one-sentence description of the game to build, including controls/theme/goal for best results (e.g. "a fast 2-button endless runner with a high score"). The engine produces ONE self-contained, playable HTML5 canvas game that lands in Studio › Games.'),
};
export const gameBuildSchema = z.object(gameBuildShape);

export const webappBuildShape = {
  brief:      z.string().min(1).describe('A description of the web app to build (e.g. "a kanban board with drag-drop and 3 columns" or "a markdown note-taking app with live preview"). The engine produces ONE self-contained, genuinely functional modern web app (React + Tailwind via CDN) that lands in Studio › WebApps and previews in a sandboxed iframe.'),
  agent_name: z.string().optional().describe('The registered agent NAME whose provider+model should build the app (e.g. "Jarvis", "F.R.I.D.A.Y"). Pick a strong code/HTML generator. Omit to use the default design agent. Not every deployment has a "Jarvis" — this lets the caller choose any available agent.'),
};
export const webappBuildSchema = z.object(webappBuildShape);

export const deployToGithubShape = {
  artifact_id: z.string().min(1).describe('The artifact id to deploy (from a canvas/game/webapp build — the id returned as artifact_id, or a project\'s latest artifact). Must be an HTML artifact.'),
  repo_name:   z.string().min(1).describe('Desired GitHub repository name (e.g. "my-kanban-app"). Auto-sanitized to GitHub\'s allowed charset; if it already exists on the account it is updated (redeploy).'),
  private:     z.boolean().optional().describe('Create the repo as private. Defaults to true. Ignored when enable_pages is true (GitHub Pages on free plans requires a public repo).'),
  enable_pages: z.boolean().optional().describe('Enable GitHub Pages so the artifact is instantly live at a public URL. Forces the repo public. Defaults to false.'),
};
export const deployToGithubSchema = z.object(deployToGithubShape);

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

export const notifyUserShape = {
  message: z.string().describe('The notification message to send to the user. Be clear and specific about what you need.'),
  kind:    z.enum(['info', 'question', 'alert', 'update']).optional()
           .describe('Type of notification: info (general), question (needs user response/decision), alert (urgent/blocking issue), update (progress on long task).'),
  context: z.string().optional().describe('Optional additional context, background info, or metadata to help the user understand the situation.'),
};
export const notifyUserSchema = z.object(notifyUserShape);

// Send an inline image to the user as part of the current chat reply.
// Either a base64 blob OR a remote URL — never both. The image is displayed
// inline in the current agent bubble in both dashboard chat surfaces.
export const sendImageToUserShape = {
  base64:    z.string().optional()
                       .describe('Raw base64-encoded image bytes (no data: prefix). Use when you produced the image yourself (e.g. from browserless_screenshot). Provide either this OR url, not both.'),
  url:       z.string().url().optional()
                       .describe('Remote http(s) URL of an existing image to display. Use when referencing an image already hosted elsewhere. Provide either this OR base64, not both.'),
  mime_type: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']).optional()
                       .describe('MIME type. Required when passing base64. Determines the saved file extension. Defaults to image/png.'),
  alt:       z.string().optional()
                       .describe('Short description of the image (used as alt text and rendered as a caption in the markdown image tag). Strongly recommended for accessibility.'),
  caption:   z.string().optional()
                       .describe('Optional caption text shown below the image. Plain text — keep it short.'),
};
export const sendImageToUserSchema = z.object(sendImageToUserShape);

export const assignTaskShape = {
  to:          z.string().describe('Agent name to assign the task to.'),
  title:       z.string(),
  description: z.string().optional(),
  priority:    z.number().min(0).max(100).optional(),
  execute_now: z.boolean().optional().describe('Run immediately and return the result.'),
};
export const assignTaskSchema = z.object(assignTaskShape);

export const autonomousModeShape = {
  action:     z.enum(['start', 'stop', 'status']).describe('start the autonomous Mission Control loop, stop it, or report status.'),
  maxTasks:   z.number().int().min(1).optional().describe('Override: max tasks to work before reporting back.'),
  maxMinutes: z.number().int().min(1).optional().describe('Override: wall-clock budget in minutes.'),
  defaultAgentName: z.string().optional().describe('Fallback agent (by name) for tasks with no assignee.'),
};
export const autonomousModeSchema = z.object(autonomousModeShape);

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
  secrets:    z.array(z.string()).optional()
    .describe('Broker secret names to inject as environment variables for this command, scoped to you. Values are placed directly into the child process and never shown to you; command output is scrubbed of them.'),
  purpose:    z.string().optional()
    .describe('Short reason the secrets are needed — recorded in the broker audit log.'),
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

export const fsEditShape = {
  path:      z.string(),
  oldString: z.string().describe('Exact text to find. Must appear exactly once in the file.'),
  newString: z.string().describe('Text to replace it with.'),
};
export const fsEditSchema = z.object(fsEditShape);

export const globShape = {
  pattern: z.string().describe("Glob pattern, e.g. 'src/**/*.ts' or '**/*.md'."),
  path:    z.string().optional().describe('Base directory to search from. Defaults to the workspace root.'),
};
export const globSchema = z.object(globShape);

// ── Session uploads (files the user sent from Discord / web GUI) ────────────

export const listUploadsShape: z.ZodRawShape = {};
export const listUploadsSchema = z.object(listUploadsShape);

export const getUploadShape = {
  id: z.string().describe('The upload id from list_uploads.'),
};
export const getUploadSchema = z.object(getUploadShape);

export const analyzeImageShape = {
  id:       z.string().describe('The image upload id from list_uploads.'),
  question: z.string().optional().describe('Optional focus for the vision model.'),
};
export const analyzeImageSchema = z.object(analyzeImageShape);

export const secretsListShape = {
  service: z.string().optional()
    .describe('Optional service filter, e.g. "N8N" or "GH" — matched case-insensitively.'),
};
export const secretsListSchema = z.object(secretsListShape);

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
  auto_reply:      z.boolean().optional().describe('When true, bot replies to all messages in this channel without an @mention, regardless of guild-level auto-reply settings. Useful for channels "owned" by a specific agent on a shared server.'),
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
  provider: z.enum(['voidai', 'elevenlabs', 'kokoro']).optional().describe('Filter to one provider. Omit to get all. ElevenLabs is empty unless ELEVENLABS_API_KEY is configured; Kokoro is empty unless KOKORO_API_KEY is configured.'),
};
export const audioListVoicesSchema = z.object(audioListVoicesShape);

export const audioStatusShape = {
  agent: z.string().optional().describe('Optional agent name or id to inspect. When omitted, returns voice config for ALL agents that have TTS on, plus the voice toggle for every Discord bot.'),
};
export const audioStatusSchema = z.object(audioStatusShape);

export const audioConfigureAgentShape = {
  agent:    z.string().describe('Agent name or id to configure.'),
  enabled:  z.boolean().describe('Turn TTS on or off for this agent. When off, the speaker button is hidden in the dashboard and Discord skips the audio attachment.'),
  provider: z.enum(['voidai', 'elevenlabs', 'kokoro']).optional().describe('TTS backend. Defaults to voidai when first enabling. ElevenLabs requires ELEVENLABS_API_KEY; Kokoro requires KOKORO_API_KEY.'),
  voice:    z.string().optional().describe('Voice id for the chosen provider. VoidAI: alloy / echo / fable / onyx / nova / shimmer. ElevenLabs: a voice_id from audio_list_voices. Kokoro: a voice id from audio_list_voices with provider=kokoro. Pass empty string to clear and use the env default.'),
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
  include_closed: z.boolean().optional().describe('Include archived/done tasks. Default true.'),
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
  status:        z.enum(['todo', 'doing', 'review', 'done', 'blocked', 'cancelled']).optional().describe('Workflow status. todo→doing→review→done is the normal flow; use "blocked" to park a task that cannot proceed (needs input/dependency) or "cancelled" to abandon one you cannot or should not do — both cleanly release the task off the active board.'),
  assignee:      z.string().optional().describe('Free-text assignee. Accepts agent names, "User", "AI IDE Agent", or anything else. Defaults to "User" on create.'),
  priority_level: z.enum(['low', 'medium', 'high', 'critical']).optional().describe('Priority enum used by the Kanban UI.'),
  task_order:    z.number().int().optional().describe('Drag-reorder position within the (status) column. Lower numbers float up.'),
  feature:       z.string().optional().describe('Free-text feature label that cuts across projects (e.g. "auth", "billing").'),
  sources:       z.unknown().optional().describe('JSON array of citations. Each entry typically {url, title, relevance}. Hooks NeuroVault retrievals onto the task.'),
  code_examples: z.unknown().optional().describe('JSON array of code snippet references. Each entry typically {file, line, summary}.'),
  verification_mode: z.enum(['reconcile', 'review']).optional().describe("Dispatcher-only discriminator for the deterministic reconcile gate. 'reconcile' asserts main HEAD moved during the task; 'review' bypasses that assertion because a review is supposed to leave main untouched. Ignored on update — a task cannot mutate its own mode."),
  dependsOn:     z.array(z.string()).optional().describe('Blocker task ids this task depends on. The task will NOT be claimable (or transitionable to "doing") until EVERY blocker is "done". Cycles and self-edges are rejected. On update this REPLACES the existing blocker set; pass [] to clear all blockers.'),
  hard:          z.boolean().optional().describe('On delete: when true, permanently remove. Default false (archive).'),
};
export const manageTaskSchema = z.object(manageTaskShape);

export const claimNextTaskShape = {
  project_id: z.string().optional().describe('Restrict to tasks in this project id.'),
  feature:    z.string().optional().describe('Restrict to tasks with this feature label.'),
};
export const claimNextTaskSchema = z.object(claimNextTaskShape);

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
  secrets:    z.array(z.string()).optional()
    .describe('Broker secret names to inject as environment variables for this script, scoped to you. Values are placed directly into the child process and never shown to you; script output is scrubbed of them.'),
  purpose:    z.string().optional()
    .describe('Short reason the secrets are needed — recorded in the broker audit log.'),
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

// ── Browserless tools (hosted Chromium) ──────────────────────────────────
// SearXNG metasearch — the first-class web_search tool. Gated by
// config.searxng.enabled (SEARXNG_ENABLED, defaults on).

export const webSearchShape = {
  query:       z.string().describe('Search query. 2-8 keywords work better than full sentences.'),
  category:    z.enum(['general', 'news', 'images', 'videos', 'it', 'science', 'files', 'social media', 'map']).optional().describe('Search category (default general). Use "it" for programming/dev queries, "science" for academic papers, "news" with time_range=day for fresh news.'),
  time_range:  z.enum(['day', 'month', 'year']).optional().describe('Restrict results to this recency window.'),
  max_results: z.number().int().min(1).max(25).optional().describe('Max results to return (default 8).'),
};
export const webSearchSchema = z.object(webSearchShape);

// Hosted Chromium (https://www.browserless.io/) gives us rendered HTML,
// screenshots, PDFs, and arbitrary JS-in-page eval over plain HTTP — no
// local Chrome install. All four tools are gated by config.browser.enabled
// (BROWSERLESS_URL + BROWSERLESS_TOKEN).
// NOTE: these are NOT web search tools. Use for rendering pages, screenshots,
// PDFs, and DOM scraping.

export const browserlessFetchShape = {
  url:                z.string().url().describe('Absolute URL to fetch. Browserless renders the page in a headless Chromium and returns the post-JS HTML. NOT a search — use this when you need the rendered page content.'),
  wait_for:           z.union([z.string(), z.number().int()]).optional().describe('Either a CSS selector to wait for, or a number of milliseconds to delay before snapshotting the DOM. Useful for SPA pages that hydrate after load.'),
  include_main_text:  z.boolean().optional().describe('When true, run @mozilla/readability on the HTML and include {mainText, title, byline, length} alongside the raw html. Great for article extraction.'),
  include_screenshot: z.boolean().optional().describe('When true, also call /screenshot for the same URL and include a base64 JPEG (full page, quality 70) in the response.'),
};
export const browserlessFetchSchema = z.object(browserlessFetchShape);

export const browserlessScreenshotShape = {
  url:       z.string().url().describe('Absolute URL to screenshot using hosted Chromium. Returns a base64 image — NOT a search result.'),
  full_page: z.boolean().optional().describe('Capture the full scrollable page. Default true.'),
  format:    z.enum(['png', 'jpeg']).optional().describe('Image format. Default png.'),
  viewport:  z.object({
    width:  z.number().int().min(100).max(3840),
    height: z.number().int().min(100).max(2160),
  }).optional().describe('Browser viewport in pixels. Defaults to browserless\'s 1920x1080.'),
};
export const browserlessScreenshotSchema = z.object(browserlessScreenshotShape);

export const browserlessPdfShape = {
  url:       z.string().url().describe('Absolute URL to render as PDF via hosted Chromium.'),
  format:    z.enum(['Letter','Legal','Tabloid','Ledger','A0','A1','A2','A3','A4','A5','A6']).optional().describe('Paper size. Default A4.'),
  landscape: z.boolean().optional().describe('Rotate to landscape. Default false.'),
};
export const browserlessPdfSchema = z.object(browserlessPdfShape);

export const browserlessRunJsShape = {
  url:          z.string().url().describe('Absolute URL the script will run against. The page is loaded with networkidle2 before the script body executes.'),
  script:       z.string().describe('Body of an async function executed in the Puppeteer Node context (NOT in the page DOM). The variables `page` and `context` are in scope; `context.url` is the URL above. Use `await page.$eval(...)` to read DOM. End with `return ...;` to return data.'),
  return_value: z.boolean().optional().describe('When true (default), the value returned by the script is JSON-decoded and surfaced as `result`. When false, only ok/status are returned.'),
};
export const browserlessRunJsSchema = z.object(browserlessRunJsShape);

// ── Cron / Automation tools ────────────────────────────────────────────────

export const scheduleJobShape = {
  name:                    z.string().describe('Human-readable job name'),
  schedule:                z.string().optional().describe('Cron expression e.g. "0 9 * * *". Omit for inbound-webhook-only jobs.'),
  job_type:                z.enum(['agent_message', 'outbound_webhook', 'shell_command', 'n8n_workflow', 'kestra_flow', 'create_task']).describe('Type of job to run'),
  config:                  z.string().describe('JSON string with type-specific config. agent_message: {agentId,message,sessionId?}. outbound_webhook: {url,method?,headers?,body?}. shell_command: {command,timeout?}. n8n_workflow: {baseUrl,apiKey,workflowId,payload?}. kestra_flow: {namespace,flowId,inputs?,baseUrl?,apiKey?}. create_task: {title,description?,agentId?,projectId?,priority?,dependsOn?,coalesceKey?} — lands a tracked task on the Mission Control board (claim→doing→review→done) instead of firing an ephemeral chat; by default coalesces to one open instance per routine.'),
  description:             z.string().optional().describe('Optional human-readable description'),
  on_complete_webhook_url: z.string().optional().describe('URL to POST to after each successful run'),
  enable_inbound:          z.boolean().optional().describe('Generate an inbound webhook slug so external services can trigger this job'),
};
export const scheduleJobSchema = z.object(scheduleJobShape);

export const listJobsShape = {
  type:    z.enum(['agent_message', 'outbound_webhook', 'shell_command', 'n8n_workflow', 'kestra_flow', 'create_task']).optional().describe('Filter by job type'),
  enabled: z.boolean().optional().describe('Filter by enabled status'),
};
export const listJobsSchema = z.object(listJobsShape);

export const updateJobShape = {
  job_id:                  z.string().describe('ID of the job to update'),
  name:                    z.string().optional(),
  schedule:                z.string().optional().describe('New cron expression'),
  enabled:                 z.boolean().optional(),
  config:                  z.string().optional().describe('Updated JSON config string'),
  on_complete_webhook_url: z.string().optional(),
  description:             z.string().optional(),
};
export const updateJobSchema = z.object(updateJobShape);

export const deleteJobShape = {
  job_id: z.string().describe('ID of the job to delete'),
};
export const deleteJobSchema = z.object(deleteJobShape);

export const getJobRunsShape = {
  job_id: z.string().describe('Job ID to fetch run history for'),
  limit:  z.number().int().min(1).max(200).optional().describe('Number of runs to return (default 20)'),
};
export const getJobRunsSchema = z.object(getJobRunsShape);

// ── LogAnalyst tools ──────────────────────────────────────────────────────

export const getRecentErrorsShape = {
  hours: z.number().int().min(1).max(168).optional()
          .describe('How many hours back to look (default 24, max 168).'),
};
export const getRecentErrorsSchema = z.object(getRecentErrorsShape);

export const getDowntimeWindowsShape = {
  hours: z.number().int().min(1).max(720).optional()
          .describe('How many hours back to look (default 168 / 7 days).'),
};
export const getDowntimeWindowsSchema = z.object(getDowntimeWindowsShape);

export const searchLogLinesShape = {
  query: z.string().describe('Substring to search for in log messages.'),
  limit: z.number().int().min(1).max(200).optional().describe('Max results (default 50).'),
};
export const searchLogLinesSchema = z.object(searchLogLinesShape);

export const getErrorTimelineShape = {
  hours: z.number().int().min(1).max(168).optional()
          .describe('How many hours back (default 24). Returns one bucket per hour.'),
};
export const getErrorTimelineSchema = z.object(getErrorTimelineShape);

export const getAttachmentShape = {
  id: z.string().describe('The attachment_id surfaced in the system context block. NOT the filename — the UUID after "attachment_id:".'),
};
export const getAttachmentSchema = z.object(getAttachmentShape);

export const listAttachmentsShape = {};
export const listAttachmentsSchema = z.object(listAttachmentsShape);

export const getAttachmentParsedShape = {
  id: z.string().describe('The attachment_id from the system context block — the UUID after "attachment_id:". Use this tool for files marked "✓ pre-parsed"; use get_attachment for the base64 fallback path.'),
};
export const getAttachmentParsedSchema = z.object(getAttachmentParsedShape);

export const searchDocumentShape = {
  id:    z.string().describe('The attachment_id of the uploaded document to search — the UUID after "attachment_id:" in the system context block.'),
  query: z.string().describe('A natural-language question or keywords. Returns the most semantically relevant passages from the document instead of the whole thing — use this for LARGE pre-parsed documents flagged "use search_document" rather than dumping the full markdown into context.'),
  top_k: z.number().int().min(1).max(20).optional().describe('How many passages to return (default 6).'),
};
export const searchDocumentSchema = z.object(searchDocumentShape);

// ── Notebook / collection RAG (spec: native-notebook-rag) ──────────────────
export const notebookCreateShape = {
  title:       z.string().describe('Name of the notebook (collection of documents).'),
  description: z.string().optional().describe('Optional description of what the notebook is for.'),
};
export const notebookCreateSchema = z.object(notebookCreateShape);

export const notebookListShape = {} as const;
export const notebookListSchema = z.object(notebookListShape);

export const notebookUseShape = {
  notebook_id: z.string().describe('The notebook id to make the active notebook for this conversation.'),
};
export const notebookUseSchema = z.object(notebookUseShape);

export const notebookStatusShape = {} as const;
export const notebookStatusSchema = z.object(notebookStatusShape);

export const notebookAddSourceShape = {
  notebook_id: z.string().optional().describe('Notebook id. If omitted, uses the active notebook for this conversation.'),
  source:      z.string().describe('An uploaded document attachment_id, OR an https URL to a document (PDF/DOCX/HTML/MD/TXT). YouTube URLs are not supported in v1.'),
};
export const notebookAddSourceSchema = z.object(notebookAddSourceShape);

export const notebookSourceListShape = {
  notebook_id: z.string().optional().describe('Notebook id. If omitted, uses the active notebook.'),
};
export const notebookSourceListSchema = z.object(notebookSourceListShape);

export const notebookAskShape = {
  notebook_id: z.string().optional().describe('Notebook id. If omitted, uses the active notebook.'),
  question:    z.string().describe('The question to answer using RAG across ALL documents in the notebook.'),
  top_k:       z.number().int().min(1).max(30).optional().describe('How many passages to retrieve (default 10).'),
};
export const notebookAskSchema = z.object(notebookAskShape);

// ── SSH machine connections (spec: ssh-machine-connections) ────────────────
export const sshRunShape = {
  machine: z.string().describe('Registered machine name or id (from the Connect → Machines tab).'),
  command: z.string().describe('Shell command to run on the remote host.'),
  timeout_ms: z.number().int().min(1000).max(300000).optional().describe('Command timeout in ms (default 60000, max 300000).'),
};
export const sshRunSchema = z.object(sshRunShape);

export const sshUploadShape = {
  machine: z.string().describe('Registered machine name or id.'),
  local_path: z.string().describe('Absolute path of the local file to upload.'),
  remote_path: z.string().describe('Destination absolute path on the remote host.'),
};
export const sshUploadSchema = z.object(sshUploadShape);

export const sshDownloadShape = {
  machine: z.string().describe('Registered machine name or id.'),
  remote_path: z.string().describe('Absolute path of the remote file to download.'),
  local_path: z.string().describe('Destination absolute path on the local host.'),
};
export const sshDownloadSchema = z.object(sshDownloadShape);

export const generateImageShape = {
  prompt:  z.string().describe('What to generate.'),
  quality: z.enum(['standard', 'hd']).optional()
             .describe('"standard" uses grok-imagine-image (~5-10s). "hd" uses grok-imagine-image-quality (~10-20s). Defaults to standard.'),
};
export const generateImageSchema = z.object(generateImageShape);

export const generateImageVeniceShape = {
  prompt:          z.string().describe('What to generate. Be descriptive — Venice models respond well to detailed cinematic prompts.'),
  model:           z.string().optional().describe('Venice image model. Defaults to flux-2-pro. Other options: flux-dev, stable-diffusion-3-5, etc.'),
  width:           z.number().int().optional().describe('Output width in pixels. Defaults to 1024.'),
  height:          z.number().int().optional().describe('Output height in pixels. Defaults to 1024.'),
  negative_prompt: z.string().optional().describe('What to avoid in the image (e.g. "blurry, low quality, watermark").'),
  alt:             z.string().optional().describe('Alt text for the displayed image. Defaults to the prompt.'),
  caption:         z.string().optional().describe('Optional caption shown below the image.'),
};
export const generateImageVeniceSchema = z.object(generateImageVeniceShape);

// ── Venice AI image EDIT (aka inpaint) — separate endpoint, separate model list ──
export const veniceImageEditShape = {
  prompt:        z.string().describe('Text directions for the edit (e.g. "change the sky to a sunrise", "remove the tree"). Short, descriptive prompts work best.'),
  input_image:   z.string().describe('Required. The image to edit. Accepts: an https URL; a session upload id (from list_uploads); a local file path (absolute, or relative to your workspace, ending in .png/.jpg/.jpeg/.webp/.gif/.bmp); a base64 string; or a "data:image/...;base64," URI. PREFER the upload id or file path for local images — the server reads the file directly, so the bytes never have to be inlined into your own context (which is slow and can be rejected for large images).'),
  model:         z.string().optional().describe('Venice edit model id. Omit to use Venice\'s built-in default. Options: firered-image-edit, qwen-edit-uncensored, grok-imagine-edit, grok-imagine-quality-edit, qwen-image-2-edit, qwen-image-2-pro-edit, wan-2-7-pro-edit, flux-2-max-edit, gpt-image-2-edit, gpt-image-1-5-edit, nano-banana-2-edit, nano-banana-pro-edit, nano-banana-2-lite-edit, luma-uni-1-edit, luma-uni-1-max-edit, seedream-v5-lite-edit, seedream-v5-pro-edit, seedream-v4-edit.'),
  aspect_ratio:  z.enum(['auto', '1:1', '3:2', '16:9', '21:9', '9:16', '2:3', '3:4', '4:5']).optional().describe('Output aspect ratio. "auto" (or omit) infers the closest supported ratio from the input image; set explicitly when exact output dimensions are required.'),
  resolution:    z.string().optional().describe('Resolution tier, e.g. "1K", "2K", "4K". Supported values vary by model. Default "1K".'),
  output_format: z.enum(['jpeg', 'jpg', 'png', 'webp']).optional().describe('Output format. When omitted, inferred from resolution: PNG for 1K, JPEG for 2K/4K.'),
  quality:       z.enum(['low', 'medium', 'high']).optional().describe('Quality tier — currently only honored by gpt-image-2-edit (default "high" for that model). Ignored by other models.'),
  alt:           z.string().optional().describe('Alt text for the displayed image. Defaults to the prompt.'),
  caption:       z.string().optional().describe('Optional caption shown below the image.'),
};
export const veniceImageEditSchema = z.object(veniceImageEditShape);

export const generateSpeechShape = {
  text:  z.string().describe('Text to synthesize into speech.'),
  voice: z.string().optional().describe('xAI voice id override. Omit to use the default configured voice.'),
};
export const generateSpeechSchema = z.object(generateSpeechShape);

// ── Abacus AI media tools ───────────────────────────────────────────────────
export const abacusImageShape = {
  prompt:       z.string().describe('Text describing the image to generate, or the edit/upscale instruction.'),
  operation:    z.enum(['generate', 'edit', 'upscale']).optional().describe("Default 'generate'. 'edit' transforms input_image per the prompt; 'upscale' increases its resolution. edit/upscale REQUIRE input_image."),
  input_image:  z.string().optional().describe('For edit/upscale: the source image. Accepts an https URL, a session upload id (from list_uploads), a local file path, a base64 string, or a "data:image/...;base64," URI. PREFER the upload id or file path for local images — read server-side, never inlined into your context.'),
  model:        z.string().optional().describe('Abacus image model id (free-form string — pass any id below). Defaults per operation: generate→flux_pro, edit→flux_kontext_edit, upscale→magnific. AVAILABLE MODELS — generate: flux_pro, flux_pro_ultra, flux2, flux2_pro, flux_kontext, flux_pro_canny, flux_pro_depth, gpt_image15, gpt_image2, imagen, nano_banana, nano_banana2, nano_banana_lite, nano_banana_pro, ideogram, ideogram_character, midjourney, seedream, recraft, recraft_svg, dreamina, hunyuan_image, imagine_art, grok_imagine_image, grok_imagine_image_quality. edit (need input_image): flux_kontext_edit, gpt_image_edit, gpt_image2_edit, qwen_image_edit, recraft_vectorize. upscale (need input_image): magnific. Known-UNSUPPORTED (will fail, do not use): dalle, wan27. Live list: /api/models?provider=abacus (media_type=image).'),
  num_images:   z.number().int().min(1).max(4).optional().describe('How many images to generate (1-4, generate only). Default 1.'),
  aspect_ratio: z.string().optional().describe('e.g. "1:1", "16:9", "2:3" — varies by model.'),
  resolution:   z.string().optional().describe('Output resolution where supported, e.g. "1K", "2K", "4K".'),
  alt:          z.string().optional().describe('Alt text for the displayed image. Defaults to the prompt.'),
  caption:      z.string().optional().describe('Optional caption shown below the image.'),
};
export const abacusImageSchema = z.object(abacusImageShape);

// ── VoidAI Nano-Banana (Gemini) image tool ──────────────────────────────────
export const voidaiImageShape = {
  prompt:       z.string().describe('Text describing the image to generate, or the edit instruction to apply to input_image.'),
  operation:    z.enum(['generate', 'edit']).optional().describe("Default 'generate' (text→image). 'edit' transforms input_image per the prompt and REQUIRES input_image."),
  input_image:  z.string().optional().describe('For edit: the source image. Accepts an https URL, a session upload id (from list_uploads), a local file path, a base64 string, or a "data:image/...;base64," URI. PREFER the upload id or file path for local images — read server-side, never inlined into your context. Ignored for generate.'),
  aspect_ratio: z.string().optional().describe('Aspect ratio, e.g. "1:1", "16:9", "2:3", "3:4". Default "1:1".'),
  resolution:   z.enum(['STANDARD', '2K', '4K']).optional().describe('Output resolution. STANDARD≈1K (default), plus 2K and 4K.'),
  model:        z.string().optional().describe('VoidAI image model id. Default "gemini-3.1-flash-image" (Nano-Banana). Other Gemini image ids like "gemini-3-pro-image" also work.'),
  alt:          z.string().optional().describe('Alt text for the displayed image. Defaults to the prompt.'),
  caption:      z.string().optional().describe('Optional caption shown below the image.'),
};
export const voidaiImageSchema = z.object(voidaiImageShape);

// ── KIE AI media-job image tool (async: submit→poll→download bytes) ──────────
export const kieImageShape = {
  prompt:       z.string().describe('Text describing the image to generate, or the edit instruction to apply to input_image.'),
  operation:    z.enum(['generate', 'edit']).optional().describe("Default 'generate' (text→image). 'edit' transforms input_image per the prompt and REQUIRES input_image."),
  input_image:  z.string().optional().describe('For edit: the source image. KIE\'s job queue REQUIRES a public https URL — pass one directly, or pass a session upload id (from list_uploads), a local file path, or a base64/data: URI and the server will stage it to a public URL automatically. PREFER the upload id or file path for local images — read server-side, never inlined into your context. Ignored for generate.'),
  aspect_ratio: z.string().optional().describe('Aspect ratio, e.g. "1:1", "16:9", "3:4". Default "1:1".'),
  output_format:z.enum(['png', 'jpeg']).optional().describe('Output format. Default "png".'),
  model:        z.string().optional().describe('KIE media model id (unified createTask API). Default per operation: generate→"google/nano-banana", edit→"google/nano-banana-edit". AVAILABLE MODELS (live-verified 2026-07-14) — generate: google/nano-banana, google/imagen4, google/imagen4-fast, google/imagen4-ultra, bytedance/seedream, bytedance/seedream-v4-text-to-image, ideogram/v3-text-to-image, qwen/text-to-image, qwen2/text-to-image, grok-imagine/text-to-image. edit (need input_image): google/nano-banana-edit, bytedance/seedream-v4-edit, seedream/4.5-edit, seedream/5-lite-image-to-image, seedream/5-pro-image-to-image, ideogram/v3-edit, ideogram/v3-remix, ideogram/character-edit, qwen/image-edit, qwen/image-to-image, qwen2/image-edit, grok-imagine/image-to-image. NOTE: gpt-image and flux are NOT on KIE\'s unified API — use voidai_gpt_image / fal_image for those.'),
  alt:          z.string().optional().describe('Alt text for the displayed image. Defaults to the prompt.'),
  caption:      z.string().optional().describe('Optional caption shown below the image.'),
};
export const kieImageSchema = z.object(kieImageShape);

// ── fal media-queue image tool (async: submit→poll→download bytes) ───────────
export const falImageShape = {
  prompt:      z.string().describe('Text describing the image to generate, or the edit instruction to apply to input_image.'),
  operation:   z.enum(['generate', 'edit']).optional().describe("Default 'generate' (text→image). 'edit' transforms input_image per the prompt and REQUIRES input_image."),
  input_image: z.string().optional().describe('For edit: the source image. fal\'s queue REQUIRES a public https URL — pass one directly, or pass a session upload id (from list_uploads), a local file path, or a base64/data: URI and the server will stage it to a public URL automatically. PREFER the upload id or file path for local images — read server-side, never inlined into your context. Ignored for generate.'),
  image_size:  z.string().optional().describe('fal image_size, e.g. "square_hd", "landscape_16_9", "portrait_4_3". Model-dependent. Generate only — edit models use aspect_ratio (baked into the prompt/model default) instead.'),
  num_images:  z.number().int().optional().describe('How many images to generate. Default 1.'),
  model:       z.string().optional().describe('fal model id (endpoint_id from fal\'s v1/models catalog). Default per operation: generate→"fal-ai/flux/schnell", edit→"fal-ai/nano-banana/edit". Others (generate, live-verified 2026-07-14): fal-ai/flux/dev, fal-ai/flux-pro/v1.1, fal-ai/flux-pro/v1.1-ultra, fal-ai/flux-2, fal-ai/flux-2-pro, fal-ai/nano-banana, fal-ai/nano-banana-2, fal-ai/nano-banana-pro, fal-ai/bytedance/seedream/v4/text-to-image, fal-ai/bytedance/seedream/v4.5/text-to-image, bytedance/seedream/v5/pro/text-to-image, fal-ai/ideogram/v3, fal-ai/recraft/v3/text-to-image, fal-ai/z-image/turbo, openai/gpt-image-2, xai/grok-imagine-image. Others (edit): fal-ai/nano-banana-2/edit, fal-ai/nano-banana-pro/edit, fal-ai/flux-pro/kontext, fal-ai/flux-pro/kontext/max, fal-ai/flux-2/edit, fal-ai/flux-2-pro/edit, fal-ai/bytedance/seedream/v4/edit, fal-ai/bytedance/seedream/v4.5/edit, bytedance/seedream/v5/pro/edit, fal-ai/gemini-25-flash-image/edit, fal-ai/gemini-3-pro-image-preview/edit, fal-ai/gpt-image-1.5/edit, openai/gpt-image-2/edit, xai/grok-imagine-image/edit.'),
  safety_tolerance: z.enum(['1', '2', '3', '4', '5', '6']).optional().describe('Content filter strictness (strictest→most permissive). Only honored by the Nano-Banana family (default "4") and Pro-tier FLUX models like flux-pro/v1.1*, flux-2-pro/-max/-flex (default "2"). Silently ignored by models that don\'t expose it (flux/schnell, flux/dev, flux-2 base, gpt-image-*, seedream, ideogram, recraft, qwen-image, grok-imagine-image).'),
  alt:         z.string().optional().describe('Alt text for the displayed image. Defaults to the prompt.'),
  caption:     z.string().optional().describe('Optional caption shown below the image.'),
};
export const falImageSchema = z.object(falImageShape);

// ── Async video generation (fal + KIE media queue → Studio › Media gallery) ───
export const falVideoShape = {
  prompt:       z.string().describe('Text describing the video to generate. For image-to-video, describes the motion/action applied to input_image.'),
  model:        z.string().optional().describe('fal video model id (endpoint_id). Default fal-ai/wan/v2.2-5b/text-to-video. Known text-to-video: fal-ai/wan/v2.2-5b/text-to-video, fal-ai/minimax/hailuo-02/standard/text-to-video, fal-ai/kling-video/v2/master/text-to-video, fal-ai/veo3, fal-ai/veo3/fast, fal-ai/ltx-video-13b-distilled. Image-to-video (set input_image): fal-ai/kling-video/v2/master/image-to-video, fal-ai/minimax/hailuo-02/standard/image-to-video, fal-ai/wan/v2.2-5b/image-to-video.'),
  input_image:  z.string().optional().describe('For image-to-video: the source/first-frame image. Pass a session upload id (from list_uploads), a local file path, a base64/data: URI, or a public https URL — the server stages it to a public URL. When set, use an image-to-video model.'),
  duration:     z.union([z.number(), z.string()]).optional().describe('Clip duration in seconds (model-dependent, e.g. 5 or 10). Omit for the model default.'),
  aspect_ratio: z.string().optional().describe('Aspect ratio, e.g. "16:9", "9:16", "1:1" (model-dependent).'),
  resolution:   z.string().optional().describe('Output resolution, e.g. "480p", "720p", "1080p" (model-dependent).'),
};
export const falVideoSchema = z.object(falVideoShape);

export const kieVideoShape = {
  prompt:       z.string().describe('Text describing the video to generate. For image-to-video, describes the motion applied to input_image.'),
  model:        z.string().optional().describe('KIE video model id (unified createTask API). Default veo3_fast. Known video models: veo3, veo3_fast, sora-2-text-to-video, runway/gen4-turbo, kling/v2-1-master. ⚠️ Model IDs pending live verification — override if a default fails.'),
  input_image:  z.string().optional().describe('For image-to-video: source image (session upload id, local path, base64/data: URI, or public https URL).'),
  duration:     z.union([z.number(), z.string()]).optional().describe('Clip duration in seconds (model-dependent).'),
  aspect_ratio: z.string().optional().describe('Aspect ratio, e.g. "16:9", "9:16" (model-dependent).'),
};
export const kieVideoSchema = z.object(kieVideoShape);

// ── Music / audio generation (async job queue → Studio › Media gallery) ───
export const falAudioShape = {
  prompt:   z.string().describe('Text describing the music/audio to generate — genre, mood, instruments, tempo, style.'),
  model:    z.string().optional().describe('fal audio/music model id (endpoint_id). Default cassetteai/music-generator (prompt→music). Known: cassetteai/music-generator, fal-ai/minimax-music (song w/ lyrics), fal-ai/stable-audio-25/text-to-audio (sound/music), fal-ai/lyria2, fal-ai/diffrhythm (song w/ lyrics), fal-ai/ace-step (uses tags not prompt).'),
  duration: z.union([z.number(), z.string()]).optional().describe('Duration in seconds (model-dependent).'),
  lyrics:   z.string().optional().describe('Optional lyrics for song-generating models (ace-step, minimax-music, diffrhythm). Ignored by instrumental models.'),
};
export const falAudioSchema = z.object(falAudioShape);

export const kieAudioShape = {
  prompt:   z.string().describe('Text describing the music/song to generate — genre, mood, instruments, style.'),
  model:    z.string().optional().describe('KIE music model id (unified createTask API). Default suno/v5. ⚠️ Model IDs pending live verification — override if a default fails.'),
  duration: z.union([z.number(), z.string()]).optional().describe('Duration in seconds (model-dependent).'),
  lyrics:   z.string().optional().describe('Optional lyrics for song generation (Suno-style models).'),
};
export const kieAudioSchema = z.object(kieAudioShape);

// ── OpenArt MCP image tool (async: submit→wait→download bytes; gallery-routed) ─
export const openartImageShape = {
  prompt:       z.string().describe('Text describing the image to generate, or the edit instruction to apply to input_image.'),
  operation:    z.enum(['generate', 'edit']).optional().describe("Default 'generate' (text→image, mode text2image). 'edit' (mode image2image) transforms input_image per the prompt and REQUIRES input_image."),
  input_image:  z.string().optional().describe('For edit: the source/reference image. Pass a session upload id (from list_uploads), a local file path, a base64/data: URI, or a public https URL — the server reads the bytes and uploads them to OpenArt via a presigned PUT. PREFER an upload id or file path for local images (read server-side, never inlined into your context). Ignored for generate.'),
  model:        z.string().optional().describe('OpenArt model id (NOT displayName). One of: nano-banana-2, nano-banana-pro, nano-banana-2-lite (default), gpt-image-2, byte-plus-seedream-4-5, byte-plus-seedream-5-lite. All support both generate and edit.'),
  aspect_ratio: z.string().optional().describe('Aspect ratio: one of 21:9, 16:9, 3:2, 4:3, 5:4, 1:1 (default), 4:5, 3:4, 2:3, 9:16.'),
  alt:          z.string().optional().describe('Alt text for the displayed image. Defaults to the prompt.'),
  caption:      z.string().optional().describe('Optional caption shown below the image.'),
};
export const openartImageSchema = z.object(openartImageShape);

// ── Higgsfield MCP image tool (async: submit→poll→URL; gallery-routed) ───────
export const higgsfieldImageShape = {
  prompt:       z.string().describe('Text describing the image to generate, or the edit instruction to apply to input_image.'),
  model:        z.string().optional().describe('Higgsfield image model id (default nano_banana_2). For edit (input_image set) use an image-to-image model: nano_banana_2, nano_banana_pro, nano_banana, nano_banana_2_lite. Others: use higgsfield_models to discover.'),
  input_image:  z.string().optional().describe('For image-to-image editing: the source image as an https URL. When set, the image is imported to Higgsfield and the prompt is applied as an edit instruction. Omit for text→image generation.'),
  aspect_ratio: z.string().optional().describe('Aspect ratio, e.g. 1:1 (default), 16:9, 9:16, 3:2, 2:3, 4:3, 3:4, 4:5, 5:4, 21:9.'),
  resolution:   z.string().optional().describe('Output resolution: 1k (default), 2k, or 4k (higher = more credits).'),
  count:        z.number().int().min(1).max(4).optional().describe('Number of images to generate (1-4, default 1).'),
  alt:          z.string().optional().describe('Alt text for the displayed image. Defaults to the prompt.'),
  caption:      z.string().optional().describe('Optional caption shown below the image.'),
};
export const higgsfieldImageSchema = z.object(higgsfieldImageShape);

// ── Higgsfield MCP video tool (async: submit→poll→URL; Studio › Media) ───────
export const higgsfieldVideoShape = {
  prompt:       z.string().describe('Text describing the video to generate.'),
  model:        z.string().optional().describe('Higgsfield video model id (default cinematic_studio_3_0). Others: use higgsfield_models to discover.'),
  aspect_ratio: z.string().optional().describe("Output aspect ratio. Use '9:16' for TikTok/Reels/Shorts (vertical) and '16:9' for landscape (default varies by model)."),
  resolution:   z.string().optional().describe('Output resolution: 480p, 720p (default), 1080p, or 4k (higher = more credits).'),
  alt:          z.string().optional().describe('Title/alt text for the video in the Media gallery. Defaults to the prompt.'),
};
export const higgsfieldVideoSchema = z.object(higgsfieldVideoShape);

// ── Higgsfield model discovery ──────────────────────────────────────────────
export const higgsfieldModelsShape = {
  type:   z.enum(['image', 'video', 'audio', '3d']).optional().describe('Filter models by output type (omit for all).'),
  query:  z.string().optional().describe('Optional use-case query for recommendations (e.g. "image-to-video, cinematic").'),
  limit:  z.number().int().min(1).max(50).optional().describe('Max models to return (default 20).'),
};
export const higgsfieldModelsSchema = z.object(higgsfieldModelsShape);

// ── VoidAI gpt-image (OpenAI Images API) image tool ─────────────────────────
export const voidaiGptImageShape = {
  prompt:      z.string().describe('Text describing the image to generate, or the edit instruction to apply to input_image.'),
  operation:   z.enum(['generate', 'edit']).optional().describe("Default 'generate' (text→image). 'edit' transforms input_image per the prompt and REQUIRES input_image."),
  input_image: z.string().optional().describe('For edit: the source image. Accepts an https URL, a session upload id (from list_uploads), a local file path, a base64 string, or a "data:image/...;base64," URI. PREFER the upload id or file path for local images — read server-side, never inlined into your context. Ignored for generate.'),
  mask:        z.string().optional().describe('For edit: optional mask (https URL or base64 data URL). Transparent areas of the mask mark the region to change (inpaint). Ignored for generate.'),
  size:        z.enum(['1024x1024', '1024x1536', '1536x1024', '512x512']).optional().describe('Output size. Default "1024x1024"; 1024x1536 (portrait) and 1536x1024 (landscape) also supported.'),
  model:       z.string().optional().describe('VoidAI gpt-image model id. Default "gpt-image-2". Others: "gpt-image-1.5", "gpt-image-1".'),
  alt:         z.string().optional().describe('Alt text for the displayed image. Defaults to the prompt.'),
  caption:     z.string().optional().describe('Optional caption shown below the image.'),
};
export const voidaiGptImageSchema = z.object(voidaiGptImageShape);

// ── VoidAI Gemini Pro image tool (gemini-3-pro-image, higher fidelity) ───────
// Thin dedicated peer of voidai_image that pins the higher-quality Gemini Pro
// model, so it is a first-class registry citizen (discoverable to every agent)
// rather than a model-override on voidai_image.
export const voidaiGeminiProImageShape = {
  prompt:       z.string().describe('Text describing the image to generate, or the edit instruction to apply to input_image.'),
  operation:    z.enum(['generate', 'edit']).optional().describe("Default 'generate' (text→image). 'edit' transforms input_image per the prompt and REQUIRES input_image."),
  input_image:  z.string().optional().describe('For edit: the source image. Accepts an https URL, a session upload id (from list_uploads), a local file path, a base64 string, or a "data:image/...;base64," URI. PREFER the upload id or file path for local images — read server-side, never inlined into your context. Ignored for generate.'),
  aspect_ratio: z.string().optional().describe('Aspect ratio, e.g. "1:1", "16:9", "2:3", "3:4". Default "1:1".'),
  resolution:   z.enum(['STANDARD', '2K', '4K']).optional().describe('Output resolution. STANDARD≈1K (default), plus 2K and 4K. Gemini Pro is the right model for 2K/4K.'),
  alt:          z.string().optional().describe('Alt text for the displayed image. Defaults to the prompt.'),
  caption:      z.string().optional().describe('Optional caption shown below the image.'),
};
export const voidaiGeminiProImageSchema = z.object(voidaiGeminiProImageShape);

// abacusVideoShape removed — Abacus RouteLLM has no video generation endpoint
// (see note in registry.ts). Re-add if/when a real video API ships.

export const abacusSpeechShape = {
  text:   z.string().describe('Text to synthesize into speech.'),
  model:  z.string().optional().describe('Abacus TTS model id. Defaults to gemini-2.5-flash-preview-tts (verified). Others: gpt-audio-mini, gemini-2.5-pro-preview-tts. Not every listed id is invocable (openai_tts/elevenlabs are rejected).'),
  voice:  z.string().optional().describe('Voice id/name, model-specific. Omit for the model default.'),
  format: z.string().optional().describe('Audio output format, e.g. "mp3", "wav", "opus". Default mp3.'),
};
export const abacusSpeechSchema = z.object(abacusSpeechShape);

export const sendDocumentShape = {
  path:     z.string().describe('Absolute path to the file on disk. The file must already exist — use fs_write to create it first if needed.'),
  caption:  z.string().optional().describe('Optional message shown above the file card in chat.'),
  filename: z.string().optional().describe('Override the display name shown to the user. Defaults to the basename of path.'),
};
export const sendDocumentSchema = z.object(sendDocumentShape);

export const kbSearchShape = {
  query:  z.string().describe('Natural-language query to search the knowledge base.'),
  source: z.string().optional().describe('Restrict to a single source_id (from list_knowledge_sources).'),
  limit:  z.number().int().min(1).max(20).optional().describe('Max results (default 5).'),
};
export const kbSearchSchema = z.object(kbSearchShape);

export const kbCrawlShape = {
  url:  z.string().describe('URL to crawl and index into the knowledge base.'),
  deep: z.boolean().optional().describe('Multi-page BFS crawl instead of a single page.'),
};
export const kbCrawlSchema = z.object(kbCrawlShape);

export const kbIndexContentShape = {
  text:  z.string().describe('Raw text/markdown to index directly (no crawl).'),
  label: z.string().describe('Source label/id to group this content under.'),
  url:   z.string().optional().describe('Optional origin URL for attribution.'),
};
export const kbIndexContentSchema = z.object(kbIndexContentShape);

export const kbListSourcesShape = {} as const;
export const kbListSourcesSchema = z.object(kbListSourcesShape);

// ── Translation glossary (kb_glossary) ───────────────────────────────────────
export const glossaryLookupShape = {
  sourceTerm:        z.string().describe('The source-language term/phrase to look up.'),
  targetLocale:      z.string().describe('Target locale/language code, e.g. "fr", "de", "ja".'),
  sourceLocale:      z.string().optional().describe('Source locale code. Default "en".'),
  includeDeprecated: z.boolean().optional().describe('Include deprecated entries in the lookup. Default false.'),
};
export const glossaryLookupSchema = z.object(glossaryLookupShape);

export const glossaryUpsertShape = {
  sourceTerm:   z.string().describe('The source-language term/phrase.'),
  targetLocale: z.string().describe('Target locale/language code, e.g. "fr", "de", "ja".'),
  translation:  z.string().describe('The approved translation for this term in the target locale.'),
  sourceLocale: z.string().optional().describe('Source locale code. Default "en".'),
  notes:        z.string().optional().describe('Optional context/usage notes (e.g. tone, brand rule).'),
  status:       z.enum(['approved', 'draft', 'deprecated']).optional().describe('Entry status. Default "approved".'),
};
export const glossaryUpsertSchema = z.object(glossaryUpsertShape);

export const glossaryListShape = {
  targetLocale:       z.string().optional().describe('Filter to a single target locale.'),
  sourceTermContains: z.string().optional().describe('Filter to source terms containing this substring.'),
  limit:              z.number().int().min(1).max(200).optional().describe('Max entries to return (default 50).'),
};
export const glossaryListSchema = z.object(glossaryListShape);

// ── Text-fit estimator (pure, stateless) ─────────────────────────────────────
export const estimateTextFitShape = {
  text:                 z.string().describe('The candidate/translated text to check.'),
  locale:               z.string().describe('Locale/language code of the text, e.g. "fr", "de", "ja", "en".'),
  boxWidthPx:           z.number().positive().describe('Text box width in pixels.'),
  boxHeightPx:          z.number().positive().describe('Text box height in pixels.'),
  fontSizePx:           z.number().positive().describe('Font size in pixels.'),
  lineHeightMultiplier: z.number().positive().optional().describe('Line height as a multiple of font size. Default 1.2.'),
  charWidthEm:          z.number().positive().optional().describe('Average glyph advance width as a fraction of em. Default 0.55.'),
};
export const estimateTextFitSchema = z.object(estimateTextFitShape);

// ── Curated image-generation/edit wrappers (proxy to MCP image servers) ──────
// See docs/specs/per-agent-image-tools-spec.md (Fix 2, Option B). Schema + shape
// are defined coupled (schema = z.object(shape)) so validateRegistryShapes()
// never warns about per-plane drift. Params mirror the live MCP server schemas;
// dispatch is live via callRegisteredTool, so a server-side param change surfaces
// as a call-time error, never a stale cache.

export const gptImageGenerateShape = {
  prompt: z.string().describe('Text describing the image to generate.'),
  style:  z.enum(['auto', 'vivid', 'natural']).optional().describe("Image style. Default 'auto'."),
};
export const gptImageGenerateSchema = z.object(gptImageGenerateShape);

export const gptImageEditShape = {
  prompt:     z.string().describe('Edit instruction to apply to the image.'),
  image_path: z.string().describe('Absolute path to the image to edit.'),
};
export const gptImageEditSchema = z.object(gptImageEditShape);

export const grokImageEditShape = {
  prompt:     z.string().describe('Natural-language edit instruction.'),
  image_path: z.string().describe('Absolute path to the image to edit.'),
  quality:    z.enum(['standard', 'hd']).optional().describe("Output quality. Default 'standard'."),
};
export const grokImageEditSchema = z.object(grokImageEditShape);

export const grokImageComposeShape = {
  prompt:      z.string().describe('Instruction guiding how to composite/blend the images.'),
  image_paths: z.array(z.string()).describe('Ordered absolute paths; referenced as "First image", "Second image", etc.'),
  quality:     z.enum(['standard', 'hd']).optional().describe("Output quality. Default 'standard'."),
};
export const grokImageComposeSchema = z.object(grokImageComposeShape);

export const geminiImageGenerateShape = {
  prompt: z.string().describe('Text describing the image to generate (Gemini Nano Banana / Imagen).'),
};
export const geminiImageGenerateSchema = z.object(geminiImageGenerateShape);

export const geminiImageEditShape = {
  prompt:     z.string().describe('Edit instruction to apply to the image.'),
  image_path: z.string().describe('Absolute path to a PNG or JPEG to edit.'),
};
export const geminiImageEditSchema = z.object(geminiImageEditShape);

// ── Loop Engineering (loop_run) ─────────────────────────────────────────────
export const loopRunShape = {
  goal:          z.string().describe('What the loop should produce — the objective the builder must satisfy and the verifier grades against.'),
  artifact_kind: z.enum(['code', 'prose', 'unknown']).optional().describe("Kind of artifact being built: 'code', 'prose', or 'unknown' (default). Routes the verifier's tier-1 model."),
  acceptance:    z.string().optional().describe('Explicit acceptance criteria that must ALL be met for the loop to pass. Folded into both the build and verify prompts.'),
  max_rounds:    z.number().int().min(1).max(8).optional().describe('Override the max build→verify rounds (default from config, hard-capped at 8).'),
};
export const loopRunSchema = z.object(loopRunShape);
