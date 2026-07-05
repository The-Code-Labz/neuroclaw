[**NeuroClaw API Reference v1.0.0**](../../../README.md)

***

[NeuroClaw API Reference](../../../README.md) / [tools/schemas](../README.md) / scheduleJobSchema

# Variable: scheduleJobSchema

> `const` **scheduleJobSchema**: `ZodObject`\<\{ `config`: `ZodString`; `description`: `ZodOptional`\<`ZodString`\>; `enable_inbound`: `ZodOptional`\<`ZodBoolean`\>; `job_type`: `ZodEnum`\<\[`"agent_message"`, `"outbound_webhook"`, `"shell_command"`, `"n8n_workflow"`\]\>; `name`: `ZodString`; `on_complete_webhook_url`: `ZodOptional`\<`ZodString`\>; `schedule`: `ZodOptional`\<`ZodString`\>; \}, `"strip"`, `ZodTypeAny`, \{ `config`: `string`; `description?`: `string`; `enable_inbound?`: `boolean`; `job_type`: `"agent_message"` \| `"outbound_webhook"` \| `"shell_command"` \| `"n8n_workflow"`; `name`: `string`; `on_complete_webhook_url?`: `string`; `schedule?`: `string`; \}, \{ `config`: `string`; `description?`: `string`; `enable_inbound?`: `boolean`; `job_type`: `"agent_message"` \| `"outbound_webhook"` \| `"shell_command"` \| `"n8n_workflow"`; `name`: `string`; `on_complete_webhook_url?`: `string`; `schedule?`: `string`; \}\>

Defined in: [tools/schemas.ts:359](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/tools/schemas.ts#L359)
