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

export interface CanvasFile {
  id: number;
  uuid?: string;
  folder_id?: number;
  display_name: string;
  filename: string;
  'content-type'?: string;
  url?: string;
  size?: number;
  created_at?: string;
  updated_at?: string;
  unlock_at?: string | null;
  locked?: boolean;
  hidden?: boolean;
  lock_at?: string | null;
  hidden_for_user?: boolean;
  thumbnail_url?: string | null;
  modified_at?: string;
  mime_class?: string;
  media_entry_id?: string | null;
  locked_for_user?: boolean;
  lock_explanation?: string;
}

export interface CanvasFolder {
  id: number;
  name: string;
  full_name?: string;
  context_id?: number;
  context_type?: string;
  parent_folder_id?: number | null;
  created_at?: string;
  updated_at?: string;
  locked?: boolean;
  folders_url?: string;
  files_url?: string;
  files_count?: number;
  folders_count?: number;
  hidden?: boolean;
  locked_for_user?: boolean;
  for_submissions?: boolean;
}

export interface CanvasFilePublicUrl {
  public_url: string;
}
