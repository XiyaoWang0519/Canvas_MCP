import { loadEnv } from './env.js';

const { canvasTimezone } = loadEnv();

const dateTimeFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: canvasTimezone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23'
});

function pad(value: number): string {
  return value.toString().padStart(2, '0');
}

function formatOffset(offsetMinutes: number): string {
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absolute = Math.abs(offsetMinutes);
  const hours = pad(Math.floor(absolute / 60));
  const minutes = pad(absolute % 60);
  return `${sign}${hours}:${minutes}`;
}

function partsToNumbers(parts: Intl.DateTimeFormatPart[]): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const getPart = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find((part) => part.type === type)?.value;
    return value ? Number.parseInt(value, 10) : 0;
  };

  return {
    year: getPart('year'),
    month: getPart('month'),
    day: getPart('day'),
    hour: getPart('hour'),
    minute: getPart('minute'),
    second: getPart('second')
  };
}

export function toCanvasTimezone(value: string | null | undefined): string | null | undefined {
  if (value == null) {
    return value;
  }

  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) {
    return value;
  }

  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const parts = dateTimeFormatter.formatToParts(date);
  const { year, month, day, hour, minute, second } = partsToNumbers(parts);

  const targetTimestamp = Date.UTC(year, month - 1, day, hour, minute, second);
  const offsetMinutes = Math.round((targetTimestamp - date.getTime()) / 60000);
  const offset = formatOffset(offsetMinutes);

  const formatted = `${year.toString().padStart(4, '0')}-${pad(month)}-${pad(day)}T${pad(
    hour
  )}:${pad(minute)}:${pad(second)}${offset}`;

  return formatted;
}
