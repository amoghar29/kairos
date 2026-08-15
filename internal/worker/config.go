package worker

import (
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/amoghar29/kairos/internal/config"
	"gopkg.in/yaml.v3"
)

type QueueStrategy string

const (
	QueueStrategyPriority   QueueStrategy = "priority"
	QueueStrategyRoundRobin QueueStrategy = "round_robin"
)

func (q QueueStrategy) Valid() bool {
	switch q {
	case QueueStrategyPriority, QueueStrategyRoundRobin:
		return true
	}
	return false
}

type PartitionInterval string

const (
	PartitionWeekly     PartitionInterval = "weekly"
	PartitionMonthly    PartitionInterval = "monthly"
	PartitionQuarterly  PartitionInterval = "quarterly"
	PartitionHalfYearly PartitionInterval = "half_yearly"
	PartitionYearly     PartitionInterval = "yearly"
)

func (p PartitionInterval) Valid() bool {
	switch p {
	case PartitionWeekly, PartitionMonthly, PartitionQuarterly, PartitionHalfYearly, PartitionYearly:
		return true
	}
	return false
}

type PartitioningConfig struct {
	Interval    PartitionInterval `yaml:"interval"`
	CreateAhead int               `yaml:"create_ahead"`
}

type RetentionConfig struct {
	Days int `yaml:"days"`
}

type DatabaseConfig struct {
	Partitioning PartitioningConfig `yaml:"partitioning"`
	Retention    RetentionConfig    `yaml:"retention"`
}

type Config struct {
	Database DatabaseConfig `yaml:"database"`

	Concurrency   int             `yaml:"concurrency"`
	BRPopTimeout  config.Duration `yaml:"brpop_timeout"`
	QueueStrategy QueueStrategy   `yaml:"queue_strategy"`

	RetryBackoffBase config.Duration `yaml:"retry_backoff_base"`
	RetryBackoffMax  config.Duration `yaml:"retry_backoff_max"`

	OutcomeWriteTimeout config.Duration `yaml:"outcome_write_timeout"`
	ShutdownGrace       config.Duration `yaml:"shutdown_grace"`

	HeartbeatInterval config.Duration `yaml:"heartbeat_interval"`
	StaleMultiplier   int             `yaml:"stale_multiplier"`

	RegistryInterval config.Duration `yaml:"registry_interval"`
	RegistryTTL      config.Duration `yaml:"registry_ttl"`

	LogFlushInterval  config.Duration `yaml:"log_flush_interval"`
	LogFlushTimeout   config.Duration `yaml:"log_flush_timeout"`
	LogFlushThreshold int             `yaml:"log_flush_threshold"`
	LogBufferCapacity int             `yaml:"log_buffer_capacity"`
}

func (c Config) StaleDelta() time.Duration {
	return c.HeartbeatInterval.Std() * time.Duration(c.StaleMultiplier)
}

func LoadConfig() (Config, error) {
	path := os.Getenv("WORKER_CONFIG_PATH")
	if path == "" {
		return Config{}, errors.New("WORKER_CONFIG_PATH must be set")
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return Config{}, fmt.Errorf("reading worker config %s: %w", path, err)
	}

	cfg := Config{}
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return Config{}, fmt.Errorf("parsing worker config %s: %w", path, err)
	}

	if err := cfg.validate(); err != nil {
		return Config{}, err
	}

	return cfg, nil
}

func (c *Config) validate() error {
	if !c.Database.Partitioning.Interval.Valid() {
		return fmt.Errorf("database.partitioning.interval %q must be one of weekly, monthly, quarterly, half_yearly, yearly", c.Database.Partitioning.Interval)
	}
	if c.Database.Partitioning.CreateAhead <= 0 {
		return errors.New("database.partitioning.create_ahead must be greater than 0")
	}
	if c.Database.Retention.Days < 0 {
		return errors.New("database.retention.days must not be negative")
	}
	if c.Concurrency <= 0 {
		return errors.New("concurrency must be greater than 0")
	}
	if c.BRPopTimeout <= 0 {
		return errors.New("brpop_timeout must be greater than 0")
	}
	if !c.QueueStrategy.Valid() {
		return fmt.Errorf("queue_strategy %q must be one of priority, round_robin", c.QueueStrategy)
	}
	if c.RetryBackoffBase <= 0 {
		return errors.New("retry_backoff_base must be greater than 0")
	}
	if c.RetryBackoffMax < c.RetryBackoffBase {
		return errors.New("retry_backoff_max must be at least retry_backoff_base")
	}
	if c.OutcomeWriteTimeout <= 0 {
		return errors.New("outcome_write_timeout must be greater than 0")
	}
	if c.ShutdownGrace <= 0 {
		return errors.New("shutdown_grace must be greater than 0")
	}
	if c.HeartbeatInterval <= 0 {
		return errors.New("heartbeat_interval must be greater than 0")
	}
	if c.StaleMultiplier < 2 {
		return errors.New("stale_multiplier must be at least 2")
	}
	if c.RegistryInterval <= 0 {
		return errors.New("registry_interval must be greater than 0")
	}
	if c.RegistryTTL < 2*c.RegistryInterval {
		return errors.New("registry_ttl must be at least twice registry_interval")
	}
	if c.LogFlushInterval <= 0 {
		return errors.New("log_flush_interval must be greater than 0")
	}
	if c.LogFlushTimeout <= 0 {
		return errors.New("log_flush_timeout must be greater than 0")
	}
	if c.LogFlushThreshold <= 0 {
		return errors.New("log_flush_threshold must be greater than 0")
	}
	if c.LogBufferCapacity < 2*c.LogFlushThreshold {
		return errors.New("log_buffer_capacity must be at least twice log_flush_threshold")
	}

	return nil
}
