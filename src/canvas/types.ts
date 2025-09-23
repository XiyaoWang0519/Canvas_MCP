export interface CanvasTerm {
  id: number;
  name?: string | null;
}

export interface CanvasEnrollment {
  type?: string;
  role?: string;
  enrollment_state?: string;
}

export interface CanvasCourse {
  id: number;
  name?: string | null;
  course_code?: string | null;
  term?: CanvasTerm | null;
  enrollments?: CanvasEnrollment[];
}

export interface CanvasAssignment {
  id: number;
  course_id: number;
  name: string;
  due_at?: string | null;
  points_possible?: number | null;
  html_url: string;
  submission?: CanvasSubmission;
}

export interface CanvasSubmission {
  workflow_state?: string;
  late?: boolean;
  missing?: boolean;
  graded?: boolean;
  excused?: boolean;
}

export interface CanvasAnnouncement {
  id: number;
  title: string;
  message: string;
  posted_at: string;
  html_url: string;
  context_code?: string;
  course_id?: number;
}

export interface CanvasTodoItem {
  type: string;
  assignment?: CanvasAssignment;
  html_url?: string;
  course_id?: number;
}

export interface CanvasPlannerItem {
  context_type?: string;
  course_id?: number;
  plannable_id: number;
  plannable_type: string;
  plannable?: {
    id: number;
    title?: string;
    due_at?: string | null;
    html_url?: string;
  };
  html_url?: string;
}
