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
