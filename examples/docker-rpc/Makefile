ROOT_DIR := $(abspath ../..)
NPM ?= npm
COMPOSE ?= docker compose
SERVICE ?= sentinel
CLIENT_ENTRY := client.mjs

.PHONY: build dist docker-build up up-detached run down stop logs rebuild clean shell

build dist:
	cd $(ROOT_DIR) && $(NPM) run build

# Build the Docker image after ensuring the framework is compiled locally.
docker-build: build
	$(COMPOSE) build $(SERVICE)

# Launch the sentinel in the foreground after compiling the framework locally.
up: #build
	$(COMPOSE) up $(SERVICE)

# Launch the sentinel in detached mode.
up-detached: build
	$(COMPOSE) up -d $(SERVICE)

run: #build
	@FAME_CONFIG=config/client-config.yml node $(CLIENT_ENTRY)

# Stop the sentinel and remove containers, networks, and volumes created by the stack.
down stop:
	$(COMPOSE) down

# Tail logs from the sentinel container.
logs:
	$(COMPOSE) logs -f $(SERVICE)

# Rebuild the image and restart the service.
rebuild: build
	$(COMPOSE) up --build $(SERVICE)

# Drop into a shell inside the sentinel container image.
shell:
	$(COMPOSE) run --rm $(SERVICE) /bin/sh

# Clean up all resources created by the example (containers, networks, volumes).
clean:
	$(COMPOSE) down -v --remove-orphans
