// Browser speech and desktop-notification plumbing for JARVIS.
//
// Browser limits worth knowing:
//  - Speech and notifications only work while a tab of the app is open (a closed browser cannot speak).
//  - Chrome refuses to speak before the user has interacted with the page once, so announcements are
//    held until the first click or key press, and dropped if they get stale while waiting.
//  - Notification permission may only be requested from a user gesture; it is never asked on load.

import type { JarvisPrefs } from './jarvis-core.js';

export const speechSupported = typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';

// ------------------------------------------------------------------ voices

/** English voices, best candidates first. macOS "Daniel" and Google UK English Male suit JARVIS well. */
const PREFERRED = [/daniel/i, /google uk english male/i, /arthur/i, /oliver/i, /microsoft (george|ryan|mark)/i, /\bben\b/i, /alex/i, /fred/i];

export function englishVoices(): SpeechSynthesisVoice[] {
  if (!speechSupported) return [];
  return window.speechSynthesis.getVoices().filter((v) => /^en([-_]|$)/i.test(v.lang));
}

export function pickVoice(name: string): SpeechSynthesisVoice | null {
  const all = englishVoices();
  if (name) {
    const hit = all.find((v) => v.name === name);
    if (hit) return hit;
  }
  for (const re of PREFERRED) {
    const hit = all.find((v) => re.test(v.name));
    if (hit) return hit;
  }
  return all.find((v) => /en[-_]GB/i.test(v.lang)) ?? all.find((v) => v.default) ?? all[0] ?? null;
}

// ------------------------------------------------------------------ queue

interface Item {
  text: string;
  at: number;
  /** Test announcements are never dropped as stale. */
  force: boolean;
}

const STALE_MS = 120_000;
const MAX_QUEUE = 5;

export class Speaker {
  private queue: Item[] = [];
  private current: Item | null = null;
  private unlocked = false;
  private timer: number | undefined;
  /** Kept referenced: some browsers garbage-collect an utterance mid-speech and never fire `end`. */
  private utterance: SpeechSynthesisUtterance | null = null;
  onChange: () => void = () => undefined;
  onBlocked: (blocked: boolean) => void = () => undefined;
  private getPrefs: () => JarvisPrefs;

  constructor(getPrefs: () => JarvisPrefs) {
    this.getPrefs = getPrefs;
    if (!speechSupported) return;
    this.unlocked = !!(navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive;
    if (!this.unlocked) {
      const unlock = (): void => {
        this.unlocked = true;
        this.onBlocked(false);
        window.removeEventListener('pointerdown', unlock, true);
        window.removeEventListener('keydown', unlock, true);
        this.pump();
      };
      window.addEventListener('pointerdown', unlock, true);
      window.addEventListener('keydown', unlock, true);
    }
    window.speechSynthesis.getVoices(); // starts loading the voice list
  }

  get blocked(): boolean {
    return speechSupported && !this.unlocked && this.queue.length > 0;
  }
  pending(): string[] {
    return [...(this.current ? [this.current.text] : []), ...this.queue.map((q) => q.text)];
  }

  say(text: string, force = false): void {
    if (!speechSupported || !text) return;
    this.queue.push({ text, at: Date.now(), force });
    // Too many waiting: the oldest ones are the least relevant by now.
    while (this.queue.length > MAX_QUEUE) this.queue.shift();
    if (!this.unlocked) this.onBlocked(true);
    this.onChange();
    this.pump();
  }

  clear(): void {
    this.queue = [];
    this.current = null;
    clearTimeout(this.timer);
    if (speechSupported) window.speechSynthesis.cancel();
    this.onChange();
  }

  private pump(): void {
    if (!speechSupported || this.current || !this.unlocked) return;
    const now = Date.now();
    let next: Item | undefined;
    while ((next = this.queue.shift())) {
      if (next.force || now - next.at < STALE_MS) break;
      next = undefined;
    }
    if (!next) {
      this.onChange();
      return;
    }
    this.current = next;
    const p = this.getPrefs();
    const u = new SpeechSynthesisUtterance(next.text);
    const v = pickVoice(p.voiceName);
    if (v) {
      u.voice = v;
      u.lang = v.lang;
    } else u.lang = 'en-GB';
    u.rate = Math.min(1.5, Math.max(0.6, p.rate));
    u.volume = Math.min(1, Math.max(0, p.volume));
    u.pitch = 0.95;
    const done = (): void => {
      if (this.utterance !== u) return;
      clearTimeout(this.timer);
      this.utterance = null;
      this.current = null;
      this.onChange();
      window.setTimeout(() => this.pump(), 350); // a short pause between announcements
    };
    u.onend = done;
    u.onerror = done;
    this.utterance = u;
    // Safety net: if the engine never reports `end`, move on instead of going silent forever.
    this.timer = window.setTimeout(done, 4000 + next.text.length * 110);
    window.speechSynthesis.speak(u);
    this.onChange();
  }
}

// ------------------------------------------------------------------ desktop notifications

export type NotifyPermission = NotificationPermission | 'unsupported';
export const notifyPermission = (): NotifyPermission => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);

/** Must be called from a click handler. */
export async function requestNotifyPermission(): Promise<NotifyPermission> {
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

export function showNotification(opts: { title: string; body: string; tag: string; silent: boolean; sticky?: boolean; onClick: () => void }): boolean {
  if (notifyPermission() !== 'granted') return false;
  try {
    const n = new Notification(opts.title, {
      body: opts.body.slice(0, 200),
      tag: opts.tag,
      silent: opts.silent,
      icon: 'icon.svg',
      requireInteraction: !!opts.sticky,
    });
    n.onclick = () => {
      window.focus();
      n.close();
      opts.onClick();
    };
    if (!opts.sticky) setTimeout(() => n.close(), 12_000);
    return true;
  } catch {
    return false; // e.g. Android Chrome only allows notifications from a service worker (phase 2 PWA)
  }
}
