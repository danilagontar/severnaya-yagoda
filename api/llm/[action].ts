// Серверная функция Vercel: то же, что прокси в dev-сервере (server/vite-plugin.ts), но для выложенного сайта.
// /api/llm/status · /api/llm/usage · /api/llm/chat. Ключ берётся из переменных окружения проекта на Vercel.
import fs from "node:fs";
import path from "node:path";
import { balance, chat, isConfigured, usage, type GigaEnv } from "../../server/gigachat.js"; // ES-модули на Vercel требуют расширение
import { MAX_USER_LEN, TASKS, isTask, rateLimited, sameOrigin } from "../../server/prompts.js";

type Req = { method?: string; query: Record<string, string | string[]>; body?: unknown; headers?: Record<string, string | string[] | undefined> };
const header = (req: Req, k: string) => {
  const v = req.headers?.[k];
  return Array.isArray(v) ? v[0] : v;
};
type Res = { status: (c: number) => Res; json: (b: unknown) => void; setHeader: (k: string, v: string) => void };

export default async function handler(req: Req, res: Res) {
  // сертификат Минцифры лежит рядом с кодом сервера (публичный файл, не секрет)
  const ca = path.join(process.cwd(), "server", "russian_trusted_root_ca.pem");
  const env: GigaEnv & { LLM_MODE?: string } = { ...(process.env as GigaEnv), GIGACHAT_CA_FILE: fs.existsSync(ca) ? ca : process.env.GIGACHAT_CA_FILE };
  const mode = env.LLM_MODE === "gigachat" && isConfigured(env) ? "gigachat" : "rules";
  const action = String(req.query.action ?? "");
  res.setHeader("Cache-Control", "no-store");

  if (action === "status") return res.status(200).json({ mode, model: mode === "gigachat" ? env.GIGACHAT_MODEL || "GigaChat-2-Max" : null });
  if (action === "usage") {
    const withBalance = req.query.balance === "1" && mode === "gigachat";
    return res.status(200).json({ mode, usage, balance: withBalance ? await balance(env) : null });
  }
  if (action === "chat" && req.method === "POST") {
    if (mode !== "gigachat") return res.status(409).json({ error: "ИИ не подключён: режим rules" });
    if (!sameOrigin(header(req, "origin"), header(req, "host"))) return res.status(403).json({ error: "запрос не с этого сайта" });
    const ip = (header(req, "x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
    if (rateLimited(ip)) return res.status(429).json({ error: "слишком много запросов к ИИ, подождите минуту" });
    let b: { task?: unknown; user?: unknown };
    try {
      b = (typeof req.body === "string" ? JSON.parse(req.body) : req.body) ?? {};
    } catch {
      return res.status(400).json({ error: "некорректный запрос" });
    }
    if (!isTask(b.task) || typeof b.user !== "string" || !b.user || b.user.length > MAX_USER_LEN) return res.status(400).json({ error: "некорректный запрос" });
    try {
      const t = TASKS[b.task];
      return res.status(200).json({ content: await chat(env, t.system, b.user, t.purpose), usage });
    } catch (e) {
      return res.status(502).json({ error: (e as Error).message });
    }
  }
  return res.status(404).json({ error: "not found" });
}
