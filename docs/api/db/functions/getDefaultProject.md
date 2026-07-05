[**NeuroClaw API Reference v1.0.0**](../../README.md)

***

[NeuroClaw API Reference](../../README.md) / [db](../README.md) / getDefaultProject

# Function: getDefaultProject()

> **getDefaultProject**(): [`ProjectRecord`](../interfaces/ProjectRecord.md)

Defined in: [db.ts:1137](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/db.ts#L1137)

The default "NeuroClaw" project created by the v1.9 migration. Returned
 so callers (route handlers, task creators) can fall back to it when the
 user / agent didn't pick a specific project.

## Returns

[`ProjectRecord`](../interfaces/ProjectRecord.md)
