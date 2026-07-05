[**NeuroClaw API Reference v1.0.0**](../../README.md)

***

[NeuroClaw API Reference](../../README.md) / [db](../README.md) / updateMcpServer

# Function: updateMcpServer()

> **updateMcpServer**(`id`, `fields`): `void`

Defined in: [db.ts:1913](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/db.ts#L1913)

## Parameters

### id

`string`

### fields

`Partial`\<\{ `enabled`: `boolean`; `headers`: `Record`\<`string`, `string`\> \| `null`; `last_probed_at`: `string` \| `null`; `name`: `string`; `status`: `string`; `status_detail`: `string` \| `null`; `tools_cached`: [`McpToolCacheEntry`](../interfaces/McpToolCacheEntry.md)[]; `tools_count`: `number`; `transport`: `"auto"` \| `"http"` \| `"sse"`; `url`: `string`; \}\>

## Returns

`void`
