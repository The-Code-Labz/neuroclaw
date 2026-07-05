[**NeuroClaw API Reference v1.0.0**](../../../README.md)

***

[NeuroClaw API Reference](../../../README.md) / [system/model-triage](../README.md) / PickModelResult

# Interface: PickModelResult

Defined in: [system/model-triage.ts:192](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/system/model-triage.ts#L192)

## Extended by

- [`PickModelResultExtended`](PickModelResultExtended.md)

## Properties

### decision?

> `optional` **decision?**: [`TriageDecision`](TriageDecision.md)

Defined in: [system/model-triage.ts:196](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/system/model-triage.ts#L196)

***

### depthPenalty?

> `optional` **depthPenalty?**: `object`

Defined in: [system/model-triage.ts:197](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/system/model-triage.ts#L197)

#### depth

> **depth**: `number`

#### from

> **from**: `ModelTier`

#### to

> **to**: `ModelTier`

***

### model

> **model**: `string` \| `null`

Defined in: [system/model-triage.ts:193](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/system/model-triage.ts#L193)

***

### tier

> **tier**: `"pinned"` \| `ModelTier`

Defined in: [system/model-triage.ts:194](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/system/model-triage.ts#L194)

***

### triaged

> **triaged**: `boolean`

Defined in: [system/model-triage.ts:195](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/system/model-triage.ts#L195)
