[**NeuroClaw API Reference v1.0.0**](../../../README.md)

***

[NeuroClaw API Reference](../../../README.md) / [agent/anthropic-client](../README.md) / getAnthropicClient

# Function: getAnthropicClient()

> **getAnthropicClient**(): `Anthropic`

Defined in: [agent/anthropic-client.ts:72](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/agent/anthropic-client.ts#L72)

Direct Anthropic SDK client. Used only when CLAUDE_BACKEND=anthropic-api.
Subscription OAuth tokens are NOT usable here — the API gateway rate-limits
non-CLI traffic. Use the claude-cli provider for subscription auth.

## Returns

`Anthropic`
