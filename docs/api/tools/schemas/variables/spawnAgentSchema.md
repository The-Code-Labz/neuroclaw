[**NeuroClaw API Reference v1.0.0**](../../../README.md)

***

[NeuroClaw API Reference](../../../README.md) / [tools/schemas](../README.md) / spawnAgentSchema

# Variable: spawnAgentSchema

> `const` **spawnAgentSchema**: `ZodObject`\<\{ `capabilities`: `ZodOptional`\<`ZodArray`\<`ZodString`, `"many"`\>\>; `description`: `ZodString`; `model`: `ZodOptional`\<`ZodString`\>; `modelTier`: `ZodOptional`\<`ZodEnum`\<\[`"pinned"`, `"auto"`, `"low"`, `"mid"`, `"high"`\]\>\>; `name`: `ZodString`; `role`: `ZodString`; `systemPrompt`: `ZodString`; `taskDescription`: `ZodString`; \}, `"strip"`, `ZodTypeAny`, \{ `capabilities?`: `string`[]; `description`: `string`; `model?`: `string`; `modelTier?`: `"auto"` \| `"pinned"` \| `"low"` \| `"mid"` \| `"high"`; `name`: `string`; `role`: `string`; `systemPrompt`: `string`; `taskDescription`: `string`; \}, \{ `capabilities?`: `string`[]; `description`: `string`; `model?`: `string`; `modelTier?`: `"auto"` \| `"pinned"` \| `"low"` \| `"mid"` \| `"high"`; `name`: `string`; `role`: `string`; `systemPrompt`: `string`; `taskDescription`: `string`; \}\>

Defined in: [tools/schemas.ts:75](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/tools/schemas.ts#L75)
