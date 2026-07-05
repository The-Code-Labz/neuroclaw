[**NeuroClaw API Reference v1.0.0**](../../../README.md)

***

[NeuroClaw API Reference](../../../README.md) / [system/spawner](../README.md) / spawnAgentAsync

# Function: spawnAgentAsync()

> **spawnAgentAsync**(`req`): `Promise`\<[`SpawnResult`](../interfaces/SpawnResult.md)\>

Defined in: [system/spawner.ts:39](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/system/spawner.ts#L39)

Async variant — runs the full triage pipeline including borderline LLM
escalation, cascade-depth penalty, and budget guard. Prefer this from
orchestrators that can afford the extra cheap classifier round-trip.

## Parameters

### req

[`SpawnRequest`](../interfaces/SpawnRequest.md)

## Returns

`Promise`\<[`SpawnResult`](../interfaces/SpawnResult.md)\>
