[**NeuroClaw API Reference v1.0.0**](../../../README.md)

***

[NeuroClaw API Reference](../../../README.md) / [tools/schemas](../README.md) / browserScreenshotSchema

# Variable: browserScreenshotSchema

> `const` **browserScreenshotSchema**: `ZodObject`\<\{ `format`: `ZodOptional`\<`ZodEnum`\<\[`"png"`, `"jpeg"`\]\>\>; `full_page`: `ZodOptional`\<`ZodBoolean`\>; `url`: `ZodString`; `viewport`: `ZodOptional`\<`ZodObject`\<\{ `height`: `ZodNumber`; `width`: `ZodNumber`; \}, `"strip"`, `ZodTypeAny`, \{ `height`: `number`; `width`: `number`; \}, \{ `height`: `number`; `width`: `number`; \}\>\>; \}, `"strip"`, `ZodTypeAny`, \{ `format?`: `"png"` \| `"jpeg"`; `full_page?`: `boolean`; `url`: `string`; `viewport?`: \{ `height`: `number`; `width`: `number`; \}; \}, \{ `format?`: `"png"` \| `"jpeg"`; `full_page?`: `boolean`; `url`: `string`; `viewport?`: \{ `height`: `number`; `width`: `number`; \}; \}\>

Defined in: [tools/schemas.ts:332](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/tools/schemas.ts#L332)
