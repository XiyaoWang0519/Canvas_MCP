import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { CanvasCourse } from '../canvas/types.js';
import { listCoursesOutputSchema, type Course } from './schemas.js';
import { mapCourse } from './mappers.js';
import { wrapTool, type ToolDependencies } from './shared.js';

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

export function sortCoursesByRecency(courses: Course[]): Course[] {
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

export function filterRecentCourses(courses: Course[]): Course[] {
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

export function isPlaceholderCourse(course: Course): boolean {
  const fallback = `COURSE-${course.id}`;
  return course.name === fallback && course.course_code === fallback && !course.term;
}

export function filterPlaceholderCourses(courses: Course[]): Course[] {
  return courses.filter((course) => !isPlaceholderCourse(course));
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

export function registerListCourses(server: McpServer, deps: ToolDependencies): void {
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
        courses = filterPlaceholderCourses(courses);

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
