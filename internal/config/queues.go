package config

import (
	"fmt"
	"os"
	"sort"

	"gopkg.in/yaml.v3"
)

type queuesFile struct {
	DefaultQueue string   `yaml:"default_queue"`
	Queues       []string `yaml:"queues"`
}

type Queues struct {
	Default string
	names   map[string]struct{}
}

func LoadQueues(path string) (*Queues, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("reading queue config %s: %w", path, err)
	}

	var parsed queuesFile
	if err := yaml.Unmarshal(raw, &parsed); err != nil {
		return nil, fmt.Errorf("parsing queue config %s: %w", path, err)
	}

	if len(parsed.Queues) == 0 {
		return nil, fmt.Errorf("queue config %s declares no queues", path)
	}

	names := make(map[string]struct{}, len(parsed.Queues))
	for _, name := range parsed.Queues {
		if name == "" {
			return nil, fmt.Errorf("queue config %s contains an empty queue name", path)
		}
		if _, dup := names[name]; dup {
			return nil, fmt.Errorf("queue config %s declares %q more than once", path, name)
		}
		names[name] = struct{}{}
	}

	if parsed.DefaultQueue == "" {
		return nil, fmt.Errorf("queue config %s is missing default_queue", path)
	}
	if _, ok := names[parsed.DefaultQueue]; !ok {
		return nil, fmt.Errorf("queue config %s sets default_queue to %q, which is not in queues", path, parsed.DefaultQueue)
	}

	return &Queues{Default: parsed.DefaultQueue, names: names}, nil
}

func (q *Queues) Exists(name string) bool {
	_, ok := q.names[name]
	return ok
}

func (q *Queues) Names() []string {
	out := make([]string, 0, len(q.names))
	for name := range q.names {
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}
