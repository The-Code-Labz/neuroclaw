[**NeuroClaw API Reference v1.0.0**](../../README.md)

***

[NeuroClaw API Reference](../../README.md) / [db](../README.md) / getOrCreateSessionByExternalId

# Function: getOrCreateSessionByExternalId()

> **getOrCreateSessionByExternalId**(`externalId`, `agentId`, `title?`): `string`

Defined in: [db.ts:1443](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/db.ts#L1443)

Look up a session by its stable external key (e.g. "discord::botId::channelId::userId").
If no such session exists, creates one and stores the external_id so future
lookups hit the same row even after a process restart.

This is the correct way for integrations (Discord bot, Slack, etc.) to get a
persistent session — avoids the "new session on every restart" bug that occurs
when session IDs are cached only in memory.

## Parameters

### externalId

`string`

### agentId

`string`

### title?

`string`

## Returns

`string`
