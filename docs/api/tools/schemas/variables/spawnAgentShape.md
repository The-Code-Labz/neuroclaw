[**NeuroClaw API Reference v1.0.0**](../../../README.md)

***

[NeuroClaw API Reference](../../../README.md) / [tools/schemas](../README.md) / spawnAgentShape

# Variable: spawnAgentShape

> `const` **spawnAgentShape**: `object`

Defined in: [tools/schemas.ts:65](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/tools/schemas.ts#L65)

## Type Declaration

### capabilities

> **capabilities**: `ZodOptional`\<`ZodArray`\<`ZodString`, `"many"`\>\>

### description

> **description**: `ZodString`

### model

> **model**: `ZodOptional`\<`ZodString`\>

### modelTier

> **modelTier**: `ZodOptional`\<`ZodEnum`\<\[`"pinned"`, `"auto"`, `"low"`, `"mid"`, `"high"`\]\>\>

### name

> **name**: `ZodString`

### role

> **role**: `ZodString`

### systemPrompt

> **systemPrompt**: `ZodString`

### taskDescription

> **taskDescription**: `ZodString`
