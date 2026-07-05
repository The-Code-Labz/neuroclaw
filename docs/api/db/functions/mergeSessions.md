[**NeuroClaw API Reference v1.0.0**](../../README.md)

***

[NeuroClaw API Reference](../../README.md) / [db](../README.md) / mergeSessions

# Function: mergeSessions()

> **mergeSessions**(`keepSessionId`, `mergeSessionIds`, `externalId?`): `object`

Defined in: [db.ts:1507](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/db.ts#L1507)

Merge one or more sessions into a single target session.

All messages from `mergeSessionIds` are re-homed onto `keepSessionId` via a
single UPDATE. The now-empty source sessions are then deleted (messages first,
then the session row). The `message_count` on the surviving session is
recalculated from the DB so it reflects the new total.

Optionally stamps `externalId` on the survivor if it does not already have one.

All three writes happen inside a transaction so a mid-flight crash cannot
leave messages orphaned on a deleted session.

Returns the number of source sessions deleted and messages re-homed.

## Parameters

### keepSessionId

`string`

### mergeSessionIds

`string`[]

### externalId?

`string` \| `null`

## Returns

`object`

### merged

> **merged**: `number`

### messagesRehoused

> **messagesRehoused**: `number`
