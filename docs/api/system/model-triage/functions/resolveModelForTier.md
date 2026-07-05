[**NeuroClaw API Reference v1.0.0**](../../../README.md)

***

[NeuroClaw API Reference](../../../README.md) / [system/model-triage](../README.md) / resolveModelForTier

# Function: resolveModelForTier()

> **resolveModelForTier**(`tier`, `opts?`): `string` \| `null`

Defined in: [system/model-triage.ts:124](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/system/model-triage.ts#L124)

Pick a concrete model id for a tier from the live catalog.
Strategy: prefer non-overridden auto-classified models in the requested tier;
deterministic ordering (alphabetical) so the same task always picks the same
model unless catalog changes.

## Parameters

### tier

`ModelTier`

### opts?

[`ResolveOpts`](../interfaces/ResolveOpts.md) = `{}`

## Returns

`string` \| `null`
