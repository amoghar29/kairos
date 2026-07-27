package config

import (
	"errors"
	"os"
	"strconv"
)

const (
	defaultPort       = 8080
	defaultQueuesPath = "queues.yaml"
	defaultEnv        = EnvDevelopment
	EnvDevelopment = "development"
	EnvProduction  = "production"
)

type Config struct {
	Port       int
	DBDSN      string
	QueuesPath string
	Env        string
}

func (c *Config) IsDevelopment() bool {
	return c.Env == EnvDevelopment
}

func LoadConfig() (*Config, error) {
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

	queuesPath := os.Getenv("QUEUES_PATH")
	if queuesPath == "" {
		queuesPath = defaultQueuesPath
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
		Port:       port,
		DBDSN:      dsn,
		QueuesPath: queuesPath,
		Env:        env,
	}, nil
}
