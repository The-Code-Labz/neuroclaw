[**NeuroClaw API Reference v1.0.0**](../../../README.md)

***

[NeuroClaw API Reference](../../../README.md) / [memory/context-compactor](../README.md) / maybeCompactHistory

# Function: maybeCompactHistory()

> **maybeCompactHistory**(`input`): `Promise`\<[`CompactionPlan`](../interfaces/CompactionPlan.md) \| `null`\>

Defined in: [memory/context-compactor.ts:55](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/memory/context-compactor.ts#L55)

Returns null when no compaction is needed. Otherwise runs the LLM
summarizer + memory retrieval and returns a splice plan.

## Parameters

### input

[`MaybeCompactInput`](../interfaces/MaybeCompactInput.md)

## Returns

`Promise`\<[`CompactionPlan`](../interfaces/CompactionPlan.md) \| `null`\>
