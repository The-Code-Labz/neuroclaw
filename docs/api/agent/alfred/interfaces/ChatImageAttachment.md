[**NeuroClaw API Reference v1.0.0**](../../../README.md)

***

[NeuroClaw API Reference](../../../README.md) / [agent/alfred](../README.md) / ChatImageAttachment

# Interface: ChatImageAttachment

Defined in: [agent/alfred.ts:1338](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/agent/alfred.ts#L1338)

Image attachment forwarded into the chat path when the resolved vision
 mode is 'native'. The route handler runs the 'preprocess' branch upstream
 and never threads anything here in that case (it's already inlined as text).

## Properties

### mime\_type?

> `optional` **mime\_type?**: `string`

Defined in: [agent/alfred.ts:1340](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/agent/alfred.ts#L1340)

***

### name?

> `optional` **name?**: `string`

Defined in: [agent/alfred.ts:1341](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/agent/alfred.ts#L1341)

***

### url

> **url**: `string`

Defined in: [agent/alfred.ts:1339](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/agent/alfred.ts#L1339)
