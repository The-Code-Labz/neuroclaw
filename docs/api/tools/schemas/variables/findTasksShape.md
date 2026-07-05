[**NeuroClaw API Reference v1.0.0**](../../../README.md)

***

[NeuroClaw API Reference](../../../README.md) / [tools/schemas](../README.md) / findTasksShape

# Variable: findTasksShape

> `const` **findTasksShape**: `object`

Defined in: [tools/schemas.ts:234](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/tools/schemas.ts#L234)

## Type Declaration

### filter\_by

> **filter\_by**: `ZodOptional`\<`ZodEnum`\<\[`"status"`, `"project"`, `"assignee"`, `"parent"`\]\>\>

### filter\_value

> **filter\_value**: `ZodOptional`\<`ZodString`\>

### include\_closed

> **include\_closed**: `ZodOptional`\<`ZodBoolean`\>

### page

> **page**: `ZodOptional`\<`ZodNumber`\>

### per\_page

> **per\_page**: `ZodOptional`\<`ZodNumber`\>

### project\_id

> **project\_id**: `ZodOptional`\<`ZodString`\>

### query

> **query**: `ZodOptional`\<`ZodString`\>

### task\_id

> **task\_id**: `ZodOptional`\<`ZodString`\>
