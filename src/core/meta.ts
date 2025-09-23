import pkg from '../../package.json' with { type: 'json' };

export const APP_NAME = typeof pkg.name === 'string' ? pkg.name : 'canvas-mcp';
export const APP_VERSION = typeof pkg.version === 'string' ? pkg.version : '0.0.0';
export const USER_AGENT = `${APP_NAME}/${APP_VERSION}`;
