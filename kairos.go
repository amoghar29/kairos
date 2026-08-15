package kairos

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"

	"github.com/amoghar29/kairos/internal/config"
	"github.com/amoghar29/kairos/internal/db"
	"github.com/amoghar29/kairos/internal/job"
	"github.com/amoghar29/kairos/internal/worker"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

type (
	Job         = worker.Job
	HandlerFunc = worker.HandlerFunc
)

type Config struct {
	RedisCfg         config.RedisConfig
	PostgresCfg      config.PostgresConfig
	WorkerConfigPath string
	Logger           *slog.Logger
}

type RunOptions struct {
	Queues []string
	// Zero falls back to concurrency in the worker config file.
	Concurrency int
}

type Kairos struct {
	cfg      worker.Config
	pool     *pgxpool.Pool
	rdb      *redis.Client
	log      *slog.Logger
	handlers map[string]HandlerFunc
}

func New(ctx context.Context, cfg Config) (*Kairos, error) {
	workerCfg, err := worker.LoadConfig(cfg.WorkerConfigPath)
	if err != nil {
		return nil, err
	}

	logger := cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}

	pool, err := db.NewPool(ctx, cfg.PostgresCfg)
	if err != nil {
		return nil, err
	}

	rdb := redis.NewClient(&redis.Options{
		Addr:     cfg.RedisCfg.Addr,
		Password: cfg.RedisCfg.Password,
		DB:       cfg.RedisCfg.DB,
		Protocol: cfg.RedisCfg.Protocol,
	})
	if err := rdb.Ping(ctx).Err(); err != nil {
		pool.Close()
		rdb.Close()
		return nil, fmt.Errorf("ping redis: %w", err)
	}

	return &Kairos{
		cfg:      workerCfg,
		pool:     pool,
		rdb:      rdb,
		log:      logger,
		handlers: make(map[string]HandlerFunc),
	}, nil
}

func (k *Kairos) AddHandler(name string, handler HandlerFunc) error {
	if name == "" {
		return errors.New("handler name must not be empty")
	}
	if handler == nil {
		return fmt.Errorf("handler %q must not be nil", name)
	}
	if _, dup := k.handlers[name]; dup {
		return fmt.Errorf("handler %q already registered", name)
	}
	k.handlers[name] = handler
	return nil
}

func (k *Kairos) Run(ctx context.Context, opts RunOptions) error {
	if err := validateQueues(opts.Queues); err != nil {
		return err
	}

	concurrency := opts.Concurrency
	if concurrency == 0 {
		concurrency = k.cfg.Concurrency
	}
	if concurrency < 0 {
		return errors.New("concurrency must not be negative")
	}

	if len(k.handlers) == 0 {
		k.log.Warn("no handlers registered, every claimed job will fail")
	}

	jobRepo := job.NewJobRepository(db.New(k.pool))
	w := worker.NewWorkerService(jobRepo, k.rdb, k.log, k.cfg, opts.Queues, concurrency, k.handlers)

	return w.Run(ctx)
}

func (k *Kairos) Close() {
	k.pool.Close()
	if err := k.rdb.Close(); err != nil {
		k.log.Warn("closing redis client", "err", err)
	}
}

func OptionsFromArgs(name string, args []string) (RunOptions, error) {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)

	var opts RunOptions
	fs.Func("queue", "queue to serve; repeat for more, in priority order", func(q string) error {
		opts.Queues = append(opts.Queues, q)
		return nil
	})
	fs.IntVar(&opts.Concurrency, "concurrency", 0, "max jobs run at once; 0 uses the worker config file")

	if err := fs.Parse(args); err != nil {
		return RunOptions{}, err
	}
	return opts, nil
}

func validateQueues(queues []string) error {
	if len(queues) == 0 {
		return errors.New("at least one queue must be given")
	}
	seen := make(map[string]struct{}, len(queues))
	for _, q := range queues {
		if q == "" {
			return errors.New("queue name must not be empty")
		}
		if _, dup := seen[q]; dup {
			return fmt.Errorf("duplicate queue name %q", q)
		}
		seen[q] = struct{}{}
	}
	return nil
}
