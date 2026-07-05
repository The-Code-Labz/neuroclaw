[**NeuroClaw API Reference v1.0.0**](../../../README.md)

***

[NeuroClaw API Reference](../../../README.md) / [agent/alfred](../README.md) / MetaEvent

# Type Alias: MetaEvent

> **MetaEvent** = \{ `event`: [`RouteEvent`](../interfaces/RouteEvent.md); `type`: `"route"`; \} \| \{ `event`: [`SpawnEvent`](../interfaces/SpawnEvent.md); `type`: `"spawn"`; \} \| \{ `agentName`: `string`; `content`: `string`; `type`: `"spawn_chunk"`; \} \| \{ `agentName`: `string`; `result`: `string`; `type`: `"spawn_done"`; \} \| \{ `agentName`: `string`; `taskId`: `string`; `type`: `"spawn_started"`; \} \| \{ `steps`: `object`[]; `type`: `"plan"`; \} \| \{ `agentName`: `string`; `stepIndex`: `number`; `task`: `string`; `type`: `"step_start"`; \} \| \{ `agentName`: `string`; `content`: `string`; `stepIndex`: `number`; `type`: `"step_chunk"`; \} \| \{ `agentName`: `string`; `stepIndex`: `number`; `type`: `"step_done"`; \} \| \{ `type`: `"merge_start"`; \} \| \{ `benefit`: `number`; `reason`: `string`; `shouldSpawn`: `boolean`; `task`: `string`; `type`: `"spawn_eval"`; \} \| \{ `fromName`: `string`; `preview`: `string`; `toName`: `string`; `type`: `"agent_message"`; \} \| \{ `executing`: `boolean`; `fromName`: `string`; `taskId`: `string`; `title`: `string`; `toName`: `string`; `type`: `"agent_task_assigned"`; \} \| \{ `error`: `string`; `type`: `"error"`; \} \| \{ `server`: `string`; `tool`: `string`; `type`: `"mcp_call_start"`; \} \| \{ `length`: `number`; `server`: `string`; `tool`: `string`; `type`: `"mcp_call_done"`; \}

Defined in: [agent/alfred.ts:62](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/agent/alfred.ts#L62)
