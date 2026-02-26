import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { CanvasFile, CanvasFilePublicUrl, CanvasFolder } from '../canvas/types.js';
import {
  getFileDownloadUrlOutputSchema,
  getFileOutputSchema,
  getFolderOutputSchema,
  listFilesOutputSchema,
  listFoldersOutputSchema
} from './schemas.js';
import { mapFile, mapFolder } from './mappers.js';
import {
  buildFileParams,
  fileToolInputSchema,
  wrapTool,
  type FileToolCommonArgs,
  type ToolDependencies
} from './shared.js';

function registerListFiles(
  server: McpServer,
  deps: ToolDependencies,
  options: {
    name: string;
    title: string;
    description: string;
    inputSchema: Record<string, z.ZodTypeAny>;
    buildPath: (args: Record<string, unknown>) => string;
  }
): void {
  server.registerTool(
    options.name,
    {
      title: options.title,
      description: options.description,
      inputSchema: options.inputSchema,
      outputSchema: listFilesOutputSchema.shape
    },
    wrapTool(
      options.name,
      async (args: FileToolCommonArgs & Record<string, unknown>) => {
        const params = buildFileParams(args);
        const path = options.buildPath(args);

        const { data, status, requestId, requestIds } = await deps.canvas.getAll<CanvasFile>(
          path,
          params
        );

        const files = data.map(mapFile);
        const payload = listFilesOutputSchema.parse({ files });

        return {
          payload,
          meta: { status, requestId, requestIds }
        };
      }
    )
  );
}

export function registerListUserFiles(server: McpServer, deps: ToolDependencies): void {
  registerListFiles(server, deps, {
    name: 'list_user_files',
    title: 'List User Files',
    description: 'List files in the authenticated user\'s personal files',
    inputSchema: { ...fileToolInputSchema },
    buildPath: () => '/api/v1/users/self/files'
  });
}

export function registerListCourseFiles(server: McpServer, deps: ToolDependencies): void {
  registerListFiles(server, deps, {
    name: 'list_course_files',
    title: 'List Course Files',
    description: 'List files within a Canvas course',
    inputSchema: {
      course_id: z.number().int().nonnegative(),
      ...fileToolInputSchema
    },
    buildPath: (args) => `/api/v1/courses/${args.course_id}/files`
  });
}

export function registerListFolderFiles(server: McpServer, deps: ToolDependencies): void {
  registerListFiles(server, deps, {
    name: 'list_folder_files',
    title: 'List Folder Files',
    description: 'List files within a specific folder',
    inputSchema: {
      folder_id: z.number().int().nonnegative(),
      ...fileToolInputSchema
    },
    buildPath: (args) => `/api/v1/folders/${args.folder_id}/files`
  });
}

export function registerGetFile(server: McpServer, deps: ToolDependencies): void {
  const inputSchema = {
    file_id: z.number().int().nonnegative()
  } satisfies Record<string, z.ZodTypeAny>;

  server.registerTool(
    'get_file',
    {
      title: 'Get File',
      description: 'Get detailed information about a specific file',
      inputSchema,
      outputSchema: getFileOutputSchema.shape
    },
    wrapTool('get_file', async (args: { file_id: number }) => {
      const { data, status, requestId } = await deps.canvas.get<CanvasFile>(
        `/api/v1/files/${args.file_id}`
      );

      const payload = getFileOutputSchema.parse({
        file: mapFile(data)
      });

      return {
        payload,
        meta: { status, requestId }
      };
    })
  );
}

export function registerGetFileDownloadUrl(server: McpServer, deps: ToolDependencies): void {
  const inputSchema = {
    file_id: z.number().int().nonnegative(),
    submission_id: z.number().int().nonnegative().optional()
  } satisfies Record<string, z.ZodTypeAny>;

  server.registerTool(
    'get_file_download_url',
    {
      title: 'Get File Download URL',
      description:
        'Get a temporary download URL for a file. The URL is signed and expires after a short time.',
      inputSchema,
      outputSchema: getFileDownloadUrlOutputSchema.shape
    },
    wrapTool(
      'get_file_download_url',
      async (args: { file_id: number; submission_id?: number }) => {
        const params: Record<string, unknown> = {};

        if (args.submission_id) {
          params.submission_id = args.submission_id;
        }

        const { data, status, requestId } = await deps.canvas.get<CanvasFilePublicUrl>(
          `/api/v1/files/${args.file_id}/public_url`,
          params
        );

        const payload = getFileDownloadUrlOutputSchema.parse({
          file_id: args.file_id,
          download_url: data.public_url
        });

        return {
          payload,
          meta: { status, requestId }
        };
      }
    )
  );
}

export function registerListUserFolders(server: McpServer, deps: ToolDependencies): void {
  const inputSchema = {} satisfies Record<string, z.ZodTypeAny>;

  server.registerTool(
    'list_user_folders',
    {
      title: 'List User Folders',
      description: 'List all folders in the authenticated user\'s personal files',
      inputSchema,
      outputSchema: listFoldersOutputSchema.shape
    },
    wrapTool('list_user_folders', async () => {
      const { data, status, requestId, requestIds } = await deps.canvas.getAll<CanvasFolder>(
        '/api/v1/users/self/folders'
      );

      const folders = data.map(mapFolder);
      const payload = listFoldersOutputSchema.parse({ folders });

      return {
        payload,
        meta: { status, requestId, requestIds }
      };
    })
  );
}

export function registerListCourseFolders(server: McpServer, deps: ToolDependencies): void {
  const inputSchema = {
    course_id: z.number().int().nonnegative()
  } satisfies Record<string, z.ZodTypeAny>;

  server.registerTool(
    'list_course_folders',
    {
      title: 'List Course Folders',
      description: 'List all folders within a Canvas course',
      inputSchema,
      outputSchema: listFoldersOutputSchema.shape
    },
    wrapTool('list_course_folders', async (args: { course_id: number }) => {
      const { data, status, requestId, requestIds } = await deps.canvas.getAll<CanvasFolder>(
        `/api/v1/courses/${args.course_id}/folders`
      );

      const folders = data.map(mapFolder);
      const payload = listFoldersOutputSchema.parse({ folders });

      return {
        payload,
        meta: { status, requestId, requestIds }
      };
    })
  );
}

export function registerGetFolder(server: McpServer, deps: ToolDependencies): void {
  const inputSchema = {
    folder_id: z.number().int().nonnegative()
  } satisfies Record<string, z.ZodTypeAny>;

  server.registerTool(
    'get_folder',
    {
      title: 'Get Folder',
      description: 'Get detailed information about a specific folder',
      inputSchema,
      outputSchema: getFolderOutputSchema.shape
    },
    wrapTool('get_folder', async (args: { folder_id: number }) => {
      const { data, status, requestId } = await deps.canvas.get<CanvasFolder>(
        `/api/v1/folders/${args.folder_id}`
      );

      const payload = getFolderOutputSchema.parse({
        folder: mapFolder(data)
      });

      return {
        payload,
        meta: { status, requestId }
      };
    })
  );
}
