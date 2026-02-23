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

export const materialTypeValues = [
  'File',
  'Page',
  'Assignment',
  'Discussion',
  'Quiz',
  'ExternalUrl',
  'ExternalTool'
] as const;

export const materialTypeSchema = z.enum(materialTypeValues);

export type MaterialType = z.infer<typeof materialTypeSchema>;

export const courseMaterialItemRefSchema = z.object({
  module_id: z.number(),
  module_name: z.string(),
  item_id: z.number(),
  title: z.string(),
  type: materialTypeSchema,
  content_id: z.number().optional(),
  html_url: z.string().optional(),
  url: z.string().optional(),
  page_url: z.string().optional(),
  external_url: z.string().optional(),
  published: z.boolean().optional(),
  locked: z.boolean().optional()
});

export type CourseMaterialItemRef = z.infer<typeof courseMaterialItemRefSchema>;

export const discoveredLinkSchema = z.object({
  api_endpoint: z.string(),
  api_returntype: z.string().optional(),
  href: z.string().optional(),
  text: z.string().optional()
});

export type DiscoveredLink = z.infer<typeof discoveredLinkSchema>;

export const pageMaterialSchema = z.object({
  page_id: z.number().optional(),
  url: z.string().optional(),
  title: z.string(),
  html_url: z.string().optional(),
  body_snippet: z.string().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  published: z.boolean().optional(),
  locked_for_user: z.boolean().optional()
});

export type PageMaterial = z.infer<typeof pageMaterialSchema>;

export const assignmentMaterialSchema = z.object({
  id: z.number(),
  name: z.string(),
  html_url: z.string().optional(),
  due_at: z.string().nullable().optional(),
  unlock_at: z.string().nullable().optional(),
  lock_at: z.string().nullable().optional(),
  created_at: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
  points_possible: z.number().nullable().optional()
});

export type AssignmentMaterial = z.infer<typeof assignmentMaterialSchema>;

export const externalMaterialSchema = z.object({
  url: z.string().optional(),
  html_url: z.string().optional()
});

export type ExternalMaterial = z.infer<typeof externalMaterialSchema>;

export const courseMaterialSchema = z.object({
  key: z.string(),
  type: materialTypeSchema,
  title: z.string(),
  source: z.object({
    module_ids: z.array(z.number()),
    module_item_ids: z.array(z.number())
  }),
  item_refs: z.array(courseMaterialItemRefSchema),
  file: fileSchema
    .extend({
      download_url: z.string().optional()
    })
    .optional(),
  page: pageMaterialSchema.optional(),
  assignment: assignmentMaterialSchema.optional(),
  external: externalMaterialSchema.optional(),
  discovered_links: z.array(discoveredLinkSchema).optional()
});

export type CourseMaterial = z.infer<typeof courseMaterialSchema>;

export const listCourseMaterialsOutputSchema = z.object({
  course_id: z.number(),
  scanned_modules: z.number(),
  scanned_items: z.number(),
  materials: z.array(courseMaterialSchema),
  truncated: z.boolean()
});

export const resolveExternalDownloadsInputSchema = z.object({
  course_id: z.number().int().nonnegative(),
  material_keys: z.array(z.string().trim().min(1)).optional(),
  max_pages: z.number().int().optional(),
  max_links_per_page: z.number().int().optional(),
  timeout_ms: z.number().int().optional()
});

export type ResolveExternalDownloadsInput = z.infer<typeof resolveExternalDownloadsInputSchema>;

export const externalDownloadResolutionConfidenceSchema = z.enum(['high', 'medium', 'low']);

export type ExternalDownloadResolutionConfidence = z.infer<
  typeof externalDownloadResolutionConfidenceSchema
>;

export const externalDownloadResolutionLinkSchema = z.object({
  url: z.string(),
  text: z.string().optional(),
  ext: z.string().optional(),
  api_endpoint: z.string().optional(),
  api_returntype: z.string().optional(),
  confidence: externalDownloadResolutionConfidenceSchema
});

export type ExternalDownloadResolutionLink = z.infer<typeof externalDownloadResolutionLinkSchema>;

export const externalDownloadResolutionStatusSchema = z.enum([
  'ok',
  'partial',
  'blocked',
  'needs_browser_fallback',
  'error'
]);

export type ExternalDownloadResolutionStatus = z.infer<typeof externalDownloadResolutionStatusSchema>;

export const resolveExternalDownloadsMaterialResultSchema = z.object({
  key: z.string(),
  type: z.enum(['ExternalUrl', 'ExternalTool']),
  title: z.string(),
  source_url: z.string(),
  resolved_url: z.string().optional(),
  status: externalDownloadResolutionStatusSchema,
  reason: z.string().optional(),
  links: z.array(externalDownloadResolutionLinkSchema)
});

export type ResolveExternalDownloadsMaterialResult = z.infer<
  typeof resolveExternalDownloadsMaterialResultSchema
>;

export const resolveExternalDownloadsOutputSchema = z.object({
  course_id: z.number(),
  processed_materials: z.number(),
  results: z.array(resolveExternalDownloadsMaterialResultSchema),
  total_links: z.number(),
  truncated: z.boolean()
});

export type ResolveExternalDownloadsOutput = z.infer<typeof resolveExternalDownloadsOutputSchema>;
