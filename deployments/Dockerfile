# Phase 14 — bumped to go1.26 to track go.mod (was 1.25). Alpine slim
# stays the build environment; the final image only carries the static
# binary so toolchain size doesn't matter.
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/wayfort ./cmd/wayfort

FROM alpine:3.20
# busybox `wget` (bundled) backs the compose healthcheck against /healthz.
RUN apk add --no-cache ca-certificates tzdata openssh-client \
    && adduser -D -u 10001 wayfort \
    # Pre-create the runtime state dir owned by the non-root user. The compose
    # `wayfort_var` named volume mounts here; an empty volume inherits this
    # ownership on first run, so the app can write keystore.unseal + sessions/
    # as uid 10001 (no root, no chown-at-runtime dance).
    && mkdir -p /app/var/sessions /app/configs \
    && chown -R wayfort:wayfort /app
WORKDIR /app
COPY --from=build /out/wayfort /usr/local/bin/wayfort
COPY configs/config.example.yaml /app/configs/config.yaml
USER wayfort
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/wayfort"]
CMD ["--config", "/app/configs/config.yaml"]
