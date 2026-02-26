import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { type ToolDependencies } from './shared.js';
import { registerListCourses } from './courses.js';
import {
  registerListAssignments,
  registerGetAssignment,
  registerListUpcoming
} from './assignments.js';
import { registerListAnnouncements } from './announcements.js';
import {
  registerListUserFiles,
  registerListCourseFiles,
  registerListFolderFiles,
  registerGetFile,
  registerGetFileDownloadUrl,
  registerListUserFolders,
  registerListCourseFolders,
  registerGetFolder
} from './files.js';

export type { ToolDependencies } from './shared.js';

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
