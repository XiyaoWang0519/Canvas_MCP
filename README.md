# Canvas MCP Server

Local Model Context Protocol (MCP) server that exposes Canvas LMS read-only tooling over HTTP/SSE (and optional stdio) for agent integrations. The server provides authenticated access to courses, assignments, announcements, and upcoming to-do work using the Canvas REST API, with pagination, retries, and structured JSON responses.

## Features

- HTTP+SSE transport at `/mcp` with static bearer authentication
- Optional stdio transport for local testing (`--stdio`)
- Canvas client with:
  - Automatic bearer or OAuth2 token handling (refresh on 401)
  - Exponential backoff with jitter (up to 3 attempts) for 429/5xx
  - Link header pagination (`per_page=100`)
  - Request ID propagation for structured errors & logging
- Tools returning strongly typed JSON payloads:
  - `list_courses`
  - `list_assignments`
  - `get_assignment`
  - `list_announcements`
  - `list_upcoming`
- JSON console logging with request metadata and Canvas status codes
- Consistent MCP error mapping for Canvas 401/403/404/429/5xx responses
- Pre-built MCP prompts for common Canvas workflows (quickstart, assignment planning, announcements)

## Getting Started

### Prerequisites

- Node.js 18.17+ or 20+

### Install

```bash
npm install
cp .env.example .env
# populate .env with Canvas credentials and MCP_BEARER
```

Required environment variables (see `.env.example`):

- `CANVAS_BASE_URL` – e.g. `https://q.utoronto.ca`
- Authentication: either
  - `CANVAS_PAT` (personal access token), **or**
  - OAuth2: `CANVAS_CLIENT_ID`, `CANVAS_CLIENT_SECRET`, `CANVAS_REFRESH_TOKEN` (+ optional `CANVAS_ACCESS_TOKEN`)
- `MCP_BEARER` – shared secret for HTTP clients hitting `/mcp`

### Run the server

#### Development (watch mode)

```bash
npm run dev
```

#### Production build

```bash
npm run build
npm start
```

Optional stdio transport (useful with `claude-dev` or MCP-compatible CLIs):

```bash
npm run dev -- --stdio
# or
node dist/index.js --stdio
```

By default the HTTP server listens on port `3333`. Override with `PORT=4000 npm run dev`.

### Health & Auth

- `GET /healthz` → `{ "ok": true }`
- All `/mcp` and `/messages` requests must send `Authorization: Bearer <MCP_BEARER>`

## Tool Reference

Each tool returns JSON via `structuredContent` (schema enforced with Zod).

| Tool | Input | Output |
| ---- | ----- | ------ |
| `list_courses` | `enrollment_state?: "active" \| "completed"`, `include_past?: boolean`, `limit?: number` | `{ courses: Course[] }` |
| `list_assignments` | `course_id: number`, optional `due_after`, `due_before` (ISO 8601), `search` | `{ assignments: Assignment[] }` |
| `get_assignment` | `course_id: number`, `assignment_id: number` | `{ assignment: Assignment }` |
| `list_announcements` | Optional `course_id`, optional `since` (ISO 8601) | `{ announcements: Announcement[] }` |
| `list_upcoming` | Optional `days` (1-30, default 7) | `{ upcoming: UpcomingItem[] }` |

Data contracts (stable):

```jsonc
Course {
  "id": 123,
  "name": "ECE496",
  "term": "Fall 2025",
  "course_code": "ECE496H1"
}

Assignment {
  "id": 456,
  "course_id": 123,
  "name": "Lab 2",
  "due_at": "2025-10-05T23:59:00Z", // null when Canvas omits the value
  "points": 10,
  "html_url": "https://.../assignments/456",
  "submission_state": "unsubmitted" // computed: unsubmitted | submitted | graded | pending_review | late | missing | excused
}

Announcement {
  "id": 789,
  "course_id": 123,
  "title": "Midterm info",
  "posted_at": "2025-10-01T14:30:00Z",
  "html_url": "..."
}

UpcomingItem extends Assignment with { "source": "todo" | "assignment" }
```

`list_upcoming` merges `/users/self/todo` and upcoming assignments (bucket filter) within the requested horizon, deduplicates by assignment id, and sorts by earliest due date.

## Prompt Reference

| Prompt | Input | Purpose |
| ------ | ----- | ------- |
| `canvas.quickstart` | _(none)_ | Kick-off instructions that remind the model how to explore Canvas data safely with the available tools. |
| `canvas.assignment_brief` | `course_hint?: string`, `days?: string (digits)` | Guides the model through gathering assignments and upcoming todo items for a specific course and time horizon. |
| `canvas.announcement_digest` | `course_hint?: string`, `since?: string (ISO-8601)` | Helps the model compile a digest of recent announcements, optionally scoped to a course or timeframe. |

## Logging & Errors

Logs are JSON documents written to stdout/stderr with fields: `tool`, `status`, `duration_ms`, `canvas_status`, `req_id`, and optional `extra_req_ids` & `error` summaries. Secrets are never logged.

Canvas errors map to MCP errors with user-facing messages:

| Canvas status | Message |
| ------------- | ------- |
| 401/403 | `Authorization failed: check Canvas token/scopes.` |
| 404 | `Not found: course or assignment id.` |
| 429 | `Rate limited by Canvas; retry later.` |
| 5xx | `Canvas temporarily unavailable.` (surfaced as HTTP 503 to the client) |

Each error includes `request_id` (Canvas `X-Request-Id`) and the last Canvas status code in MCP error `data`.

## Testing

- `npm run build` – type-checks & emits JS
- `npm test` – placeholder (add integration tests under `tests/` as needed)

## Next Steps

- Add caching or ETag support where helpful
- Implement write actions (submissions, comments) once scopes allow
- Containerize via Docker for deployment
