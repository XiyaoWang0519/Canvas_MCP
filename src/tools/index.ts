import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { registerListAnnouncements } from './announcements.js';
import {
  registerGetAssignment,
  registerListAssignments,
  registerListUpcoming
} from './assignments.js';
import { registerListCourseMaterials } from './course-materials.js';
import { registerListCourses } from './courses.js';
import {
  type ExternalFetchLike,
  registerResolveExternalDownloads
} from './external-downloads.js';
import {
  registerGetFile,
  registerGetFileDownloadUrl,
  registerGetFolder,
  registerListCourseFiles,
  registerListCourseFolders,
  registerListFolderFiles,
  registerListUserFiles,
  registerListUserFolders
} from './files.js';
import { type ToolDependencies } from './shared.js';

export type CanvasToolDependencies = ToolDependencies & {
  fetchImpl?: ExternalFetchLike;
};

export function registerCanvasTools(
  server: McpServer,
  deps: CanvasToolDependencies
): void {
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
