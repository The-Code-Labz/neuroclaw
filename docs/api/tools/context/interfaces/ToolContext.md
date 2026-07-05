[**NeuroClaw API Reference v1.0.0**](../../../README.md)

***

[NeuroClaw API Reference](../../../README.md) / [tools/context](../README.md) / ToolContext

# Interface: ToolContext

Defined in: [tools/context.ts:7](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/tools/context.ts#L7)

## Properties

### agentId?

> `optional` **agentId?**: `string` \| `null`

Defined in: [tools/context.ts:9](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/tools/context.ts#L9)

Calling agent (for write attribution, gating, recursive chatStream parent).

***

### onMeta?

> `optional` **onMeta?**: (`e`) => `void` \| `Promise`\<`void`\>

Defined in: [tools/context.ts:13](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/tools/context.ts#L13)

Optional dashboard SSE event sink; only the OpenAI chat path attaches one.

#### Parameters

##### e

[`MetaEvent`](../../../agent/alfred/type-aliases/MetaEvent.md)

#### Returns

`void` \| `Promise`\<`void`\>

***

### runId?

> `optional` **runId?**: `string` \| `null`

Defined in: [tools/context.ts:17](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/tools/context.ts#L17)

Active run id (v2.0). Tool handlers that recursively call chatStream pass
 this through so every event in the spawned turn rolls up under the same
 parent run. Optional — null when the tool path has no active run.

***

### sessionId?

> `optional` **sessionId?**: `string` \| `null`

Defined in: [tools/context.ts:11](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/tools/context.ts#L11)

Current chat session, if any. Some tools annotate writes with it.
