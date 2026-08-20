package client

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/amoghar29/kairos/models"
)

const (
	uriListQueues = "/queues"

	uriListWorkers = "/workers"

	uriListHandlers = "/handlers"

	// %s = handler name
	uriGetHandler = "/handlers/%s"

	uriPostJob = "/jobs"

	uriListJobs = "/jobs"

	// %s = jobId
	uriGetJob = "/jobs/%s"

	// %s = jobId
	uriDeleteJob = "/jobs/%s"

	// %s = jobId
	uriCancelJobs = "/jobs/%s/cancel"

	// %s = jobId
	uriRerunJob = "/jobs/%s/rerun"

	// %s = jobId
	uriPauseJob = "/jobs/%s/pause"

	// %s = jobId
	uriRescheduleJob = "/jobs/%s/schedule"

	// %s = jobId
	uriListJobAttempts = "/jobs/%s/attempts"

	// %s = jobId, %s = attemptId
	uriListAttemptLogs = "/jobs/%s/attempts/%s/logs"
)

const (
	exponentialDelay = 100 * time.Millisecond
	maxRetries       = 3
)
const defaultTimeout = 30 * time.Second

const idempotencyHeader = "Idempotency-Key"

type Opt struct {
	RootURL    string
	HTTPClient *http.Client
}

type Client struct {
	o *Opt
}

func New(o *Opt) *Client {
	c := &Client{o: &Opt{
		RootURL:    strings.TrimRight(o.RootURL, "/"),
		HTTPClient: o.HTTPClient,
	}}

	if c.o.HTTPClient == nil {
		c.o.HTTPClient = &http.Client{Timeout: defaultTimeout}
	}

	return c
}

type APIError struct {
	StatusCode int
	models.ErrorResponse
}

func (e *APIError) Error() string {
	if len(e.Fields) > 0 {
		return fmt.Sprintf("%d %s: %s %v", e.StatusCode, e.Code, e.Message, e.Fields)
	}
	return fmt.Sprintf("%d %s: %s", e.StatusCode, e.Code, e.Message)
}

func (e *APIError) NotFound() bool { return e.StatusCode == http.StatusNotFound }

func (e *APIError) Conflict() bool { return e.StatusCode == http.StatusConflict }

// replayable reports whether re-sending the request can change the outcome on the
// server. GET and DELETE are idempotent. Creating a job is only safe to replay when
// an Idempotency-Key lets the server dedupe it; the other POSTs are guarded by the
// job version, so a replay is rejected rather than double-applied.
func replayable(method, rURI string, headers http.Header) bool {
	if method != http.MethodPost {
		return true
	}
	if rURI == uriPostJob {
		return headers.Get(idempotencyHeader) != ""
	}
	return true
}

// retriableStatus covers the 500 the API itself returns, plus the gateway codes a
// proxy in front of it emits while the server is unreachable — the same transient
// condition a bare connection error signals when nothing is proxying. Every 4xx is
// deterministic and is returned on the first attempt.
func retriableStatus(code int) bool {
	switch code {
	case http.StatusInternalServerError,
		http.StatusBadGateway,
		http.StatusServiceUnavailable,
		http.StatusGatewayTimeout:
		return true
	}
	return false
}

// backoff is exponential with equal jitter, so clients that fail together do not
// come back in lockstep.
func backoff(attempt int) time.Duration {
	half := (exponentialDelay << (attempt - 1)) / 2
	return half + time.Duration(rand.Int64N(int64(half)+1))
}

func sleep(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()

	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

func (c *Client) doHTTPReqWithRetry(
	ctx context.Context,
	method string,
	rURI string,
	reqBody interface{},
	headers http.Header,
	obj interface{},
) error {
	attempts := 1
	if replayable(method, rURI, headers) {
		attempts = maxRetries + 1
	}

	for attempt := 1; ; attempt++ {
		retry, err := c.doHTTPReq(ctx, method, rURI, reqBody, headers, obj)
		if !retry || attempt >= attempts {
			return err
		}

		if sleep(ctx, backoff(attempt)) != nil {
			return err
		}
	}
}

// doHTTPReq performs one attempt. It reports whether the failure it returns is
// worth repeating; a nil error is never retried.
func (c *Client) doHTTPReq(
	ctx context.Context,
	method string,
	rURI string,
	reqBody interface{},
	headers http.Header,
	obj interface{},
) (bool, error) {
	var postBody io.Reader

	uri := c.o.RootURL + rURI

	// POST body
	if reqBody != nil && method == http.MethodPost {
		b, err := json.Marshal(reqBody)
		if err != nil {
			return false, fmt.Errorf("error marshalling request body: %v", err)
		}

		postBody = bytes.NewReader(b)
	}

	// Create request
	req, err := http.NewRequestWithContext(ctx, method, uri, postBody)
	if err != nil {
		return false, fmt.Errorf("request preparation failed: %v", err)
	}

	// Headers
	if headers != nil {
		req.Header = headers
	}
	// POST JSON
	if req.Header.Get("Content-Type") == "" &&
		method == http.MethodPost {
		req.Header.Set("Content-Type", "application/json")
	}

	// GET / DELETE query params
	if reqBody != nil &&
		(method == http.MethodGet || method == http.MethodDelete) {

		params, ok := reqBody.(url.Values)
		if !ok {
			return false, fmt.Errorf("expected url.Values for query params")
		}

		req.URL.RawQuery = params.Encode()
	}

	// Send request
	r, err := c.o.HTTPClient.Do(req)
	if err != nil {
		return ctx.Err() == nil, fmt.Errorf("request failed: %w", err)
	}

	defer func() {
		io.Copy(io.Discard, r.Body)
		r.Body.Close()
	}()

	// Read response
	body, err := io.ReadAll(r.Body)
	if err != nil {
		return ctx.Err() == nil, fmt.Errorf("error reading response: %w", err)
	}

	// Handle non-2xx
	if r.StatusCode < 200 || r.StatusCode > 299 {
		e := &APIError{StatusCode: r.StatusCode}
		if err := json.Unmarshal(body, &e.ErrorResponse); err != nil || e.Message == "" {
			e.Message = http.StatusText(r.StatusCode)
		}

		return retriableStatus(r.StatusCode) && ctx.Err() == nil, e
	}

	// Decode response. The payload is written at the top level, so there
	// is no envelope to unwrap. 204s and DeleteJob pass a nil obj.
	if obj == nil || len(body) == 0 {
		return false, nil
	}

	if err := json.Unmarshal(body, obj); err != nil {
		return false, fmt.Errorf("error unmarshaling JSON response: %v", err)
	}

	return false, nil
}

type JobQuery struct {
	States  []string
	Queue   string
	Handler string
	JobType string
	Search  string
	Limit   int32
	Offset  int32
}

func (q JobQuery) values() url.Values {
	v := url.Values{}
	for _, s := range q.States {
		v.Add("state", s)
	}
	setStr(v, "queue", q.Queue)
	setStr(v, "handler", q.Handler)
	setStr(v, "job_type", q.JobType)
	setStr(v, "q", q.Search)
	setInt(v, "limit", q.Limit)
	setInt(v, "offset", q.Offset)
	return v
}

type PageQuery struct {
	Limit  int32
	Offset int32
}

func (q PageQuery) values() url.Values {
	v := url.Values{}
	setInt(v, "limit", q.Limit)
	setInt(v, "offset", q.Offset)
	return v
}

type LogQuery struct {
	AfterSeq int32
	Limit    int32
}

func (q LogQuery) values() url.Values {
	v := url.Values{}
	setInt(v, "after_seq", q.AfterSeq)
	setInt(v, "limit", q.Limit)
	return v
}

func setStr(v url.Values, key, val string) {
	if val != "" {
		v.Set(key, val)
	}
}

func setInt(v url.Values, key string, val int32) {
	if val != 0 {
		v.Set(key, strconv.FormatInt(int64(val), 10))
	}
}

func (c *Client) GetQueues(ctx context.Context) (models.QueueListResponse, error) {
	var out models.QueueListResponse
	err := c.doHTTPReqWithRetry(ctx, http.MethodGet, uriListQueues, nil, nil, &out)
	return out, err
}

func (c *Client) GetWorkers(ctx context.Context) (models.WorkerListResponse, error) {
	var out models.WorkerListResponse
	err := c.doHTTPReqWithRetry(ctx, http.MethodGet, uriListWorkers, nil, nil, &out)
	return out, err
}

func (c *Client) GetHandlers(ctx context.Context) (models.HandlerListResponse, error) {
	var out models.HandlerListResponse
	err := c.doHTTPReqWithRetry(ctx, http.MethodGet, uriListHandlers, nil, nil, &out)
	return out, err
}

func (c *Client) GetHandler(ctx context.Context, name string) (models.HandlerDetailResponse, error) {
	var out models.HandlerDetailResponse
	err := c.doHTTPReqWithRetry(ctx, http.MethodGet,
		fmt.Sprintf(uriGetHandler, url.PathEscape(name)), nil, nil, &out)
	return out, err
}

func (c *Client) PostJob(ctx context.Context, j models.CreateJobRequest, idempotencyKey string) (models.JobResponse, error) {
	var out models.JobResponse

	var h http.Header
	if idempotencyKey != "" {
		h = http.Header{idempotencyHeader: []string{idempotencyKey}}
	}

	err := c.doHTTPReqWithRetry(ctx, http.MethodPost, uriPostJob, j, h, &out)
	return out, err
}

func (c *Client) GetJobs(ctx context.Context, q JobQuery) (models.JobListResponse, error) {
	var out models.JobListResponse
	err := c.doHTTPReqWithRetry(ctx, http.MethodGet, uriListJobs, q.values(), nil, &out)
	return out, err
}

func (c *Client) GetJob(ctx context.Context, id string) (models.JobResponse, error) {
	var out models.JobResponse
	err := c.doHTTPReqWithRetry(ctx, http.MethodGet, fmt.Sprintf(uriGetJob, id), nil, nil, &out)
	return out, err
}

func (c *Client) DeleteJob(ctx context.Context, id string) error {
	return c.doHTTPReqWithRetry(ctx, http.MethodDelete, fmt.Sprintf(uriDeleteJob, id), nil, nil, nil)
}

func (c *Client) CancelJob(ctx context.Context, id string, version int32) (models.JobResponse, error) {
	var out models.JobResponse
	err := c.doHTTPReqWithRetry(ctx, http.MethodPost, fmt.Sprintf(uriCancelJobs, id),
		models.VersionRequest{Version: version}, nil, &out)
	return out, err
}

func (c *Client) RerunJob(ctx context.Context, id string, version int32) (models.JobResponse, error) {
	var out models.JobResponse
	err := c.doHTTPReqWithRetry(ctx, http.MethodPost, fmt.Sprintf(uriRerunJob, id),
		models.VersionRequest{Version: version}, nil, &out)
	return out, err
}

func (c *Client) PauseJob(ctx context.Context, id string, version int32, paused bool) (models.JobResponse, error) {
	var out models.JobResponse
	err := c.doHTTPReqWithRetry(ctx, http.MethodPost, fmt.Sprintf(uriPauseJob, id),
		models.PauseRequest{Version: version, Paused: &paused}, nil, &out)
	return out, err
}

func (c *Client) RescheduleJob(ctx context.Context, id string, s models.RescheduleRequest) (models.JobResponse, error) {
	var out models.JobResponse
	err := c.doHTTPReqWithRetry(ctx, http.MethodPost, fmt.Sprintf(uriRescheduleJob, id), s, nil, &out)
	return out, err
}

func (c *Client) GetJobAttempts(ctx context.Context, id string, q PageQuery) (models.JobAttemptListResponse, error) {
	var out models.JobAttemptListResponse
	err := c.doHTTPReqWithRetry(ctx, http.MethodGet, fmt.Sprintf(uriListJobAttempts, id),
		q.values(), nil, &out)
	return out, err
}

func (c *Client) GetAttemptLogs(ctx context.Context, jobID, attemptID string, q LogQuery) (models.JobLogListResponse, error) {
	var out models.JobLogListResponse
	err := c.doHTTPReqWithRetry(ctx, http.MethodGet, fmt.Sprintf(uriListAttemptLogs, jobID, attemptID),
		q.values(), nil, &out)
	return out, err
}
