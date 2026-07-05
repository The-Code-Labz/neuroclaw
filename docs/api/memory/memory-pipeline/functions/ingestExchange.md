[**NeuroClaw API Reference v1.0.0**](../../../README.md)

***

[NeuroClaw API Reference](../../../README.md) / [memory/memory-pipeline](../README.md) / ingestExchange

# Function: ingestExchange()

> **ingestExchange**(`input`): `Promise`\<[`IngestResult`](../interfaces/IngestResult.md)\>

Defined in: [memory/memory-pipeline.ts:79](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/memory/memory-pipeline.ts#L79)

Synchronous-style entry point. Most callers should NOT await this — the
`ingestExchangeAsync()` wrapper kicks it off as fire-and-forget.

## Parameters

### input

[`IngestExchange`](../interfaces/IngestExchange.md)

## Returns

`Promise`\<[`IngestResult`](../interfaces/IngestResult.md)\>
