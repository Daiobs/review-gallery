import { authenticateAccess } from "./auth.js";
import { runCleanup } from "./cleanup.js";
import { handleAgentRequest } from "./routes/agent.js";
import { handleReviewRequest } from "./routes/review.js";
import type { Env, ExecutionContext, ScheduledController } from "./types.js";
import { jsonResponse, withSecurityHeaders } from "./utils.js";

function isAgentApiPath(pathname: string): boolean {
  return pathname === "/api/agent" || pathname.startsWith("/api/agent/");
}

function isReviewApiPath(pathname: string): boolean {
  return pathname === "/api/review" || pathname.startsWith("/api/review/");
}

function isOtherApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

export default {
  async fetch(request: Request, env: Env, _ctx?: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);
      const { pathname } = url;

      if (isAgentApiPath(pathname)) {
        const response = await handleAgentRequest(request, url, env);
        return withSecurityHeaders(response);
      }

      // All non-/api/agent/* routes (including static UI pages and /api/review/*)
      // MUST pass Cloudflare Access JWT authentication first.
      const accessAuth = await authenticateAccess(request, env);
      if (!accessAuth.ok) {
        return withSecurityHeaders(accessAuth.response);
      }

      if (isReviewApiPath(pathname)) {
        const response = await handleReviewRequest(request, url, env);
        return withSecurityHeaders(response);
      }

      if (isOtherApiPath(pathname)) {
        return jsonResponse({ error: "not_found" }, 404);
      }

      if (!env.ASSETS || typeof env.ASSETS.fetch !== "function") {
        return jsonResponse({ error: "assets_binding_missing" }, 500);
      }

      const assetResponse = await env.ASSETS.fetch(request);
      return withSecurityHeaders(assetResponse);
    } catch {
      return jsonResponse({ error: "internal_error" }, 500);
    }
  },

  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx?: ExecutionContext
  ): Promise<void> {
    const scheduledDate =
      controller && typeof controller.scheduledTime === "number" && controller.scheduledTime > 0
        ? new Date(controller.scheduledTime)
        : new Date();
    const task = runCleanup(env, scheduledDate);
    if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(task);
    }
    await task;
  },
};
