[**NeuroClaw API Reference v1.0.0**](../../../README.md)

***

[NeuroClaw API Reference](../../../README.md) / [agent/alfred](../README.md) / chatStream

# Function: chatStream()

> **chatStream**(`userMessage`, `sessionId`, `onChunk`, `systemPrompt`, `agentId?`, `onMeta?`, `attachments?`, `extraSystemContext?`, `runId?`): `Promise`\<`void`\>

Defined in: [agent/alfred.ts:1355](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/agent/alfred.ts#L1355)

Routes to the correct streaming implementation based on agent provider.
`attachments` is only set when the agent is on a vision-capable provider
AND vision_mode resolved to 'native' — for all other paths the route
handler converted the images into text descriptions before calling us.

`extraSystemContext` is appended to the dynamically-rebuilt system prompt
on every turn (after team awareness + skills + memory blocks). Use it for
per-request context the agent needs but that doesn't belong in its stored
prompt: the Discord turn ids the bot path threads in, etc.

## Parameters

### userMessage

`string`

### sessionId

`string`

### onChunk

(`chunk`) => `void` \| `Promise`\<`void`\>

### systemPrompt

`string`

### agentId?

`string`

### onMeta?

(`e`) => `void` \| `Promise`\<`void`\>

### attachments?

[`ChatImageAttachment`](../interfaces/ChatImageAttachment.md)[]

### extraSystemContext?

`string`

### runId?

`string`

## Returns

`Promise`\<`void`\>
