[**NeuroClaw API Reference v1.0.0**](../../README.md)

***

[NeuroClaw API Reference](../../README.md) / [db](../README.md) / deleteProjectHard

# Function: deleteProjectHard()

> **deleteProjectHard**(`id`): `object`

Defined in: [db.ts:1213](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/db.ts#L1213)

Permanently remove a project. Tasks that pointed at it are reassigned to
 the default NeuroClaw project so we don't violate the FK on a re-read.

## Parameters

### id

`string`

## Returns

`object`

### ok

> **ok**: `boolean`

### reason?

> `optional` **reason?**: `string`
