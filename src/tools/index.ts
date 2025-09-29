import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import { CanvasClient, type CanvasResult } from '../canvas/client.js';
import {
  CanvasAnnouncement,
  CanvasAssignment,
  CanvasCourse,
  CanvasFile,
  CanvasFilePublicUrl,
  CanvasFolder,
  CanvasTodoItem
} from '../canvas/types.js';
import { AppError, unknownError } from '../core/errors.js';
import { log, logToolEvent } from '../core/logger.js';
import {
  getAssignmentOutputSchema,
  getFileDownloadUrlOutputSchema,
  getFileOutputSchema,
  getFolderOutputSchema,
  listAnnouncementsOutputSchema,
  listAssignmentsOutputSchema,
  listCoursesOutputSchema,
  listFilesOutputSchema,
  listFoldersOutputSchema,
  listUpcomingOutputSchema,
  type Course
} from './schemas.js';
import {
  mapAnnouncement,
  mapAssignment,
  mapCourse,
  mapFile,
  mapFolder,
  mapUpcomingFromAssignment
} from './mappers.js';

const DEFAULT_COURSE_LIMIT = 20;
const YEAR_REGEX = /(20\d{2})/;
const TERM_ORDER: Array<{ keyword: string; rank: number }> = [
  { keyword: 'winter', rank: 1 },
  { keyword: 'spring', rank: 2 },
  { keyword: 'summer', rank: 3 },
  { keyword: 'fall', rank: 4 },
  { keyword: 'autumn', rank: 4 },
  { keyword: 'fall-winter', rank: 5 }
];

export interface ToolDependencies {
  canvas: CanvasClient;
}

interface ToolMeta {
  status?: number;
  requestId?: string;
  requestIds?: string[];
}

type ToolHandler<TArgs, TResult extends Record<string, unknown>> = (
  args: TArgs
) => Promise<{
  payload: TResult;
  meta: ToolMeta;
}>;

function toMcpError(error: AppError | Error): McpError {
  if (error instanceof AppError) {
    return new McpError(ErrorCode.InternalError, error.message, {
      code: error.code,
      ...error.data
    });
  }

  return new McpError(ErrorCode.InternalError, error.message ?? 'Unexpected error');
}

function wrapTool<TArgs, TResult extends Record<string, unknown>>(
  name: string,
  handler: ToolHandler<TArgs, TResult>
): (args: TArgs) => Promise<{ content: []; structuredContent: TResult }> {
  return async (args: TArgs) => {
    const start = Date.now();
    try {
      const { payload, meta } = await handler(args);
      logToolEvent('tool.completed', {
        tool: name,
        status: 'success',
        durationMs: Date.now() - start,
        canvasStatus: meta.status,
        requestId: meta.requestId,
        extraRequestIds: meta.requestIds
      });

      return {
        content: [],
        structuredContent: payload
      };
    } catch (error) {
      const duration = Date.now() - start;
      if (error instanceof AppError || error instanceof Error) {
        const wrapped = toMcpError(error);
        logToolEvent('tool.failed', {
          tool: name,
          status: 'error',
          durationMs: duration,
          canvasStatus: (error instanceof AppError && error.data?.canvasStatus) || undefined,
          requestId: (error instanceof AppError && error.data?.requestId) || undefined,
          error
        });
        throw wrapped;
      }

      logToolEvent('tool.failed', {
        tool: name,
        status: 'error',
        durationMs: duration,
        error: String(error)
      });
      throw new McpError(ErrorCode.InternalError, 'Unexpected error');
    }
  };
}

function sortCoursesByRecency(courses: Course[]): Course[] {
  return [...courses].sort((a, b) => {
    const aInfo = courseRecencyInfo(a);
    const bInfo = courseRecencyInfo(b);

    if (aInfo.year !== bInfo.year) {
      return bInfo.year - aInfo.year;
    }

    if (aInfo.season !== bInfo.season) {
      return bInfo.season - aInfo.season;
    }

    return a.name.localeCompare(b.name);
  });
}

function filterRecentCourses(courses: Course[]): Course[] {
  const currentYear = new Date().getFullYear();
  const minYear = currentYear - 1;

  return courses.filter((course) => {
    const year = extractCourseYear(course);
    if (year === null) {
      return true;
    }
    return year >= minYear;
  });
}

function extractCourseYear(course: Course): number | null {
  const termYear = extractYear(course.term);
  if (termYear !== null) {
    return termYear;
  }

  return extractYear(course.course_code);
}

function extractYear(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const match = value.match(YEAR_REGEX);
  if (!match) {
    return null;
  }
  const year = Number(match[0]);
  return Number.isFinite(year) ? year : null;
}

function courseRecencyInfo(course: Course): { year: number; season: number } {
  const year = extractCourseYear(course) ?? -Infinity;
  const season = extractSeasonRank(course.term) ?? extractSeasonRank(course.course_code) ?? 0;
  return { year, season };
}

function extractSeasonRank(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const lower = value.toLowerCase();
  for (const { keyword, rank } of TERM_ORDER) {
    if (lower.includes(keyword)) {
      return rank;
    }
  }
  return null;
}

export function registerCanvasTools(server: McpServer, deps: ToolDependencies): void {
  registerListCourses(server, deps);
  registerListAssignments(server, deps);
  registerGetAssignment(server, deps);
  registerListAnnouncements(server, deps);
  registerListUpcoming(server, deps);
  registerListUserFiles(server, deps);
  registerListCourseFiles(server, deps);
  registerListFolderFiles(server, deps);
  registerGetFile(server, deps);
  registerGetFileDownloadUrl(server, deps);
  registerListUserFolders(server, deps);
  registerListCourseFolders(server, deps);
  registerGetFolder(server, deps);
}

function registerListCourses(server: McpServer, deps: ToolDependencies): void {
  const inputSchema = {
    enrollment_state: z.enum(['active', 'completed']).optional(),
    include_past: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).optional()
  };

  server.registerTool(
    'list_courses',
    {
      title: 'List Courses',
      description: 'List Canvas courses for the authenticated user',
      inputSchema,
      outputSchema: listCoursesOutputSchema.shape
    },
    wrapTool(
      'list_courses',
      async (args: {
        enrollment_state?: 'active' | 'completed';
        include_past?: boolean;
        limit?: number;
      }) => {
        const params: Record<string, unknown> = {
          'include[]': ['term']
        };

        if (args.enrollment_state) {
          params['enrollment_state[]'] = [args.enrollment_state];
        }

        params['state[]'] = ['available'];

        const { data, status, requestId, requestIds } = await deps.canvas.getAll<CanvasCourse>(
          '/api/v1/users/self/courses',
          params
        );

        const includePast = args.include_past ?? false;
        const limit = args.limit ?? DEFAULT_COURSE_LIMIT;

        let courses = data.map(mapCourse);
        courses = sortCoursesByRecency(courses);

        if (!includePast) {
          courses = filterRecentCourses(courses);
        }

        if (limit) {
          courses = courses.slice(0, limit);
        }

        const payload = listCoursesOutputSchema.parse({
          courses
        });

        return {
          payload,
          meta: { status, requestId, requestIds }
        };
      }
    )
  );
}

function registerListAssignments(server: McpServer, deps: ToolDependencies): void {
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

function registerGetAssignment(server: McpServer, deps: ToolDependencies): void {
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

function registerListAnnouncements(server: McpServer, deps: ToolDependencies): void {
  const inputSchema = {
    course_id: z.number().int().nonnegative().optional(),
    since: z.string().datetime().optional()
  } satisfies Record<string, z.ZodTypeAny>;

  server.registerTool(
    'list_announcements',
    {
      title: 'List Announcements',
      description: 'List announcements across Canvas courses',
      inputSchema,
      outputSchema: listAnnouncementsOutputSchema.shape
    },
    wrapTool(
      'list_announcements',
      async (args: { course_id?: number; since?: string }) => {
        let contextCodes: string[] | undefined;
        const requestIds: string[] = [];
        const statuses: number[] = [];

        if (args.course_id) {
          contextCodes = [`course_${args.course_id}`];
        } else {
          const coursesResult = await deps.canvas.getAll<CanvasCourse>(
            '/api/v1/users/self/courses',
            { 'enrollment_state[]': ['active'], 'include[]': ['term'] }
          );
          if (coursesResult.requestIds) {
            requestIds.push(...coursesResult.requestIds);
          } else if (coursesResult.requestId) {
            requestIds.push(coursesResult.requestId);
          }
          statuses.push(coursesResult.status);

          contextCodes = coursesResult.data.map((course) => `course_${course.id}`);
        }

        if (!contextCodes || contextCodes.length === 0) {
          throw unknownError('No accessible Canvas courses found for announcements.');
        }

        const params: Record<string, unknown> = {
          'context_codes[]': contextCodes,
          active_only: true
        };

        if (args.since) {
          params.start_date = args.since;
        }

        const { data, status, requestId, requestIds: announcementReqIds } =
          await deps.canvas.getAll<CanvasAnnouncement>('/api/v1/announcements', params);

        if (requestId) {
          requestIds.push(requestId);
        }
        if (announcementReqIds) {
          requestIds.push(...announcementReqIds);
        }
        statuses.push(status);

        const payload = listAnnouncementsOutputSchema.parse({
          announcements: data.map(mapAnnouncement)
        });

        return {
          payload,
          meta: {
            status: statuses.at(-1),
            requestId: requestIds.at(-1),
            requestIds
          }
        };
      }
    )
  );
}

function registerListUpcoming(server: McpServer, deps: ToolDependencies): void {
  const inputSchema = {
    days: z.number().int().min(1).max(30).optional()
  } satisfies Record<string, z.ZodTypeAny>;

  server.registerTool(
    'list_upcoming',
    {
      title: 'List Upcoming Work',
      description: 'Combine Canvas to-dos and upcoming assignments sorted by due date',
      inputSchema,
      outputSchema: listUpcomingOutputSchema.shape
    },
    wrapTool('list_upcoming', async (args: { days?: number }) => {
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

      for (const course of coursesResult.data) {
        let assignmentsResult: CanvasResult<CanvasAssignment[]>;
        try {
          assignmentsResult = await deps.canvas.getAll<CanvasAssignment>(
            `/api/v1/courses/${course.id}/assignments`,
            {
              'include[]': ['submission'],
              bucket: 'upcoming'
            }
          );
        } catch (error) {
          if (error instanceof AppError && error.code === 'AUTHORIZATION_FAILED') {
            log('warn', 'Skipping course for upcoming assignments due to authorization error', {
              course_id: course.id
            });
            continue;
          }
          throw error;
        }

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

function registerListUserFiles(server: McpServer, deps: ToolDependencies): void {
  const inputSchema = {
    search_term: z.string().optional(),
    content_types: z.array(z.string()).optional(),
    sort: z.enum(['name', 'size', 'created_at', 'updated_at', 'content_type']).optional(),
    order: z.enum(['asc', 'desc']).optional()
  } satisfies Record<string, z.ZodTypeAny>;

  server.registerTool(
    'list_user_files',
    {
      title: 'List User Files',
      description: 'List files in the authenticated user\'s personal files',
      inputSchema,
      outputSchema: listFilesOutputSchema.shape
    },
    wrapTool(
      'list_user_files',
      async (args: {
        search_term?: string;
        content_types?: string[];
        sort?: 'name' | 'size' | 'created_at' | 'updated_at' | 'content_type';
        order?: 'asc' | 'desc';
      }) => {
        const params: Record<string, unknown> = {};

        if (args.search_term) {
          params.search_term = args.search_term;
        }
        if (args.content_types && args.content_types.length > 0) {
          params['content_types[]'] = args.content_types;
        }
        if (args.sort) {
          params.sort = args.sort;
        }
        if (args.order) {
          params.order = args.order;
        }

        const { data, status, requestId, requestIds } = await deps.canvas.getAll<CanvasFile>(
          '/api/v1/users/self/files',
          params
        );

        const files = data.map(mapFile);
        const payload = listFilesOutputSchema.parse({ files });

        return {
          payload,
          meta: { status, requestId, requestIds }
        };
      }
    )
  );
}

function registerListCourseFiles(server: McpServer, deps: ToolDependencies): void {
  const inputSchema = {
    course_id: z.number().int().nonnegative(),
    search_term: z.string().optional(),
    content_types: z.array(z.string()).optional(),
    sort: z.enum(['name', 'size', 'created_at', 'updated_at', 'content_type']).optional(),
    order: z.enum(['asc', 'desc']).optional()
  } satisfies Record<string, z.ZodTypeAny>;

  server.registerTool(
    'list_course_files',
    {
      title: 'List Course Files',
      description: 'List files within a Canvas course',
      inputSchema,
      outputSchema: listFilesOutputSchema.shape
    },
    wrapTool(
      'list_course_files',
      async (args: {
        course_id: number;
        search_term?: string;
        content_types?: string[];
        sort?: 'name' | 'size' | 'created_at' | 'updated_at' | 'content_type';
        order?: 'asc' | 'desc';
      }) => {
        const params: Record<string, unknown> = {};

        if (args.search_term) {
          params.search_term = args.search_term;
        }
        if (args.content_types && args.content_types.length > 0) {
          params['content_types[]'] = args.content_types;
        }
        if (args.sort) {
          params.sort = args.sort;
        }
        if (args.order) {
          params.order = args.order;
        }

        const { data, status, requestId, requestIds } = await deps.canvas.getAll<CanvasFile>(
          `/api/v1/courses/${args.course_id}/files`,
          params
        );

        const files = data.map(mapFile);
        const payload = listFilesOutputSchema.parse({ files });

        return {
          payload,
          meta: { status, requestId, requestIds }
        };
      }
    )
  );
}

function registerListFolderFiles(server: McpServer, deps: ToolDependencies): void {
  const inputSchema = {
    folder_id: z.number().int().nonnegative(),
    search_term: z.string().optional(),
    content_types: z.array(z.string()).optional(),
    sort: z.enum(['name', 'size', 'created_at', 'updated_at', 'content_type']).optional(),
    order: z.enum(['asc', 'desc']).optional()
  } satisfies Record<string, z.ZodTypeAny>;

  server.registerTool(
    'list_folder_files',
    {
      title: 'List Folder Files',
      description: 'List files within a specific folder',
      inputSchema,
      outputSchema: listFilesOutputSchema.shape
    },
    wrapTool(
      'list_folder_files',
      async (args: {
        folder_id: number;
        search_term?: string;
        content_types?: string[];
        sort?: 'name' | 'size' | 'created_at' | 'updated_at' | 'content_type';
        order?: 'asc' | 'desc';
      }) => {
        const params: Record<string, unknown> = {};

        if (args.search_term) {
          params.search_term = args.search_term;
        }
        if (args.content_types && args.content_types.length > 0) {
          params['content_types[]'] = args.content_types;
        }
        if (args.sort) {
          params.sort = args.sort;
        }
        if (args.order) {
          params.order = args.order;
        }

        const { data, status, requestId, requestIds } = await deps.canvas.getAll<CanvasFile>(
          `/api/v1/folders/${args.folder_id}/files`,
          params
        );

        const files = data.map(mapFile);
        const payload = listFilesOutputSchema.parse({ files });

        return {
          payload,
          meta: { status, requestId, requestIds }
        };
      }
    )
  );
}

function registerGetFile(server: McpServer, deps: ToolDependencies): void {
  const inputSchema = {
    file_id: z.number().int().nonnegative()
  } satisfies Record<string, z.ZodTypeAny>;

  server.registerTool(
    'get_file',
    {
      title: 'Get File',
      description: 'Get detailed information about a specific file',
      inputSchema,
      outputSchema: getFileOutputSchema.shape
    },
    wrapTool('get_file', async (args: { file_id: number }) => {
      const { data, status, requestId } = await deps.canvas.get<CanvasFile>(
        `/api/v1/files/${args.file_id}`
      );

      const payload = getFileOutputSchema.parse({
        file: mapFile(data)
      });

      return {
        payload,
        meta: { status, requestId }
      };
    })
  );
}

function registerGetFileDownloadUrl(server: McpServer, deps: ToolDependencies): void {
  const inputSchema = {
    file_id: z.number().int().nonnegative(),
    submission_id: z.number().int().nonnegative().optional()
  } satisfies Record<string, z.ZodTypeAny>;

  server.registerTool(
    'get_file_download_url',
    {
      title: 'Get File Download URL',
      description:
        'Get a temporary download URL for a file. The URL is signed and expires after a short time.',
      inputSchema,
      outputSchema: getFileDownloadUrlOutputSchema.shape
    },
    wrapTool(
      'get_file_download_url',
      async (args: { file_id: number; submission_id?: number }) => {
        const params: Record<string, unknown> = {};

        if (args.submission_id) {
          params.submission_id = args.submission_id;
        }

        const { data, status, requestId } = await deps.canvas.get<CanvasFilePublicUrl>(
          `/api/v1/files/${args.file_id}/public_url`,
          params
        );

        const payload = getFileDownloadUrlOutputSchema.parse({
          file_id: args.file_id,
          download_url: data.public_url
        });

        return {
          payload,
          meta: { status, requestId }
        };
      }
    )
  );
}

function registerListUserFolders(server: McpServer, deps: ToolDependencies): void {
  const inputSchema = {} satisfies Record<string, z.ZodTypeAny>;

  server.registerTool(
    'list_user_folders',
    {
      title: 'List User Folders',
      description: 'List all folders in the authenticated user\'s personal files',
      inputSchema,
      outputSchema: listFoldersOutputSchema.shape
    },
    wrapTool('list_user_folders', async () => {
      const { data, status, requestId, requestIds } = await deps.canvas.getAll<CanvasFolder>(
        '/api/v1/users/self/folders'
      );

      const folders = data.map(mapFolder);
      const payload = listFoldersOutputSchema.parse({ folders });

      return {
        payload,
        meta: { status, requestId, requestIds }
      };
    })
  );
}

function registerListCourseFolders(server: McpServer, deps: ToolDependencies): void {
  const inputSchema = {
    course_id: z.number().int().nonnegative()
  } satisfies Record<string, z.ZodTypeAny>;

  server.registerTool(
    'list_course_folders',
    {
      title: 'List Course Folders',
      description: 'List all folders within a Canvas course',
      inputSchema,
      outputSchema: listFoldersOutputSchema.shape
    },
    wrapTool('list_course_folders', async (args: { course_id: number }) => {
      const { data, status, requestId, requestIds } = await deps.canvas.getAll<CanvasFolder>(
        `/api/v1/courses/${args.course_id}/folders`
      );

      const folders = data.map(mapFolder);
      const payload = listFoldersOutputSchema.parse({ folders });

      return {
        payload,
        meta: { status, requestId, requestIds }
      };
    })
  );
}

function registerGetFolder(server: McpServer, deps: ToolDependencies): void {
  const inputSchema = {
    folder_id: z.number().int().nonnegative()
  } satisfies Record<string, z.ZodTypeAny>;

  server.registerTool(
    'get_folder',
    {
      title: 'Get Folder',
      description: 'Get detailed information about a specific folder',
      inputSchema,
      outputSchema: getFolderOutputSchema.shape
    },
    wrapTool('get_folder', async (args: { folder_id: number }) => {
      const { data, status, requestId } = await deps.canvas.get<CanvasFolder>(
        `/api/v1/folders/${args.folder_id}`
      );

      const payload = getFolderOutputSchema.parse({
        folder: mapFolder(data)
      });

      return {
        payload,
        meta: { status, requestId }
      };
    })
  );
}
