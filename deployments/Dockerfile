# Phase 14 — bumped to go1.26 to track go.mod (was 1.25). Alpine slim
# stays the build environment; the final image only carries the static
# binary so toolchain size doesn't matter.
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/jumpserver ./cmd/jumpserver

FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata openssh-client && adduser -D -u 10001 jumpserver
USER jumpserver
WORKDIR /app
COPY --from=build /out/jumpserver /usr/local/bin/jumpserver
COPY configs/config.example.yaml /app/configs/config.yaml
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/jumpserver"]
CMD ["--config", "/app/configs/config.yaml"]
