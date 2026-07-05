[**NeuroClaw API Reference v1.0.0**](../../../README.md)

***

[NeuroClaw API Reference](../../../README.md) / [system/router](../README.md) / classifyRoute

# Function: classifyRoute()

> **classifyRoute**(`message`, `candidates`): `Promise`\<[`RouteDecision`](../interfaces/RouteDecision.md) \| `null`\>

Defined in: [system/router.ts:17](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/system/router.ts#L17)

Calls the LLM to classify which agent best fits the message.
Returns null if routing is disabled, confidence is below threshold, or parsing fails.

## Parameters

### message

`string`

### candidates

[`AgentRecord`](../../../db/interfaces/AgentRecord.md)[]

## Returns

`Promise`\<[`RouteDecision`](../interfaces/RouteDecision.md) \| `null`\>
