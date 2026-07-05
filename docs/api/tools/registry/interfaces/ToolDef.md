[**NeuroClaw API Reference v1.0.0**](../../../README.md)

***

[NeuroClaw API Reference](../../../README.md) / [tools/registry](../README.md) / ToolDef

# Interface: ToolDef\<Schema\>

Defined in: [tools/registry.ts:62](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/tools/registry.ts#L62)

## Type Parameters

### Schema

`Schema` *extends* `z.ZodTypeAny` = `z.ZodTypeAny`

## Properties

### description

> **description**: `string`

Defined in: [tools/registry.ts:64](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/tools/registry.ts#L64)

***

### gate?

> `optional` **gate?**: (`ctx`) => [`GateResult`](GateResult.md)

Defined in: [tools/registry.ts:69](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/tools/registry.ts#L69)

#### Parameters

##### ctx

[`ToolContext`](../../context/interfaces/ToolContext.md)

#### Returns

[`GateResult`](GateResult.md)

***

### handler

> **handler**: (`args`, `ctx`) => `Promise`\<`unknown`\>

Defined in: [tools/registry.ts:70](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/tools/registry.ts#L70)

#### Parameters

##### args

`TypeOf`\<`Schema`\>

##### ctx

[`ToolContext`](../../context/interfaces/ToolContext.md)

#### Returns

`Promise`\<`unknown`\>

***

### name

> **name**: `string`

Defined in: [tools/registry.ts:63](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/tools/registry.ts#L63)

***

### schema

> **schema**: `Schema`

Defined in: [tools/registry.ts:66](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/tools/registry.ts#L66)

Used directly by Claude SDK; converted to JSON Schema for OpenAI / MCP.

***

### shape

> **shape**: `ZodRawShape`

Defined in: [tools/registry.ts:68](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/tools/registry.ts#L68)

Same shape as Zod's `.shape` for Claude SDK's tool() helper.
