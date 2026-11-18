// Cloud edition entry point: one Worker serves the static app (Workers Static Assets, free and not counted
// as Worker requests), the API under /api and /auth, and the shared monitoring Cron Trigger.

import { handleApi } from './api.js';
import { assertConfigured, type Env } from './env.js';
import { errorResponse } from './http.js';
import { runTick } from './monitor.js';

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) {
      try {
        assertConfigured(env);
        return await handleApi(req, env, url);
      } catch (e) {
        return errorResponse(e);
      }
    }
    return env.ASSETS.fetch(req);
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runTick(env, event.scheduledTime).then(
        (r) =>
          console.log(JSON.stringify({ tick: r.at, due: r.due, checked: r.checked.length, events: r.checked.reduce((n, c) => n + c.events, 0), deferred: r.deferred, subrequests: r.subrequests })),
        (e) => console.error('tick failed', (e as Error).message)
      )
    );
  },
} satisfies ExportedHandler<Env>;
