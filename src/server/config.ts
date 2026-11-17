// Credential storage. The token lives in the user's home folder (mode 0600), never in the project
// folder and never in the browser.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PublicConfig } from '../shared/types.js';

export const CONFIG_DIR = process.env['JBD_CONFIG_DIR'] || path.join(os.homedir(), '.jira-bug-dashboard');
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export const DEFAULTS = {
  // Field names or IDs (customfield_12345), checked in order. Names are resolved per Jira site.
  severityFields: 'Defect Severity, Severity',
  issueTypes: 'Bug',
};

export interface Config {
  source: 'env' | 'file';
  jiraUrl: string;
  email: string;
  apiToken: string;
  severityFields: string;
  issueTypes: string;
  displayName?: string;
  savedAt?: string;
}

export function loadConfig(): Config | null {
  const env = process.env;
  // Optional override for people who prefer env vars; never written to disk.
  if (env['JIRA_URL'] && env['JIRA_USERNAME'] && env['JIRA_API_TOKEN']) {
    return {
      source: 'env',
      jiraUrl: env['JIRA_URL'].replace(/\/+$/, ''),
      email: env['JIRA_USERNAME'],
      apiToken: env['JIRA_API_TOKEN'],
      severityFields: env['SEVERITY_FIELDS'] || DEFAULTS.severityFields,
      issueTypes: env['ISSUE_TYPES'] || DEFAULTS.issueTypes,
    };
  }
  try {
    const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) as Partial<Config>;
    if (!saved.jiraUrl || !saved.email || !saved.apiToken) return null;
    return { ...DEFAULTS, ...saved, source: 'file' } as Config;
  } catch {
    return null;
  }
}

export function saveConfig(cfg: Omit<Config, 'source'>): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${CONFIG_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_FILE);
  fs.chmodSync(CONFIG_FILE, 0o600); // no-op on Windows; the file is under the user's profile there
}

export function clearConfigFile(): void {
  fs.rmSync(CONFIG_FILE, { force: true });
}

/** What the browser is allowed to see. Never includes the token. */
export function publicConfig(cfg: Config | null): PublicConfig {
  if (!cfg) return { configured: false };
  return {
    configured: true,
    source: cfg.source,
    jiraUrl: cfg.jiraUrl,
    email: cfg.email,
    displayName: cfg.displayName ?? null,
    severityFields: cfg.severityFields,
    issueTypes: cfg.issueTypes,
    configFile: cfg.source === 'file' ? CONFIG_FILE : null,
  };
}
