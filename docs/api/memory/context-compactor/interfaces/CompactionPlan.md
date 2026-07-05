[**NeuroClaw API Reference v1.0.0**](../../../README.md)

***

[NeuroClaw API Reference](../../../README.md) / [memory/context-compactor](../README.md) / CompactionPlan

# Interface: CompactionPlan

Defined in: [memory/context-compactor.ts:24](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/memory/context-compactor.ts#L24)

## Properties

### from

> **from**: `number`

Defined in: [memory/context-compactor.ts:30](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/memory/context-compactor.ts#L30)

Indices into the caller's history array. Replace the inclusive range
[from, to] with `replacement`. `from` is always 1 (we never touch the
system prompt at index 0). `to` is `history.length - 1 - keepRecent`.

***

### replacement

> **replacement**: `object`

Defined in: [memory/context-compactor.ts:33](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/memory/context-compactor.ts#L33)

The single synthetic message to splice in. Caller wraps it in its own type.

#### role

> **role**: `"system"`

#### text

> **text**: `string`

***

### summaryWritten

> **summaryWritten**: `object`

Defined in: [memory/context-compactor.ts:35](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/memory/context-compactor.ts#L35)

What got persisted — for telemetry.

#### memory\_id?

> `optional` **memory\_id?**: `string`

#### vault\_path?

> `optional` **vault\_path?**: `string`

***

### to

> **to**: `number`

Defined in: [memory/context-compactor.ts:31](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/memory/context-compactor.ts#L31)

***

### tokensReclaimed

> **tokensReclaimed**: `number`

Defined in: [memory/context-compactor.ts:37](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/memory/context-compactor.ts#L37)

Tokens estimated to have been removed (rough).
