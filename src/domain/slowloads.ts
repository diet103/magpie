// Page loads that took long on a phone, as the phone itself timed them. Neither person can open developer tools
// on a phone, so the app keeps the last few and Settings says where the time went. Nothing here identifies an
// entry: only the kind of page is stored.
import { all, run, type DB } from '../db/sqlite.ts';
import { nowIso } from './time.ts';

const KEEP = 100;
const PHASES = ['startup', 'connect', 'wait', 'download', 'render'] as const;
export type Phase = (typeof PHASES)[number];

export interface SlowLoad {
  id: number;
  at: string;
  user_name: string;
  page: string;
  total_ms: number;
  startup_ms: number;
  connect_ms: number;
  wait_ms: number;
  download_ms: number;
  render_ms: number;
  kind: string;
  network: string | null;
}

const ms = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(Math.round(v), 0), 600_000) : 0);

/** "/e/42" and "/c/7-restaurants?sort=title" become "/e/N" and "/c/N": the kind of page, not which one. */
export function pageShape(path: unknown): string {
  const p = typeof path === 'string' ? path.split(/[?#]/)[0] : '';
  const shape = p.replace(/\d+(-[a-z0-9-]*)?/g, 'N').replace(/[^a-zA-Z/_-]/g, '').slice(0, 60);
  return shape.startsWith('/') ? shape : '/';
}

/** Stores what a phone reported. Whatever it sent is reduced to a page kind and a handful of bounded numbers. */
export function recordSlowLoad(db: DB, userId: number, report: Record<string, unknown>): { page: string; total: number; phase: Phase } | null {
  const total = ms(report.total);
  if (total < 1000) return null;
  const page = pageShape(report.path);
  const kind = ['navigate', 'reload', 'back_forward'].includes(String(report.kind)) ? String(report.kind) : 'navigate';
  const network = typeof report.network === 'string' && /^[a-z0-9-]{1,12}$/.test(report.network) ? report.network : null;
  const parts = PHASES.map((p) => ms(report[p]));
  run(
    db,
    `INSERT INTO slow_loads (at, user_id, page, total_ms, startup_ms, connect_ms, wait_ms, download_ms, render_ms, kind, network)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    nowIso(),
    userId,
    page,
    total,
    ...parts,
    kind,
    network,
  );
  run(db, 'DELETE FROM slow_loads WHERE id <= (SELECT id FROM slow_loads ORDER BY id DESC LIMIT 1 OFFSET ?)', KEEP);
  return { page, total, phase: PHASES[parts.indexOf(Math.max(...parts))] };
}

export function recentSlowLoads(db: DB, limit = 10): SlowLoad[] {
  return all<SlowLoad>(
    db,
    `SELECT s.*, u.display_name AS user_name FROM slow_loads s JOIN users u ON u.id = s.user_id ORDER BY s.id DESC LIMIT ?`,
    limit,
  );
}

/** Which part of a load took longest. */
export function slowestPhase(s: SlowLoad): Phase {
  const parts = [s.startup_ms, s.connect_ms, s.wait_ms, s.download_ms, s.render_ms];
  return PHASES[parts.indexOf(Math.max(...parts))];
}
