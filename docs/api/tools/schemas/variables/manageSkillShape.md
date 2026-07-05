[**NeuroClaw API Reference v1.0.0**](../../../README.md)

***

[NeuroClaw API Reference](../../../README.md) / [tools/schemas](../README.md) / manageSkillShape

# Variable: manageSkillShape

> `const` **manageSkillShape**: `object`

Defined in: [tools/schemas.ts:282](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/tools/schemas.ts#L282)

## Type Declaration

### action

> **action**: `ZodEnum`\<\[`"create"`, `"update"`, `"delete"`\]\>

### body

> **body**: `ZodOptional`\<`ZodString`\>

### description

> **description**: `ZodOptional`\<`ZodString`\>

### name

> **name**: `ZodString`

### scripts

> **scripts**: `ZodOptional`\<`ZodArray`\<`ZodObject`\<\{ `content`: `ZodString`; `filename`: `ZodString`; \}, `"strip"`, `ZodTypeAny`, \{ `content`: `string`; `filename`: `string`; \}, \{ `content`: `string`; `filename`: `string`; \}\>, `"many"`\>\>

### tools

> **tools**: `ZodOptional`\<`ZodArray`\<`ZodString`, `"many"`\>\>

### triggers

> **triggers**: `ZodOptional`\<`ZodArray`\<`ZodString`, `"many"`\>\>
