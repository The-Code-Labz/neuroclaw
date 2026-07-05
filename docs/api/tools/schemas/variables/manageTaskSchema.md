[**NeuroClaw API Reference v1.0.0**](../../../README.md)

***

[NeuroClaw API Reference](../../../README.md) / [tools/schemas](../README.md) / manageTaskSchema

# Variable: manageTaskSchema

> `const` **manageTaskSchema**: `ZodObject`\<\{ `action`: `ZodEnum`\<\[`"create"`, `"update"`, `"delete"`\]\>; `assignee`: `ZodOptional`\<`ZodString`\>; `code_examples`: `ZodOptional`\<`ZodUnknown`\>; `description`: `ZodOptional`\<`ZodString`\>; `feature`: `ZodOptional`\<`ZodString`\>; `hard`: `ZodOptional`\<`ZodBoolean`\>; `parent_task_id`: `ZodOptional`\<`ZodString`\>; `priority_level`: `ZodOptional`\<`ZodEnum`\<\[`"low"`, `"medium"`, `"high"`, `"critical"`\]\>\>; `project_id`: `ZodOptional`\<`ZodString`\>; `sources`: `ZodOptional`\<`ZodUnknown`\>; `status`: `ZodOptional`\<`ZodEnum`\<\[`"todo"`, `"doing"`, `"review"`, `"done"`\]\>\>; `task_id`: `ZodOptional`\<`ZodString`\>; `task_order`: `ZodOptional`\<`ZodNumber`\>; `title`: `ZodOptional`\<`ZodString`\>; \}, `"strip"`, `ZodTypeAny`, \{ `action`: `"create"` \| `"update"` \| `"delete"`; `assignee?`: `string`; `code_examples?`: `unknown`; `description?`: `string`; `feature?`: `string`; `hard?`: `boolean`; `parent_task_id?`: `string`; `priority_level?`: `"critical"` \| `"low"` \| `"high"` \| `"medium"`; `project_id?`: `string`; `sources?`: `unknown`; `status?`: `"done"` \| `"todo"` \| `"doing"` \| `"review"`; `task_id?`: `string`; `task_order?`: `number`; `title?`: `string`; \}, \{ `action`: `"create"` \| `"update"` \| `"delete"`; `assignee?`: `string`; `code_examples?`: `unknown`; `description?`: `string`; `feature?`: `string`; `hard?`: `boolean`; `parent_task_id?`: `string`; `priority_level?`: `"critical"` \| `"low"` \| `"high"` \| `"medium"`; `project_id?`: `string`; `sources?`: `unknown`; `status?`: `"done"` \| `"todo"` \| `"doing"` \| `"review"`; `task_id?`: `string`; `task_order?`: `number`; `title?`: `string`; \}\>

Defined in: [tools/schemas.ts:262](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/tools/schemas.ts#L262)
