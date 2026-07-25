# Interview Auctions
#
# The short version:
#
#   make install   once
#   make demo      everything, seeded, in one terminal
#
# `make demo` is the one to use for a first look: it rebuilds the database from
# the migrations, loads 300 listings with bid histories, and runs the API and
# the frontend together. Ctrl-C stops both.

SHELL := /bin/bash
SERVER := server/typescript

# The default `node` on many machines is too old for Vite 7 (needs 20.19+).
# Every recipe below goes through nvm using the committed .nvmrc, so the right
# version is used regardless of what the shell defaults to.
# nvm installs to different places depending on how it was installed, so try
# the usual ones rather than assuming. If none is found the recipes still run
# with whatever `node` is on PATH.
NVM := export NVM_DIR="$$HOME/.nvm"; \
       for candidate in "$$NVM_DIR/nvm.sh" /usr/local/opt/nvm/nvm.sh /opt/homebrew/opt/nvm/nvm.sh; do \
         [ -s "$$candidate" ] && . "$$candidate" && break; \
       done; \
       nvm use >/dev/null 2>&1 || true;

.DEFAULT_GOAL := help
.PHONY: help install demo dev api web seed reset test test-server test-web coverage lint clean stop

help: ## Show this help
	@echo "Interview Auctions"
	@echo
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'
	@echo
	@echo "  First time:  make install && make demo"

# better-sqlite3 is a native module. Prebuilt binaries cover most platforms,
# but not x64 macOS on Node 20 -- there it compiles from source, and on recent
# Command Line Tools the C++ standard headers aren't on the default include
# path, so the build dies with "fatal error: 'climits' file not found".
#
# Pointing at the SDK's libc++ headers fixes it, and setting it unconditionally
# on macOS is harmless where the prebuilt binary is used anyway.
SDK_ENV := if [ "$$(uname)" = "Darwin" ] && command -v xcrun >/dev/null 2>&1; then              export SDKROOT="$$(xcrun --sdk macosx --show-sdk-path)";              export CPLUS_INCLUDE_PATH="$$SDKROOT/usr/include/c++/v1$${CPLUS_INCLUDE_PATH:+:$$CPLUS_INCLUDE_PATH}";            fi;

install: ## Install dependencies for the frontend and the API
	@$(NVM) npm install
	@$(NVM) $(SDK_ENV) cd $(SERVER) && npm install

demo: reset seed ## Fresh database + 300 listings, then run everything
	@echo ""
	@echo "  API   http://localhost:3001"
	@echo "  App   http://localhost:5173"
	@echo ""
	@echo "  A listing called 'Minute Refreshing Item' reopens about once a"
	@echo "  minute, so the countdown's final seconds and the live flip to"
	@echo "  Ended are always a few seconds away. Search DEMO for the fixed"
	@echo "  listings covering every countdown band."
	@echo ""
	@$(MAKE) --no-print-directory dev

dev: ## Run the API and frontend together (no reseed)
	@$(NVM) trap 'kill 0' EXIT INT TERM; \
	  ( cd $(SERVER) && npm run dev & ) ; \
	  npm run dev & \
	  wait

api: ## Run just the API
	@$(NVM) cd $(SERVER) && npm run dev

web: ## Run just the frontend
	@$(NVM) npm run dev

seed: ## Load 300 generated listings and their bid histories
	@$(NVM) cd $(SERVER) && npm run seed:demo

reset: ## Delete the database so the next start rebuilds it from migrations
	@rm -f $(SERVER)/data/auction.db $(SERVER)/data/auction.db-wal $(SERVER)/data/auction.db-shm
	@echo "database removed - migrations and the base fixture rerun on next start"

test: test-server test-web ## Run every test

test-server: ## API tests
	@$(NVM) cd $(SERVER) && npm test

test-web: ## Frontend tests
	@$(NVM) npm test

coverage: ## Run every test with coverage and print a combined summary
	@$(NVM) cd $(SERVER) && npm test -- --coverage --silent || true
	@$(NVM) npm test -- --coverage --silent || true
	@$(NVM) node scripts/coverage-summary.mjs

lint: ## Biome check across the repo
	@$(NVM) npx biome check .

stop: ## Kill anything left listening on the dev ports
	@-lsof -ti :3001 -ti :5173 | xargs kill -9 2>/dev/null || true
	@echo "stopped"

clean: reset ## Remove the database and all build output
	@rm -rf dist coverage $(SERVER)/coverage
	@echo "cleaned"
