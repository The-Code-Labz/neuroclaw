[**NeuroClaw API Reference v1.0.0**](../../../README.md)

***

[NeuroClaw API Reference](../../../README.md) / [system/model-triage](../README.md) / PickModelResultExtended

# Interface: PickModelResultExtended

Defined in: [system/model-triage.ts:218](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/system/model-triage.ts#L218)

## Extends

- [`PickModelResult`](PickModelResult.md)

## Properties

### budgetDowngrade?

> `optional` **budgetDowngrade?**: `object`

Defined in: [system/model-triage.ts:220](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/system/model-triage.ts#L220)

#### from

> **from**: `ModelTier`

#### reason

> **reason**: `string`

#### to

> **to**: `ModelTier`

***

### decision?

> `optional` **decision?**: [`TriageDecision`](TriageDecision.md)

Defined in: [system/model-triage.ts:196](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/system/model-triage.ts#L196)

#### Inherited from

[`PickModelResult`](PickModelResult.md).[`decision`](PickModelResult.md#decision)

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

#### Inherited from

[`PickModelResult`](PickModelResult.md).[`depthPenalty`](PickModelResult.md#depthpenalty)

***

### llmEscalated?

> `optional` **llmEscalated?**: `boolean`

Defined in: [system/model-triage.ts:219](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/system/model-triage.ts#L219)

***

### model

> **model**: `string` \| `null`

Defined in: [system/model-triage.ts:193](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/system/model-triage.ts#L193)

#### Inherited from

[`PickModelResult`](PickModelResult.md).[`model`](PickModelResult.md#model)

***

### tier

> **tier**: `"pinned"` \| `ModelTier`

Defined in: [system/model-triage.ts:194](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/system/model-triage.ts#L194)

#### Inherited from

[`PickModelResult`](PickModelResult.md).[`tier`](PickModelResult.md#tier)

***

### triaged

> **triaged**: `boolean`

Defined in: [system/model-triage.ts:195](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/system/model-triage.ts#L195)

#### Inherited from

[`PickModelResult`](PickModelResult.md).[`triaged`](PickModelResult.md#triaged)
