// Серверный клиент GigaChat API. Работает только в Node (dev-сервер Vite), ключ в браузер не попадает.
// Адреса и заголовки сверены с developers.sber.ru 12.11.2026 (см. docs/llm.md).
// С реальным ключом не проверялся.

import https from "node:https";
import fs from "node:fs";
import crypto from "node:crypto";

export interface GigaEnv {
  GIGACHAT_AUTH_KEY?: string;
  GIGACHAT_SCOPE?: string;
  GIGACHAT_MODEL?: string;
  GIGACHAT_CA_FILE?: string;
  NODE_EXTRA_CA_CERTS?: string;
}

const OAUTH_URL = "https://ngw.devices.sberbank.ru:9443/api/v2/oauth";
const CHAT_URL = "https://api.giga.chat/v1/chat/completions";
const BALANCE_URL = "https://api.giga.chat/v1/balance";

// Расход токенов: копим в памяти dev-сервера и дописываем каждый запрос в logs/gigachat-usage.jsonl
export interface Usage {
  requests: number;
  prompt: number;
  completion: number;
  total: number;
  since: string;
  last: { at: string; purpose: string; total: number } | null;
}
export const usage: Usage = { requests: 0, prompt: 0, completion: 0, total: 0, since: new Date().toISOString(), last: null };

function recordUsage(purpose: string, u?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }) {
  const p = u?.prompt_tokens ?? 0, c = u?.completion_tokens ?? 0, t = u?.total_tokens ?? p + c;
  usage.requests++;
  usage.prompt += p;
  usage.completion += c;
  usage.total += t;
  usage.last = { at: new Date().toISOString(), purpose, total: t };
  try {
    fs.mkdirSync("logs", { recursive: true });
    fs.appendFileSync("logs/gigachat-usage.jsonl", JSON.stringify({ at: usage.last.at, purpose, prompt: p, completion: c, total: t }) + "\n");
  } catch {
    /* лог необязателен */
  }
}

/** Остаток токенов. Документация: доступно только при купленных пакетах, при pay-as-you-go — 403. */
export async function balance(env: GigaEnv): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  try {
    const ca = loadCa(env);
    const token = await getToken(env, ca);
    const res = await request(BALANCE_URL, { method: "GET", headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }, "", ca);
    if (res.status !== 200) return { ok: false, error: `${res.status}: ${res.text.slice(0, 160)}` };
    return { ok: true, data: JSON.parse(res.text) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

let cached: { token: string; expiresAt: number } | null = null;

function request(url: string, opts: https.RequestOptions, body: string, ca?: Buffer): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { ...opts, ca, timeout: 30000 }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: data }));
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("GigaChat: таймаут запроса")));
    req.end(body);
  });
}

function loadCa(env: GigaEnv): Buffer | undefined {
  const file = env.GIGACHAT_CA_FILE || env.NODE_EXTRA_CA_CERTS;
  if (file && fs.existsSync(file)) return fs.readFileSync(file);
  return undefined;
}

export function isConfigured(env: GigaEnv): boolean {
  return !!env.GIGACHAT_AUTH_KEY;
}

async function getToken(env: GigaEnv, ca?: Buffer): Promise<string> {
  if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;
  const body = new URLSearchParams({ scope: env.GIGACHAT_SCOPE || "GIGACHAT_API_PERS" }).toString();
  const res = await request(
    OAUTH_URL,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${env.GIGACHAT_AUTH_KEY}`,
        RqUID: crypto.randomUUID(),
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
    },
    body,
    ca,
  );
  if (res.status !== 200) throw new Error(`GigaChat OAuth ${res.status}: ${res.text.slice(0, 200)}`);
  const j = JSON.parse(res.text) as { access_token: string; expires_at?: number };
  // expires_at в миллисекундах; если поля нет — токен живёт 30 минут
  cached = { token: j.access_token, expiresAt: j.expires_at ?? Date.now() + 30 * 60_000 };
  return cached.token;
}

export async function chat(env: GigaEnv, system: string, user: string, purpose = "chat"): Promise<string> {
  const ca = loadCa(env);
  const token = await getToken(env, ca);
  const body = JSON.stringify({
    model: env.GIGACHAT_MODEL || "GigaChat-2-Max",
    temperature: 0.0001,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
  // 429 Too Many Requests: бесплатный тариф ограничивает частоту — повторяем с паузой 1,5 / 3 / 6 с.
  let res = { status: 0, text: "" };
  for (const wait of [0, 1500, 3000, 6000]) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    res = await request(
      CHAT_URL,
      { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" } },
      body,
      ca,
    );
    if (res.status !== 429) break;
  }
  if (res.status !== 200) throw new Error(`GigaChat ${res.status}: ${res.text.slice(0, 200)}`);
  const j = JSON.parse(res.text) as { choices: { message: { content: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };
  recordUsage(purpose, j.usage);
  return j.choices?.[0]?.message?.content ?? "";
}
