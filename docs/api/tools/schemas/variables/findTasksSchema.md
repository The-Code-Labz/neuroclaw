[**NeuroClaw API Reference v1.0.0**](../../../README.md)

***

[NeuroClaw API Reference](../../../README.md) / [tools/schemas](../README.md) / findTasksSchema

# Variable: findTasksSchema

> `const` **findTasksSchema**: `ZodObject`\<\{ `filter_by`: `ZodOptional`\<`ZodEnum`\<\[`"status"`, `"project"`, `"assignee"`, `"parent"`\]\>\>; `filter_value`: `ZodOptional`\<`ZodString`\>; `include_closed`: `ZodOptional`\<`ZodBoolean`\>; `page`: `ZodOptional`\<`ZodNumber`\>; `per_page`: `ZodOptional`\<`ZodNumber`\>; `project_id`: `ZodOptional`\<`ZodString`\>; `query`: `ZodOptional`\<`ZodString`\>; `task_id`: `ZodOptional`\<`ZodString`\>; \}, `"strip"`, `ZodTypeAny`, \{ `filter_by?`: `"status"` \| `"project"` \| `"assignee"` \| `"parent"`; `filter_value?`: `string`; `include_closed?`: `boolean`; `page?`: `number`; `per_page?`: `number`; `project_id?`: `string`; `query?`: `string`; `task_id?`: `string`; \}, \{ `filter_by?`: `"status"` \| `"project"` \| `"assignee"` \| `"parent"`; `filter_value?`: `string`; `include_closed?`: `boolean`; `page?`: `number`; `per_page?`: `number`; `project_id?`: `string`; `query?`: `string`; `task_id?`: `string`; \}\>

Defined in: [tools/schemas.ts:244](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/tools/schemas.ts#L244)
