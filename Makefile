# Build helpers.
#
# The freerdp-worker binary is built via OS-native scripts under scripts/
# rather than at gateway startup — see scripts/README.md for rationale.
# `make install-worker` dispatches to the right script for the current OS.

.PHONY: help build build-worker install-worker install-worker-linux install-worker-darwin install-worker-windows test

help:
	@echo "Targets:"
	@echo "  make build                   # Build gateway binary (no CGo) → ./bin/wayfort"
	@echo "  make build-worker            # Build worker binary (-tags freerdp) → ./bin/freerdp-worker"
	@echo "  make install-worker          # Build + install worker (auto-detects OS)"
	@echo "  make install-worker-linux    # Force Linux script"
	@echo "  make install-worker-darwin   # Force macOS script"
	@echo "  make install-worker-windows  # Force Windows PowerShell script"
	@echo "  make test                    # Unit tests"

build:
	bash scripts/build-gateway.sh

build-worker:
	go build -tags freerdp -trimpath -o ./bin/freerdp-worker ./cmd/freerdp-worker

install-worker:
	bash scripts/build-worker.sh

install-worker-linux:
	bash scripts/build-worker-linux.sh

install-worker-darwin:
	bash scripts/build-worker-darwin.sh

install-worker-windows:
	powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-worker-windows.ps1

test:
	go test ./...
