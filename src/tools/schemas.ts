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
