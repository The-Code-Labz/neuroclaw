# Integrations Module

External platform integrations.

## Overview

Currently contains the Discord bot integration, with more platforms planned.

## Discord Bot

The Discord bot allows agents to interact through Discord channels:
- Per-channel agent routing
- Voice message support (TTS/STT)
- Auto-reply configuration per server
- Emoji reactions

### Files

| File | Purpose |
|------|---------|
| `discord-bot.ts` | Main bot implementation |

### Running

```bash
# Start the bot
npm run bot:discord

# With hot reload
npm run bot:discord:watch
```

### Configuration

Bots are configured via the dashboard or tools:

1. Register bot with token:
   ```
   discord_register_bot(name: "mybot", token: "...")
   ```

2. Add channel routing:
   ```
   discord_add_channel_route(channelId: "123", agentName: "alfred")
   ```

3. Configure auto-reply servers:
   ```
   discord_set_auto_reply_guilds(guildIds: ["456", "789"])
   ```

### Voice Support

When `voice_enabled=true`:
- User voice messages are transcribed (STT)
- Agent responses are converted to audio (TTS)
- Per-user voice preferences supported

### Environment Variables

| Variable | Description |
|----------|-------------|
| `DISCORD_BOT_TOKEN` | Default bot token (optional, can use dashboard) |
| `ELEVENLABS_API_KEY` | For high-quality TTS voices |

## Future Integrations

Planned:
- Slack
- Telegram
- Matrix
- Custom webhooks
