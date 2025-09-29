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
  - `list_user_files`
  - `list_course_files`
  - `list_folder_files`
  - `get_file`
  - `get_file_download_url`
  - `list_user_folders`
  - `list_course_folders`
  - `get_folder`
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

### Course & Assignment Tools

| Tool | Input | Output |
| ---- | ----- | ------ |
| `list_courses` | `enrollment_state?: "active" \| "completed"`, `include_past?: boolean`, `limit?: number` | `{ courses: Course[] }` |
| `list_assignments` | `course_id: number`, optional `due_after`, `due_before` (ISO 8601), `search` | `{ assignments: Assignment[] }` |
| `get_assignment` | `course_id: number`, `assignment_id: number` | `{ assignment: Assignment }` |
| `list_announcements` | Optional `course_id`, optional `since` (ISO 8601) | `{ announcements: Announcement[] }` |
| `list_upcoming` | Optional `days` (1-30, default 7) | `{ upcoming: UpcomingItem[] }` |

### File & Folder Tools

| Tool | Input | Output |
| ---- | ----- | ------ |
| `list_user_files` | Optional `search_term`, `content_types`, `sort`, `order` | `{ files: File[] }` |
| `list_course_files` | `course_id: number`, optional `search_term`, `content_types`, `sort`, `order` | `{ files: File[] }` |
| `list_folder_files` | `folder_id: number`, optional `search_term`, `content_types`, `sort`, `order` | `{ files: File[] }` |
| `get_file` | `file_id: number` | `{ file: File }` |
| `get_file_download_url` | `file_id: number`, optional `submission_id` | `{ file_id: number, download_url: string }` |
| `list_user_folders` | _(none)_ | `{ folders: Folder[] }` |
| `list_course_folders` | `course_id: number` | `{ folders: Folder[] }` |
| `get_folder` | `folder_id: number` | `{ folder: Folder }` |

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

File {
  "id": 1234,
  "uuid": "abc123...",
  "folder_id": 567,
  "display_name": "Lecture Notes.pdf",
  "filename": "lecture_notes.pdf",
  "content_type": "application/pdf",
  "url": "https://.../files/1234/download",
  "size": 1048576, // bytes
  "created_at": "2025-09-15T10:00:00Z",
  "updated_at": "2025-09-15T10:00:00Z",
  "locked": false,
  "hidden": false,
  "locked_for_user": false,
  "thumbnail_url": null,
  "mime_class": "pdf"
}

Folder {
  "id": 567,
  "name": "Lectures",
  "full_name": "course files/Lectures",
  "context_id": 123,
  "context_type": "Course",
  "parent_folder_id": 100,
  "created_at": "2025-09-01T00:00:00Z",
  "updated_at": "2025-09-15T00:00:00Z",
  "locked": false,
  "folders_count": 3,
  "files_count": 15,
  "hidden": false,
  "locked_for_user": false,
  "for_submissions": false
}
```

`list_upcoming` merges `/users/self/todo` and upcoming assignments (bucket filter) within the requested horizon, deduplicates by assignment id, and sorts by earliest due date.

### File Download

The `get_file_download_url` tool returns a temporary, signed URL that allows direct download of file content. This URL:
- Is valid for a limited time (typically 10 minutes)
- Includes authentication parameters in the URL (no additional headers needed)
- Points directly to Canvas's file storage (usually AWS S3)
- Should not be cached or stored long-term

Use this tool when you need to access the actual file content. For file metadata only (name, size, type, etc.), use `get_file` instead.

## Prompt Reference

| Prompt | Input | Purpose |
| ------ | ----- | ------- |
| `canvas.quickstart` | _(none)_ | Kick-off instructions that remind the model how to explore Canvas data safely with the available tools, including file access. |
| `canvas.assignment_brief` | `course_hint?: string`, `days?: string (digits)` | Guides the model through gathering assignments and upcoming todo items for a specific course and time horizon. |
| `canvas.announcement_digest` | `course_hint?: string`, `since?: string (ISO-8601)` | Helps the model compile a digest of recent announcements, optionally scoped to a course or timeframe. |
| `canvas.file_access` | `course_hint?: string`, `file_type?: string` | Guides the model through locating, browsing, and accessing Canvas files. Includes tips on folder navigation, content type filtering, and download URL usage. |

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
- `./test-mcp-simple.sh` – quick functional test (stdio mode)
- `node test-client.js` – full integration test (HTTP+SSE, requires server running)
- See `TESTING.md` for comprehensive testing guide

## Next Steps

- Add caching or ETag support where helpful
- Implement write actions (submissions, comments) once scopes allow
- Containerize via Docker for deployment
