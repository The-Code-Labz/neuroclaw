[**NeuroClaw API Reference v1.0.0**](../../../README.md)

***

[NeuroClaw API Reference](../../../README.md) / [agent/alfred](../README.md) / orchestrateMultiAgent

# Function: orchestrateMultiAgent()

> **orchestrateMultiAgent**(`rawMessage`, `sessionIdIn`, `onChunk`, `alfredId`, `onMeta?`, `origin?`): `Promise`\<`string`\>

Defined in: [agent/alfred.ts:1410](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/agent/alfred.ts#L1410)

Orchestrates a potentially complex task across multiple agents.
- Simple messages → single chatStream call (Alfred handles)
- Complex messages → decompose → execute steps → merge results

## Parameters

### rawMessage

`string`

### sessionIdIn

`string` \| `undefined`

### onChunk

(`chunk`) => `void` \| `Promise`\<`void`\>

### alfredId

`string`

### onMeta?

(`e`) => `void` \| `Promise`\<`void`\>

### origin?

`string` = `'orchestrate'`

## Returns

`Promise`\<`string`\>
