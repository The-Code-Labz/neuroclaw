[**NeuroClaw API Reference v1.0.0**](../../../README.md)

***

[NeuroClaw API Reference](../../../README.md) / [tools/registry](../README.md) / getAllTools

# Function: getAllTools()

> **getAllTools**(): [`ToolDef`](../interfaces/ToolDef.md)\<`ZodTypeAny`\>[]

Defined in: [tools/registry.ts:1370](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/tools/registry.ts#L1370)

Native registry + dynamically synthesized MCP-registry tools. Used by
 callers that want the full list without context-gating (e.g. Codex's
 HTTP /mcp tools/list endpoint, dashboard introspection).

## Returns

[`ToolDef`](../interfaces/ToolDef.md)\<`ZodTypeAny`\>[]
