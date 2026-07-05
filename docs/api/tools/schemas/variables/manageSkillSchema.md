[**NeuroClaw API Reference v1.0.0**](../../../README.md)

***

[NeuroClaw API Reference](../../../README.md) / [tools/schemas](../README.md) / manageSkillSchema

# Variable: manageSkillSchema

> `const` **manageSkillSchema**: `ZodObject`\<\{ `action`: `ZodEnum`\<\[`"create"`, `"update"`, `"delete"`\]\>; `body`: `ZodOptional`\<`ZodString`\>; `description`: `ZodOptional`\<`ZodString`\>; `name`: `ZodString`; `scripts`: `ZodOptional`\<`ZodArray`\<`ZodObject`\<\{ `content`: `ZodString`; `filename`: `ZodString`; \}, `"strip"`, `ZodTypeAny`, \{ `content`: `string`; `filename`: `string`; \}, \{ `content`: `string`; `filename`: `string`; \}\>, `"many"`\>\>; `tools`: `ZodOptional`\<`ZodArray`\<`ZodString`, `"many"`\>\>; `triggers`: `ZodOptional`\<`ZodArray`\<`ZodString`, `"many"`\>\>; \}, `"strip"`, `ZodTypeAny`, \{ `action`: `"create"` \| `"update"` \| `"delete"`; `body?`: `string`; `description?`: `string`; `name`: `string`; `scripts?`: `object`[]; `tools?`: `string`[]; `triggers?`: `string`[]; \}, \{ `action`: `"create"` \| `"update"` \| `"delete"`; `body?`: `string`; `description?`: `string`; `name`: `string`; `scripts?`: `object`[]; `tools?`: `string`[]; `triggers?`: `string`[]; \}\>

Defined in: [tools/schemas.ts:294](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/tools/schemas.ts#L294)
