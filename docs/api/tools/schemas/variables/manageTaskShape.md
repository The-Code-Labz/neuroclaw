[**NeuroClaw API Reference v1.0.0**](../../../README.md)

***

[NeuroClaw API Reference](../../../README.md) / [tools/schemas](../README.md) / manageTaskShape

# Variable: manageTaskShape

> `const` **manageTaskShape**: `object`

Defined in: [tools/schemas.ts:246](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/tools/schemas.ts#L246)

## Type Declaration

### action

> **action**: `ZodEnum`\<\[`"create"`, `"update"`, `"delete"`\]\>

### assignee

> **assignee**: `ZodOptional`\<`ZodString`\>

### code\_examples

> **code\_examples**: `ZodOptional`\<`ZodUnknown`\>

### description

> **description**: `ZodOptional`\<`ZodString`\>

### feature

> **feature**: `ZodOptional`\<`ZodString`\>

### hard

> **hard**: `ZodOptional`\<`ZodBoolean`\>

### parent\_task\_id

> **parent\_task\_id**: `ZodOptional`\<`ZodString`\>

### priority\_level

> **priority\_level**: `ZodOptional`\<`ZodEnum`\<\[`"low"`, `"medium"`, `"high"`, `"critical"`\]\>\>

### project\_id

> **project\_id**: `ZodOptional`\<`ZodString`\>

### sources

> **sources**: `ZodOptional`\<`ZodUnknown`\>

### status

> **status**: `ZodOptional`\<`ZodEnum`\<\[`"todo"`, `"doing"`, `"review"`, `"done"`\]\>\>

### task\_id

> **task\_id**: `ZodOptional`\<`ZodString`\>

### task\_order

> **task\_order**: `ZodOptional`\<`ZodNumber`\>

### title

> **title**: `ZodOptional`\<`ZodString`\>
