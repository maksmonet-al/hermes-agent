import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Mondwest font only — use on layout shells; do not force normal-case here or `text-display` chrome (Segmented, badges) stops uppercasing. */
export const themedFont = "font-mondwest";

/** Mondwest body copy — sentence-case themed text (not uppercase chrome). */
export const themedBody = "font-mondwest normal-case";

/** Mondwest brand chrome — uppercase section headers and nav labels. */
export const themedChrome = "font-mondwest text-display";

/** Relative time from a Unix epoch timestamp (seconds). */
export function timeAgo(ts: number): string {
  const delta = Date.now() / 1000 - ts;
  if (delta < 60) return "только что";
  if (delta < 3600) return `${Math.floor(delta / 60)} мин назад`;
  if (delta < 86400) return `${Math.floor(delta / 3600)} ч назад`;
  if (delta < 172800) return "вчера";
  return `${Math.floor(delta / 86400)} дн. назад`;
}

/** Relative time from an ISO-8601 timestamp string. */
export function isoTimeAgo(iso: string): string {
  const delta = (Date.now() - new Date(iso).getTime()) / 1000;
  if (delta < 0 || Number.isNaN(delta)) return "неизвестно";
  if (delta < 60) return "только что";
  if (delta < 3600) return `${Math.floor(delta / 60)} мин назад`;
  if (delta < 86400) return `${Math.floor(delta / 3600)} ч назад`;
  return `${Math.floor(delta / 86400)} дн. назад`;
}
