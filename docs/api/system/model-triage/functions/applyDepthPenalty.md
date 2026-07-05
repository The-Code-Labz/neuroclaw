[**NeuroClaw API Reference v1.0.0**](../../../README.md)

***

[NeuroClaw API Reference](../../../README.md) / [system/model-triage](../README.md) / applyDepthPenalty

# Function: applyDepthPenalty()

> **applyDepthPenalty**(`tier`, `spawnDepth`): `object`

Defined in: [system/model-triage.ts:208](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/system/model-triage.ts#L208)

Cascade-depth penalty: deep sub-agents are forced to cheaper tiers to
avoid runaway spawn pyramids burning Opus calls.
  depth 0 → no penalty
  depth 1 → no penalty (first-level spawn)
  depth 2 → cap at mid
  depth ≥ 3 → cap at low

## Parameters

### tier

`ModelTier`

### spawnDepth

`number`

## Returns

`object`

### capped

> **capped**: `boolean`

### tier

> **tier**: `ModelTier`
