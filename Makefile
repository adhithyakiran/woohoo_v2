.DEFAULT_GOAL := help
SHELL := /bin/sh

help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

install: ## Install workspace dependencies
	npm install

check: ## Typecheck the whole workspace
	npm run typecheck

test: ## Run every test, including the eval gates
	npm test

eval: ## Run the eval suites with the CI gate reporter
	npm run eval

eval-adversarial: ## Run only the zero-tolerance adversarial suite
	npm run eval -- adversarial safety

turn: ## Drive one turn, e.g. make turn Q="turn on the lights"
	npm run turn -- "$(Q)"

repl: ## Interactive device simulator; session state persists between turns
	npm run turn

gateway: ## Run the device gateway on :8443
	npm run gateway

edge: ## Run the edge appliance (outbound-only, no listening socket)
	npm run edge

up: ## Bring up the full Docker stack
	docker compose up -d --build

down: ## Tear the stack down
	docker compose down

logs: ## Follow stack logs
	docker compose logs -f

conformance: ## Run the capability conformance suite against the configured adapter
	npm run eval -- capability

ci: check test ## What CI runs: typecheck plus every gate

.PHONY: help install check test eval eval-adversarial turn repl gateway edge up down logs conformance ci
