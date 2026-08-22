package client

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/amoghar29/kairos/models"
)

type capture struct {
	method string
	path   string
	query  string
	header http.Header
	body   string
}

func newServer(t *testing.T, handler func(w http.ResponseWriter, r *http.Request)) (*Client, *capture) {
	t.Helper()

	got := &capture{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		got.method, got.path, got.query, got.header, got.body = r.Method, r.URL.Path, r.URL.RawQuery, r.Header, string(b)

		w.Header().Set("Content-Type", "application/json")
		handler(w, r)
	}))
	t.Cleanup(srv.Close)

	return New(&Opt{RootURL: srv.URL + "/api/v1/"}), got
}

func TestPostJob(t *testing.T) {
	c, got := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(models.JobResponse{ID: "job-1", Name: "send-email", Version: 1})
	})

	job, err := c.PostJob(context.Background(),
		models.CreateJobRequest{Name: "send-email", Queue: "default", Handler: "email"}, "key-1")
	if err != nil {
		t.Fatalf("PostJob: %v", err)
	}

	if job.ID != "job-1" || job.Version != 1 {
		t.Errorf("decoded %+v, want ID job-1 version 1", job)
	}
	if got.path != "/api/v1/jobs" {
		t.Errorf("path = %q", got.path)
	}
	if h := got.header.Get("Idempotency-Key"); h != "key-1" {
		t.Errorf("Idempotency-Key = %q", h)
	}
	if ct := got.header.Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q", ct)
	}
}

func TestGetJobsQueryEncoding(t *testing.T) {
	c, got := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(models.JobListResponse{
			Jobs:       []models.JobResponse{{ID: "job-1"}},
			Pagination: models.PaginationResponse{Limit: 5, HasMore: true},
		})
	})

	list, err := c.GetJobs(context.Background(), JobQuery{
		States: []string{"pending", "dead"},
		Queue:  "default",
		Limit:  5,
	})
	if err != nil {
		t.Fatalf("GetJobs: %v", err)
	}

	if len(list.Jobs) != 1 || !list.Pagination.HasMore {
		t.Errorf("decoded %+v", list)
	}
	// Offset is zero, so it is omitted and the server default applies.
	if want := "limit=5&queue=default&state=pending&state=dead"; got.query != want {
		t.Errorf("query = %q, want %q", got.query, want)
	}
}

func TestDeleteJobNoContent(t *testing.T) {
	c, got := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})

	if err := c.DeleteJob(context.Background(), "job-1"); err != nil {
		t.Fatalf("DeleteJob: %v", err)
	}
	if got.method != http.MethodDelete || got.path != "/api/v1/jobs/job-1" {
		t.Errorf("%s %s", got.method, got.path)
	}
}

func TestConflictError(t *testing.T) {
	c, got := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
		json.NewEncoder(w).Encode(models.ErrorResponse{
			Message: "job was modified by another request",
			Code:    models.CodeConflict,
		})
	})

	_, err := c.CancelJob(context.Background(), "job-1", 3)

	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("err = %T %v, want *APIError", err, err)
	}
	if !apiErr.Conflict() || apiErr.Code != models.CodeConflict {
		t.Errorf("apiErr = %+v", apiErr)
	}
	if got.body != `{"version":3}` {
		t.Errorf("body = %s", got.body)
	}
}

func TestValidationErrorFields(t *testing.T) {
	c, _ := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnprocessableEntity)
		json.NewEncoder(w).Encode(models.ErrorResponse{
			Message: "the request body failed validation",
			Code:    models.CodeValidationFailed,
			Fields:  map[string]string{"queue": `unknown queue "nope"`},
		})
	})

	_, err := c.PostJob(context.Background(), models.CreateJobRequest{Queue: "nope"}, "")

	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("err = %T %v, want *APIError", err, err)
	}
	if apiErr.Fields["queue"] == "" {
		t.Errorf("fields not decoded: %+v", apiErr)
	}
}

func TestContextCancellation(t *testing.T) {
	c, _ := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(models.QueueListResponse{})
	})

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if _, err := c.GetQueues(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
}

func TestRetriesThenSucceeds(t *testing.T) {
	var calls int
	c, _ := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls < 3 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		json.NewEncoder(w).Encode(models.QueueListResponse{Queues: []models.QueueStat{{Queue: "default"}}})
	})

	out, err := c.GetQueues(context.Background())
	if err != nil {
		t.Fatalf("GetQueues: %v", err)
	}
	if calls != 3 {
		t.Errorf("calls = %d, want 3", calls)
	}
	if len(out.Queues) != 1 {
		t.Errorf("decoded %+v", out)
	}
}

func TestRetriesExhausted(t *testing.T) {
	var calls int
	c, _ := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(http.StatusBadGateway)
	})

	_, err := c.GetQueues(context.Background())

	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.StatusCode != http.StatusBadGateway {
		t.Fatalf("err = %v", err)
	}
	if calls != maxRetries+1 {
		t.Errorf("calls = %d, want %d", calls, maxRetries+1)
	}
}

func TestNoRetryOnClientError(t *testing.T) {
	var calls int
	c, _ := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(http.StatusUnprocessableEntity)
		json.NewEncoder(w).Encode(models.ErrorResponse{Message: "bad", Code: models.CodeValidationFailed})
	})

	if _, err := c.GetQueues(context.Background()); err == nil {
		t.Fatal("want error")
	}
	if calls != 1 {
		t.Errorf("calls = %d, want 1", calls)
	}
}

func TestPostJobNotReplayedWithoutIdempotencyKey(t *testing.T) {
	var calls int
	c, _ := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(http.StatusServiceUnavailable)
	})

	if _, err := c.PostJob(context.Background(), models.CreateJobRequest{Name: "n"}, ""); err == nil {
		t.Fatal("want error")
	}
	if calls != 1 {
		t.Errorf("calls = %d, want 1 — a job create without a key must not be replayed", calls)
	}
}

func TestPostJobReplayedWithIdempotencyKey(t *testing.T) {
	var calls int
	c, _ := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls < 2 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(models.JobResponse{ID: "job-1"})
	})

	job, err := c.PostJob(context.Background(), models.CreateJobRequest{Name: "n"}, "key-1")
	if err != nil {
		t.Fatalf("PostJob: %v", err)
	}
	if calls != 2 || job.ID != "job-1" {
		t.Errorf("calls = %d, job = %+v", calls, job)
	}
}

func TestVersionedPostIsReplayed(t *testing.T) {
	var calls int
	c, got := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls < 2 {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		json.NewEncoder(w).Encode(models.JobResponse{ID: "job-1", Version: 4})
	})

	if _, err := c.CancelJob(context.Background(), "job-1", 3); err != nil {
		t.Fatalf("CancelJob: %v", err)
	}
	if calls != 2 {
		t.Errorf("calls = %d, want 2", calls)
	}
	// The body must be re-sent intact on the replay, not consumed by attempt one.
	if got.body != `{"version":3}` {
		t.Errorf("replayed body = %q", got.body)
	}
}

func TestNoRetryOn429(t *testing.T) {
	var calls int
	c, _ := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(http.StatusTooManyRequests)
	})

	if _, err := c.GetQueues(context.Background()); err == nil {
		t.Fatal("want error")
	}
	if calls != 1 {
		t.Errorf("calls = %d, want 1 — the API has no rate limiting, so 429 is not a transient it can clear", calls)
	}
}
