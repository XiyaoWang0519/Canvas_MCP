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
  CanvasModule,
  CanvasModuleItem,
  CanvasPage,
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
  listCourseMaterialsOutputSchema,
  listCoursesOutputSchema,
  listFilesOutputSchema,
  listFoldersOutputSchema,
  listUpcomingOutputSchema,
  materialTypeValues,
  resolveExternalDownloadsInputSchema,
  resolveExternalDownloadsOutputSchema,
  type Course,
  type CourseMaterial,
  type MaterialType,
  type ResolveExternalDownloadsMaterialResult
} from './schemas.js';
import {
  mapAnnouncement,
  mapAssignment,
  mapCourse,
  mapFile,
  mapFolder,
  mapUpcomingFromAssignment
} from './mappers.js';
import {
  buildCourseMaterialKey,
  createBodySnippet,
  extractDiscoveredLinksFromHtml,
  mapModuleItemRef,
  upsertCourseMaterial
} from './course-materials.js';
import {
  classifyBrowserFallbackReason,
  dedupeResolvedLinks,
  extractExternalDownloadLinksFromHtml,
  fetchExternalResource,
  finalizeResultStatus,
  toAbsoluteHttpUrl,
  validateOutboundHttpUrl,
  type ExternalFetchLike
} from './external-downloads.js';
import { toCanvasTimezone } from '../core/timezone.js';

const DEFAULT_COURSE_LIMIT = 20;
const UPCOMING_ASSIGNMENT_CONCURRENCY = 5;
const COURSE_MATERIALS_LIMIT_DEFAULT = 200;
const COURSE_MATERIALS_LIMIT_MAX = 1000;
const COURSE_MATERIALS_DETAIL_CONCURRENCY = 5;
const EXTERNAL_DOWNLOADS_DEFAULT_MAX_PAGES = 20;
const EXTERNAL_DOWNLOADS_MAX_PAGES = 100;
const EXTERNAL_DOWNLOADS_DEFAULT_MAX_LINKS_PER_PAGE = 50;
const EXTERNAL_DOWNLOADS_MAX_LINKS_PER_PAGE = 200;
const EXTERNAL_DOWNLOADS_DEFAULT_TIMEOUT_MS = 15_000;
const EXTERNAL_DOWNLOADS_MIN_TIMEOUT_MS = 2_000;
const EXTERNAL_DOWNLOADS_MAX_TIMEOUT_MS = 60_000;
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
  fetchImpl?: ExternalFetchLike;
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

function createConcurrencyLimiter(maxConcurrent: number) {
  const limit = Math.max(1, Math.floor(maxConcurrent));
  let active = 0;
  const queue: Array<() => void> = [];

  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const execute = () => {
        active += 1;
        fn()
          .then(resolve)
          .catch(reject)
          .finally(() => {
            active -= 1;
            const next = queue.shift();
            if (next) {
              next();
            }
          });
      };

      if (active < limit) {
        execute();
      } else {
        queue.push(execute);
      }
    });
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
  registerListCourseMaterials(server, deps);
  registerResolveExternalDownloads(server, deps);
  registerListUserFiles(server, deps);
  registerListCourseFiles(server, deps);
  registerListFolderFiles(server, deps);
  registerGetFile(server, deps);
  registerGetFileDownloadUrl(server, deps);
  registerListUserFolders(server, deps);
  registerListCourseFolders(server, deps);
  registerGetFolder(server, deps);
}

type FileToolCommonArgs = {
  search_term?: string;
  content_types?: string;
  sort?: 'name' | 'size' | 'created_at' | 'updated_at' | 'content_type';
  order?: 'asc' | 'desc';
};

function normalizeContentTypes(value: string | string[] | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }

  const values = Array.isArray(value) ? value : value.split(',');

  const normalized = values
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return normalized.length > 0 ? normalized : undefined;
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

type MetaAccumulator = {
  statuses: number[];
  requestIds: string[];
};

function collectMeta<T>(acc: MetaAccumulator, result: CanvasResult<T>): void {
  acc.statuses.push(result.status);

  if (result.requestIds) {
    acc.requestIds.push(...result.requestIds);
    return;
  }

  if (result.requestId) {
    acc.requestIds.push(result.requestId);
  }
}

function getFirstContentId(material: CourseMaterial): number | undefined {
  return material.item_refs.find((ref) => typeof ref.content_id === 'number')?.content_id;
}

function getFirstPageIdentifier(material: CourseMaterial): string | undefined {
  const ref = material.item_refs.find((entry) => entry.page_url) ?? material.item_refs[0];
  if (!ref) {
    return undefined;
  }

  if (ref.page_url) {
    return ref.page_url;
  }

  if (typeof ref.content_id === 'number') {
    return String(ref.content_id);
  }

  return undefined;
}

async function collectCourseMaterialsFromModules(args: {
  courseId: number;
  includeTypes: Set<MaterialType>;
  deps: ToolDependencies;
  meta: MetaAccumulator;
}): Promise<{
  scannedModules: number;
  scannedItems: number;
  materials: CourseMaterial[];
}> {
  const modulesResult = await args.deps.canvas.getAll<CanvasModule>(
    `/api/v1/courses/${args.courseId}/modules`
  );
  collectMeta(args.meta, modulesResult);

  let scannedItems = 0;
  const materialMap = new Map<string, CourseMaterial>();

  for (const module of modulesResult.data) {
    const itemsResult = await args.deps.canvas.getAll<CanvasModuleItem>(
      `/api/v1/courses/${args.courseId}/modules/${module.id}/items`,
      {
        'include[]': ['content_details']
      }
    );
    collectMeta(args.meta, itemsResult);

    scannedItems += itemsResult.data.length;

    for (const item of itemsResult.data) {
      const itemRef = mapModuleItemRef(module, item);
      if (!itemRef || !args.includeTypes.has(itemRef.type)) {
        continue;
      }

      const key = buildCourseMaterialKey(itemRef);
      upsertCourseMaterial(materialMap, key, itemRef);
    }
  }

  const materials = Array.from(materialMap.values());
  for (const material of materials) {
    material.item_refs = material.item_refs.sort((a, b) => a.item_id - b.item_id);
    material.source.module_ids = material.source.module_ids.sort((a, b) => a - b);
    material.source.module_item_ids = material.source.module_item_ids.sort((a, b) => a - b);
  }

  return {
    scannedModules: modulesResult.data.length,
    scannedItems,
    materials
  };
}

function mapMaterialAssignment(raw: CanvasAssignment): NonNullable<CourseMaterial['assignment']> {
  return {
    id: raw.id,
    name: raw.name,
    html_url: raw.html_url,
    due_at: toCanvasTimezone(raw.due_at) ?? raw.due_at ?? null,
    unlock_at: toCanvasTimezone(raw.unlock_at) ?? raw.unlock_at ?? null,
    lock_at: toCanvasTimezone(raw.lock_at) ?? raw.lock_at ?? null,
    created_at: toCanvasTimezone(raw.created_at) ?? raw.created_at ?? null,
    updated_at: toCanvasTimezone(raw.updated_at) ?? raw.updated_at ?? null,
    points_possible: typeof raw.points_possible === 'number' ? raw.points_possible : null
  };
}

function mapMaterialPage(raw: CanvasPage): NonNullable<CourseMaterial['page']> {
  return {
    page_id: typeof raw.page_id === 'number' ? raw.page_id : undefined,
    url: raw.url,
    title: raw.title?.trim() || 'Untitled page',
    html_url: raw.html_url,
    body_snippet: createBodySnippet(raw.body),
    created_at: toCanvasTimezone(raw.created_at) ?? raw.created_at,
    updated_at: toCanvasTimezone(raw.updated_at) ?? raw.updated_at,
    published: typeof raw.published === 'boolean' ? raw.published : undefined,
    locked_for_user:
      typeof raw.locked_for_user === 'boolean' ? raw.locked_for_user : undefined
  };
}

async function enrichCourseMaterial(
  material: CourseMaterial,
  args: {
    courseId: number;
    includeHtmlLinkExtraction: boolean;
    deps: ToolDependencies;
    meta: MetaAccumulator;
  }
): Promise<void> {
  if (material.type === 'ExternalTool' || material.type === 'ExternalUrl') {
    const ref = material.item_refs.find((entry) => entry.external_url || entry.url) ?? material.item_refs[0];
    if (!ref) {
      return;
    }

    material.external = {
      url: ref.external_url ?? ref.url,
      html_url: ref.html_url
    };
    return;
  }

  if (material.type === 'File') {
    const fileId = getFirstContentId(material);
    if (!fileId) {
      return;
    }

    try {
      const fileResult = await args.deps.canvas.get<CanvasFile>(`/api/v1/files/${fileId}`);
      collectMeta(args.meta, fileResult);
      const file = mapFile(fileResult.data);

      let downloadUrl: string | undefined;
      try {
        const downloadResult = await args.deps.canvas.get<CanvasFilePublicUrl>(
          `/api/v1/files/${fileId}/public_url`
        );
        collectMeta(args.meta, downloadResult);
        downloadUrl = downloadResult.data.public_url;
      } catch (error) {
        log('warn', 'Unable to resolve temporary download URL for file material', {
          key: material.key,
          file_id: fileId,
          error: error instanceof Error ? error.message : String(error),
          code: error instanceof AppError ? error.code : undefined
        });
      }

      material.file = {
        ...file,
        download_url: downloadUrl
      };
      material.title = material.title || file.display_name;
    } catch (error) {
      log('warn', 'Skipping file enrichment for course material', {
        key: material.key,
        file_id: fileId,
        error: error instanceof Error ? error.message : String(error),
        code: error instanceof AppError ? error.code : undefined
      });
    }

    return;
  }

  if (material.type === 'Page') {
    const pageIdentifier = getFirstPageIdentifier(material);
    if (!pageIdentifier) {
      return;
    }

    try {
      const pageResult = await args.deps.canvas.get<CanvasPage>(
        `/api/v1/courses/${args.courseId}/pages/${encodeURIComponent(pageIdentifier)}`
      );
      collectMeta(args.meta, pageResult);
      material.page = mapMaterialPage(pageResult.data);
      material.title = material.page.title;
    } catch (error) {
      log('warn', 'Skipping page enrichment for course material', {
        key: material.key,
        page_identifier: pageIdentifier,
        error: error instanceof Error ? error.message : String(error),
        code: error instanceof AppError ? error.code : undefined
      });
    }

    return;
  }

  if (material.type === 'Assignment') {
    const assignmentId = getFirstContentId(material);
    if (!assignmentId) {
      return;
    }

    try {
      const assignmentResult = await args.deps.canvas.get<CanvasAssignment>(
        `/api/v1/courses/${args.courseId}/assignments/${assignmentId}`,
        {
          'include[]': ['submission']
        }
      );
      collectMeta(args.meta, assignmentResult);
      material.assignment = mapMaterialAssignment(assignmentResult.data);
      material.title = assignmentResult.data.name;

      if (args.includeHtmlLinkExtraction) {
        const discoveredLinks = extractDiscoveredLinksFromHtml(assignmentResult.data.description);
        if (discoveredLinks.length > 0) {
          material.discovered_links = discoveredLinks;
        }
      }
    } catch (error) {
      log('warn', 'Skipping assignment enrichment for course material', {
        key: material.key,
        assignment_id: assignmentId,
        error: error instanceof Error ? error.message : String(error),
        code: error instanceof AppError ? error.code : undefined
      });
    }
  }
}

function registerListCourseMaterials(server: McpServer, deps: ToolDependencies): void {
  const inputSchema = {
    course_id: z.number().int().nonnegative(),
    include_types: z.array(z.enum(materialTypeValues)).optional(),
    include_html_link_extraction: z.boolean().optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(COURSE_MATERIALS_LIMIT_MAX)
      .optional()
  } satisfies Record<string, z.ZodTypeAny>;

  server.registerTool(
    'list_course_materials',
    {
      title: 'List Course Materials',
      description:
        'Aggregate discoverable course-provided materials from module items (files, pages, assignments, links, and more).',
      inputSchema,
      outputSchema: listCourseMaterialsOutputSchema.shape
    },
    wrapTool(
      'list_course_materials',
      async (args: {
        course_id: number;
        include_types?: MaterialType[];
        include_html_link_extraction?: boolean;
        limit?: number;
      }) => {
        const includeTypes = new Set<MaterialType>(
          args.include_types && args.include_types.length > 0
            ? args.include_types
            : [...materialTypeValues]
        );
        const includeHtmlLinkExtraction = args.include_html_link_extraction ?? true;
        const limit = args.limit ?? COURSE_MATERIALS_LIMIT_DEFAULT;

        const meta: MetaAccumulator = {
          statuses: [],
          requestIds: []
        };

        const collected = await collectCourseMaterialsFromModules({
          courseId: args.course_id,
          includeTypes,
          deps,
          meta
        });

        const deduplicatedMaterials = collected.materials;
        const truncated = deduplicatedMaterials.length > limit;
        const materials = deduplicatedMaterials.slice(0, limit);

        const limitEnrichment = createConcurrencyLimiter(COURSE_MATERIALS_DETAIL_CONCURRENCY);
        await Promise.all(
          materials.map((material) =>
            limitEnrichment(() =>
              enrichCourseMaterial(material, {
                courseId: args.course_id,
                includeHtmlLinkExtraction,
                deps,
                meta
              })
            )
          )
        );

        const payload = listCourseMaterialsOutputSchema.parse({
          course_id: args.course_id,
          scanned_modules: collected.scannedModules,
          scanned_items: collected.scannedItems,
          materials,
          truncated
        });

        return {
          payload,
          meta: {
            status: meta.statuses.at(-1),
            requestId: meta.requestIds.at(-1),
            requestIds: meta.requestIds
          }
        };
      }
    )
  );
}

function clampInteger(value: number, min: number, max: number): number {
  const normalized = Number.isFinite(value) ? Math.floor(value) : min;
  return Math.min(max, Math.max(min, normalized));
}

function getMaterialSourceUrl(material: CourseMaterial): string | undefined {
  const preferredRef =
    material.item_refs.find((entry) => entry.external_url || entry.url || entry.html_url) ??
    material.item_refs[0];

  const rawSource =
    material.external?.url ??
    material.external?.html_url ??
    preferredRef?.external_url ??
    preferredRef?.url ??
    preferredRef?.html_url;

  if (!rawSource) {
    return undefined;
  }

  const baseCandidates = [
    preferredRef?.html_url,
    preferredRef?.url,
    preferredRef?.external_url,
    process.env.CANVAS_BASE_URL
  ];

  const direct = toAbsoluteHttpUrl(rawSource, rawSource);
  if (direct) {
    return direct;
  }

  for (const base of baseCandidates) {
    if (!base) {
      continue;
    }

    const normalized = toAbsoluteHttpUrl(rawSource, base);
    if (normalized) {
      return normalized;
    }
  }

  return rawSource;
}

function getSessionlessLaunchBaseUrls(): string[] {
  const candidates: string[] = [];

  const canvasBase = process.env.CANVAS_BASE_URL;
  if (canvasBase) {
    const normalizedCanvasBase = toAbsoluteHttpUrl(canvasBase, canvasBase);
    if (normalizedCanvasBase) {
      candidates.push(normalizedCanvasBase);

      try {
        candidates.push(new URL(normalizedCanvasBase).origin);
      } catch (error) {
        // Ignore malformed base URL fallback.
      }
    }
  }

  if (candidates.length === 0) {
    candidates.push('https://canvas.invalid/');
  }

  return Array.from(new Set(candidates));
}

function parseLaunchUrl(payload: unknown, baseUrls: string[]): string | undefined {
  const candidates: unknown[] = [];

  if (typeof payload === 'string') {
    candidates.push(payload);
  } else if (payload && typeof payload === 'object') {
    const value = payload as Record<string, unknown>;
    candidates.push(
      value.url,
      value.launch_url,
      value.sessionless_launch_url,
      value.html_url,
      value.target_link_uri
    );
  }

  for (const candidate of candidates) {
    if (typeof candidate !== 'string') {
      continue;
    }

    const direct = toAbsoluteHttpUrl(candidate, candidate);
    if (direct) {
      return direct;
    }

    for (const baseUrl of baseUrls) {
      const normalized = toAbsoluteHttpUrl(candidate, baseUrl);
      if (normalized) {
        return normalized;
      }
    }
  }

  return undefined;
}

async function resolveExternalToolLaunchUrl(args: {
  material: CourseMaterial;
  courseId: number;
  deps: ToolDependencies;
  meta: MetaAccumulator;
}): Promise<{ launchUrl?: string; reason?: string }> {
  const sourceUrl = getMaterialSourceUrl(args.material);

  const strategies: Array<{ params: Record<string, unknown>; label: string }> = [];
  for (const itemRef of args.material.item_refs) {
    if (typeof itemRef.content_id === 'number') {
      strategies.push({
        params: { id: itemRef.content_id },
        label: `id=${itemRef.content_id}`
      });
    }
  }

  if (sourceUrl) {
    strategies.push({
      params: { url: sourceUrl },
      label: 'url=<source>'
    });
  }

  if (strategies.length === 0) {
    return {
      reason: 'No launch identifier was available for this external tool item.'
    };
  }

  let lastReason: string | undefined;
  const launchBaseUrls = getSessionlessLaunchBaseUrls();

  for (const strategy of strategies) {
    try {
      const launchResult = await args.deps.canvas.get<Record<string, unknown>>(
        `/api/v1/courses/${args.courseId}/external_tools/sessionless_launch`,
        strategy.params
      );
      collectMeta(args.meta, launchResult);

      const launchUrl = parseLaunchUrl(launchResult.data, launchBaseUrls);
      if (launchUrl) {
        return { launchUrl };
      }

      lastReason =
        'Canvas sessionless launch endpoint responded without a usable launch URL.';
    } catch (error) {
      if (error instanceof AppError) {
        if (error.code === 'AUTHORIZATION_FAILED') {
          return {
            reason:
              'Canvas denied sessionless launch for this external tool. A browser-based launch is likely required.'
          };
        }

        if (error.code === 'NOT_FOUND' || error.code === 'BAD_REQUEST') {
          lastReason =
            'Canvas sessionless launch endpoint did not resolve this tool by id/url.';
          continue;
        }
      }

      lastReason =
        error instanceof Error
          ? `Failed to resolve external tool launch URL (${strategy.label}): ${error.message}`
          : `Failed to resolve external tool launch URL (${strategy.label}).`;
    }
  }

  return {
    reason:
      lastReason ??
      'Unable to resolve an API-based launch URL for this external tool; browser fallback is likely required.'
  };
}

function classifyHttpFailureStatus(
  status: number,
  type: 'ExternalUrl' | 'ExternalTool'
): ResolveExternalDownloadsMaterialResult['status'] {
  if (status === 401 || status === 403) {
    return type === 'ExternalTool' ? 'needs_browser_fallback' : 'blocked';
  }

  return status >= 500 ? 'partial' : 'error';
}

async function resolveExternalMaterialLinks(args: {
  material: CourseMaterial;
  courseId: number;
  timeoutMs: number;
  maxLinksPerPage: number;
  deps: ToolDependencies;
  meta: MetaAccumulator;
}): Promise<{ result: ResolveExternalDownloadsMaterialResult; linksTruncated: boolean }> {
  const sourceUrl = getMaterialSourceUrl(args.material);

  const baseResult: ResolveExternalDownloadsMaterialResult = {
    key: args.material.key,
    type: args.material.type === 'ExternalTool' ? 'ExternalTool' : 'ExternalUrl',
    title: args.material.title,
    source_url: sourceUrl ?? '',
    status: 'error',
    links: []
  };

  if (!sourceUrl) {
    return {
      result: {
        ...baseResult,
        reason: 'No source URL was available for this material.'
      },
      linksTruncated: false
    };
  }

  let targetUrl = sourceUrl;
  if (args.material.type === 'ExternalTool') {
    const launchResolution = await resolveExternalToolLaunchUrl({
      material: args.material,
      courseId: args.courseId,
      deps: args.deps,
      meta: args.meta
    });

    if (!launchResolution.launchUrl) {
      return {
        result: {
          ...baseResult,
          status: 'needs_browser_fallback',
          reason:
            launchResolution.reason ??
            'Unable to resolve a sessionless launch URL for this external tool.',
          source_url: sourceUrl
        },
        linksTruncated: false
      };
    }

    targetUrl = launchResolution.launchUrl;
    baseResult.resolved_url = targetUrl;
  }

  const outboundValidation = validateOutboundHttpUrl(targetUrl, targetUrl);
  if (!outboundValidation.allowed) {
    return {
      result: {
        ...baseResult,
        status: args.material.type === 'ExternalTool' ? 'needs_browser_fallback' : 'blocked',
        source_url: sourceUrl,
        resolved_url: outboundValidation.normalizedUrl ?? baseResult.resolved_url,
        reason: outboundValidation.reason ?? 'Blocked outbound URL target.'
      },
      linksTruncated: false
    };
  }

  const validatedTargetUrl = outboundValidation.normalizedUrl ?? targetUrl;
  if (args.material.type === 'ExternalTool') {
    baseResult.resolved_url = validatedTargetUrl;
  }

  const fetched = await fetchExternalResource(validatedTargetUrl, {
    timeoutMs: args.timeoutMs,
    maxRetries: 2
  }, args.deps.fetchImpl);

  if (fetched.blockedReason) {
    return {
      result: {
        ...baseResult,
        status: args.material.type === 'ExternalTool' ? 'needs_browser_fallback' : 'blocked',
        reason: fetched.blockedReason,
        source_url: sourceUrl,
        resolved_url: fetched.finalUrl ?? baseResult.resolved_url
      },
      linksTruncated: false
    };
  }

  if (fetched.error) {
    const status = args.material.type === 'ExternalTool' ? 'needs_browser_fallback' : 'error';
    return {
      result: {
        ...baseResult,
        status,
        reason: fetched.error,
        source_url: sourceUrl,
        resolved_url: fetched.finalUrl ?? baseResult.resolved_url
      },
      linksTruncated: false
    };
  }

  const responseStatus = fetched.status ?? 0;
  if (responseStatus >= 400) {
    const status = classifyHttpFailureStatus(responseStatus, baseResult.type);

    return {
      result: {
        ...baseResult,
        status,
        source_url: sourceUrl,
        resolved_url: fetched.finalUrl ?? baseResult.resolved_url,
        reason: `HTTP ${responseStatus} while fetching external content.`
      },
      linksTruncated: false
    };
  }

  if (fetched.directLink) {
    const deduped = dedupeResolvedLinks([fetched.directLink]);
    return {
      result: {
        ...baseResult,
        status: deduped.length > 0 ? 'ok' : 'partial',
        source_url: sourceUrl,
        resolved_url: fetched.finalUrl ?? baseResult.resolved_url,
        links: deduped,
        reason: deduped.length > 0 ? undefined : 'Direct download URL was already deduplicated.'
      },
      linksTruncated: false
    };
  }

  const extraction = extractExternalDownloadLinksFromHtml(fetched.html, {
    baseUrl: fetched.finalUrl ?? validatedTargetUrl,
    maxLinks: args.maxLinksPerPage
  });

  const links = dedupeResolvedLinks(extraction.links);

  if (links.length === 0) {
    const fallbackReason = classifyBrowserFallbackReason(fetched.html);

    if (args.material.type === 'ExternalTool' || fallbackReason) {
      return {
        result: {
          ...baseResult,
          status: 'needs_browser_fallback',
          source_url: sourceUrl,
          resolved_url: fetched.finalUrl ?? baseResult.resolved_url,
          reason:
            fallbackReason ??
            'No downloadable links were detected from the API-resolved external tool page.',
          links
        },
        linksTruncated: extraction.truncated
      };
    }

    return {
      result: {
        ...baseResult,
        status: 'partial',
        source_url: sourceUrl,
        resolved_url: fetched.finalUrl ?? baseResult.resolved_url,
        reason: 'No candidate download links were detected in the fetched HTML.',
        links
      },
      linksTruncated: extraction.truncated
    };
  }

  return {
    result: {
      ...baseResult,
      status: extraction.truncated ? 'partial' : 'ok',
      source_url: sourceUrl,
      resolved_url: fetched.finalUrl ?? baseResult.resolved_url,
      reason: extraction.truncated
        ? 'Link extraction was truncated by max_links_per_page.'
        : undefined,
      links
    },
    linksTruncated: extraction.truncated
  };
}

function registerResolveExternalDownloads(server: McpServer, deps: ToolDependencies): void {
  server.registerTool(
    'resolve_external_downloads',
    {
      title: 'Resolve External Downloads',
      description:
        'Resolve ExternalUrl/ExternalTool module items and extract candidate downloadable links using API-first HTTP fetching.',
      inputSchema: resolveExternalDownloadsInputSchema.shape,
      outputSchema: resolveExternalDownloadsOutputSchema.shape
    },
    wrapTool(
      'resolve_external_downloads',
      async (args: {
        course_id: number;
        material_keys?: string[];
        max_pages?: number;
        max_links_per_page?: number;
        timeout_ms?: number;
      }) => {
        const maxPages = clampInteger(
          args.max_pages ?? EXTERNAL_DOWNLOADS_DEFAULT_MAX_PAGES,
          1,
          EXTERNAL_DOWNLOADS_MAX_PAGES
        );
        const maxLinksPerPage = clampInteger(
          args.max_links_per_page ?? EXTERNAL_DOWNLOADS_DEFAULT_MAX_LINKS_PER_PAGE,
          1,
          EXTERNAL_DOWNLOADS_MAX_LINKS_PER_PAGE
        );
        const timeoutMs = clampInteger(
          args.timeout_ms ?? EXTERNAL_DOWNLOADS_DEFAULT_TIMEOUT_MS,
          EXTERNAL_DOWNLOADS_MIN_TIMEOUT_MS,
          EXTERNAL_DOWNLOADS_MAX_TIMEOUT_MS
        );

        const meta: MetaAccumulator = {
          statuses: [],
          requestIds: []
        };

        const collected = await collectCourseMaterialsFromModules({
          courseId: args.course_id,
          includeTypes: new Set<MaterialType>(['ExternalUrl', 'ExternalTool']),
          deps,
          meta
        });

        const materialsByKey = new Map(collected.materials.map((material) => [material.key, material]));

        let candidates: CourseMaterial[];
        if (args.material_keys && args.material_keys.length > 0) {
          const seen = new Set<string>();
          candidates = [];

          for (const key of args.material_keys) {
            if (!key || seen.has(key)) {
              continue;
            }
            seen.add(key);

            const material = materialsByKey.get(key);
            if (material) {
              candidates.push(material);
            }
          }
        } else {
          candidates = [...collected.materials].sort((a, b) => a.key.localeCompare(b.key));
        }

        const truncatedByPages = candidates.length > maxPages;
        const processQueue = candidates.slice(0, maxPages);
        const globalSeenLinks = new Set<string>();

        let truncated = truncatedByPages;
        const results: ResolveExternalDownloadsMaterialResult[] = [];

        for (const material of processQueue) {
          const { result, linksTruncated } = await resolveExternalMaterialLinks({
            material,
            courseId: args.course_id,
            timeoutMs,
            maxLinksPerPage,
            deps,
            meta
          });

          const globallyDedupedLinks = dedupeResolvedLinks(result.links, globalSeenLinks);
          let normalizedResult: ResolveExternalDownloadsMaterialResult = {
            ...result,
            links: globallyDedupedLinks
          };

          if (
            result.status === 'ok' &&
            result.links.length > 0 &&
            globallyDedupedLinks.length === 0
          ) {
            normalizedResult = {
              ...normalizedResult,
              status: 'partial',
              reason: 'All discovered links were duplicates of earlier materials.'
            };
          }

          normalizedResult = finalizeResultStatus(normalizedResult, {
            linksTruncated
          });

          if (linksTruncated) {
            truncated = true;
          }

          results.push(normalizedResult);
        }

        const totalLinks = results.reduce((sum, entry) => sum + entry.links.length, 0);

        const payload = resolveExternalDownloadsOutputSchema.parse({
          course_id: args.course_id,
          processed_materials: results.length,
          results,
          total_links: totalLinks,
          truncated
        });

        return {
          payload,
          meta: {
            status: meta.statuses.at(-1),
            requestId: meta.requestIds.at(-1),
            requestIds: meta.requestIds
          }
        };
      }
    )
  );
}

function registerListUserFiles(server: McpServer, deps: ToolDependencies): void {
  const inputSchema = {
    search_term: z.string().optional(),
    content_types: z
      .preprocess((value) => {
        if (Array.isArray(value)) {
          return value.join(',');
        }
        return value ?? undefined;
      }, z.string().optional()),
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
      async (args: FileToolCommonArgs) => {
        const params: Record<string, unknown> = {};

        if (args.search_term) {
          params.search_term = args.search_term;
        }
        const contentTypes = normalizeContentTypes(args.content_types);
        if (contentTypes && contentTypes.length > 0) {
          params['content_types[]'] = contentTypes;
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
    content_types: z
      .preprocess((value) => {
        if (Array.isArray(value)) {
          return value.join(',');
        }
        return value ?? undefined;
      }, z.string().optional()),
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
        content_types?: string;
        sort?: 'name' | 'size' | 'created_at' | 'updated_at' | 'content_type';
        order?: 'asc' | 'desc';
      }) => {
        const params: Record<string, unknown> = {};

        if (args.search_term) {
          params.search_term = args.search_term;
        }
        const contentTypes = normalizeContentTypes(args.content_types);
        if (contentTypes && contentTypes.length > 0) {
          params['content_types[]'] = contentTypes;
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
    content_types: z
      .preprocess((value) => {
        if (Array.isArray(value)) {
          return value.join(',');
        }
        return value ?? undefined;
      }, z.string().optional()),
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
        content_types?: string;
        sort?: 'name' | 'size' | 'created_at' | 'updated_at' | 'content_type';
        order?: 'asc' | 'desc';
      }) => {
        const params: Record<string, unknown> = {};

        if (args.search_term) {
          params.search_term = args.search_term;
        }
        const contentTypes = normalizeContentTypes(args.content_types);
        if (contentTypes && contentTypes.length > 0) {
          params['content_types[]'] = contentTypes;
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
