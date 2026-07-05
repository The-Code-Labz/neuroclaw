[**NeuroClaw API Reference v1.0.0**](../../README.md)

***

[NeuroClaw API Reference](../../README.md) / [db](../README.md) / archiveProject

# Function: archiveProject()

> **archiveProject**(`id`): `void`

Defined in: [db.ts:1207](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/db.ts#L1207)

Soft-delete a project by flipping `archived = 1`. Use deleteProjectHard()
 when the user really wants the row gone (and accepts that orphaned tasks
 fall back to the default NeuroClaw project).

## Parameters

### id

`string`

## Returns

`void`
