[**NeuroClaw API Reference v1.0.0**](../../../README.md)

***

[NeuroClaw API Reference](../../../README.md) / [system/model-triage](../README.md) / pickModelAsync

# Function: pickModelAsync()

> **pickModelAsync**(`opts`): `Promise`\<[`PickModelResultExtended`](../interfaces/PickModelResultExtended.md)\>

Defined in: [system/model-triage.ts:257](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/system/model-triage.ts#L257)

Async variant — runs the borderline LLM classifier when the heuristic score
lands in the configured grey zone. Use this from spawn/chat paths that can
afford the extra (cheap) round-trip; fall back to pickModel() when latency-sensitive.

## Parameters

### opts

[`PickModelOpts`](../interfaces/PickModelOpts.md)

## Returns

`Promise`\<[`PickModelResultExtended`](../interfaces/PickModelResultExtended.md)\>
