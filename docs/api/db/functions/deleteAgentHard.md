[**NeuroClaw API Reference v1.0.0**](../../README.md)

***

[NeuroClaw API Reference](../../README.md) / [db](../README.md) / deleteAgentHard

# Function: deleteAgentHard()

> **deleteAgentHard**(`id`): `object`

Defined in: [db.ts:1376](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/db.ts#L1376)

Permanently delete an agent. Alfred is protected. NULLs out the agent_id on
tasks / messages / agent_messages so history isn't lost — we just orphan the
references. Use deactivateAgent() for the soft-delete (status='inactive').

## Parameters

### id

`string`

## Returns

`object`

### cleared?

> `optional` **cleared?**: `object`

#### cleared.agentMessagesFrom

> **agentMessagesFrom**: `number`

#### cleared.agentMessagesTo

> **agentMessagesTo**: `number`

#### cleared.messages

> **messages**: `number`

#### cleared.tasks

> **tasks**: `number`

### ok

> **ok**: `boolean`

### reason?

> `optional` **reason?**: `string`
