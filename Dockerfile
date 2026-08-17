FROM golang:1.26-alpine AS build
WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 go build -o /out/api ./cmd/api && \
    CGO_ENABLED=0 go build -o /out/consumer ./cmd/consumer

FROM build AS goose-build
RUN go install github.com/pressly/goose/v3/cmd/goose@latest

FROM alpine:3.20 AS base
RUN adduser -D -u 10001 kairos
WORKDIR /app

COPY consumer.yaml /app/consumer.yaml
USER kairos

FROM base AS api
COPY --from=build /out/api /usr/local/bin/api
EXPOSE 8000
ENTRYPOINT ["api"]

FROM base AS consumer
COPY --from=build /out/consumer /usr/local/bin/consumer
ENTRYPOINT ["consumer"]

FROM alpine:3.20 AS migrate
WORKDIR /migrations
COPY --from=goose-build /go/bin/goose /usr/local/bin/goose
COPY internal/db/migrations /migrations
ENTRYPOINT ["goose", "-dir", "/migrations", "postgres"]
