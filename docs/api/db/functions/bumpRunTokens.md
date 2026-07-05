[**NeuroClaw API Reference v1.0.0**](../../README.md)

***

[NeuroClaw API Reference](../../README.md) / [db](../README.md) / bumpRunTokens

# Function: bumpRunTokens()

> **bumpRunTokens**(`runId`, `inputTokens`, `outputTokens`): `void`

Defined in: [db.ts:1696](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/db.ts#L1696)

Increment a run's running token counters. Called per LLM iteration so that
tool-loop turns and multi-agent step turns all roll up into the parent run.

## Parameters

### runId

`string`

### inputTokens

`number`

### outputTokens

`number`

## Returns

`void`
