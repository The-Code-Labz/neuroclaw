[**NeuroClaw API Reference v1.0.0**](../../../README.md)

***

[NeuroClaw API Reference](../../../README.md) / [mcp/mcp-registry](../README.md) / getEnabledServersWithTools

# Function: getEnabledServersWithTools()

> **getEnabledServersWithTools**(): [`RegistryServerWithTools`](../interfaces/RegistryServerWithTools.md)[]

Defined in: [mcp/mcp-registry.ts:88](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/mcp/mcp-registry.ts#L88)

Synchronous read of every enabled, ready server's cached tools. Hot path
 for the runtime adapters — must not do I/O.

## Returns

[`RegistryServerWithTools`](../interfaces/RegistryServerWithTools.md)[]
