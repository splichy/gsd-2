import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  queryKnowledge,
  formatRoadmapExcerpt
} from "../context-store.js";
const syntheticKnowledge = `# Project Knowledge Base

## Database Patterns
SQLite is the primary persistence layer, using WAL mode for concurrent reads.
All queries use prepared statements for SQL injection prevention.
Connection pooling is handled by better-sqlite3's synchronous API.
Schema migrations are versioned and applied at startup.

Example patterns:
- Use transactions for multi-statement operations
- Prefer RETURNING clause for insert/update
- Index foreign keys for join performance
- Use CHECK constraints for data validation

Performance considerations:
- WAL checkpoint every 1000 writes
- Vacuum on shutdown for space reclamation
- Page size 4096 for SSD optimization

Database schema evolution:
- Migrations stored in migrations/ directory
- Each migration has up/down scripts
- Version table tracks applied migrations
- Rollback supported for last N migrations

Connection management:
- Single connection for write operations
- Read connections pooled for concurrency
- Connection timeout set to 5 seconds
- Busy timeout handles lock contention

Query patterns:
- Use prepared statements for parameterization
- Batch inserts via INSERT ... VALUES syntax
- Upserts via INSERT OR REPLACE
- Pagination via LIMIT/OFFSET or cursor

## API Design Principles
REST endpoints follow OpenAPI 3.0 specification.
Versioned paths use /v1/resource pattern.
Authentication uses Bearer tokens in Authorization header.
Rate limiting applies per-client with sliding window algorithm.

Response formats:
- Success: { data: T, meta?: { pagination } }
- Error: { error: { code, message, details? } }
- Pagination: cursor-based for large collections

Content negotiation:
- Accept: application/json (default)
- Accept: text/plain (for CLI consumers)
- Accept: text/event-stream (for SSE endpoints)

API versioning strategy:
- Major versions in URL path (/v1, /v2)
- Minor versions via Accept-Version header
- Deprecation warnings in response headers
- 12-month sunset period for old versions

Endpoint naming conventions:
- Nouns for resources (users, projects)
- Verbs only for non-CRUD actions (login, export)
- Plural form for collections
- Singular for singletons (me, config)

HTTP method semantics:
- GET: read-only, cacheable
- POST: create or non-idempotent action
- PUT: full replacement
- PATCH: partial update
- DELETE: remove resource

## Testing Strategy
Unit tests use node:test with strict assertions.
Integration tests mock external services via msw.
E2E tests use Playwright for browser automation.
Test coverage target is 80% line coverage.

Test organization:
- Unit tests adjacent to source files (*.test.ts)
- Integration tests in __tests__/integration/
- E2E tests in e2e/ directory
- Fixtures in __fixtures__/ subdirectories

Mocking guidelines:
- Prefer dependency injection over global mocks
- Use vi.mock() sparingly, only for ES module boundaries
- Reset mocks in afterEach hooks

Test data management:
- Factories generate realistic test data
- Seeds populate database for integration tests
- Snapshots capture expected output
- Golden files for complex comparisons

Assertion patterns:
- Use strict equality for primitives
- Deep equality for objects/arrays
- Regex matching for dynamic content
- Snapshot testing for UI components

Test isolation:
- Each test gets fresh database state
- Environment variables reset between tests
- File system operations use temp directories
- Network calls intercepted by mock server

## Error Handling
Errors are typed using discriminated unions.
Application errors extend BaseError class.
HTTP errors map to standard status codes.
Unhandled rejections trigger graceful shutdown.

Error codes follow domain prefixes:
- AUTH_xxx: Authentication/authorization errors
- DB_xxx: Database operation failures
- NET_xxx: Network/external service errors
- VAL_xxx: Validation errors

Logging integration:
- Error instances auto-serialize to JSON
- Stack traces included in development
- Correlation IDs propagate through request chain

Error recovery strategies:
- Retry with exponential backoff for transient errors
- Circuit breaker for external service failures
- Fallback values for non-critical operations
- Graceful degradation for partial failures

User-facing error messages:
- Generic messages for security-sensitive errors
- Actionable guidance for recoverable errors
- Reference codes for support escalation
- Localized messages via i18n

Error boundary patterns:
- Component-level boundaries in UI
- Route-level error handlers in API
- Global unhandled rejection handlers
- Process-level crash recovery

## Observability Patterns
Structured logging uses pino with JSON output.
Metrics collected via OpenTelemetry SDK.
Traces propagate context through async boundaries.
Health checks exposed at /health and /ready endpoints.

Log levels:
- ERROR: Unrecoverable failures
- WARN: Degraded operation
- INFO: Significant state changes
- DEBUG: Detailed diagnostic data

Metric types:
- Counters for request counts
- Histograms for latency distribution
- Gauges for resource utilization

Trace context propagation:
- W3C Trace Context headers
- Baggage for cross-service metadata
- Span attributes for searchability
- Events for significant moments

Dashboard design:
- SLO dashboards for reliability
- Request flow visualization
- Error rate trends
- Resource saturation alerts

Alerting strategy:
- Page for customer-impacting issues
- Ticket for degraded performance
- Notification for capacity planning
- Silence during maintenance windows

## Security Guidelines
Secrets never appear in logs or error messages.
Environment variables validated at startup.
CORS configured per-environment whitelist.
CSP headers enforced for web responses.

Input validation:
- Zod schemas for request body parsing
- Path parameters validated against patterns
- Query parameters have default/max values

Output encoding:
- HTML entities escaped in templates
- JSON stringification for API responses
- URL encoding for redirect targets

Authentication patterns:
- JWT tokens with short expiry
- Refresh token rotation
- Session invalidation on logout
- Multi-factor authentication support

Authorization model:
- Role-based access control (RBAC)
- Resource-level permissions
- Attribute-based policies (ABAC)
- Principle of least privilege

Secure communication:
- TLS 1.3 minimum
- Certificate pinning for mobile
- HSTS preload list
- Certificate transparency logging

## Performance Optimization
Critical paths target sub-10ms latency.
Database queries use covering indexes.
Response compression enabled for > 1KB bodies.
Static assets served with immutable caching.

Caching strategy:
- Redis for session data
- In-memory LRU for hot paths
- CDN for static assets
- Stale-while-revalidate for API responses

Memory management:
- Stream large payloads instead of buffering
- Weak references for disposable caches
- Manual GC hints for batch operations

Query optimization:
- Explain plans for complex queries
- Index usage analysis
- Query result caching
- Connection pooling tuning

Frontend performance:
- Code splitting for lazy loading
- Image optimization and lazy loading
- Critical CSS inlining
- Prefetching for likely navigations

Backend performance:
- Async I/O for non-blocking operations
- Worker threads for CPU-bound tasks
- Connection keep-alive
- Response streaming

## Deployment Architecture
Containers built with multi-stage Dockerfiles.
Kubernetes manifests in deploy/ directory.
Horizontal pod autoscaling on CPU/memory.
Rolling updates with zero-downtime.

Environment hierarchy:
- development: local Docker Compose
- staging: shared k8s namespace
- production: isolated k8s cluster

Configuration:
- ConfigMaps for non-sensitive config
- Secrets for credentials
- Environment-specific overlays via Kustomize

Container best practices:
- Non-root user in container
- Read-only filesystem where possible
- Resource limits and requests
- Liveness and readiness probes

Service mesh integration:
- Istio for traffic management
- mTLS for service-to-service auth
- Retry and timeout policies
- Circuit breaking configuration

Disaster recovery:
- Database replication across zones
- Point-in-time recovery capability
- Regular backup verification
- Documented runbooks

## Development Workflow
Feature branches follow conventional commits.
PRs require CI pass and code review.
Main branch deploys to staging automatically.
Release tags trigger production deployment.

CI pipeline stages:
1. Install dependencies
2. Lint and type check
3. Unit tests with coverage
4. Build artifacts
5. Integration tests
6. Security scan

Local development:
- pnpm for package management
- Turborepo for monorepo orchestration
- Docker Compose for service dependencies

Code review guidelines:
- Focus on correctness and clarity
- Security-sensitive changes require security review
- Performance-critical paths need benchmarks
- Breaking changes need migration guide

Branch strategy:
- main: production-ready code
- develop: integration branch (optional)
- feature/*: new functionality
- fix/*: bug fixes
- release/*: release preparation

Documentation requirements:
- README for project overview
- API docs auto-generated from OpenAPI
- Architecture decision records (ADRs)
- Runbooks for operational procedures
`;
const syntheticRoadmap = `# M005: Tiered Context Injection

## Vision
Refactor prompt builders to inject relevance-scoped context instead of full files.
This reduces token consumption and improves agent focus on relevant information.

## Success Criteria
- [ ] 40% reduction in injected context size
- [ ] No regression in agent task completion rate
- [ ] Measurable test confirms reduction target

## Slice Overview
| ID | Slice | Risk | Depends | Done | After this |
|----|-------|------|---------|------|------------|
| S01 | Scope existing DB queries | low | \u2014 | \u2705 | planSlice and researchSlice use milestone+slice filters for decisions/requirements. |
| S02 | KNOWLEDGE scoping + roadmap excerpt | medium | S01 | \u2B1C | KNOWLEDGE sections filtered by keywords. Roadmap injected as excerpt. |
| S03 | Measurement test suite | low | S02 | \u2B1C | Automated tests confirm 40% reduction vs baseline. |
| S04 | Documentation and rollout | low | S03 | \u2B1C | Updated docs. Feature flag for gradual rollout. |

## Key Risks
1. Keyword extraction may miss relevant sections \u2014 mitigate with fallback to full content
2. Excerpt parsing fragile to roadmap format changes \u2014 mitigate with graceful degradation

## Definition of Done
- [ ] All slices complete with passing verification
- [ ] Measurement tests in CI
- [ ] No increase in prompt build latency
`;
describe("measurement: context reduction verification", () => {
  test("synthetic KNOWLEDGE fixture is ~8KB as specified", () => {
    const sizeKB = syntheticKnowledge.length / 1024;
    assert.ok(
      sizeKB >= 7 && sizeKB <= 10,
      `KNOWLEDGE fixture should be ~8KB, got ${sizeKB.toFixed(2)}KB`
    );
  });
  test("synthetic KNOWLEDGE has 9 H2 sections", () => {
    const h2Count = (syntheticKnowledge.match(/^## /gm) || []).length;
    assert.strictEqual(h2Count, 9, `KNOWLEDGE fixture should have 9 H2 sections, got ${h2Count}`);
  });
  test("queryKnowledge achieves \u226540% reduction with targeted keywords", async () => {
    const keywords = ["database", "testing"];
    const scopedResult = await queryKnowledge(syntheticKnowledge, keywords);
    const fullSize = syntheticKnowledge.length;
    const scopedSize = scopedResult.length;
    const reductionPct = (fullSize - scopedSize) / fullSize * 100;
    assert.match(scopedResult, /## Database Patterns/, "should include Database section");
    assert.match(scopedResult, /## Testing Strategy/, "should include Testing section");
    assert.ok(!scopedResult.includes("## API Design"), "should exclude API section");
    assert.ok(!scopedResult.includes("## Observability"), "should exclude Observability section");
    assert.ok(!scopedResult.includes("## Deployment"), "should exclude Deployment section");
    assert.ok(
      reductionPct >= 40,
      `queryKnowledge should achieve \u226540% reduction, got ${reductionPct.toFixed(1)}% (${scopedSize} chars vs ${fullSize} chars)`
    );
    console.log(`  \u2192 queryKnowledge: ${reductionPct.toFixed(1)}% reduction (${scopedSize} \u2192 ${fullSize} chars)`);
  });
  test("queryKnowledge with single keyword achieves \u226540% reduction", async () => {
    const keywords = ["security"];
    const scopedResult = await queryKnowledge(syntheticKnowledge, keywords);
    const fullSize = syntheticKnowledge.length;
    const scopedSize = scopedResult.length;
    const reductionPct = (fullSize - scopedSize) / fullSize * 100;
    assert.match(scopedResult, /## Security Guidelines/, "should include Security section");
    assert.ok(
      reductionPct >= 40,
      `single keyword should achieve \u226540% reduction, got ${reductionPct.toFixed(1)}%`
    );
  });
  test("formatRoadmapExcerpt achieves \u226540% reduction", () => {
    const sliceId = "S02";
    const excerptResult = formatRoadmapExcerpt(syntheticRoadmap, sliceId, ".gsd/milestones/M005/M005-ROADMAP.md");
    const fullSize = syntheticRoadmap.length;
    const excerptSize = excerptResult.length;
    const reductionPct = (fullSize - excerptSize) / fullSize * 100;
    assert.match(excerptResult, /\| ID \| Slice \|/, "should have table header");
    assert.match(excerptResult, /\| S01 \|/, "should have predecessor S01");
    assert.match(excerptResult, /\| S02 \|/, "should have target S02");
    assert.match(excerptResult, /See full roadmap:/, "should have reference directive");
    assert.ok(!excerptResult.includes("| S03 |"), "should exclude S03");
    assert.ok(!excerptResult.includes("| S04 |"), "should exclude S04");
    assert.ok(
      reductionPct >= 40,
      `formatRoadmapExcerpt should achieve \u226540% reduction, got ${reductionPct.toFixed(1)}% (${excerptSize} chars vs ${fullSize} chars)`
    );
    console.log(`  \u2192 formatRoadmapExcerpt: ${reductionPct.toFixed(1)}% reduction (${excerptSize} \u2192 ${fullSize} chars)`);
  });
  test("combined KNOWLEDGE + roadmap reduction exceeds 40%", async () => {
    const keywords = ["database", "testing"];
    const scopedKnowledge = await queryKnowledge(syntheticKnowledge, keywords);
    const scopedRoadmap = formatRoadmapExcerpt(syntheticRoadmap, "S02");
    const fullKnowledgeSize = syntheticKnowledge.length;
    const fullRoadmapSize = syntheticRoadmap.length;
    const fullTotal = fullKnowledgeSize + fullRoadmapSize;
    const scopedKnowledgeSize = scopedKnowledge.length;
    const scopedRoadmapSize = scopedRoadmap.length;
    const scopedTotal = scopedKnowledgeSize + scopedRoadmapSize;
    const combinedReductionPct = (fullTotal - scopedTotal) / fullTotal * 100;
    assert.ok(
      combinedReductionPct >= 40,
      `combined reduction should be \u226540%, got ${combinedReductionPct.toFixed(1)}%`
    );
    console.log(`  \u2192 Combined: ${combinedReductionPct.toFixed(1)}% reduction`);
    console.log(`    - KNOWLEDGE: ${fullKnowledgeSize} \u2192 ${scopedKnowledgeSize} chars`);
    console.log(`    - Roadmap: ${fullRoadmapSize} \u2192 ${scopedRoadmapSize} chars`);
    console.log(`    - Total: ${fullTotal} \u2192 ${scopedTotal} chars`);
  });
});
describe("measurement: edge cases maintain reduction target", () => {
  test("three keywords still achieves \u226540% reduction", async () => {
    const keywords = ["database", "api", "security"];
    const scopedResult = await queryKnowledge(syntheticKnowledge, keywords);
    const fullSize = syntheticKnowledge.length;
    const scopedSize = scopedResult.length;
    const reductionPct = (fullSize - scopedSize) / fullSize * 100;
    assert.match(scopedResult, /## Database Patterns/, "should include Database");
    assert.match(scopedResult, /## API Design/, "should include API");
    assert.match(scopedResult, /## Security Guidelines/, "should include Security");
    assert.ok(
      reductionPct >= 40,
      `3 keywords should still achieve \u226540% reduction, got ${reductionPct.toFixed(1)}%`
    );
  });
  test("excerpt for S01 (no dependencies) achieves \u226540% reduction", () => {
    const excerptResult = formatRoadmapExcerpt(syntheticRoadmap, "S01");
    const fullSize = syntheticRoadmap.length;
    const excerptSize = excerptResult.length;
    const reductionPct = (fullSize - excerptSize) / fullSize * 100;
    assert.match(excerptResult, /\| S01 \|/, "should have S01");
    assert.ok(!excerptResult.includes("| S02 |"), "should not have S02");
    assert.ok(
      reductionPct >= 40,
      `S01 excerpt should achieve \u226540% reduction, got ${reductionPct.toFixed(1)}%`
    );
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9tZWFzdXJlbWVudC50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgeyBkZXNjcmliZSwgdGVzdCB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHtcbiAgcXVlcnlLbm93bGVkZ2UsXG4gIGZvcm1hdFJvYWRtYXBFeGNlcnB0LFxufSBmcm9tICcuLi9jb250ZXh0LXN0b3JlLnRzJztcblxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4vLyBtZWFzdXJlbWVudC50ZXN0LnRzIFx1MjAxNCBWZXJpZnkgXHUyMjY1NDAlIGNvbnRleHQgcmVkdWN0aW9uIGZyb20gc2NvcGVkIGluamVjdGlvblxuLy9cbi8vIFRlc3RzIHF1ZXJ5S25vd2xlZGdlKCkgYW5kIGZvcm1hdFJvYWRtYXBFeGNlcnB0KCkgd2l0aCByZWFsaXN0aWMgc3ludGhldGljXG4vLyBmaXh0dXJlcyB0byBjb25maXJtIHRoZSBjb250ZXh0IHJlZHVjdGlvbiB0YXJnZXQgaXMgbWV0LlxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBTeW50aGV0aWMgS05PV0xFREdFLm1kIEZpeHR1cmUgKH44S0IsIDkgSDIgc2VjdGlvbnMpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5jb25zdCBzeW50aGV0aWNLbm93bGVkZ2UgPSBgIyBQcm9qZWN0IEtub3dsZWRnZSBCYXNlXG5cbiMjIERhdGFiYXNlIFBhdHRlcm5zXG5TUUxpdGUgaXMgdGhlIHByaW1hcnkgcGVyc2lzdGVuY2UgbGF5ZXIsIHVzaW5nIFdBTCBtb2RlIGZvciBjb25jdXJyZW50IHJlYWRzLlxuQWxsIHF1ZXJpZXMgdXNlIHByZXBhcmVkIHN0YXRlbWVudHMgZm9yIFNRTCBpbmplY3Rpb24gcHJldmVudGlvbi5cbkNvbm5lY3Rpb24gcG9vbGluZyBpcyBoYW5kbGVkIGJ5IGJldHRlci1zcWxpdGUzJ3Mgc3luY2hyb25vdXMgQVBJLlxuU2NoZW1hIG1pZ3JhdGlvbnMgYXJlIHZlcnNpb25lZCBhbmQgYXBwbGllZCBhdCBzdGFydHVwLlxuXG5FeGFtcGxlIHBhdHRlcm5zOlxuLSBVc2UgdHJhbnNhY3Rpb25zIGZvciBtdWx0aS1zdGF0ZW1lbnQgb3BlcmF0aW9uc1xuLSBQcmVmZXIgUkVUVVJOSU5HIGNsYXVzZSBmb3IgaW5zZXJ0L3VwZGF0ZVxuLSBJbmRleCBmb3JlaWduIGtleXMgZm9yIGpvaW4gcGVyZm9ybWFuY2Vcbi0gVXNlIENIRUNLIGNvbnN0cmFpbnRzIGZvciBkYXRhIHZhbGlkYXRpb25cblxuUGVyZm9ybWFuY2UgY29uc2lkZXJhdGlvbnM6XG4tIFdBTCBjaGVja3BvaW50IGV2ZXJ5IDEwMDAgd3JpdGVzXG4tIFZhY3V1bSBvbiBzaHV0ZG93biBmb3Igc3BhY2UgcmVjbGFtYXRpb25cbi0gUGFnZSBzaXplIDQwOTYgZm9yIFNTRCBvcHRpbWl6YXRpb25cblxuRGF0YWJhc2Ugc2NoZW1hIGV2b2x1dGlvbjpcbi0gTWlncmF0aW9ucyBzdG9yZWQgaW4gbWlncmF0aW9ucy8gZGlyZWN0b3J5XG4tIEVhY2ggbWlncmF0aW9uIGhhcyB1cC9kb3duIHNjcmlwdHNcbi0gVmVyc2lvbiB0YWJsZSB0cmFja3MgYXBwbGllZCBtaWdyYXRpb25zXG4tIFJvbGxiYWNrIHN1cHBvcnRlZCBmb3IgbGFzdCBOIG1pZ3JhdGlvbnNcblxuQ29ubmVjdGlvbiBtYW5hZ2VtZW50OlxuLSBTaW5nbGUgY29ubmVjdGlvbiBmb3Igd3JpdGUgb3BlcmF0aW9uc1xuLSBSZWFkIGNvbm5lY3Rpb25zIHBvb2xlZCBmb3IgY29uY3VycmVuY3lcbi0gQ29ubmVjdGlvbiB0aW1lb3V0IHNldCB0byA1IHNlY29uZHNcbi0gQnVzeSB0aW1lb3V0IGhhbmRsZXMgbG9jayBjb250ZW50aW9uXG5cblF1ZXJ5IHBhdHRlcm5zOlxuLSBVc2UgcHJlcGFyZWQgc3RhdGVtZW50cyBmb3IgcGFyYW1ldGVyaXphdGlvblxuLSBCYXRjaCBpbnNlcnRzIHZpYSBJTlNFUlQgLi4uIFZBTFVFUyBzeW50YXhcbi0gVXBzZXJ0cyB2aWEgSU5TRVJUIE9SIFJFUExBQ0Vcbi0gUGFnaW5hdGlvbiB2aWEgTElNSVQvT0ZGU0VUIG9yIGN1cnNvclxuXG4jIyBBUEkgRGVzaWduIFByaW5jaXBsZXNcblJFU1QgZW5kcG9pbnRzIGZvbGxvdyBPcGVuQVBJIDMuMCBzcGVjaWZpY2F0aW9uLlxuVmVyc2lvbmVkIHBhdGhzIHVzZSAvdjEvcmVzb3VyY2UgcGF0dGVybi5cbkF1dGhlbnRpY2F0aW9uIHVzZXMgQmVhcmVyIHRva2VucyBpbiBBdXRob3JpemF0aW9uIGhlYWRlci5cblJhdGUgbGltaXRpbmcgYXBwbGllcyBwZXItY2xpZW50IHdpdGggc2xpZGluZyB3aW5kb3cgYWxnb3JpdGhtLlxuXG5SZXNwb25zZSBmb3JtYXRzOlxuLSBTdWNjZXNzOiB7IGRhdGE6IFQsIG1ldGE/OiB7IHBhZ2luYXRpb24gfSB9XG4tIEVycm9yOiB7IGVycm9yOiB7IGNvZGUsIG1lc3NhZ2UsIGRldGFpbHM/IH0gfVxuLSBQYWdpbmF0aW9uOiBjdXJzb3ItYmFzZWQgZm9yIGxhcmdlIGNvbGxlY3Rpb25zXG5cbkNvbnRlbnQgbmVnb3RpYXRpb246XG4tIEFjY2VwdDogYXBwbGljYXRpb24vanNvbiAoZGVmYXVsdClcbi0gQWNjZXB0OiB0ZXh0L3BsYWluIChmb3IgQ0xJIGNvbnN1bWVycylcbi0gQWNjZXB0OiB0ZXh0L2V2ZW50LXN0cmVhbSAoZm9yIFNTRSBlbmRwb2ludHMpXG5cbkFQSSB2ZXJzaW9uaW5nIHN0cmF0ZWd5OlxuLSBNYWpvciB2ZXJzaW9ucyBpbiBVUkwgcGF0aCAoL3YxLCAvdjIpXG4tIE1pbm9yIHZlcnNpb25zIHZpYSBBY2NlcHQtVmVyc2lvbiBoZWFkZXJcbi0gRGVwcmVjYXRpb24gd2FybmluZ3MgaW4gcmVzcG9uc2UgaGVhZGVyc1xuLSAxMi1tb250aCBzdW5zZXQgcGVyaW9kIGZvciBvbGQgdmVyc2lvbnNcblxuRW5kcG9pbnQgbmFtaW5nIGNvbnZlbnRpb25zOlxuLSBOb3VucyBmb3IgcmVzb3VyY2VzICh1c2VycywgcHJvamVjdHMpXG4tIFZlcmJzIG9ubHkgZm9yIG5vbi1DUlVEIGFjdGlvbnMgKGxvZ2luLCBleHBvcnQpXG4tIFBsdXJhbCBmb3JtIGZvciBjb2xsZWN0aW9uc1xuLSBTaW5ndWxhciBmb3Igc2luZ2xldG9ucyAobWUsIGNvbmZpZylcblxuSFRUUCBtZXRob2Qgc2VtYW50aWNzOlxuLSBHRVQ6IHJlYWQtb25seSwgY2FjaGVhYmxlXG4tIFBPU1Q6IGNyZWF0ZSBvciBub24taWRlbXBvdGVudCBhY3Rpb25cbi0gUFVUOiBmdWxsIHJlcGxhY2VtZW50XG4tIFBBVENIOiBwYXJ0aWFsIHVwZGF0ZVxuLSBERUxFVEU6IHJlbW92ZSByZXNvdXJjZVxuXG4jIyBUZXN0aW5nIFN0cmF0ZWd5XG5Vbml0IHRlc3RzIHVzZSBub2RlOnRlc3Qgd2l0aCBzdHJpY3QgYXNzZXJ0aW9ucy5cbkludGVncmF0aW9uIHRlc3RzIG1vY2sgZXh0ZXJuYWwgc2VydmljZXMgdmlhIG1zdy5cbkUyRSB0ZXN0cyB1c2UgUGxheXdyaWdodCBmb3IgYnJvd3NlciBhdXRvbWF0aW9uLlxuVGVzdCBjb3ZlcmFnZSB0YXJnZXQgaXMgODAlIGxpbmUgY292ZXJhZ2UuXG5cblRlc3Qgb3JnYW5pemF0aW9uOlxuLSBVbml0IHRlc3RzIGFkamFjZW50IHRvIHNvdXJjZSBmaWxlcyAoKi50ZXN0LnRzKVxuLSBJbnRlZ3JhdGlvbiB0ZXN0cyBpbiBfX3Rlc3RzX18vaW50ZWdyYXRpb24vXG4tIEUyRSB0ZXN0cyBpbiBlMmUvIGRpcmVjdG9yeVxuLSBGaXh0dXJlcyBpbiBfX2ZpeHR1cmVzX18vIHN1YmRpcmVjdG9yaWVzXG5cbk1vY2tpbmcgZ3VpZGVsaW5lczpcbi0gUHJlZmVyIGRlcGVuZGVuY3kgaW5qZWN0aW9uIG92ZXIgZ2xvYmFsIG1vY2tzXG4tIFVzZSB2aS5tb2NrKCkgc3BhcmluZ2x5LCBvbmx5IGZvciBFUyBtb2R1bGUgYm91bmRhcmllc1xuLSBSZXNldCBtb2NrcyBpbiBhZnRlckVhY2ggaG9va3NcblxuVGVzdCBkYXRhIG1hbmFnZW1lbnQ6XG4tIEZhY3RvcmllcyBnZW5lcmF0ZSByZWFsaXN0aWMgdGVzdCBkYXRhXG4tIFNlZWRzIHBvcHVsYXRlIGRhdGFiYXNlIGZvciBpbnRlZ3JhdGlvbiB0ZXN0c1xuLSBTbmFwc2hvdHMgY2FwdHVyZSBleHBlY3RlZCBvdXRwdXRcbi0gR29sZGVuIGZpbGVzIGZvciBjb21wbGV4IGNvbXBhcmlzb25zXG5cbkFzc2VydGlvbiBwYXR0ZXJuczpcbi0gVXNlIHN0cmljdCBlcXVhbGl0eSBmb3IgcHJpbWl0aXZlc1xuLSBEZWVwIGVxdWFsaXR5IGZvciBvYmplY3RzL2FycmF5c1xuLSBSZWdleCBtYXRjaGluZyBmb3IgZHluYW1pYyBjb250ZW50XG4tIFNuYXBzaG90IHRlc3RpbmcgZm9yIFVJIGNvbXBvbmVudHNcblxuVGVzdCBpc29sYXRpb246XG4tIEVhY2ggdGVzdCBnZXRzIGZyZXNoIGRhdGFiYXNlIHN0YXRlXG4tIEVudmlyb25tZW50IHZhcmlhYmxlcyByZXNldCBiZXR3ZWVuIHRlc3RzXG4tIEZpbGUgc3lzdGVtIG9wZXJhdGlvbnMgdXNlIHRlbXAgZGlyZWN0b3JpZXNcbi0gTmV0d29yayBjYWxscyBpbnRlcmNlcHRlZCBieSBtb2NrIHNlcnZlclxuXG4jIyBFcnJvciBIYW5kbGluZ1xuRXJyb3JzIGFyZSB0eXBlZCB1c2luZyBkaXNjcmltaW5hdGVkIHVuaW9ucy5cbkFwcGxpY2F0aW9uIGVycm9ycyBleHRlbmQgQmFzZUVycm9yIGNsYXNzLlxuSFRUUCBlcnJvcnMgbWFwIHRvIHN0YW5kYXJkIHN0YXR1cyBjb2Rlcy5cblVuaGFuZGxlZCByZWplY3Rpb25zIHRyaWdnZXIgZ3JhY2VmdWwgc2h1dGRvd24uXG5cbkVycm9yIGNvZGVzIGZvbGxvdyBkb21haW4gcHJlZml4ZXM6XG4tIEFVVEhfeHh4OiBBdXRoZW50aWNhdGlvbi9hdXRob3JpemF0aW9uIGVycm9yc1xuLSBEQl94eHg6IERhdGFiYXNlIG9wZXJhdGlvbiBmYWlsdXJlc1xuLSBORVRfeHh4OiBOZXR3b3JrL2V4dGVybmFsIHNlcnZpY2UgZXJyb3JzXG4tIFZBTF94eHg6IFZhbGlkYXRpb24gZXJyb3JzXG5cbkxvZ2dpbmcgaW50ZWdyYXRpb246XG4tIEVycm9yIGluc3RhbmNlcyBhdXRvLXNlcmlhbGl6ZSB0byBKU09OXG4tIFN0YWNrIHRyYWNlcyBpbmNsdWRlZCBpbiBkZXZlbG9wbWVudFxuLSBDb3JyZWxhdGlvbiBJRHMgcHJvcGFnYXRlIHRocm91Z2ggcmVxdWVzdCBjaGFpblxuXG5FcnJvciByZWNvdmVyeSBzdHJhdGVnaWVzOlxuLSBSZXRyeSB3aXRoIGV4cG9uZW50aWFsIGJhY2tvZmYgZm9yIHRyYW5zaWVudCBlcnJvcnNcbi0gQ2lyY3VpdCBicmVha2VyIGZvciBleHRlcm5hbCBzZXJ2aWNlIGZhaWx1cmVzXG4tIEZhbGxiYWNrIHZhbHVlcyBmb3Igbm9uLWNyaXRpY2FsIG9wZXJhdGlvbnNcbi0gR3JhY2VmdWwgZGVncmFkYXRpb24gZm9yIHBhcnRpYWwgZmFpbHVyZXNcblxuVXNlci1mYWNpbmcgZXJyb3IgbWVzc2FnZXM6XG4tIEdlbmVyaWMgbWVzc2FnZXMgZm9yIHNlY3VyaXR5LXNlbnNpdGl2ZSBlcnJvcnNcbi0gQWN0aW9uYWJsZSBndWlkYW5jZSBmb3IgcmVjb3ZlcmFibGUgZXJyb3JzXG4tIFJlZmVyZW5jZSBjb2RlcyBmb3Igc3VwcG9ydCBlc2NhbGF0aW9uXG4tIExvY2FsaXplZCBtZXNzYWdlcyB2aWEgaTE4blxuXG5FcnJvciBib3VuZGFyeSBwYXR0ZXJuczpcbi0gQ29tcG9uZW50LWxldmVsIGJvdW5kYXJpZXMgaW4gVUlcbi0gUm91dGUtbGV2ZWwgZXJyb3IgaGFuZGxlcnMgaW4gQVBJXG4tIEdsb2JhbCB1bmhhbmRsZWQgcmVqZWN0aW9uIGhhbmRsZXJzXG4tIFByb2Nlc3MtbGV2ZWwgY3Jhc2ggcmVjb3ZlcnlcblxuIyMgT2JzZXJ2YWJpbGl0eSBQYXR0ZXJuc1xuU3RydWN0dXJlZCBsb2dnaW5nIHVzZXMgcGlubyB3aXRoIEpTT04gb3V0cHV0LlxuTWV0cmljcyBjb2xsZWN0ZWQgdmlhIE9wZW5UZWxlbWV0cnkgU0RLLlxuVHJhY2VzIHByb3BhZ2F0ZSBjb250ZXh0IHRocm91Z2ggYXN5bmMgYm91bmRhcmllcy5cbkhlYWx0aCBjaGVja3MgZXhwb3NlZCBhdCAvaGVhbHRoIGFuZCAvcmVhZHkgZW5kcG9pbnRzLlxuXG5Mb2cgbGV2ZWxzOlxuLSBFUlJPUjogVW5yZWNvdmVyYWJsZSBmYWlsdXJlc1xuLSBXQVJOOiBEZWdyYWRlZCBvcGVyYXRpb25cbi0gSU5GTzogU2lnbmlmaWNhbnQgc3RhdGUgY2hhbmdlc1xuLSBERUJVRzogRGV0YWlsZWQgZGlhZ25vc3RpYyBkYXRhXG5cbk1ldHJpYyB0eXBlczpcbi0gQ291bnRlcnMgZm9yIHJlcXVlc3QgY291bnRzXG4tIEhpc3RvZ3JhbXMgZm9yIGxhdGVuY3kgZGlzdHJpYnV0aW9uXG4tIEdhdWdlcyBmb3IgcmVzb3VyY2UgdXRpbGl6YXRpb25cblxuVHJhY2UgY29udGV4dCBwcm9wYWdhdGlvbjpcbi0gVzNDIFRyYWNlIENvbnRleHQgaGVhZGVyc1xuLSBCYWdnYWdlIGZvciBjcm9zcy1zZXJ2aWNlIG1ldGFkYXRhXG4tIFNwYW4gYXR0cmlidXRlcyBmb3Igc2VhcmNoYWJpbGl0eVxuLSBFdmVudHMgZm9yIHNpZ25pZmljYW50IG1vbWVudHNcblxuRGFzaGJvYXJkIGRlc2lnbjpcbi0gU0xPIGRhc2hib2FyZHMgZm9yIHJlbGlhYmlsaXR5XG4tIFJlcXVlc3QgZmxvdyB2aXN1YWxpemF0aW9uXG4tIEVycm9yIHJhdGUgdHJlbmRzXG4tIFJlc291cmNlIHNhdHVyYXRpb24gYWxlcnRzXG5cbkFsZXJ0aW5nIHN0cmF0ZWd5OlxuLSBQYWdlIGZvciBjdXN0b21lci1pbXBhY3RpbmcgaXNzdWVzXG4tIFRpY2tldCBmb3IgZGVncmFkZWQgcGVyZm9ybWFuY2Vcbi0gTm90aWZpY2F0aW9uIGZvciBjYXBhY2l0eSBwbGFubmluZ1xuLSBTaWxlbmNlIGR1cmluZyBtYWludGVuYW5jZSB3aW5kb3dzXG5cbiMjIFNlY3VyaXR5IEd1aWRlbGluZXNcblNlY3JldHMgbmV2ZXIgYXBwZWFyIGluIGxvZ3Mgb3IgZXJyb3IgbWVzc2FnZXMuXG5FbnZpcm9ubWVudCB2YXJpYWJsZXMgdmFsaWRhdGVkIGF0IHN0YXJ0dXAuXG5DT1JTIGNvbmZpZ3VyZWQgcGVyLWVudmlyb25tZW50IHdoaXRlbGlzdC5cbkNTUCBoZWFkZXJzIGVuZm9yY2VkIGZvciB3ZWIgcmVzcG9uc2VzLlxuXG5JbnB1dCB2YWxpZGF0aW9uOlxuLSBab2Qgc2NoZW1hcyBmb3IgcmVxdWVzdCBib2R5IHBhcnNpbmdcbi0gUGF0aCBwYXJhbWV0ZXJzIHZhbGlkYXRlZCBhZ2FpbnN0IHBhdHRlcm5zXG4tIFF1ZXJ5IHBhcmFtZXRlcnMgaGF2ZSBkZWZhdWx0L21heCB2YWx1ZXNcblxuT3V0cHV0IGVuY29kaW5nOlxuLSBIVE1MIGVudGl0aWVzIGVzY2FwZWQgaW4gdGVtcGxhdGVzXG4tIEpTT04gc3RyaW5naWZpY2F0aW9uIGZvciBBUEkgcmVzcG9uc2VzXG4tIFVSTCBlbmNvZGluZyBmb3IgcmVkaXJlY3QgdGFyZ2V0c1xuXG5BdXRoZW50aWNhdGlvbiBwYXR0ZXJuczpcbi0gSldUIHRva2VucyB3aXRoIHNob3J0IGV4cGlyeVxuLSBSZWZyZXNoIHRva2VuIHJvdGF0aW9uXG4tIFNlc3Npb24gaW52YWxpZGF0aW9uIG9uIGxvZ291dFxuLSBNdWx0aS1mYWN0b3IgYXV0aGVudGljYXRpb24gc3VwcG9ydFxuXG5BdXRob3JpemF0aW9uIG1vZGVsOlxuLSBSb2xlLWJhc2VkIGFjY2VzcyBjb250cm9sIChSQkFDKVxuLSBSZXNvdXJjZS1sZXZlbCBwZXJtaXNzaW9uc1xuLSBBdHRyaWJ1dGUtYmFzZWQgcG9saWNpZXMgKEFCQUMpXG4tIFByaW5jaXBsZSBvZiBsZWFzdCBwcml2aWxlZ2VcblxuU2VjdXJlIGNvbW11bmljYXRpb246XG4tIFRMUyAxLjMgbWluaW11bVxuLSBDZXJ0aWZpY2F0ZSBwaW5uaW5nIGZvciBtb2JpbGVcbi0gSFNUUyBwcmVsb2FkIGxpc3Rcbi0gQ2VydGlmaWNhdGUgdHJhbnNwYXJlbmN5IGxvZ2dpbmdcblxuIyMgUGVyZm9ybWFuY2UgT3B0aW1pemF0aW9uXG5Dcml0aWNhbCBwYXRocyB0YXJnZXQgc3ViLTEwbXMgbGF0ZW5jeS5cbkRhdGFiYXNlIHF1ZXJpZXMgdXNlIGNvdmVyaW5nIGluZGV4ZXMuXG5SZXNwb25zZSBjb21wcmVzc2lvbiBlbmFibGVkIGZvciA+IDFLQiBib2RpZXMuXG5TdGF0aWMgYXNzZXRzIHNlcnZlZCB3aXRoIGltbXV0YWJsZSBjYWNoaW5nLlxuXG5DYWNoaW5nIHN0cmF0ZWd5OlxuLSBSZWRpcyBmb3Igc2Vzc2lvbiBkYXRhXG4tIEluLW1lbW9yeSBMUlUgZm9yIGhvdCBwYXRoc1xuLSBDRE4gZm9yIHN0YXRpYyBhc3NldHNcbi0gU3RhbGUtd2hpbGUtcmV2YWxpZGF0ZSBmb3IgQVBJIHJlc3BvbnNlc1xuXG5NZW1vcnkgbWFuYWdlbWVudDpcbi0gU3RyZWFtIGxhcmdlIHBheWxvYWRzIGluc3RlYWQgb2YgYnVmZmVyaW5nXG4tIFdlYWsgcmVmZXJlbmNlcyBmb3IgZGlzcG9zYWJsZSBjYWNoZXNcbi0gTWFudWFsIEdDIGhpbnRzIGZvciBiYXRjaCBvcGVyYXRpb25zXG5cblF1ZXJ5IG9wdGltaXphdGlvbjpcbi0gRXhwbGFpbiBwbGFucyBmb3IgY29tcGxleCBxdWVyaWVzXG4tIEluZGV4IHVzYWdlIGFuYWx5c2lzXG4tIFF1ZXJ5IHJlc3VsdCBjYWNoaW5nXG4tIENvbm5lY3Rpb24gcG9vbGluZyB0dW5pbmdcblxuRnJvbnRlbmQgcGVyZm9ybWFuY2U6XG4tIENvZGUgc3BsaXR0aW5nIGZvciBsYXp5IGxvYWRpbmdcbi0gSW1hZ2Ugb3B0aW1pemF0aW9uIGFuZCBsYXp5IGxvYWRpbmdcbi0gQ3JpdGljYWwgQ1NTIGlubGluaW5nXG4tIFByZWZldGNoaW5nIGZvciBsaWtlbHkgbmF2aWdhdGlvbnNcblxuQmFja2VuZCBwZXJmb3JtYW5jZTpcbi0gQXN5bmMgSS9PIGZvciBub24tYmxvY2tpbmcgb3BlcmF0aW9uc1xuLSBXb3JrZXIgdGhyZWFkcyBmb3IgQ1BVLWJvdW5kIHRhc2tzXG4tIENvbm5lY3Rpb24ga2VlcC1hbGl2ZVxuLSBSZXNwb25zZSBzdHJlYW1pbmdcblxuIyMgRGVwbG95bWVudCBBcmNoaXRlY3R1cmVcbkNvbnRhaW5lcnMgYnVpbHQgd2l0aCBtdWx0aS1zdGFnZSBEb2NrZXJmaWxlcy5cbkt1YmVybmV0ZXMgbWFuaWZlc3RzIGluIGRlcGxveS8gZGlyZWN0b3J5LlxuSG9yaXpvbnRhbCBwb2QgYXV0b3NjYWxpbmcgb24gQ1BVL21lbW9yeS5cblJvbGxpbmcgdXBkYXRlcyB3aXRoIHplcm8tZG93bnRpbWUuXG5cbkVudmlyb25tZW50IGhpZXJhcmNoeTpcbi0gZGV2ZWxvcG1lbnQ6IGxvY2FsIERvY2tlciBDb21wb3NlXG4tIHN0YWdpbmc6IHNoYXJlZCBrOHMgbmFtZXNwYWNlXG4tIHByb2R1Y3Rpb246IGlzb2xhdGVkIGs4cyBjbHVzdGVyXG5cbkNvbmZpZ3VyYXRpb246XG4tIENvbmZpZ01hcHMgZm9yIG5vbi1zZW5zaXRpdmUgY29uZmlnXG4tIFNlY3JldHMgZm9yIGNyZWRlbnRpYWxzXG4tIEVudmlyb25tZW50LXNwZWNpZmljIG92ZXJsYXlzIHZpYSBLdXN0b21pemVcblxuQ29udGFpbmVyIGJlc3QgcHJhY3RpY2VzOlxuLSBOb24tcm9vdCB1c2VyIGluIGNvbnRhaW5lclxuLSBSZWFkLW9ubHkgZmlsZXN5c3RlbSB3aGVyZSBwb3NzaWJsZVxuLSBSZXNvdXJjZSBsaW1pdHMgYW5kIHJlcXVlc3RzXG4tIExpdmVuZXNzIGFuZCByZWFkaW5lc3MgcHJvYmVzXG5cblNlcnZpY2UgbWVzaCBpbnRlZ3JhdGlvbjpcbi0gSXN0aW8gZm9yIHRyYWZmaWMgbWFuYWdlbWVudFxuLSBtVExTIGZvciBzZXJ2aWNlLXRvLXNlcnZpY2UgYXV0aFxuLSBSZXRyeSBhbmQgdGltZW91dCBwb2xpY2llc1xuLSBDaXJjdWl0IGJyZWFraW5nIGNvbmZpZ3VyYXRpb25cblxuRGlzYXN0ZXIgcmVjb3Zlcnk6XG4tIERhdGFiYXNlIHJlcGxpY2F0aW9uIGFjcm9zcyB6b25lc1xuLSBQb2ludC1pbi10aW1lIHJlY292ZXJ5IGNhcGFiaWxpdHlcbi0gUmVndWxhciBiYWNrdXAgdmVyaWZpY2F0aW9uXG4tIERvY3VtZW50ZWQgcnVuYm9va3NcblxuIyMgRGV2ZWxvcG1lbnQgV29ya2Zsb3dcbkZlYXR1cmUgYnJhbmNoZXMgZm9sbG93IGNvbnZlbnRpb25hbCBjb21taXRzLlxuUFJzIHJlcXVpcmUgQ0kgcGFzcyBhbmQgY29kZSByZXZpZXcuXG5NYWluIGJyYW5jaCBkZXBsb3lzIHRvIHN0YWdpbmcgYXV0b21hdGljYWxseS5cblJlbGVhc2UgdGFncyB0cmlnZ2VyIHByb2R1Y3Rpb24gZGVwbG95bWVudC5cblxuQ0kgcGlwZWxpbmUgc3RhZ2VzOlxuMS4gSW5zdGFsbCBkZXBlbmRlbmNpZXNcbjIuIExpbnQgYW5kIHR5cGUgY2hlY2tcbjMuIFVuaXQgdGVzdHMgd2l0aCBjb3ZlcmFnZVxuNC4gQnVpbGQgYXJ0aWZhY3RzXG41LiBJbnRlZ3JhdGlvbiB0ZXN0c1xuNi4gU2VjdXJpdHkgc2NhblxuXG5Mb2NhbCBkZXZlbG9wbWVudDpcbi0gcG5wbSBmb3IgcGFja2FnZSBtYW5hZ2VtZW50XG4tIFR1cmJvcmVwbyBmb3IgbW9ub3JlcG8gb3JjaGVzdHJhdGlvblxuLSBEb2NrZXIgQ29tcG9zZSBmb3Igc2VydmljZSBkZXBlbmRlbmNpZXNcblxuQ29kZSByZXZpZXcgZ3VpZGVsaW5lczpcbi0gRm9jdXMgb24gY29ycmVjdG5lc3MgYW5kIGNsYXJpdHlcbi0gU2VjdXJpdHktc2Vuc2l0aXZlIGNoYW5nZXMgcmVxdWlyZSBzZWN1cml0eSByZXZpZXdcbi0gUGVyZm9ybWFuY2UtY3JpdGljYWwgcGF0aHMgbmVlZCBiZW5jaG1hcmtzXG4tIEJyZWFraW5nIGNoYW5nZXMgbmVlZCBtaWdyYXRpb24gZ3VpZGVcblxuQnJhbmNoIHN0cmF0ZWd5OlxuLSBtYWluOiBwcm9kdWN0aW9uLXJlYWR5IGNvZGVcbi0gZGV2ZWxvcDogaW50ZWdyYXRpb24gYnJhbmNoIChvcHRpb25hbClcbi0gZmVhdHVyZS8qOiBuZXcgZnVuY3Rpb25hbGl0eVxuLSBmaXgvKjogYnVnIGZpeGVzXG4tIHJlbGVhc2UvKjogcmVsZWFzZSBwcmVwYXJhdGlvblxuXG5Eb2N1bWVudGF0aW9uIHJlcXVpcmVtZW50czpcbi0gUkVBRE1FIGZvciBwcm9qZWN0IG92ZXJ2aWV3XG4tIEFQSSBkb2NzIGF1dG8tZ2VuZXJhdGVkIGZyb20gT3BlbkFQSVxuLSBBcmNoaXRlY3R1cmUgZGVjaXNpb24gcmVjb3JkcyAoQURScylcbi0gUnVuYm9va3MgZm9yIG9wZXJhdGlvbmFsIHByb2NlZHVyZXNcbmA7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBTeW50aGV0aWMgUm9hZG1hcCBGaXh0dXJlICh+MUtCLCA0IHNsaWNlcykgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmNvbnN0IHN5bnRoZXRpY1JvYWRtYXAgPSBgIyBNMDA1OiBUaWVyZWQgQ29udGV4dCBJbmplY3Rpb25cblxuIyMgVmlzaW9uXG5SZWZhY3RvciBwcm9tcHQgYnVpbGRlcnMgdG8gaW5qZWN0IHJlbGV2YW5jZS1zY29wZWQgY29udGV4dCBpbnN0ZWFkIG9mIGZ1bGwgZmlsZXMuXG5UaGlzIHJlZHVjZXMgdG9rZW4gY29uc3VtcHRpb24gYW5kIGltcHJvdmVzIGFnZW50IGZvY3VzIG9uIHJlbGV2YW50IGluZm9ybWF0aW9uLlxuXG4jIyBTdWNjZXNzIENyaXRlcmlhXG4tIFsgXSA0MCUgcmVkdWN0aW9uIGluIGluamVjdGVkIGNvbnRleHQgc2l6ZVxuLSBbIF0gTm8gcmVncmVzc2lvbiBpbiBhZ2VudCB0YXNrIGNvbXBsZXRpb24gcmF0ZVxuLSBbIF0gTWVhc3VyYWJsZSB0ZXN0IGNvbmZpcm1zIHJlZHVjdGlvbiB0YXJnZXRcblxuIyMgU2xpY2UgT3ZlcnZpZXdcbnwgSUQgfCBTbGljZSB8IFJpc2sgfCBEZXBlbmRzIHwgRG9uZSB8IEFmdGVyIHRoaXMgfFxufC0tLS18LS0tLS0tLXwtLS0tLS18LS0tLS0tLS0tfC0tLS0tLXwtLS0tLS0tLS0tLS18XG58IFMwMSB8IFNjb3BlIGV4aXN0aW5nIERCIHF1ZXJpZXMgfCBsb3cgfCBcdTIwMTQgfCBcdTI3MDUgfCBwbGFuU2xpY2UgYW5kIHJlc2VhcmNoU2xpY2UgdXNlIG1pbGVzdG9uZStzbGljZSBmaWx0ZXJzIGZvciBkZWNpc2lvbnMvcmVxdWlyZW1lbnRzLiB8XG58IFMwMiB8IEtOT1dMRURHRSBzY29waW5nICsgcm9hZG1hcCBleGNlcnB0IHwgbWVkaXVtIHwgUzAxIHwgXHUyQjFDIHwgS05PV0xFREdFIHNlY3Rpb25zIGZpbHRlcmVkIGJ5IGtleXdvcmRzLiBSb2FkbWFwIGluamVjdGVkIGFzIGV4Y2VycHQuIHxcbnwgUzAzIHwgTWVhc3VyZW1lbnQgdGVzdCBzdWl0ZSB8IGxvdyB8IFMwMiB8IFx1MkIxQyB8IEF1dG9tYXRlZCB0ZXN0cyBjb25maXJtIDQwJSByZWR1Y3Rpb24gdnMgYmFzZWxpbmUuIHxcbnwgUzA0IHwgRG9jdW1lbnRhdGlvbiBhbmQgcm9sbG91dCB8IGxvdyB8IFMwMyB8IFx1MkIxQyB8IFVwZGF0ZWQgZG9jcy4gRmVhdHVyZSBmbGFnIGZvciBncmFkdWFsIHJvbGxvdXQuIHxcblxuIyMgS2V5IFJpc2tzXG4xLiBLZXl3b3JkIGV4dHJhY3Rpb24gbWF5IG1pc3MgcmVsZXZhbnQgc2VjdGlvbnMgXHUyMDE0IG1pdGlnYXRlIHdpdGggZmFsbGJhY2sgdG8gZnVsbCBjb250ZW50XG4yLiBFeGNlcnB0IHBhcnNpbmcgZnJhZ2lsZSB0byByb2FkbWFwIGZvcm1hdCBjaGFuZ2VzIFx1MjAxNCBtaXRpZ2F0ZSB3aXRoIGdyYWNlZnVsIGRlZ3JhZGF0aW9uXG5cbiMjIERlZmluaXRpb24gb2YgRG9uZVxuLSBbIF0gQWxsIHNsaWNlcyBjb21wbGV0ZSB3aXRoIHBhc3NpbmcgdmVyaWZpY2F0aW9uXG4tIFsgXSBNZWFzdXJlbWVudCB0ZXN0cyBpbiBDSVxuLSBbIF0gTm8gaW5jcmVhc2UgaW4gcHJvbXB0IGJ1aWxkIGxhdGVuY3lcbmA7XG5cbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuLy8gTWVhc3VyZW1lbnQgVGVzdHNcbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuXG5kZXNjcmliZShcIm1lYXN1cmVtZW50OiBjb250ZXh0IHJlZHVjdGlvbiB2ZXJpZmljYXRpb25cIiwgKCkgPT4ge1xuICB0ZXN0KFwic3ludGhldGljIEtOT1dMRURHRSBmaXh0dXJlIGlzIH44S0IgYXMgc3BlY2lmaWVkXCIsICgpID0+IHtcbiAgICBjb25zdCBzaXplS0IgPSBzeW50aGV0aWNLbm93bGVkZ2UubGVuZ3RoIC8gMTAyNDtcbiAgICBhc3NlcnQub2soXG4gICAgICBzaXplS0IgPj0gNyAmJiBzaXplS0IgPD0gMTAsXG4gICAgICBgS05PV0xFREdFIGZpeHR1cmUgc2hvdWxkIGJlIH44S0IsIGdvdCAke3NpemVLQi50b0ZpeGVkKDIpfUtCYFxuICAgICk7XG4gIH0pO1xuXG4gIHRlc3QoXCJzeW50aGV0aWMgS05PV0xFREdFIGhhcyA5IEgyIHNlY3Rpb25zXCIsICgpID0+IHtcbiAgICBjb25zdCBoMkNvdW50ID0gKHN5bnRoZXRpY0tub3dsZWRnZS5tYXRjaCgvXiMjIC9nbSkgfHwgW10pLmxlbmd0aDtcbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwoaDJDb3VudCwgOSwgYEtOT1dMRURHRSBmaXh0dXJlIHNob3VsZCBoYXZlIDkgSDIgc2VjdGlvbnMsIGdvdCAke2gyQ291bnR9YCk7XG4gIH0pO1xuXG4gIHRlc3QoXCJxdWVyeUtub3dsZWRnZSBhY2hpZXZlcyBcdTIyNjU0MCUgcmVkdWN0aW9uIHdpdGggdGFyZ2V0ZWQga2V5d29yZHNcIiwgYXN5bmMgKCkgPT4ge1xuICAgIC8vIEtleXdvcmRzIHRhcmdldGluZyAyIHNlY3Rpb25zOiBcIkRhdGFiYXNlIFBhdHRlcm5zXCIgYW5kIFwiVGVzdGluZyBTdHJhdGVneVwiXG4gICAgY29uc3Qga2V5d29yZHMgPSBbJ2RhdGFiYXNlJywgJ3Rlc3RpbmcnXTtcbiAgICBcbiAgICBjb25zdCBzY29wZWRSZXN1bHQgPSBhd2FpdCBxdWVyeUtub3dsZWRnZShzeW50aGV0aWNLbm93bGVkZ2UsIGtleXdvcmRzKTtcbiAgICBcbiAgICBjb25zdCBmdWxsU2l6ZSA9IHN5bnRoZXRpY0tub3dsZWRnZS5sZW5ndGg7XG4gICAgY29uc3Qgc2NvcGVkU2l6ZSA9IHNjb3BlZFJlc3VsdC5sZW5ndGg7XG4gICAgY29uc3QgcmVkdWN0aW9uUGN0ID0gKChmdWxsU2l6ZSAtIHNjb3BlZFNpemUpIC8gZnVsbFNpemUpICogMTAwO1xuICAgIFxuICAgIC8vIFZlcmlmeSB3ZSBnb3QgbWF0Y2hpbmcgc2VjdGlvbnNcbiAgICBhc3NlcnQubWF0Y2goc2NvcGVkUmVzdWx0LCAvIyMgRGF0YWJhc2UgUGF0dGVybnMvLCAnc2hvdWxkIGluY2x1ZGUgRGF0YWJhc2Ugc2VjdGlvbicpO1xuICAgIGFzc2VydC5tYXRjaChzY29wZWRSZXN1bHQsIC8jIyBUZXN0aW5nIFN0cmF0ZWd5LywgJ3Nob3VsZCBpbmNsdWRlIFRlc3Rpbmcgc2VjdGlvbicpO1xuICAgIFxuICAgIC8vIFZlcmlmeSB3ZSBleGNsdWRlZCBvdGhlciBzZWN0aW9uc1xuICAgIGFzc2VydC5vayghc2NvcGVkUmVzdWx0LmluY2x1ZGVzKCcjIyBBUEkgRGVzaWduJyksICdzaG91bGQgZXhjbHVkZSBBUEkgc2VjdGlvbicpO1xuICAgIGFzc2VydC5vayghc2NvcGVkUmVzdWx0LmluY2x1ZGVzKCcjIyBPYnNlcnZhYmlsaXR5JyksICdzaG91bGQgZXhjbHVkZSBPYnNlcnZhYmlsaXR5IHNlY3Rpb24nKTtcbiAgICBhc3NlcnQub2soIXNjb3BlZFJlc3VsdC5pbmNsdWRlcygnIyMgRGVwbG95bWVudCcpLCAnc2hvdWxkIGV4Y2x1ZGUgRGVwbG95bWVudCBzZWN0aW9uJyk7XG4gICAgXG4gICAgLy8gVmVyaWZ5IFx1MjI2NTQwJSByZWR1Y3Rpb24gKDIvOSBzZWN0aW9ucyA9IH43OCUgcmVkdWN0aW9uIGV4cGVjdGVkKVxuICAgIGFzc2VydC5vayhcbiAgICAgIHJlZHVjdGlvblBjdCA+PSA0MCxcbiAgICAgIGBxdWVyeUtub3dsZWRnZSBzaG91bGQgYWNoaWV2ZSBcdTIyNjU0MCUgcmVkdWN0aW9uLCBnb3QgJHtyZWR1Y3Rpb25QY3QudG9GaXhlZCgxKX0lICgke3Njb3BlZFNpemV9IGNoYXJzIHZzICR7ZnVsbFNpemV9IGNoYXJzKWBcbiAgICApO1xuICAgIFxuICAgIGNvbnNvbGUubG9nKGAgIFx1MjE5MiBxdWVyeUtub3dsZWRnZTogJHtyZWR1Y3Rpb25QY3QudG9GaXhlZCgxKX0lIHJlZHVjdGlvbiAoJHtzY29wZWRTaXplfSBcdTIxOTIgJHtmdWxsU2l6ZX0gY2hhcnMpYCk7XG4gIH0pO1xuXG4gIHRlc3QoXCJxdWVyeUtub3dsZWRnZSB3aXRoIHNpbmdsZSBrZXl3b3JkIGFjaGlldmVzIFx1MjI2NTQwJSByZWR1Y3Rpb25cIiwgYXN5bmMgKCkgPT4ge1xuICAgIC8vIFNpbmdsZSBrZXl3b3JkIHRhcmdldGluZyAxIHNlY3Rpb25cbiAgICBjb25zdCBrZXl3b3JkcyA9IFsnc2VjdXJpdHknXTtcbiAgICBcbiAgICBjb25zdCBzY29wZWRSZXN1bHQgPSBhd2FpdCBxdWVyeUtub3dsZWRnZShzeW50aGV0aWNLbm93bGVkZ2UsIGtleXdvcmRzKTtcbiAgICBcbiAgICBjb25zdCBmdWxsU2l6ZSA9IHN5bnRoZXRpY0tub3dsZWRnZS5sZW5ndGg7XG4gICAgY29uc3Qgc2NvcGVkU2l6ZSA9IHNjb3BlZFJlc3VsdC5sZW5ndGg7XG4gICAgY29uc3QgcmVkdWN0aW9uUGN0ID0gKChmdWxsU2l6ZSAtIHNjb3BlZFNpemUpIC8gZnVsbFNpemUpICogMTAwO1xuICAgIFxuICAgIC8vIFZlcmlmeSB3ZSBnb3QgbWF0Y2hpbmcgc2VjdGlvblxuICAgIGFzc2VydC5tYXRjaChzY29wZWRSZXN1bHQsIC8jIyBTZWN1cml0eSBHdWlkZWxpbmVzLywgJ3Nob3VsZCBpbmNsdWRlIFNlY3VyaXR5IHNlY3Rpb24nKTtcbiAgICBcbiAgICAvLyBWZXJpZnkgXHUyMjY1NDAlIHJlZHVjdGlvbiAoMS85IHNlY3Rpb25zID0gfjg5JSByZWR1Y3Rpb24gZXhwZWN0ZWQpXG4gICAgYXNzZXJ0Lm9rKFxuICAgICAgcmVkdWN0aW9uUGN0ID49IDQwLFxuICAgICAgYHNpbmdsZSBrZXl3b3JkIHNob3VsZCBhY2hpZXZlIFx1MjI2NTQwJSByZWR1Y3Rpb24sIGdvdCAke3JlZHVjdGlvblBjdC50b0ZpeGVkKDEpfSVgXG4gICAgKTtcbiAgfSk7XG5cbiAgdGVzdChcImZvcm1hdFJvYWRtYXBFeGNlcnB0IGFjaGlldmVzIFx1MjI2NTQwJSByZWR1Y3Rpb25cIiwgKCkgPT4ge1xuICAgIGNvbnN0IHNsaWNlSWQgPSAnUzAyJztcbiAgICBcbiAgICBjb25zdCBleGNlcnB0UmVzdWx0ID0gZm9ybWF0Um9hZG1hcEV4Y2VycHQoc3ludGhldGljUm9hZG1hcCwgc2xpY2VJZCwgJy5nc2QvbWlsZXN0b25lcy9NMDA1L00wMDUtUk9BRE1BUC5tZCcpO1xuICAgIFxuICAgIGNvbnN0IGZ1bGxTaXplID0gc3ludGhldGljUm9hZG1hcC5sZW5ndGg7XG4gICAgY29uc3QgZXhjZXJwdFNpemUgPSBleGNlcnB0UmVzdWx0Lmxlbmd0aDtcbiAgICBjb25zdCByZWR1Y3Rpb25QY3QgPSAoKGZ1bGxTaXplIC0gZXhjZXJwdFNpemUpIC8gZnVsbFNpemUpICogMTAwO1xuICAgIFxuICAgIC8vIFZlcmlmeSBleGNlcnB0IGNvbnRhaW5zIHJlcXVpcmVkIGVsZW1lbnRzXG4gICAgYXNzZXJ0Lm1hdGNoKGV4Y2VycHRSZXN1bHQsIC9cXHwgSUQgXFx8IFNsaWNlIFxcfC8sICdzaG91bGQgaGF2ZSB0YWJsZSBoZWFkZXInKTtcbiAgICBhc3NlcnQubWF0Y2goZXhjZXJwdFJlc3VsdCwgL1xcfCBTMDEgXFx8LywgJ3Nob3VsZCBoYXZlIHByZWRlY2Vzc29yIFMwMScpO1xuICAgIGFzc2VydC5tYXRjaChleGNlcnB0UmVzdWx0LCAvXFx8IFMwMiBcXHwvLCAnc2hvdWxkIGhhdmUgdGFyZ2V0IFMwMicpO1xuICAgIGFzc2VydC5tYXRjaChleGNlcnB0UmVzdWx0LCAvU2VlIGZ1bGwgcm9hZG1hcDovLCAnc2hvdWxkIGhhdmUgcmVmZXJlbmNlIGRpcmVjdGl2ZScpO1xuICAgIFxuICAgIC8vIFZlcmlmeSB3ZSBleGNsdWRlZCBvdGhlciBzbGljZXNcbiAgICBhc3NlcnQub2soIWV4Y2VycHRSZXN1bHQuaW5jbHVkZXMoJ3wgUzAzIHwnKSwgJ3Nob3VsZCBleGNsdWRlIFMwMycpO1xuICAgIGFzc2VydC5vayghZXhjZXJwdFJlc3VsdC5pbmNsdWRlcygnfCBTMDQgfCcpLCAnc2hvdWxkIGV4Y2x1ZGUgUzA0Jyk7XG4gICAgXG4gICAgLy8gVmVyaWZ5IFx1MjI2NTQwJSByZWR1Y3Rpb24gKDIgcm93cyArIG92ZXJoZWFkIHZzIGZ1bGwgcm9hZG1hcCA9IHNpZ25pZmljYW50IHJlZHVjdGlvbilcbiAgICBhc3NlcnQub2soXG4gICAgICByZWR1Y3Rpb25QY3QgPj0gNDAsXG4gICAgICBgZm9ybWF0Um9hZG1hcEV4Y2VycHQgc2hvdWxkIGFjaGlldmUgXHUyMjY1NDAlIHJlZHVjdGlvbiwgZ290ICR7cmVkdWN0aW9uUGN0LnRvRml4ZWQoMSl9JSAoJHtleGNlcnB0U2l6ZX0gY2hhcnMgdnMgJHtmdWxsU2l6ZX0gY2hhcnMpYFxuICAgICk7XG4gICAgXG4gICAgY29uc29sZS5sb2coYCAgXHUyMTkyIGZvcm1hdFJvYWRtYXBFeGNlcnB0OiAke3JlZHVjdGlvblBjdC50b0ZpeGVkKDEpfSUgcmVkdWN0aW9uICgke2V4Y2VycHRTaXplfSBcdTIxOTIgJHtmdWxsU2l6ZX0gY2hhcnMpYCk7XG4gIH0pO1xuXG4gIHRlc3QoXCJjb21iaW5lZCBLTk9XTEVER0UgKyByb2FkbWFwIHJlZHVjdGlvbiBleGNlZWRzIDQwJVwiLCBhc3luYyAoKSA9PiB7XG4gICAgLy8gU2ltdWxhdGUgd2hhdCBoYXBwZW5zIGluIGJ1aWxkUGxhblNsaWNlUHJvbXB0XG4gICAgY29uc3Qga2V5d29yZHMgPSBbJ2RhdGFiYXNlJywgJ3Rlc3RpbmcnXTtcbiAgICBcbiAgICBjb25zdCBzY29wZWRLbm93bGVkZ2UgPSBhd2FpdCBxdWVyeUtub3dsZWRnZShzeW50aGV0aWNLbm93bGVkZ2UsIGtleXdvcmRzKTtcbiAgICBjb25zdCBzY29wZWRSb2FkbWFwID0gZm9ybWF0Um9hZG1hcEV4Y2VycHQoc3ludGhldGljUm9hZG1hcCwgJ1MwMicpO1xuICAgIFxuICAgIGNvbnN0IGZ1bGxLbm93bGVkZ2VTaXplID0gc3ludGhldGljS25vd2xlZGdlLmxlbmd0aDtcbiAgICBjb25zdCBmdWxsUm9hZG1hcFNpemUgPSBzeW50aGV0aWNSb2FkbWFwLmxlbmd0aDtcbiAgICBjb25zdCBmdWxsVG90YWwgPSBmdWxsS25vd2xlZGdlU2l6ZSArIGZ1bGxSb2FkbWFwU2l6ZTtcbiAgICBcbiAgICBjb25zdCBzY29wZWRLbm93bGVkZ2VTaXplID0gc2NvcGVkS25vd2xlZGdlLmxlbmd0aDtcbiAgICBjb25zdCBzY29wZWRSb2FkbWFwU2l6ZSA9IHNjb3BlZFJvYWRtYXAubGVuZ3RoO1xuICAgIGNvbnN0IHNjb3BlZFRvdGFsID0gc2NvcGVkS25vd2xlZGdlU2l6ZSArIHNjb3BlZFJvYWRtYXBTaXplO1xuICAgIFxuICAgIGNvbnN0IGNvbWJpbmVkUmVkdWN0aW9uUGN0ID0gKChmdWxsVG90YWwgLSBzY29wZWRUb3RhbCkgLyBmdWxsVG90YWwpICogMTAwO1xuICAgIFxuICAgIC8vIENvbWJpbmVkIHJlZHVjdGlvbiBzaG91bGQgZWFzaWx5IGV4Y2VlZCA0MCVcbiAgICBhc3NlcnQub2soXG4gICAgICBjb21iaW5lZFJlZHVjdGlvblBjdCA+PSA0MCxcbiAgICAgIGBjb21iaW5lZCByZWR1Y3Rpb24gc2hvdWxkIGJlIFx1MjI2NTQwJSwgZ290ICR7Y29tYmluZWRSZWR1Y3Rpb25QY3QudG9GaXhlZCgxKX0lYFxuICAgICk7XG4gICAgXG4gICAgY29uc29sZS5sb2coYCAgXHUyMTkyIENvbWJpbmVkOiAke2NvbWJpbmVkUmVkdWN0aW9uUGN0LnRvRml4ZWQoMSl9JSByZWR1Y3Rpb25gKTtcbiAgICBjb25zb2xlLmxvZyhgICAgIC0gS05PV0xFREdFOiAke2Z1bGxLbm93bGVkZ2VTaXplfSBcdTIxOTIgJHtzY29wZWRLbm93bGVkZ2VTaXplfSBjaGFyc2ApO1xuICAgIGNvbnNvbGUubG9nKGAgICAgLSBSb2FkbWFwOiAke2Z1bGxSb2FkbWFwU2l6ZX0gXHUyMTkyICR7c2NvcGVkUm9hZG1hcFNpemV9IGNoYXJzYCk7XG4gICAgY29uc29sZS5sb2coYCAgICAtIFRvdGFsOiAke2Z1bGxUb3RhbH0gXHUyMTkyICR7c2NvcGVkVG90YWx9IGNoYXJzYCk7XG4gIH0pO1xufSk7XG5cbmRlc2NyaWJlKFwibWVhc3VyZW1lbnQ6IGVkZ2UgY2FzZXMgbWFpbnRhaW4gcmVkdWN0aW9uIHRhcmdldFwiLCAoKSA9PiB7XG4gIHRlc3QoXCJ0aHJlZSBrZXl3b3JkcyBzdGlsbCBhY2hpZXZlcyBcdTIyNjU0MCUgcmVkdWN0aW9uXCIsIGFzeW5jICgpID0+IHtcbiAgICAvLyBFdmVuIHdpdGggMyBtYXRjaGluZyBzZWN0aW9ucyAoMy85ID0gMzMlKSwgd2Ugc2hvdWxkIGhpdCB0YXJnZXRcbiAgICBjb25zdCBrZXl3b3JkcyA9IFsnZGF0YWJhc2UnLCAnYXBpJywgJ3NlY3VyaXR5J107XG4gICAgXG4gICAgY29uc3Qgc2NvcGVkUmVzdWx0ID0gYXdhaXQgcXVlcnlLbm93bGVkZ2Uoc3ludGhldGljS25vd2xlZGdlLCBrZXl3b3Jkcyk7XG4gICAgXG4gICAgY29uc3QgZnVsbFNpemUgPSBzeW50aGV0aWNLbm93bGVkZ2UubGVuZ3RoO1xuICAgIGNvbnN0IHNjb3BlZFNpemUgPSBzY29wZWRSZXN1bHQubGVuZ3RoO1xuICAgIGNvbnN0IHJlZHVjdGlvblBjdCA9ICgoZnVsbFNpemUgLSBzY29wZWRTaXplKSAvIGZ1bGxTaXplKSAqIDEwMDtcbiAgICBcbiAgICAvLyBWZXJpZnkgbWF0Y2hlcyAoMyBzZWN0aW9ucylcbiAgICBhc3NlcnQubWF0Y2goc2NvcGVkUmVzdWx0LCAvIyMgRGF0YWJhc2UgUGF0dGVybnMvLCAnc2hvdWxkIGluY2x1ZGUgRGF0YWJhc2UnKTtcbiAgICBhc3NlcnQubWF0Y2goc2NvcGVkUmVzdWx0LCAvIyMgQVBJIERlc2lnbi8sICdzaG91bGQgaW5jbHVkZSBBUEknKTtcbiAgICBhc3NlcnQubWF0Y2goc2NvcGVkUmVzdWx0LCAvIyMgU2VjdXJpdHkgR3VpZGVsaW5lcy8sICdzaG91bGQgaW5jbHVkZSBTZWN1cml0eScpO1xuICAgIFxuICAgIC8vIFdpdGggMy85IHNlY3Rpb25zLCByZWR1Y3Rpb24gc2hvdWxkIGJlIH42NyVcbiAgICBhc3NlcnQub2soXG4gICAgICByZWR1Y3Rpb25QY3QgPj0gNDAsXG4gICAgICBgMyBrZXl3b3JkcyBzaG91bGQgc3RpbGwgYWNoaWV2ZSBcdTIyNjU0MCUgcmVkdWN0aW9uLCBnb3QgJHtyZWR1Y3Rpb25QY3QudG9GaXhlZCgxKX0lYFxuICAgICk7XG4gIH0pO1xuXG4gIHRlc3QoXCJleGNlcnB0IGZvciBTMDEgKG5vIGRlcGVuZGVuY2llcykgYWNoaWV2ZXMgXHUyMjY1NDAlIHJlZHVjdGlvblwiLCAoKSA9PiB7XG4gICAgY29uc3QgZXhjZXJwdFJlc3VsdCA9IGZvcm1hdFJvYWRtYXBFeGNlcnB0KHN5bnRoZXRpY1JvYWRtYXAsICdTMDEnKTtcbiAgICBcbiAgICBjb25zdCBmdWxsU2l6ZSA9IHN5bnRoZXRpY1JvYWRtYXAubGVuZ3RoO1xuICAgIGNvbnN0IGV4Y2VycHRTaXplID0gZXhjZXJwdFJlc3VsdC5sZW5ndGg7XG4gICAgY29uc3QgcmVkdWN0aW9uUGN0ID0gKChmdWxsU2l6ZSAtIGV4Y2VycHRTaXplKSAvIGZ1bGxTaXplKSAqIDEwMDtcbiAgICBcbiAgICAvLyBTMDEgaGFzIG5vIHByZWRlY2Vzc29yLCBzbyBqdXN0IDEgcm93ICsgaGVhZGVyICsgcmVmZXJlbmNlXG4gICAgYXNzZXJ0Lm1hdGNoKGV4Y2VycHRSZXN1bHQsIC9cXHwgUzAxIFxcfC8sICdzaG91bGQgaGF2ZSBTMDEnKTtcbiAgICBhc3NlcnQub2soIWV4Y2VycHRSZXN1bHQuaW5jbHVkZXMoJ3wgUzAyIHwnKSwgJ3Nob3VsZCBub3QgaGF2ZSBTMDInKTtcbiAgICBcbiAgICAvLyBTaW5nbGUgcm93IHNob3VsZCBzdGlsbCBhY2hpZXZlIHNpZ25pZmljYW50IHJlZHVjdGlvblxuICAgIGFzc2VydC5vayhcbiAgICAgIHJlZHVjdGlvblBjdCA+PSA0MCxcbiAgICAgIGBTMDEgZXhjZXJwdCBzaG91bGQgYWNoaWV2ZSBcdTIyNjU0MCUgcmVkdWN0aW9uLCBnb3QgJHtyZWR1Y3Rpb25QY3QudG9GaXhlZCgxKX0lYFxuICAgICk7XG4gIH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFBQSxTQUFTLFVBQVUsWUFBWTtBQUMvQixPQUFPLFlBQVk7QUFDbkI7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFXUCxNQUFNLHFCQUFxQjtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7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
