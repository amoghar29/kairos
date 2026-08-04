package config

import (
	"errors"
	"fmt"
	"os"
	"strconv"

	"gopkg.in/yaml.v3"
)

const (
	defaultPort = 8080
	defaultEnv  = EnvDevelopment

	EnvDevelopment = "development"
	EnvProduction  = "production"

	defaultConsumerConfigPath = "consumer.yaml"
)

type Config struct {
	Port  int
	DBDSN string
	Env   string
}

type Queue struct {
	Name  string `yaml:"name"`
	Limit int    `yaml:"limit"`
}

type Queues []Queue

type ConsumerConfig struct {
	PollInterval      int    `yaml:"poll_interval"`
	StaleThreshold    int    `yaml:"stale_threshold"`
	HeartbeatInterval int    `yaml:"heartbeat_interval"`
	DefaultQueueLimit int    `yaml:"default_queue_limit"`
	MaxDeliveryCount  int    `yaml:"max_delivery_count"`
	Queues            Queues `yaml:"queues"`
}

func (c *Config) IsDevelopment() bool {
	return c.Env == EnvDevelopment
}

func LoadAPIConfig() (*Config, error) {
	dsn := os.Getenv("DBDSN")
	if dsn == "" {
		return nil, errors.New("DBDSN must be set")
	}

	port := defaultPort
	if raw := os.Getenv("PORT"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil {
			return nil, errors.New("PORT must be an integer")
		}
		port = parsed
	}

	env := os.Getenv("ENV")
	switch env {
	case "":
		env = defaultEnv
	case EnvDevelopment, EnvProduction:
	default:
		return nil, errors.New("ENV must be either development or production")
	}

	return &Config{
		Port:  port,
		DBDSN: dsn,
		Env:   env,
	}, nil
}

func LoadConsumerConfig() (ConsumerConfig, error) {
	path := os.Getenv("CONSUMER_CONFIG_PATH")
	if path == "" {
		path = defaultConsumerConfigPath
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
	if c.HeartbeatInterval <= 0 || c.HeartbeatInterval >= c.StaleThreshold {
		return errors.New("heartbeat_interval must be greater than 0 and less than stale_threshold")
	}
	if c.MaxDeliveryCount <= 0 {
		return errors.New("max_delivery_count must be greater than 0")
	}
	if c.DefaultQueueLimit <= 0 {
		return errors.New("default_queue_limit must be greater than 0")
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

		if q.Limit <= 0 {
			c.Queues[i].Limit = c.DefaultQueueLimit
		}
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

