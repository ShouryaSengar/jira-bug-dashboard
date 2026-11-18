// JARVIS event classification, shared by both editions. Pure functions: the caller fetches Jira data
// (so it can manage its own request budget) and passes it in; these functions only decide which events
// the changelog and comments represent.
//
// Every changelog item and comment has a stable id. Ids are recorded in `seen`, so the same change can
// never produce two events, even across restarts or overlapping sync windows.

import type { JarvisEvent, JarvisEventType } from '../shared/types.js';
import { adfToText, iso, severityRank, type Json } from './jira.js';

export type Draft = Omit<JarvisEvent, 'id' | 'at' | 'read'>;

export const IMPORTANCE: Record<JarvisEventType, 'high' | 'normal' | 'low'> = {
  assigned: 'high', reopened: 'high', priority: 'normal', severity: 'normal', status: 'normal', comment: 'normal',
  resolved: 'normal', closed: 'normal', reassigned_away: 'normal', unassigned: 'normal', updated: 'low',
};
export const NOISY_FIELDS = new Set(['rank', 'lastviewed', 'remoteissuelink', 'worklogid', 'timespent']);

export interface DetectCtx {
  siteUrl: string;
  meId: string;
  severityIds: Set<string>;
  /** Lower-cased display names of the severity fields, for changelog items that carry no field id. */
  severityNames: Set<string>;
  seen: Set<string>;
  /** Status id -> status category key ('new' | 'indeterminate' | 'done'), when known. */
  statusCat: (id: string) => string | undefined;
  priorityRank: (name: string | null) => number;
}

/** Short text for the "latest activity" column. */
export function eventLabel(e: Pick<JarvisEvent, 'type' | 'actor' | 'from' | 'to' | 'escalated' | 'detail'>): string {
  const who = e.actor ? ` by ${e.actor}` : '';
  switch (e.type) {
    case 'assigned': return `Assigned to you${who}`;
    case 'reassigned_away': return `Reassigned to ${e.to ?? 'someone else'}`;
    case 'unassigned': return 'Unassigned';
    case 'status': return `Status: ${e.from ?? '?'} → ${e.to ?? '?'}`;
    case 'reopened': return `Reopened${who}`;
    case 'resolved': return `Resolved${who}`;
    case 'closed': return `Closed${who}`;
    case 'comment': return `Comment${who}`;
    case 'priority': return `Priority ${e.escalated ? 'raised' : 'lowered'} to ${e.to ?? '?'}`;
    case 'severity': return `Severity ${e.escalated ? 'raised' : 'changed'} to ${e.to ?? '?'}`;
    default: return `Updated: ${e.detail ?? 'details'}`;
  }
}

export function draft(siteUrl: string, i: Json, type: JarvisEventType, o: Partial<Draft> & { occurredAt: string }): Draft {
  const f = i.fields;
  return {
    type, key: i.key, summary: String(f.summary ?? ''), project: String(f.project?.key ?? ''),
    url: `${siteUrl}/browse/${i.key}`, actor: null, from: null, to: null, detail: null, escalated: false,
    importance: IMPORTANCE[type], own: false, ...o,
  };
}

const seenId = (key: string, h: Json, it: Json): string => `${key}:h${h.id}:${String(it.fieldId ?? it.field)}`;

/** Marks every item of a changelog as already known (history before an assignment is not news). */
export function markHistorySeen(c: DetectCtx, key: string, hist: Json[]): void {
  for (const h of hist) for (const it of h.items || []) c.seen.add(seenId(key, h, it));
}

/** Status ids that appear in a changelog, so a caller can look up unknown categories before classifying. */
export function statusIdsIn(hist: Json[]): string[] {
  const ids = new Set<string>();
  for (const h of hist) for (const it of h.items || []) if (String(it.fieldId ?? it.field) === 'status') {
    if (it.from) ids.add(String(it.from));
    if (it.to) ids.add(String(it.to));
  }
  return [...ids];
}

/**
 * A bug that newly appeared in my list. Returns the "assigned" event, or nothing when it is not news
 * (for example a closed bug that merely re-entered the monitoring window).
 */
export function classifyNew(c: DetectCtx, i: Json, hist: Json[], lastSyncMs: number): Draft[] {
  const done = i.fields.status?.statusCategory?.key === 'done';
  // The assignment itself, if Jira shows it: the newest change that set the assignee to me.
  const h = [...hist].reverse().find((x) => (x.items || []).some((it: Json) => it.field === 'assignee' && it.to === c.meId));
  const when = h ? Date.parse(iso(h.created)) : Date.parse(iso(i.fields.updated));
  if (done && !(h && when > lastSyncMs - 5000)) return [];
  const id = `${i.key}:assigned:${h?.id ?? iso(i.fields.updated)}`;
  if (c.seen.has(id)) return [];
  c.seen.add(id);
  markHistorySeen(c, i.key, hist);
  return [draft(c.siteUrl, i, 'assigned', {
    occurredAt: new Date(when).toISOString(),
    actor: h?.author?.displayName ?? null,
    own: h?.author?.accountId === c.meId,
  })];
}

/** A bug already in my list whose `updated` changed: turn its new changelog entries and comments into events. */
export function classifyChanges(c: DetectCtx, i: Json, hist: Json[], comments: Json[], sinceMs: number): Draft[] {
  const since = sinceMs - 1500;
  const out: Draft[] = [];
  for (const h of hist) {
    const created = Date.parse(iso(h.created));
    if (!(created > since)) continue;
    const own = h.author?.accountId === c.meId;
    const actor = h.author?.displayName ?? null;
    const occurredAt = new Date(created).toISOString();
    const other: string[] = [];
    for (const it of h.items || []) {
      const fid = String(it.fieldId ?? it.field);
      const sid = seenId(i.key, h, it);
      if (c.seen.has(sid)) continue;
      c.seen.add(sid);
      const field = String(it.field ?? '');
      const from = it.fromString ?? null, to = it.toString ?? null;
      if (fid === 'status') {
        const fc = c.statusCat(String(it.from));
        const tc = c.statusCat(String(it.to)) ?? (to === i.fields.status?.name ? i.fields.status?.statusCategory?.key : undefined);
        let type: JarvisEventType = 'status';
        if (fc === 'done' && tc !== 'done') type = 'reopened';
        else if (/re-?open/i.test(to ?? '')) type = 'reopened';
        else if (tc === 'done' && fc !== 'done') type = /clos/i.test(to ?? '') ? 'closed' : 'resolved';
        out.push(draft(c.siteUrl, i, type, { occurredAt, actor, from, to, own }));
      } else if (fid === 'priority') {
        const up = c.priorityRank(to) < c.priorityRank(from);
        out.push(draft(c.siteUrl, i, 'priority', { occurredAt, actor, from, to, own, escalated: up, importance: up ? 'high' : 'normal' }));
      } else if (c.severityIds.has(fid) || c.severityNames.has(field.toLowerCase())) {
        const up = severityRank(to) < severityRank(from);
        out.push(draft(c.siteUrl, i, 'severity', { occurredAt, actor, from, to, own, escalated: up, importance: up ? 'high' : 'normal' }));
      } else if (fid === 'assignee') {
        // Handed to me while the bug was already in my list (it left and came back between two checks).
        // Handing it to someone else is detected from the issue list, not from here.
        if (String(it.to) === c.meId && String(it.from) !== c.meId) out.push(draft(c.siteUrl, i, 'assigned', { occurredAt, actor, own }));
      } else if (!NOISY_FIELDS.has(field.toLowerCase())) {
        other.push(field);
      }
    }
    if (other.length) out.push(draft(c.siteUrl, i, 'updated', { occurredAt, actor, own, detail: [...new Set(other)].join(', ') }));
  }

  let n = 0;
  for (const cm of comments) {
    const created = Date.parse(iso(cm.created));
    if (!(created > since)) continue;
    const sid = `${i.key}:c${cm.id}`;
    if (c.seen.has(sid)) continue;
    c.seen.add(sid);
    if (++n > 5) continue;
    out.push(draft(c.siteUrl, i, 'comment', {
      occurredAt: new Date(created).toISOString(),
      actor: cm.author?.displayName ?? null,
      own: cm.author?.accountId === c.meId,
      detail: adfToText(cm.body).replace(/\s+/g, ' ').trim().slice(0, 160),
    }));
  }
  return out;
}

/** A bug that left my list. `i` must contain summary, status, assignee, project and updated. */
export function classifyAway(c: DetectCtx, i: Json, prevSummary: string): Draft | null {
  const a = i.fields.assignee;
  if (a?.accountId === c.meId) return null; // still mine; it only aged out of the window or changed type
  const sid = `${i.key}:away:${iso(i.fields.updated)}`;
  if (c.seen.has(sid)) return null;
  c.seen.add(sid);
  return draft(c.siteUrl, i, a ? 'reassigned_away' : 'unassigned', { occurredAt: iso(i.fields.updated), to: a?.displayName ?? null, summary: prevSummary || String(i.fields.summary ?? '') });
}
