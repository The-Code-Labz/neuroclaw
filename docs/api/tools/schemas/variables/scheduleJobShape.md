[**NeuroClaw API Reference v1.0.0**](../../../README.md)

***

[NeuroClaw API Reference](../../../README.md) / [tools/schemas](../README.md) / scheduleJobShape

# Variable: scheduleJobShape

> `const` **scheduleJobShape**: `object`

Defined in: [tools/schemas.ts:350](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/tools/schemas.ts#L350)

## Type Declaration

### config

> **config**: `ZodString`

### description

> **description**: `ZodOptional`\<`ZodString`\>

### enable\_inbound

> **enable\_inbound**: `ZodOptional`\<`ZodBoolean`\>

### job\_type

> **job\_type**: `ZodEnum`\<\[`"agent_message"`, `"outbound_webhook"`, `"shell_command"`, `"n8n_workflow"`\]\>

### name

> **name**: `ZodString`

### on\_complete\_webhook\_url

> **on\_complete\_webhook\_url**: `ZodOptional`\<`ZodString`\>

### schedule

> **schedule**: `ZodOptional`\<`ZodString`\>
