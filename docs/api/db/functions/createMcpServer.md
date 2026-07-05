[**NeuroClaw API Reference v1.0.0**](../../README.md)

***

[NeuroClaw API Reference](../../README.md) / [db](../README.md) / createMcpServer

# Function: createMcpServer()

> **createMcpServer**(`input`): [`McpServerRow`](../interfaces/McpServerRow.md)

Defined in: [db.ts:1892](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/db.ts#L1892)

## Parameters

### input

#### enabled?

`boolean`

#### headers?

`Record`\<`string`, `string`\> \| `null`

#### name

`string`

#### transport?

`"auto"` \| `"http"` \| `"sse"`

#### url

`string`

## Returns

[`McpServerRow`](../interfaces/McpServerRow.md)
