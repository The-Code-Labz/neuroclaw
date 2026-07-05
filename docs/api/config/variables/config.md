[**NeuroClaw API Reference v1.0.0**](../../README.md)

***

[NeuroClaw API Reference](../../README.md) / [config](../README.md) / config

# Variable: config

> `const` **config**: `object`

Defined in: [config.ts:5](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/config.ts#L5)

## Type Declaration

### anthropic

#### Get Signature

> **get** **anthropic**(): `object`

##### Returns

`object`

###### apiKey

> **apiKey**: `string`

###### enabled

> **enabled**: `boolean`

### audio

#### Get Signature

> **get** **audio**(): `object`

##### Returns

`object`

###### deepgram

> **deepgram**: `object`

###### deepgram.apiKey

> **apiKey**: `string`

###### deepgram.baseURL

> **baseURL**: `string`

###### deepgram.enabled

> **enabled**: `boolean`

###### deepgram.model

> **model**: `string`

###### elevenlabs

> **elevenlabs**: `object`

###### elevenlabs.apiKey

> **apiKey**: `string`

###### elevenlabs.baseURL

> **baseURL**: `string`

###### elevenlabs.defaultVoiceId

> **defaultVoiceId**: `string`

###### elevenlabs.enabled

> **enabled**: `boolean` = `!!elevenKey`

###### elevenlabs.model

> **model**: `string`

###### maxFileMb

> **maxFileMb**: `number`

###### maxTtsChars

> **maxTtsChars**: `number`

###### voidai

> **voidai**: `object`

###### voidai.transcribeModel

> **transcribeModel**: `string`

###### voidai.ttsModel

> **ttsModel**: `string`

###### voidai.ttsVoice

> **ttsVoice**: `string`

### browser

#### Get Signature

> **get** **browser**(): `object`

##### Returns

`object`

###### enabled

> **enabled**: `boolean`

###### timeoutMs

> **timeoutMs**: `number`

###### token

> **token**: `string`

###### url

> **url**: `string`

### claude

#### Get Signature

> **get** **claude**(): `object`

##### Returns

`object`

###### backend

> **backend**: `"claude-cli"` \| `"anthropic-api"`

###### cliCommand

> **cliCommand**: `string`

###### concurrencyLimit

> **concurrencyLimit**: `number`

###### maxTurns

> **maxTurns**: `number`

###### retryBaseMs

> **retryBaseMs**: `number`

###### retryMax

> **retryMax**: `number`

###### timeoutMs

> **timeoutMs**: `number`

### codex

#### Get Signature

> **get** **codex**(): `object`

##### Returns

`object`

###### backend

> **backend**: `"cli"` \| `"api"`

###### cliCommand

> **cliCommand**: `string`

###### concurrencyLimit

> **concurrencyLimit**: `number`

###### sandboxMode

> **sandboxMode**: `string`

###### timeoutMs

> **timeoutMs**: `number`

### compaction

#### Get Signature

> **get** **compaction**(): `object`

##### Returns

`object`

###### enabled

> **enabled**: `boolean`

###### extractWorkingState

> **extractWorkingState**: `boolean`

###### keepRecent

> **keepRecent**: `number`

###### model

> **model**: `string` \| `undefined`

###### reinjectMemories

> **reinjectMemories**: `number`

###### tokenThreshold

> **tokenThreshold**: `number`

###### turnThreshold

> **turnThreshold**: `number`

### composio

#### Get Signature

> **get** **composio**(): `object`

##### Returns

`object`

###### apiKey

> **apiKey**: `string` \| `undefined`

###### baseUrl

> **baseUrl**: `string` \| `undefined`

###### enabled

> **enabled**: `boolean` = `!!apiKey`

###### sessionTtlSec

> **sessionTtlSec**: `number`

### dashboard

#### Get Signature

> **get** **dashboard**(): `object`

##### Returns

`object`

###### port

> **port**: `number`

###### token

> **token**: `string`

### db

#### Get Signature

> **get** **db**(): `object`

##### Returns

`object`

###### path

> **path**: `string`

### discordBot

#### Get Signature

> **get** **discordBot**(): `object`

##### Returns

`object`

###### allowedUsers

> **allowedUsers**: `string`[] = `allow`

###### channelRoutes

> **channelRoutes**: `Record`\<`string`, `string`\> = `routes`

###### defaultAgent

> **defaultAgent**: `string`

###### enabled

> **enabled**: `boolean` = `!!token`

###### maxReplyChars

> **maxReplyChars**: `number`

###### token

> **token**: `string` \| `undefined`

### dream

#### Get Signature

> **get** **dream**(): `object`

##### Returns

`object`

###### enabled

> **enabled**: `boolean`

###### lookbackHours

> **lookbackHours**: `number`

###### model

> **model**: `string` \| `undefined`

###### runTime

> **runTime**: `string`

### embeddings

#### Get Signature

> **get** **embeddings**(): `object`

##### Returns

`object`

###### enabled

> **enabled**: `boolean`

###### minChars

> **minChars**: `number`

###### model

> **model**: `string`

### exec

#### Get Signature

> **get** **exec**(): `object`

##### Returns

`object`

###### bashDeny

> **bashDeny**: `string`[]

###### defaultCwd

> **defaultCwd**: `string`

###### outputMaxBytes

> **outputMaxBytes**: `number`

###### root

> **root**: `string`

###### timeoutMs

> **timeoutMs**: `number`

### gemini

#### Get Signature

> **get** **gemini**(): `object`

##### Returns

`object`

###### cliCommand

> **cliCommand**: `string`

###### concurrencyLimit

> **concurrencyLimit**: `number`

###### model

> **model**: `string`

###### timeoutMs

> **timeoutMs**: `number`

### heartbeat

#### Get Signature

> **get** **heartbeat**(): `object`

##### Returns

`object`

###### enabled

> **enabled**: `boolean`

###### intervalSec

> **intervalSec**: `number`

###### model

> **model**: `string`

###### skipClaudeCli

> **skipClaudeCli**: `boolean`

### langfuse

#### Get Signature

> **get** **langfuse**(): `object`

##### Returns

`object`

###### enabled

> **enabled**: `boolean`

###### host

> **host**: `string`

###### publicKey

> **publicKey**: `string`

###### secretKey

> **secretKey**: `string`

### mcp

#### Get Signature

> **get** **mcp**(): `object`

##### Returns

`object`

###### enabled

> **enabled**: `boolean`

###### insightslmSearchTool

> **insightslmSearchTool**: `string`

###### insightslmUrl

> **insightslmUrl**: `string`

###### neurovaultDefaultVault

> **neurovaultDefaultVault**: `string`

###### neurovaultUrl

> **neurovaultUrl**: `string`

###### researchlmSearchTool

> **researchlmSearchTool**: `string`

###### researchlmUrl

> **researchlmUrl**: `string`

### memory

#### Get Signature

> **get** **memory**(): `object`

##### Returns

`object`

###### extractMinChars

> **extractMinChars**: `number`

###### extractModel

> **extractModel**: `string` \| `undefined`

###### importanceThreshold

> **importanceThreshold**: `number`

###### perHourMax

> **perHourMax**: `number`

###### perSessionMax

> **perSessionMax**: `number`

###### preinjectEnabled

> **preinjectEnabled**: `boolean`

###### preinjectMax

> **preinjectMax**: `number`

### memoryGraph

#### Get Signature

> **get** **memoryGraph**(): `object`

##### Returns

`object`

###### enabled

> **enabled**: `boolean`

### review

#### Get Signature

> **get** **review**(): `object`

##### Returns

`object`

###### councilUrl

> **councilUrl**: `string`

###### loopEnabled

> **loopEnabled**: `boolean`

###### maxIterations

> **maxIterations**: `number`

### routing

#### Get Signature

> **get** **routing**(): `object`

##### Returns

`object`

###### enabled

> **enabled**: `boolean`

###### minConfidence

> **minConfidence**: `number`

###### model

> **model**: `string` \| `undefined`

### spawning

#### Get Signature

> **get** **spawning**(): `object`

##### Returns

`object`

###### autoApprove

> **autoApprove**: `boolean`

###### enabled

> **enabled**: `boolean`

###### hardLimit

> **hardLimit**: `number`

###### idleTimeoutMinutes

> **idleTimeoutMinutes**: `number`

###### softLimit

> **softLimit**: `number`

###### ttlHours

> **ttlHours**: `number`

### triage

#### Get Signature

> **get** **triage**(): `object`

##### Returns

`object`

###### borderHigh

> **borderHigh**: `number`

###### borderLow

> **borderLow**: `number`

###### budgetHour

> **budgetHour**: `number`

###### budgetSession

> **budgetSession**: `number`

###### llmEnabled

> **llmEnabled**: `boolean`

###### llmModel

> **llmModel**: `string` \| `undefined`

### vision

#### Get Signature

> **get** **vision**(): `object`

##### Returns

`object`

###### maxChars

> **maxChars**: `number`

###### model

> **model**: `string`

###### prompt

> **prompt**: `string`

###### provider

> **provider**: `string`

### voice

#### Get Signature

> **get** **voice**(): `object`

##### Returns

`object`

###### maxUtteranceSec

> **maxUtteranceSec**: `number`

###### silenceThresholdMs

> **silenceThresholdMs**: `number`

### voidai

#### Get Signature

> **get** **voidai**(): `object`

##### Returns

`object`

###### apiKey

> **apiKey**: `string`

###### baseURL

> **baseURL**: `string`

###### model

> **model**: `string`
