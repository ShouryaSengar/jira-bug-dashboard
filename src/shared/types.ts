/** Shapes shared by the local server and the browser app. Types only, no runtime code. */

export type StatusCategory = 'new' | 'indeterminate' | 'done';

export interface Person {
  name: string;
  email: string | null;
}

export interface Bug {
  key: string;
  url: string;
  summary: string;
  type: string | undefined;
  status: string;
  statusCategory: StatusCategory | undefined;
  priority: string | null;
  severity: string | null;
  reporter: Person | null;
  assignee: Person | null;
  created: string;
  updated: string;
  resolved: string | null;
  /** How the bug relates to the tracked issue, e.g. "blocks" or "child of". */
  relation: string;
}

export interface ParentIssue {
  key: string;
  url: string;
  summary: string;
  status: string | undefined;
  type: string | undefined;
}

export interface BugsResponse {
  parent: ParentIssue;
  bugs: Bug[];
  severityFieldsUsed: string[];
  jql: string;
  fetchedAt: string;
}

/** What the browser may know about the saved connection. Never includes the token. */
export interface PublicConfig {
  configured: boolean;
  source?: 'env' | 'file';
  jiraUrl?: string;
  email?: string;
  displayName?: string | null;
  severityFields?: string;
  issueTypes?: string;
  configFile?: string | null;
}

export interface ConfigUpdate {
  jiraUrl: string;
  email: string;
  apiToken: string;
  severityFields?: string;
  issueTypes?: string;
}

// ------------------------------------------------------------------ For You + JARVIS

export interface MyBug extends Bug {
  project: { key: string; name: string };
  parent: { key: string; summary: string; type: string | undefined } | null;
  labels: string[];
  blocked: boolean;
  blockedReason: string | null;
  /** Assigned to me within the last 7 days (best effort, see README). */
  recentlyAssigned: boolean;
  /** Most recent change JARVIS has seen on this bug. */
  lastActivity: { at: string; label: string } | null;
}

export interface MyBugsResponse {
  me: { name: string; email: string | null };
  bugs: MyBug[];
  jql: string;
  truncated: boolean;
  recentlyAssignedSource: 'jira-history' | 'created' | 'none';
  fetchedAt: string;
}

export interface IssueDetail {
  key: string;
  url: string;
  summary: string;
  status: string;
  statusCategory: StatusCategory | undefined;
  priority: string | null;
  severity: string | null;
  project: { key: string; name: string };
  assignee: Person | null;
  reporter: Person | null;
  created: string;
  updated: string;
  resolved: string | null;
  parent: { key: string; summary: string; url: string } | null;
  labels: string[];
  description: string;
  comments: { id: string; author: string; created: string; body: string }[];
  history: { id: string; author: string; created: string; items: { field: string; from: string | null; to: string | null }[] }[];
  links: { relation: string; key: string; summary: string; status: string; url: string }[];
}

export type JarvisEventType =
  | 'assigned' | 'reassigned_away' | 'unassigned' | 'status' | 'reopened' | 'resolved' | 'closed'
  | 'comment' | 'priority' | 'severity' | 'updated';

export interface JarvisEvent {
  /** Monotonic id assigned by the server. Negative ids are simulated events that never reach the server. */
  id: number;
  type: JarvisEventType;
  /** When JARVIS detected it. */
  at: string;
  /** When it happened in Jira. */
  occurredAt: string;
  key: string;
  summary: string;
  project: string;
  url: string;
  actor: string | null;
  from: string | null;
  to: string | null;
  /** Comment excerpt or list of changed fields. */
  detail: string | null;
  /** For priority and severity changes: true when it became more severe. */
  escalated: boolean;
  importance: 'high' | 'normal' | 'low';
  /** Caused by me. Recorded, never announced. */
  own: boolean;
  read: boolean;
  simulated?: boolean;
}

export interface JarvisServerPrefs {
  enabled: boolean;
  paused: boolean;
  intervalSec: number;
  /** Show native OS notifications from the server while no browser tab is connected. */
  osNotify: boolean;
  /** Closed bugs updated within this many days still count as monitored. */
  closedWindowDays: number;
}

export type JarvisState = 'unconfigured' | 'off' | 'paused' | 'syncing' | 'online' | 'backoff';

export interface JarvisStatus {
  state: JarvisState;
  prefs: JarvisServerPrefs;
  lastSyncAt: string | null;
  nextSyncAt: string | null;
  lastError: string | null;
  monitored: number;
  unread: number;
  lastEventId: number;
  clients: number;
  osNotifySupported: boolean;
}
