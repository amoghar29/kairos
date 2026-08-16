package queue

const keyPrefix = "queue:"

// Key returns the Redis list holding pending job IDs for a queue.
func Key(name string) string {
	return keyPrefix + name
}
