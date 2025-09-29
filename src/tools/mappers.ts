import {
  CanvasAnnouncement,
  CanvasAssignment,
  CanvasCourse,
  CanvasFile,
  CanvasFolder,
  CanvasSubmission
} from '../canvas/types.js';
import {
  Announcement,
  Assignment,
  Course,
  File,
  Folder,
  SubmissionState,
  UpcomingItem
} from './schemas.js';

function normalizeTerm(term?: string | null): string {
  return term?.trim() ?? '';
}

function computeSubmissionState(submission?: CanvasSubmission): SubmissionState {
  if (!submission) {
    return 'unsubmitted';
  }

  if (submission.excused) {
    return 'excused';
  }

  const state = submission.workflow_state;
  switch (state) {
    case 'graded':
      return 'graded';
    case 'pending_review':
      return 'pending_review';
    case 'submitted':
      return submission.late ? 'late' : 'submitted';
    case 'unsubmitted':
      return submission.missing ? 'missing' : 'unsubmitted';
    default:
      if (submission.missing) {
        return 'missing';
      }
      return 'unsubmitted';
  }
}

function ensureCourseId(id: number | undefined, fallback?: string): number {
  if (typeof id === 'number' && Number.isFinite(id)) {
    return id;
  }

  if (!fallback) {
    return 0;
  }

  const [, courseId] = fallback.split('_');
  const parsed = Number(courseId);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function mapCourse(raw: CanvasCourse): Course {
  const trimmedName = typeof raw.name === 'string' ? raw.name.trim() : '';
  const trimmedCourseCode =
    typeof raw.course_code === 'string' ? raw.course_code.trim() : '';
  const safeCourseCode = trimmedCourseCode || `COURSE-${raw.id}`;
  const safeName = trimmedName || safeCourseCode || `Course ${raw.id}`;

  return {
    id: raw.id,
    name: safeName,
    term: normalizeTerm(raw.term?.name ?? null),
    course_code: safeCourseCode
  };
}

export function mapAssignment(raw: CanvasAssignment, source?: 'todo' | 'assignment'): Assignment | UpcomingItem {
  const base: Assignment = {
    id: raw.id,
    course_id: raw.course_id,
    name: raw.name,
    due_at: raw.due_at ?? null,
    points: typeof raw.points_possible === 'number' ? raw.points_possible : null,
    html_url: raw.html_url,
    submission_state: computeSubmissionState(raw.submission)
  };

  if (!source) {
    return base;
  }

  return {
    ...base,
    source
  } satisfies UpcomingItem;
}

export function mapAnnouncement(raw: CanvasAnnouncement): Announcement {
  return {
    id: raw.id,
    course_id: ensureCourseId(raw.course_id, raw.context_code),
    title: raw.title,
    posted_at: raw.posted_at,
    html_url: raw.html_url
  };
}

export function mapUpcomingFromAssignment(
  assignment: CanvasAssignment,
  source: 'todo' | 'assignment'
): UpcomingItem {
  return mapAssignment(assignment, source) as UpcomingItem;
}

export function normalizePlannerItem(
  assignment: CanvasAssignment | undefined,
  planner: {
    course_id?: number;
    plannable_id: number;
    plannable?: {
      id: number;
      title?: string;
      due_at?: string | null;
      html_url?: string;
    };
    html_url?: string;
  }
): CanvasAssignment | undefined {
  if (!assignment && planner.plannable) {
    const plannable = planner.plannable;
    return {
      id: planner.plannable_id,
      course_id: planner.course_id ?? 0,
      name: plannable.title ?? 'Untitled',
      due_at: plannable.due_at ?? null,
      points_possible: null,
      html_url: plannable.html_url ?? planner.html_url ?? ''
    };
  }

  if (assignment) {
    return {
      ...assignment,
      course_id: assignment.course_id || planner.course_id || 0,
      html_url: assignment.html_url || planner.html_url || '',
      due_at: assignment.due_at ?? planner.plannable?.due_at ?? null
    };
  }

  return undefined;
}

export function mapFile(raw: CanvasFile): File {
  return {
    id: raw.id,
    uuid: raw.uuid,
    folder_id: raw.folder_id,
    display_name: raw.display_name,
    filename: raw.filename,
    content_type: raw['content-type'],
    url: raw.url,
    size: raw.size,
    created_at: raw.created_at,
    updated_at: raw.updated_at,
    locked: raw.locked,
    hidden: raw.hidden,
    locked_for_user: raw.locked_for_user,
    thumbnail_url: raw.thumbnail_url,
    mime_class: raw.mime_class
  };
}

export function mapFolder(raw: CanvasFolder): Folder {
  return {
    id: raw.id,
    name: raw.name,
    full_name: raw.full_name,
    context_id: raw.context_id,
    context_type: raw.context_type,
    parent_folder_id: raw.parent_folder_id,
    created_at: raw.created_at,
    updated_at: raw.updated_at,
    locked: raw.locked,
    folders_count: raw.folders_count,
    files_count: raw.files_count,
    hidden: raw.hidden,
    locked_for_user: raw.locked_for_user,
    for_submissions: raw.for_submissions
  };
}
