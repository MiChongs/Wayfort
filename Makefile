# Plan 18 — build helpers. The most important target is `sync-workersrc`
# which keeps internal/desktop/_workersrc/ in lockstep with the real
# worker source (cmd/freerdp-worker/) + the desktop type files the
# worker depends on. CI runs `make verify-workersrc` to catch drift.

.PHONY: help build build-worker sync-workersrc verify-workersrc test test-bootstrap

help:
	@echo "Common targets:"
	@echo "  make sync-workersrc    # Refresh internal/desktop/_workersrc mirror"
	@echo "  make verify-workersrc  # CI: error if sync-workersrc would change anything"
	@echo "  make build             # Build gateway (untagged — dummy worker backend)"
	@echo "  make build-worker      # Build freerdp-worker binary (-tags freerdp)"
	@echo "  make test              # Unit tests"
	@echo "  make test-bootstrap    # Integration test: real bootstrap pipeline"

build:
	go build -o ./bin/jumpserver ./cmd/jumpserver

build-worker:
	go build -tags freerdp -o ./bin/freerdp-worker ./cmd/freerdp-worker

sync-workersrc:
	./scripts/sync-workersrc.sh

verify-workersrc: sync-workersrc
	@if ! git diff --quiet --exit-code internal/desktop/_workersrc; then \
	  echo "ERROR: internal/desktop/_workersrc is out of sync with cmd/freerdp-worker."; \
	  echo "Run 'make sync-workersrc' and commit the result."; \
	  git diff --stat internal/desktop/_workersrc; \
	  exit 1; \
	fi
	@echo "internal/desktop/_workersrc is in sync."

test:
	go test ./...

test-bootstrap:
	JUMPSERVER_TEST_BOOTSTRAP=1 go test ./internal/desktop/... -v -run TestEnsureWorker_RealBootstrap
