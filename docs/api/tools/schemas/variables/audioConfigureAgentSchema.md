[**NeuroClaw API Reference v1.0.0**](../../../README.md)

***

[NeuroClaw API Reference](../../../README.md) / [tools/schemas](../README.md) / audioConfigureAgentSchema

# Variable: audioConfigureAgentSchema

> `const` **audioConfigureAgentSchema**: `ZodObject`\<\{ `agent`: `ZodString`; `enabled`: `ZodBoolean`; `provider`: `ZodOptional`\<`ZodEnum`\<\[`"voidai"`, `"elevenlabs"`\]\>\>; `voice`: `ZodOptional`\<`ZodString`\>; \}, `"strip"`, `ZodTypeAny`, \{ `agent`: `string`; `enabled`: `boolean`; `provider?`: `"voidai"` \| `"elevenlabs"`; `voice?`: `string`; \}, \{ `agent`: `string`; `enabled`: `boolean`; `provider?`: `"voidai"` \| `"elevenlabs"`; `voice?`: `string`; \}\>

Defined in: [tools/schemas.ts:189](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/tools/schemas.ts#L189)
