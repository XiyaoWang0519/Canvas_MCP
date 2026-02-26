import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import {
  CanvasAnnouncement,
  CanvasCourse
} from '../canvas/types.js';
import { unknownError } from '../core/errors.js';
import { listAnnouncementsOutputSchema } from './schemas.js';
import { mapAnnouncement } from './mappers.js';
import { wrapTool, type ToolDependencies } from './shared.js';

export function registerListAnnouncements(server: McpServer, deps: ToolDependencies): void {
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
