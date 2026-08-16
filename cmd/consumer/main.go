package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"

	"github.com/amoghar29/kairos/internal/config"
	"github.com/amoghar29/kairos/internal/consumer"
	"github.com/amoghar29/kairos/internal/db"
	"github.com/amoghar29/kairos/internal/job"
	"github.com/amoghar29/kairos/internal/logging"
	"github.com/joho/godotenv"
	"github.com/redis/go-redis/v9"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "consumer: startup failed: %v\n", err)
		os.Exit(1)
	}
}

func run() (err error) {
	godotenv.Load()

	ctx := context.Background()
	cfg, err := config.LoadConsumerConfig()
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}

	logConfig := config.LoadLogConfig(os.Getenv("CONSUMER_LOG_FILE"))
	logger, logFile, err := logging.New(logConfig.File)
	if err != nil {
		return fmt.Errorf("init logging: %w", err)
	}
	defer logFile.Close()

	defer func() {
		if err != nil {
			logger.Error("consumer exiting", slog.Any("error", err))
		}
	}()

	pgCfg, err := config.LoadPostgresConfig()
	if err != nil {
		return fmt.Errorf("load postgres config: %w", err)
	}
	dbPool, err := db.NewPool(ctx, pgCfg)
	if err != nil {
		return fmt.Errorf("connect to postgres: %w", err)
	}
	defer dbPool.Close()

	redisCfg, err := config.LoadRedisConfig()
	if err != nil {
		return fmt.Errorf("load redis config: %w", err)
	}
	rdb := redis.NewClient(&redis.Options{
		Addr:     redisCfg.Addr,
		Password: redisCfg.Password,
		DB:       redisCfg.DB,
		Protocol: redisCfg.Protocol,
	})
	defer rdb.Close()

	jobRepo := job.New(db.New(dbPool))
	jobConsumer := consumer.NewJobConsumer(jobRepo, rdb, cfg, logger)
	jobConsumer.RunConsumer(ctx)

	return nil
}
