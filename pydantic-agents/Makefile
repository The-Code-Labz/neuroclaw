# Convenience targets for the Dockerised Pydantic-AI MCP agents.
#
# `make up`        - build (if needed) and start all 7 agents in the background
# `make down`      - stop all containers (preserves volumes)
# `make restart`   - rolling restart of all agents
# `make rebuild`   - force rebuild of images, recreate containers
# `make logs`      - tail logs from every agent
# `make ps`        - status of every agent
# `make logs-<svc>`- tail one agent, e.g. `make logs-deep-research`

COMPOSE ?= docker-compose

.PHONY: up down restart rebuild logs ps build pull clean

up:
	$(COMPOSE) up -d --build

down:
	$(COMPOSE) down

restart:
	$(COMPOSE) restart

rebuild:
	$(COMPOSE) build --pull
	$(COMPOSE) up -d --force-recreate

build:
	$(COMPOSE) build

logs:
	$(COMPOSE) logs -f --tail=100

ps:
	$(COMPOSE) ps

# Per-agent log shortcut: `make logs-deep-research`, `make logs-crawl4ai`, etc.
logs-%:
	$(COMPOSE) logs -f --tail=200 $*

# Remove containers AND named volumes (DESTROYS image-agent outputs!)
clean:
	$(COMPOSE) down -v
