import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GetPromptResult, PromptMessage } from '@modelcontextprotocol/sdk/types.js';

export function registerCanvasPrompts(server: McpServer): void {
  server.registerPrompt(
    'canvas.quickstart',
    {
      title: 'Canvas Quickstart',
      description: 'Kick-off instructions for using Canvas MCP tools effectively.'
    },
    () => buildQuickstartPrompt()
  );

  const assignmentArgs = {
    course_hint: z
      .string()
      .trim()
      .min(1)
      .describe('Optional name or code snippet for the course to prioritise.')
      .optional(),
    days: z
      .string()
      .trim()
      .regex(/^\d+$/, 'Provide the number of days as digits (e.g. "14").')
      .describe('How many days ahead to plan for upcoming work (numeric string, 1-60).')
      .optional()
  } satisfies Record<string, z.ZodTypeAny>;

  server.registerPrompt(
    'canvas.assignment_brief',
    {
      title: 'Assignment Brief',
      description: 'Guide the model through gathering course assignments and upcoming deliverables.',
      argsSchema: assignmentArgs
    },
    (args) => buildAssignmentBriefPrompt(args)
  );

  const announcementArgs = {
    course_hint: z
      .string()
      .trim()
      .min(1)
      .describe('Optional course identifier when the learner only needs a specific class.')
      .optional(),
    since: z
      .string()
      .datetime()
      .describe('ISO-8601 timestamp to bound announcements. Defaults to the last 14 days if omitted.')
      .optional()
  } satisfies Record<string, z.ZodTypeAny>;

  server.registerPrompt(
    'canvas.announcement_digest',
    {
      title: 'Announcement Digest',
      description: 'Produce a summary of recent Canvas announcements.',
      argsSchema: announcementArgs
    },
    (args) => buildAnnouncementDigestPrompt(args)
  );
}

function buildQuickstartPrompt(): GetPromptResult {
  const text = joinLines([
    'You are the Canvas study planner connected to the Canvas MCP server. Always rely on the provided tools to retrieve data instead of guessing.',
    '',
    'Available tools:',
    '- `list_courses`: discover Canvas course IDs, names, codes, and terms.',
    '- `list_assignments`: inspect assignments inside a course, filtering by due dates or keywords as needed.',
    '- `get_assignment`: drill into a single assignment for submission status or full details before advising.',
    '- `list_upcoming`: gather the near-term to-do list that Canvas surfaces across courses.',
    '- `list_announcements`: review announcements, optionally scoped to a single course or recent timeframe.',
    '',
    'Workflow:',
    '1. Clarify the learner\'s goal (course, timeframe, task type) and ask follow-up questions when details are missing.',
    '2. Call `list_courses` early to translate human course references into Canvas IDs before using other tools.',
    '3. Fetch targeted data with the other tools, choosing date filters or search terms that match the learner\'s request.',
    '4. Read tool results from `structuredContent` and combine them into a concise answer grouped by course and sorted by due date.',
    '5. Highlight overdue or at-risk work, include Canvas links when present, and suggest next actions or follow-up tools when data is missing.',
    '6. If no relevant data is found, state that clearly and recommend what the learner can try next (different filters, future check-ins, etc.).',
    '',
    'Keep responses actionable and skimmable--use short paragraphs or bullet lists so the learner can plan quickly.'
  ]);

  return {
    description: 'Kick-off instructions for Canvas support sessions.',
    messages: [toUserMessage(text)]
  };
}

function buildAssignmentBriefPrompt(args: {
  course_hint?: string;
  days?: string;
}): GetPromptResult {
  const courseHint = sanitize(args.course_hint);
  const parsedDays = parsePositiveInt(args.days, { min: 1, max: 60 });
  const horizonDays = parsedDays ?? 14;

  const focusLine = courseHint
    ? `Focus on the course that best matches "${courseHint}". Cross-check with \`list_courses\` and confirm with the learner if multiple matches exist.`
    : 'Ask the learner which course to plan for if it is unclear, and confirm the Canvas course ID via `list_courses`.';

  const text = joinLines([
    'Objective: create a concise assignment briefing for the learner.',
    '',
    focusLine,
    parsedDays !== undefined
      ? `Plan the next ${horizonDays} day(s) unless the learner requests something different.`
      : args.days
      ? `The provided days value "${args.days}" is not a valid positive integer, so default to a ${horizonDays}-day horizon unless the learner requests otherwise.`
      : `Plan the next ${horizonDays} day(s) unless the learner requests something different.`,
    '',
    'Recommended flow:',
    '1. Use `list_courses` to locate the course ID and surface the official course name/term.',
    '2. Pull the current workload with `list_assignments`, filtering by due date (`due_after`/`due_before`) or keywords when appropriate.',
    `3. Call \`list_upcoming\` with \`days=${horizonDays}\` to capture Canvas to-do items in the same horizon and merge them with assignments.`,
    '4. Use `get_assignment` on any item where you need the full prompt, submission status, or rubric context before making recommendations.',
    '5. Summarise findings by due date: show status (submitted, late, missing, pending), points, and Canvas links when available.',
    '6. Highlight urgent tasks, blockers, or missing data, and suggest follow-up actions the learner can take immediately.',
    '',
    'Answer format suggestion:',
    '- Course: <name> (<term>)',
    '  - Next actions for the coming week',
    '  - Upcoming deadlines with submission status and links',
    '  - Notes (missing submissions, instructions to review, questions to ask the instructor)'
  ]);

  return {
    description: 'Playbook for gathering and presenting Canvas assignments.',
    messages: [toUserMessage(text)]
  };
}

function buildAnnouncementDigestPrompt(args: {
  course_hint?: string;
  since?: string;
}): GetPromptResult {
  const courseHint = sanitize(args.course_hint);
  const since = sanitize(args.since);

  const courseLine = courseHint
    ? `Prioritise announcements from courses matching "${courseHint}". Use \`list_courses\` to map the hint to Canvas IDs and confirm with the learner when ambiguous.`
    : 'If no course is specified, explain that you will check recent announcements from all accessible courses and invite the learner to narrow it down.';

  const sinceLine = since
    ? `Filter announcements to those posted on or after ${since}.`
    : 'If no timeframe is supplied, default to the last 14 days and confirm that window with the learner.';

  const text = joinLines([
    'Objective: provide an actionable digest of recent Canvas announcements.',
    '',
    courseLine,
    sinceLine,
    '',
    'Recommended flow:',
    '1. Call `list_courses` when you need to translate user-friendly course names into Canvas IDs.',
    '2. Fetch announcements with `list_announcements`, supplying `course_id` when the learner only wants one course and the `since` parameter when a timeframe is known.',
    '3. Order announcements from newest to oldest. Extract titles, posted_at timestamps, author (if provided), and key takeaways.',
    '4. Note any embedded links or follow-up actions, and mention when no announcements were found for the requested window.',
    '5. Suggest what the learner should do next (e.g. acknowledge the announcement, check attachments, contact the instructor).'
  ]);

  return {
    description: 'Guidance for assembling Canvas announcement summaries.',
    messages: [toUserMessage(text)]
  };
}

function toUserMessage(text: string): PromptMessage {
  return {
    role: 'user',
    content: {
      type: 'text',
      text
    }
  };
}

function joinLines(lines: string[]): string {
  return lines.join('\n');
}

function parsePositiveInt(
  value: string | undefined,
  bounds: { min: number; max: number }
): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  if (parsed < bounds.min || parsed > bounds.max) {
    return undefined;
  }

  return parsed;
}

function sanitize(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.replace(/\s+/g, ' ').trim();
}
