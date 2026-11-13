// Прокси GigaChat внутри dev-сервера Vite: /api/llm/status и /api/llm/chat.
import { loadEnv, type Plugin } from "vite";
import { balance, chat, isConfigured, usage, type GigaEnv } from "./gigachat.ts";
import { MAX_USER_LEN, TASKS, isTask, rateLimited, sameOrigin } from "./prompts.ts";

export function gigachatProxy(): Plugin {
  let env: GigaEnv & { LLM_MODE?: string } = {};
  return {
    name: "gigachat-proxy",
    configResolved(c) {
      env = loadEnv(c.mode, process.cwd(), "") as typeof env;
    },
    configureServer(server) {
      server.middlewares.use("/api/llm", async (req, res) => {
        const send = (code: number, obj: unknown) => {
          res.statusCode = code;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify(obj));
        };
        const mode = env.LLM_MODE === "gigachat" && isConfigured(env) ? "gigachat" : "rules";
        if (req.url?.startsWith("/status")) return send(200, { mode, model: mode === "gigachat" ? env.GIGACHAT_MODEL || "GigaChat-2-Max" : null });
        if (req.url?.startsWith("/usage")) {
          const withBalance = req.url.includes("balance=1") && mode === "gigachat";
          return send(200, { mode, usage, balance: withBalance ? await balance(env) : null });
        }
        if (req.url?.startsWith("/chat") && req.method === "POST") {
          if (mode !== "gigachat") return send(409, { error: "LLM не подключена: режим rules" });
          if (!sameOrigin(req.headers.origin, req.headers.host)) return send(403, { error: "запрос не с этого сайта" });
          if (rateLimited(req.socket.remoteAddress ?? "local")) return send(429, { error: "слишком много запросов к ИИ, подождите минуту" });
          let raw = "";
          for await (const c of req) raw += c;
          let body: { task?: unknown; user?: unknown };
          try {
            body = JSON.parse(raw);
          } catch {
            return send(400, { error: "некорректный запрос" });
          }
          if (!isTask(body.task) || typeof body.user !== "string" || !body.user || body.user.length > MAX_USER_LEN) return send(400, { error: "некорректный запрос" });
          try {
            const t = TASKS[body.task];
            return send(200, { content: await chat(env, t.system, body.user, t.purpose), usage });
          } catch (e) {
            return send(502, { error: (e as Error).message });
          }
        }
        send(404, { error: "not found" });
      });
    },
  };
}
