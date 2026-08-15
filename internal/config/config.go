package config

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"time"

	"gopkg.in/yaml.v3"
)

type PostgresConfig struct {
	DSN               string
	MaxConns          int32
	MinConns          int32
	MaxConnLifetime   time.Duration
	MaxConnIdleTime   time.Duration
	HealthCheckPeriod time.Duration
}

type RedisConfig struct {
	Addr     string
	Password string
	DB       int
	Protocol int
}

type LogConfig struct {
	File string
}

type Config struct {
	Port     int
	Postgres PostgresConfig
	Log      LogConfig
}

type Queue struct {
	Name string `yaml:"name"`
}

type Queues []Queue


type Duration time.Duration

func (d *Duration) UnmarshalYAML(value *yaml.Node) error {
	var s string
	if err := value.Decode(&s); err != nil {
		return fmt.Errorf("duration must be a string such as \"30s\": %w", err)
	}
	parsed, err := time.ParseDuration(s)
	if err != nil {
		return fmt.Errorf("invalid duration %q: %w", s, err)
	}
	*d = Duration(parsed)
	return nil
}

func (d Duration) Std() time.Duration { return time.Duration(d) }

type ConsumerConfig struct {
	PollInterval int `yaml:"poll_interval"`
	// QueueLimit caps how many due jobs are fetched per queue per poll. Global for now.
	// TODO: allow a per-queue override on Queue that falls back to this.
	QueueLimit       int     `yaml:"queue_limit"`
	MaxDeliveryCount int     `yaml:"max_delivery_count"`
	ClaimDeadline    int     `yaml:"claim_deadline"`
	Queues           Queues  `yaml:"queues"`
	AgingRate        float64 `yaml:"aging_rate"`
}

func LoadPostgresConfig() (PostgresConfig, error) {
	dsn := os.Getenv("DBDSN")
	if dsn == "" {
		return PostgresConfig{}, errors.New("DBDSN must be set")
	}

	maxConns, err := strconv.Atoi(os.Getenv("DB_MAX_CONNS"))
	if err != nil {
		return PostgresConfig{}, errors.New("DB_MAX_CONNS must be set to an integer")
	}

	minConns, err := strconv.Atoi(os.Getenv("DB_MIN_CONNS"))
	if err != nil {
		return PostgresConfig{}, errors.New("DB_MIN_CONNS must be set to an integer")
	}

	maxConnLifetime, err := time.ParseDuration(os.Getenv("DB_MAX_CONN_LIFETIME"))
	if err != nil {
		return PostgresConfig{}, errors.New("DB_MAX_CONN_LIFETIME must be set to a duration such as 1h")
	}

	maxConnIdleTime, err := time.ParseDuration(os.Getenv("DB_MAX_CONN_IDLE_TIME"))
	if err != nil {
		return PostgresConfig{}, errors.New("DB_MAX_CONN_IDLE_TIME must be set to a duration such as 30m")
	}

	healthCheckPeriod, err := time.ParseDuration(os.Getenv("DB_HEALTH_CHECK_PERIOD"))
	if err != nil {
		return PostgresConfig{}, errors.New("DB_HEALTH_CHECK_PERIOD must be set to a duration such as 1m")
	}

	if maxConns <= 0 {
		return PostgresConfig{}, errors.New("DB_MAX_CONNS must be greater than 0")
	}
	if minConns < 0 || minConns > maxConns {
		return PostgresConfig{}, errors.New("DB_MIN_CONNS must be between 0 and DB_MAX_CONNS")
	}

	return PostgresConfig{
		DSN:               dsn,
		MaxConns:          int32(maxConns),
		MinConns:          int32(minConns),
		MaxConnLifetime:   maxConnLifetime,
		MaxConnIdleTime:   maxConnIdleTime,
		HealthCheckPeriod: healthCheckPeriod,
	}, nil
}

func LoadRedisConfig() (RedisConfig, error) {
	addr := os.Getenv("REDIS_ADDR")
	if addr == "" {
		return RedisConfig{}, errors.New("REDIS_ADDR must be set")
	}

	dbIndex, err := strconv.Atoi(os.Getenv("REDIS_DB"))
	if err != nil {
		return RedisConfig{}, errors.New("REDIS_DB must be set to an integer")
	}

	protocol, err := strconv.Atoi(os.Getenv("REDIS_PROTOCOL"))
	if err != nil {
		return RedisConfig{}, errors.New("REDIS_PROTOCOL must be set to an integer")
	}

	// Empty means no auth.
	return RedisConfig{
		Addr:     addr,
		Password: os.Getenv("REDIS_PASSWORD"),
		DB:       dbIndex,
		Protocol: protocol,
	}, nil
}

// Empty path means stdout, which also selects the text/debug handler in internal/logging.
func LoadLogConfig(path string) LogConfig {
	return LogConfig{File: path}
}

func LoadAPIConfig() (*Config, error) {
	postgres, err := LoadPostgresConfig()
	if err != nil {
		return nil, err
	}

	port, err := strconv.Atoi(os.Getenv("PORT"))
	if err != nil {
		return nil, errors.New("PORT must be set to an integer")
	}

	return &Config{
		Port:     port,
		Postgres: postgres,
		Log:      LoadLogConfig(os.Getenv("API_LOG_FILE")),
	}, nil
}

func LoadConsumerConfig() (ConsumerConfig, error) {
	path := os.Getenv("CONSUMER_CONFIG_PATH")
	if path == "" {
		return ConsumerConfig{}, errors.New("CONSUMER_CONFIG_PATH must be set")
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return ConsumerConfig{}, fmt.Errorf("reading consumer config %s: %w", path, err)
	}

	cfg := ConsumerConfig{}
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return ConsumerConfig{}, fmt.Errorf("parsing consumer config %s: %w", path, err)
	}

	if err := cfg.validate(); err != nil {
		return ConsumerConfig{}, err
	}

	return cfg, nil
}

func (c *ConsumerConfig) validate() error {
	if c.PollInterval <= 0 {
		return errors.New("poll_interval must be greater than 0")
	}
	if c.MaxDeliveryCount <= 0 {
		return errors.New("max_delivery_count must be greater than 0")
	}
	if c.QueueLimit <= 0 {
		return errors.New("queue_limit must be greater than 0")
	}
	// A deadline shorter than the poll interval can pass before a worker has had a realistic
	// chance to pick the job up, since expiry is only ever noticed on a poll.
	if c.ClaimDeadline <= 0 || c.ClaimDeadline <= c.PollInterval {
		return errors.New("claim_deadline (seconds) must be greater than 0 and longer than poll_interval")
	}

	seen := make(map[string]struct{}, len(c.Queues))
	for i, q := range c.Queues {
		if q.Name == "" {
			return fmt.Errorf("queues[%d]: name must not be empty", i)
		}
		if _, dup := seen[q.Name]; dup {
			return fmt.Errorf("queues[%d]: duplicate queue name %q", i, q.Name)
		}
		seen[q.Name] = struct{}{}
	}

	return nil
}

func LoadQueues() (Queues, error) {
	cfg, err := LoadConsumerConfig()
	if err != nil {
		return nil, err
	}
	return cfg.Queues, nil
}

func (qs Queues) Exists(name string) bool {
	for _, q := range qs {
		if q.Name == name {
			return true
		}
	}
	return false
}
