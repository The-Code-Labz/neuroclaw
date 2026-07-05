---
title: Areas
order: 30
---

# Areas

Areas are named groupings that let you organize agents into logical teams or departments — the equivalent of rooms, divisions, or workstreams in a larger agent organization. An agent belongs to at most one area at a time.

Areas are visualized on the dashboard's **PARA Map** page, which arranges agent cards by area so you can see at a glance how your team is structured and which agents are unassigned.

## Area schema

Each area is a lightweight record stored in the `areas` table:

| Field | Type | Default | Notes |
|---|---|---|---|
| `id` | string (UUID) | auto | Primary key |
| `name` | string | — | Required; display label |
| `icon_glyph` | string | `◈` | Single character or symbol shown on the card |
| `color_token` | string | `neon` | Theme color applied to the area tile (`neon`, `amber`, `green`, `neon-2`, `violet`, etc.) |
| `sort_order` | integer | `0` | Lower numbers appear first on the PARA Map |
| `created_at` | string (datetime) | now | |
| `updated_at` | string (datetime) | now | Updated on every `PATCH` |

On a clean database, NeuroClaw seeds five default areas: **Lifestyle** (`◈`, neon), **Finance** (`$`, amber), **Health** (`+`, green), **Work** (`▣`, neon-2), and **Learning** (`✦`, violet). These are created in order with `sort_order` values of 0, 10, 20, 30, and 40. Seeding is skipped if any areas already exist.

## Creating and managing areas

All area endpoints require the standard dashboard token (`?token=` query param or `x-dashboard-token` header).

### List all areas

```
GET /api/areas
```

Returns an array of `AreaRecord` objects sorted by `sort_order ASC`, then `created_at ASC`.

### Create an area

```
POST /api/areas
Content-Type: application/json

{
  "name": "Customer Support",
  "icon_glyph": "★",
  "color_token": "amber",
  "sort_order": 50
}
```

Only `name` is required. Omitted optional fields fall back to their defaults (`◈`, `neon`, `0`). Returns the created area record with HTTP 201.

### Update an area

```
PATCH /api/areas/:id
Content-Type: application/json

{
  "name": "Support",
  "color_token": "green"
}
```

All fields are optional; only the fields present in the body are updated. `updated_at` is refreshed automatically. Returns `{ "ok": true }`.

### Delete an area

```
DELETE /api/areas/:id
```

Deletes the area and sets `area_id = NULL` on every agent that was assigned to it. Agents are not deleted — they become unassigned. Returns `{ "ok": true }`.

## Assigning agents to areas

An agent's area membership is stored as `area_id` on the `agents` row. Use the following endpoint to assign or unassign an agent:

```
POST /api/agents/:id/area
Content-Type: application/json

{ "area_id": "area-uuid-here" }
```

To remove an agent from all areas without assigning it to a new one, send `null`:

```json
{ "area_id": null }
```

Passing an `area_id` that does not exist will write the value but produce a dangling reference — always use IDs returned from `GET /api/areas`. Every assignment change is written to `audit_logs` with the action `agent_area_set`.

## How areas surface in the dashboard

The **PARA Map** page groups agent cards by area. Agents without an `area_id` appear in an **Unassigned** section at the bottom. Within each area tile, agents are listed with their name, role badge, and status indicator.

The standard **Agents** page also exposes area information on each agent card, making the `area_id` visible without switching to the PARA Map view.

## Use cases

**Organizing a large team by function.** When you have more than a handful of agents, a flat list becomes hard to navigate. Grouping a Researcher, a Coder, and a Planner into a **Work** area and a set of onboarding and support agents into a **Customer Support** area makes team structure immediately legible.

**Mirroring real organizational structure.** If different people own different parts of your agent team (one person owns research agents, another owns automation agents), areas give each owner a clear visual boundary without affecting routing or permissions.

**Separating production agents from experimental ones.** Create a **Sandbox** or **Experimental** area and place temporary or in-progress agents there so they are visually distinct from stable, production-ready agents.

**PARA-style personal knowledge workflow.** The default seeded areas (Projects, Areas, Resources, Archive — adapted as Lifestyle, Finance, Health, Work, Learning) reflect a personal-productivity model where each agent handles a domain of your life or work. Assign an agent that tracks financial data to **Finance**, a health journaling agent to **Health**, and so on.
