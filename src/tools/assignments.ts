import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import {
  CanvasAssignment,
  CanvasCourse,
  CanvasTodoItem
} from '../canvas/types.js';
import { type CanvasResult } from '../canvas/client.js';
import { AppError } from '../core/errors.js';
import { log } from '../core/logger.js';
import {
  getAssignmentOutputSchema,
  listAssignmentsOutputSchema,
  listUpcomingOutputSchema
} from './schemas.js';
import { mapAssignment, mapUpcomingFromAssignment } from './mappers.js';
import {
  createConcurrencyLimiter,
  wrapTool,
  type ToolDependencies
} from './shared.js';

const UPCOMING_ASSIGNMENT_CONCURRENCY = 5;

export function registerListAssignments(server: McpServer, deps: ToolDependencies): void {
  const inputSchema = {
    course_id: z.number().int().nonnegative(),
    due_after: z.string().datetime().optional(),
    due_before: z.string().datetime().optional(),
    search: z.string().trim().min(1).optional()
  } satisfies Record<string, z.ZodTypeAny>;

  server.registerTool(
    'list_assignments',
    {
      title: 'List Assignments',
      description: 'List assignments within a Canvas course',
      inputSchema,
      outputSchema: listAssignmentsOutputSchema.shape
    },
    wrapTool(
      'list_assignments',
      async (args: {
        course_id: number;
        due_after?: string;
        due_before?: string;
        search?: string;
      }) => {
        const params: Record<string, unknown> = {
          'include[]': ['submission']
        };

        if (args.due_after) {
          params.due_after = args.due_after;
        }
        if (args.due_before) {
          params.due_before = args.due_before;
        }
        if (args.search) {
          params.search_term = args.search;
        }

        const { data, status, requestId, requestIds } = await deps.canvas.getAll<CanvasAssignment>(
          `/api/v1/courses/${args.course_id}/assignments`,
          params
        );

        const assignments = data.map((assignment) =>
          mapAssignment({ ...assignment, course_id: assignment.course_id ?? args.course_id })
        );

        const payload = listAssignmentsOutputSchema.parse({ assignments });

        return {
          payload,
          meta: { status, requestId, requestIds }
        };
      }
    )
  );
}

export function registerGetAssignment(server: McpServer, deps: ToolDependencies): void {
  const inputSchema = {
    course_id: z.number().int().nonnegative(),
    assignment_id: z.number().int().nonnegative()
  } satisfies Record<string, z.ZodTypeAny>;

  server.registerTool(
    'get_assignment',
    {
      title: 'Get Assignment',
      description: 'Fetch a single assignment by id',
      inputSchema,
      outputSchema: getAssignmentOutputSchema.shape
    },
    wrapTool(
      'get_assignment',
      async (args: { course_id: number; assignment_id: number }) => {
        const { data, status, requestId } = await deps.canvas.get<CanvasAssignment>(
          `/api/v1/courses/${args.course_id}/assignments/${args.assignment_id}`,
          {
            'include[]': ['submission']
          }
        );

        const payload = getAssignmentOutputSchema.parse({
          assignment: mapAssignment({ ...data, course_id: data.course_id ?? args.course_id })
        });

        return {
          payload,
          meta: { status, requestId }
        };
      }
    )
  );
}

function isWithinRange(
  isoDate: string | null | undefined,
  start: Date,
  end: Date
): boolean {
  if (!isoDate) {
    return false;
  }

  const timestamp = Date.parse(isoDate);
  if (Number.isNaN(timestamp)) {
    return false;
  }

  return timestamp >= start.getTime() && timestamp <= end.getTime();
}

export function registerListUpcoming(server: McpServer, deps: ToolDependencies): void {
  const inputSchema = {
    days: z.number().int().min(1).max(30).optional(),
    max_courses: z.number().int().min(1).max(100).optional()
  } satisfies Record<string, z.ZodTypeAny>;

  server.registerTool(
    'list_upcoming',
    {
      title: 'List Upcoming Work',
      description: 'Combine Canvas to-dos and upcoming assignments sorted by due date',
      inputSchema,
      outputSchema: listUpcomingOutputSchema.shape
    },
    wrapTool('list_upcoming', async (args: { days?: number; max_courses?: number }) => {
      const rangeDays = args.days ?? 7;
      const now = new Date();
      const rangeEnd = new Date(now.getTime() + rangeDays * 24 * 60 * 60 * 1000);

      const upcomingMap = new Map<number, ReturnType<typeof mapUpcomingFromAssignment>>();
      const metaRequestIds: string[] = [];
      const metaStatuses: number[] = [];

      const todoResult = await deps.canvas.getAll<CanvasTodoItem>('/api/v1/users/self/todo');
      if (todoResult.requestIds) {
        metaRequestIds.push(...todoResult.requestIds);
      } else if (todoResult.requestId) {
        metaRequestIds.push(todoResult.requestId);
      }
      metaStatuses.push(todoResult.status);

      for (const todo of todoResult.data) {
        if (!todo.assignment) {
          continue;
        }

        const assignment: CanvasAssignment = {
          ...todo.assignment,
          course_id: todo.assignment.course_id ?? todo.course_id ?? 0,
          html_url: todo.assignment.html_url ?? todo.html_url ?? ''
        };

        if (!isWithinRange(assignment.due_at, now, rangeEnd)) {
          continue;
        }

        const mapped = mapUpcomingFromAssignment(assignment, 'todo');
        upcomingMap.set(mapped.id, mapped);
      }

      const coursesResult = await deps.canvas.getAll<CanvasCourse>(
        '/api/v1/users/self/courses',
        { 'enrollment_state[]': ['active'] }
      );
      if (coursesResult.requestIds) {
        metaRequestIds.push(...coursesResult.requestIds);
      } else if (coursesResult.requestId) {
        metaRequestIds.push(coursesResult.requestId);
      }
      metaStatuses.push(coursesResult.status);

      const maxCourses = args.max_courses ?? coursesResult.data.length;
      const courses = coursesResult.data.slice(0, maxCourses);
      const limitAssignments = createConcurrencyLimiter(UPCOMING_ASSIGNMENT_CONCURRENCY);

      type AssignmentSuccess = {
        course: CanvasCourse;
        assignmentsResult: CanvasResult<CanvasAssignment[]>;
      };
      type AssignmentFailure = { course: CanvasCourse; error: unknown; isAuthFailure: boolean };
      type AssignmentFetchResult = AssignmentSuccess | AssignmentFailure;

      const assignmentResults: AssignmentFetchResult[] = await Promise.all(
        courses.map((course) =>
          limitAssignments(async () => {
            try {
              const assignmentsResult = await deps.canvas.getAll<CanvasAssignment>(
                `/api/v1/courses/${course.id}/assignments`,
                {
                  'include[]': ['submission'],
                  bucket: 'upcoming'
                }
              );

              return { course, assignmentsResult };
            } catch (error) {
              const isAuthFailure =
                error instanceof AppError && error.code === 'AUTHORIZATION_FAILED';
              if (isAuthFailure) {
                log(
                  'warn',
                  'Skipping course for upcoming assignments due to authorization error',
                  { course_id: course.id }
                );
                return { course, error, isAuthFailure };
              }

              log('warn', 'Skipping course for upcoming assignments due to error', {
                course_id: course.id,
                error: error instanceof Error ? error.message : String(error),
                code: error instanceof AppError ? error.code : undefined
              });
              return { course, error, isAuthFailure: false };
            }
          })
        )
      );

      let assignmentSuccessCount = 0;
      let assignmentAuthFailureCount = 0;
      let assignmentNonAuthFailureCount = 0;

      for (const result of assignmentResults) {
        if (!('assignmentsResult' in result)) {
          if (result?.isAuthFailure) {
            assignmentAuthFailureCount += 1;
          } else if (result) {
            assignmentNonAuthFailureCount += 1;
          }
          continue;
        }

        const { course, assignmentsResult } = result;
        assignmentSuccessCount += 1;

        if (assignmentsResult.requestIds) {
          metaRequestIds.push(...assignmentsResult.requestIds);
        } else if (assignmentsResult.requestId) {
          metaRequestIds.push(assignmentsResult.requestId);
        }
        metaStatuses.push(assignmentsResult.status);

        for (const assignment of assignmentsResult.data) {
          const dueAt = assignment.due_at ?? null;
          if (dueAt && !isWithinRange(dueAt, now, rangeEnd)) {
            continue;
          }

          const mapped = mapUpcomingFromAssignment(
            { ...assignment, course_id: assignment.course_id ?? course.id },
            'assignment'
          );

          if (!upcomingMap.has(mapped.id)) {
            upcomingMap.set(mapped.id, mapped);
          }
        }
      }

      if (courses.length > 0 && assignmentSuccessCount === 0) {
        const details = {
          courseCount: courses.length,
          authFailures: assignmentAuthFailureCount,
          nonAuthFailures: assignmentNonAuthFailureCount
        };
        if (assignmentNonAuthFailureCount > 0) {
          throw new AppError(
            'CANVAS_UNAVAILABLE',
            'Failed to fetch upcoming assignments for all courses.',
            503,
            { details }
          );
        }
        throw new AppError(
          'AUTHORIZATION_FAILED',
          'Authorization failed for all courses when fetching assignments.',
          403,
          { details }
        );
      }

      const upcoming = Array.from(upcomingMap.values()).sort((a, b) => {
        const aTime = a.due_at ? Date.parse(a.due_at) : Number.POSITIVE_INFINITY;
        const bTime = b.due_at ? Date.parse(b.due_at) : Number.POSITIVE_INFINITY;
        return aTime - bTime;
      });

      const payload = listUpcomingOutputSchema.parse({ upcoming });

      return {
        payload,
        meta: {
          status: metaStatuses.at(-1),
          requestId: metaRequestIds.at(-1),
          requestIds: metaRequestIds
        }
      };
    })
  );
}
