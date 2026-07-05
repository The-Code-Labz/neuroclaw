[**NeuroClaw API Reference v1.0.0**](../../../README.md)

***

[NeuroClaw API Reference](../../../README.md) / [tools/schemas](../README.md) / browserScreenshotShape

# Variable: browserScreenshotShape

> `const` **browserScreenshotShape**: `object`

Defined in: [tools/schemas.ts:323](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/tools/schemas.ts#L323)

## Type Declaration

### format

> **format**: `ZodOptional`\<`ZodEnum`\<\[`"png"`, `"jpeg"`\]\>\>

### full\_page

> **full\_page**: `ZodOptional`\<`ZodBoolean`\>

### url

> **url**: `ZodString`

### viewport

> **viewport**: `ZodOptional`\<`ZodObject`\<\{ `height`: `ZodNumber`; `width`: `ZodNumber`; \}, `"strip"`, `ZodTypeAny`, \{ `height`: `number`; `width`: `number`; \}, \{ `height`: `number`; `width`: `number`; \}\>\>
