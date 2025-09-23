export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogPayload {
  level: LogLevel;
  msg: string;
  ts: string;
  [key: string]: unknown;
}

function emit(payload: LogPayload): void {
  const serialized = JSON.stringify(payload);
  if (payload.level === 'error') {
    console.error(serialized);
    return;
  }
  console.log(serialized);
}

export function log(level: LogLevel, msg: string, context?: Record<string, unknown>): void {
  emit({
    level,
    msg,
    ts: new Date().toISOString(),
    ...context
  });
}

export interface ToolLogContext {
  tool: string;
  status: 'success' | 'error';
  durationMs: number;
  canvasStatus?: number;
  requestId?: string;
  extraRequestIds?: string[];
  error?: unknown;
}

export function logToolEvent(msg: string, context: ToolLogContext): void {
  const serializedError = context.error instanceof Error
    ? { name: context.error.name, message: context.error.message }
    : context.error;

  log(context.status === 'error' ? 'error' : 'info', msg, {
    tool: context.tool,
    status: context.status,
    duration_ms: context.durationMs,
    canvas_status: context.canvasStatus,
    req_id: context.requestId,
    extra_req_ids: context.extraRequestIds,
    error: serializedError
  });
}
