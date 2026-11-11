/**
 * Door station drivers, by the value of a doorbell's `type` option.
 *
 * To add a brand: create drivers/<brand>/index.ts exporting a `Driver` (see intercom.ts and
 * CONTRIBUTING.md), add it here, and add its id to `type` in config.yaml.
 */
import type { Driver } from '../intercom.ts';
import { hikvision } from './hikvision/index.ts';

export const DRIVERS: Record<string, Driver<any>> = {
  [hikvision.id]: hikvision,
};

/** Doorbells without a `type` (every configuration before 0.7) are Hikvision. */
export const DEFAULT_DRIVER = hikvision.id;
