import { z } from 'zod';

export const submissionStateSchema = z.enum([
  'unsubmitted',
  'submitted',
  'graded',
  'pending_review',
  'late',
  'missing',
  'excused'
]);

export type SubmissionState = z.infer<typeof submissionStateSchema>;

export const courseSchema = z.object({
  id: z.number(),
  name: z.string(),
  term: z.string(),
  course_code: z.string()
});

export type Course = z.infer<typeof courseSchema>;

export const assignmentSchema = z.object({
  id: z.number(),
  course_id: z.number(),
  name: z.string(),
  due_at: z.string().nullable(),
  points: z.number().nullable(),
  html_url: z.string(),
  submission_state: submissionStateSchema.optional()
});

export type Assignment = z.infer<typeof assignmentSchema>;

export const announcementSchema = z.object({
  id: z.number(),
  course_id: z.number(),
  title: z.string(),
  posted_at: z.string(),
  html_url: z.string()
});

export type Announcement = z.infer<typeof announcementSchema>;

export const upcomingItemSchema = assignmentSchema.extend({
  source: z.enum(['todo', 'assignment'])
});

export type UpcomingItem = z.infer<typeof upcomingItemSchema>;

export const listCoursesOutputSchema = z.object({
  courses: z.array(courseSchema)
});

export const listAssignmentsOutputSchema = z.object({
  assignments: z.array(assignmentSchema)
});

export const getAssignmentOutputSchema = z.object({
  assignment: assignmentSchema
});

export const listAnnouncementsOutputSchema = z.object({
  announcements: z.array(announcementSchema)
});

export const listUpcomingOutputSchema = z.object({
  upcoming: z.array(upcomingItemSchema)
});

export const fileSchema = z.object({
  id: z.number(),
  uuid: z.string().optional(),
  folder_id: z.number().optional(),
  display_name: z.string(),
  filename: z.string(),
  content_type: z.string().optional(),
  url: z.string().optional(),
  size: z.number().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  locked: z.boolean().optional(),
  hidden: z.boolean().optional(),
  locked_for_user: z.boolean().optional(),
  thumbnail_url: z.string().nullable().optional(),
  mime_class: z.string().optional()
});

export type FileResource = z.infer<typeof fileSchema>;

/** @deprecated Use FileResource instead to avoid collision with built-in DOM File type */
export type File = FileResource;

export const folderSchema = z.object({
  id: z.number(),
  name: z.string(),
  full_name: z.string().optional(),
  context_id: z.number().optional(),
  context_type: z.string().optional(),
  parent_folder_id: z.number().nullable().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  locked: z.boolean().optional(),
  folders_count: z.number().optional(),
  files_count: z.number().optional(),
  hidden: z.boolean().optional(),
  locked_for_user: z.boolean().optional(),
  for_submissions: z.boolean().optional()
});

export type Folder = z.infer<typeof folderSchema>;

export const listFilesOutputSchema = z.object({
  files: z.array(fileSchema)
});

export const getFileOutputSchema = z.object({
  file: fileSchema
});

export const getFileDownloadUrlOutputSchema = z.object({
  file_id: z.number(),
  download_url: z.string()
});

export const listFoldersOutputSchema = z.object({
  folders: z.array(folderSchema)
});

export const getFolderOutputSchema = z.object({
  folder: folderSchema
});
