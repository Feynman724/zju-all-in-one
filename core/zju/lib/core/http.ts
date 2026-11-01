/**
 * HTTP 客户端 + CookieJar。移植自 course_choser/src/http.js，加类型与 agent 注入点。
 *
 * CookieJar 按 domain + path 区分：zdbk 在 /jwglxt、/javajw、/jwglxt/xtgl 三个 path 下各发一个
 * JSESSIONID，扁平的 name→value 映射会互相覆盖导致登录失败。
 */
import http from "node:http";
import https from "node:https";
import { TransportError } from "./errors.ts";
import { debug } from "./output.ts";

export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  hostOnly: boolean;
  secure: boolean;
  expires: number | null;
  created: number;
}

export class CookieJar {
  cookies: Cookie[];
  private sequence: number;

  constructor(cookies: Cookie[] = []) {
    this.cookies = cookies.map((c) => ({ ...c }));
    this.sequence = cookies.length;
  }

  setCookie(raw: string, source: string): void {
    const url = new URL(source);
    const fields = raw.split(";");
    const first = fields.shift() ?? "";
    const eq = first.indexOf("=");
    if (eq < 1) return;
    const entry: Cookie = {
      name: first.slice(0, eq).trim(),
      value: first.slice(eq + 1).trim(),
      domain: url.hostname,
      path: url.pathname.slice(0, url.pathname.lastIndexOf("/")) || "/",
      hostOnly: true,
      secure: false,
      expires: null,
      created: this.sequence++,
    };
    let maxAge: number | undefined;
    for (const field of fields) {
      const split = field.indexOf("=");
      const key = (split < 0 ? field : field.slice(0, split)).trim().toLowerCase();
      const value = split < 0 ? "" : field.slice(split + 1).trim();
      if (key === "domain") {
        const domain = value.replace(/^\./, "").toLowerCase();
        if (!domain || !(url.hostname === domain || url.hostname.endsWith("." + domain))) return;
        entry.domain = domain;
        entry.hostOnly = false;
      }
      if (key === "path" && value.startsWith("/")) entry.path = value;
      if (key === "secure") entry.secure = true;
      if (key === "max-age" && /^-?\d+$/.test(value)) maxAge = Number(value);
      if (key === "expires" && Number.isFinite(Date.parse(value))) entry.expires = Date.parse(value);
    }
    if (maxAge !== undefined) entry.expires = Date.now() + maxAge * 1000;
    const old = this.cookies.find((c) => c.name === entry.name && c.domain === entry.domain && c.path === entry.path);
    if (old) entry.created = old.created;
    this.cookies = this.cookies.filter((c) => c !== old);
    if (entry.expires === null || entry.expires > Date.now()) this.cookies.push(entry);
  }

  /** 直接放入一个 cookie（用于从缓存恢复或手动导入） */
  put(name: string, value: string, domain: string, path = "/", secure = false): void {
    this.cookies = this.cookies.filter((c) => !(c.name === name && c.domain === domain && c.path === path));
    this.cookies.push({ name, value, domain, path, hostOnly: false, secure, expires: null, created: this.sequence++ });
  }

  setFromResponse(headers: string | string[] | undefined, url: string): void {
    const list = headers === undefined ? [] : Array.isArray(headers) ? headers : [headers];
    for (const cookie of list) this.setCookie(cookie, url);
  }

  getCookieHeader(source: string): string {
    const url = new URL(source);
    return this.matching(url)
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
  }

  get(name: string, source: string): string | undefined {
    return this.matching(new URL(source)).find((c) => c.name === name)?.value;
  }

  /** 删除 cookie。默认只删 domain 精确相等的；includeSubdomains=true 才连子域一起删。 */
  removeDomain(domain: string, includeSubdomains = false): void {
    this.cookies = this.cookies.filter((c) => !(c.domain === domain || (includeSubdomains && c.domain.endsWith("." + domain))));
  }

  removeWhere(pred: (c: Cookie) => boolean): void {
    this.cookies = this.cookies.filter((c) => !pred(c));
  }

  private matching(url: URL): Cookie[] {
    const now = Date.now();
    return this.cookies
      .filter(
        (c) =>
          (c.expires === null || c.expires > now) &&
          (!c.secure || url.protocol === "https:") &&
          (c.hostOnly ? c.domain === url.hostname : c.domain === url.hostname || url.hostname.endsWith("." + c.domain)) &&
          (url.pathname === c.path || url.pathname.startsWith(c.path.endsWith("/") ? c.path : c.path + "/")),
      )
      .sort((a, b) => b.path.length - a.path.length || a.created - b.created);
  }

  toJSON(): Cookie[] {
    return this.cookies;
  }
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeout?: number;
  signal?: AbortSignal;
}

export class HttpResponse {
  /** 本进程连接编号，用于验证预热与提交是否复用了同一 TCP/TLS 连接。 */
  readonly connection: { id: number; reused: boolean } | undefined;
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
  /** 原始字节（PDF 等二进制响应用这个；body 是它的 utf8 解码） */
  readonly raw: Buffer;
  readonly url: string;
  readonly elapsedMs: number;

  constructor(init: { status: number; headers: http.IncomingHttpHeaders; body?: string; raw?: Buffer; url: string; elapsedMs: number; connection?: { id: number; reused: boolean } }) {
    this.connection = init.connection;
    this.status = init.status;
    this.headers = init.headers;
    this.raw = init.raw ?? Buffer.from(init.body ?? "", "utf8");
    this.body = init.body ?? this.raw.toString("utf8");
    this.url = init.url;
    this.elapsedMs = init.elapsedMs;
  }

  json<T = unknown>(): T | null {
    try {
      return JSON.parse(this.body) as T;
    } catch {
      return null;
    }
  }

  get location(): string | undefined {
    return this.headers.location;
  }

  get isRedirect(): boolean {
    return [301, 302, 303, 307, 308].includes(this.status) && !!this.location;
  }

  get contentType(): string {
    return String(this.headers["content-type"] ?? "");
  }
}

export interface HttpClientOptions {
  /** 附加信任根（本地 TLS 测试等）；不关闭证书验证。 */
  ca?: https.AgentOptions["ca"];
  scheduling?: "lifo" | "fifo";
  maxSockets?: number;
  timeout?: number;
  idleTimeoutMs?: number;
  jar?: CookieJar;
  signal?: AbortSignal;
  /** 注入自定义 agent（SOCKS 等）。返回 undefined 则用内置 keep-alive agent。 */
  agentFor?: (url: URL) => http.Agent | https.Agent | undefined;
  userAgent?: string;
}

export const DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

const REDIRECT_STATUSES = [301, 302, 303, 307, 308];

/** 唯一连接池；不自动重试 POST。 */
export class HttpClient {
  private socketIds = new WeakMap<object, number>();
  private nextSocketId = 1;
  jar: CookieJar;
  readonly timeout: number;
  readonly signal: AbortSignal | undefined;
  readonly userAgent: string;
  private readonly httpAgent: http.Agent;
  private readonly httpsAgent: https.Agent;
  private readonly agentFor: HttpClientOptions["agentFor"];
  readonly stats = { requests: 0, errors: 0, timeouts: 0, reused: 0, newConnections: 0 };
  private rtts: number[] = [];
  clockOffset = 0;
  private closed = false;

  constructor(opts: HttpClientOptions = {}) {
    this.jar = opts.jar ?? new CookieJar();
    this.timeout = opts.timeout ?? 10000;
    this.signal = opts.signal;
    this.userAgent = opts.userAgent ?? DEFAULT_UA;
    this.agentFor = opts.agentFor;
    const agentOpts = { proxyEnv: process.env, keepAlive: true, maxSockets: opts.maxSockets ?? 4, maxFreeSockets: opts.maxSockets ?? 4, scheduling: opts.scheduling ?? "lifo", timeout: opts.idleTimeoutMs ?? 30000 };
    this.httpAgent = new http.Agent(agentOpts);
    this.httpsAgent = new https.Agent({ ...agentOpts, ...(opts.ca ? { ca: opts.ca } : {}) });
  }

  get steadyRtt(): number {
    const values = [...this.rtts].sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)] ?? 0;
  }

  socketStats(origin: string): { free: number; active: number; queued: number; freeIds: number[] } {
    const u = new URL(origin), agent = u.protocol === "https:" ? this.httpsAgent : this.httpAgent;
    const prefix = `${u.hostname}:${u.port || (u.protocol === "https:" ? 443 : 80)}:`;
    const free = Object.entries(agent.freeSockets).filter(([key]) => key.startsWith(prefix)).flatMap(([, sockets]) => sockets ?? []).filter(s => !s.destroyed);
    const active = Object.entries(agent.sockets).filter(([key]) => key.startsWith(prefix)).flatMap(([, sockets]) => sockets ?? []).filter(s => !s.destroyed);
    const queued = Object.entries(agent.requests).filter(([key]) => key.startsWith(prefix)).reduce((n, [, requests]) => n + (requests?.length ?? 0), 0);
    return { free: free.length, active: active.length, queued, freeIds: free.map(s => this.socketIds.get(s)!).filter(Boolean) };
  }

  request(url: string, options: RequestOptions = {}): Promise<HttpResponse> {
    const { method = "GET", headers = {}, body, timeout = this.timeout, signal = this.signal } = options;
    if (signal?.aborted || this.closed) return Promise.reject(new TransportError("请求已取消", { code: "ABORT_ERR" }));
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return Promise.reject(new TransportError("不支持的协议", { url }));
    const secure = u.protocol === "https:";
    const started = performance.now();
    this.stats.requests++;
    const finalHeaders: Record<string, string | number> = {
      "User-Agent": this.userAgent,
      Accept: "*/*",
      "Accept-Language": "zh-CN,zh;q=0.9",
      "Accept-Encoding": "identity",
      ...headers,
    };
    const cookie = this.jar.getCookieHeader(url);
    if (cookie && !Object.keys(headers).some((k) => k.toLowerCase() === "cookie")) finalHeaders["Cookie"] = cookie;
    if (body !== undefined && !Object.keys(finalHeaders).some((k) => k.toLowerCase() === "content-length")) finalHeaders["Content-Length"] = Buffer.byteLength(body);
    debug(`${method} ${u.origin}${u.pathname}`);
    const agent = this.agentFor?.(u) ?? (secure ? this.httpsAgent : this.httpAgent);

    return new Promise<HttpResponse>((resolve, reject) => {
      let settled = false;
      let phase = "queue";
      let timer: NodeJS.Timeout | undefined;
      let connection: { id: number; reused: boolean } | undefined;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      const fail = (err: Error & { code?: string }) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (err.code !== "ABORT_ERR") this.stats.errors++;
        if (err.code === "ETIMEDOUT") this.stats.timeouts++;
        reject(new TransportError(err.message, { code: err.code, phase, url, connection, elapsedMs: Math.round(performance.now() - started) }, err));
      };
      const abort = () => {
        const timedOut = signal?.reason instanceof Error && signal.reason.name === "TimeoutError";
        fail(Object.assign(new Error(timedOut ? "请求截止时间已到，连接超时" : "请求已取消"), { code: timedOut ? "ETIMEDOUT" : "ABORT_ERR" }));
        req.destroy();
      };
      const req = (secure ? https : http).request(u, { method, headers: finalHeaders, agent }, (res) => {
        if (settled) {
          res.destroy();
          return;
        }
        phase = "response";
        this.jar.setFromResponse(res.headers["set-cookie"], url);
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 16 * 1024 * 1024) {
            fail(Object.assign(new Error("响应超过 16MB"), { code: "BODY_TOO_LARGE" }));
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          if (settled) return;
          settled = true;
          cleanup();
          const elapsed = performance.now() - started;
          this.rtts.push(elapsed);
          if (this.rtts.length > 30) this.rtts.shift();
          if (res.headers.date && Number.isFinite(Date.parse(res.headers.date))) this.clockOffset = Date.parse(res.headers.date) - Date.now();
          resolve(new HttpResponse({ status: res.statusCode ?? 0, headers: res.headers, raw: Buffer.concat(chunks), url, elapsedMs: Math.round(elapsed), ...(connection ? { connection } : {}) }));
        });
        res.on("error", fail);
        res.on("aborted", () => fail(Object.assign(new Error("响应中途断开"), { code: "ECONNRESET" })));
        res.on("close", () => {
          if (!res.complete) fail(Object.assign(new Error("响应未完整接收"), { code: "ECONNRESET" }));
        });
      });
      req.on("socket", (socket) => {
        const previous = this.socketIds.get(socket), id = previous ?? this.nextSocketId++;
        this.socketIds.set(socket, id);
        connection = { id, reused: previous !== undefined };
        this.stats[connection.reused ? "reused" : "newConnections"]++;
        phase = socket.connecting ? "connect" : "request";
        socket.setNoDelay(true);
        req.setTimeout(0);
        if (socket.connecting) {
          socket.once("connect", () => {
            phase = secure ? "tls" : "request";
          });
          if (secure) socket.once("secureConnect", () => {
            phase = "request";
          });
        }
      });
      req.on("error", fail);
      req.on("close", () => {
        if (!settled) fail(Object.assign(new Error("连接提前关闭"), { code: "ECONNRESET" }));
      });
      timer = setTimeout(() => {
        fail(Object.assign(new Error(`请求超时（${timeout}ms）`), { code: "ETIMEDOUT" }));
        req.destroy();
      }, timeout);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      req.end(body);
    });
  }

  /** 跟随重定向；303 与 POST 的 301/302 改 GET；跨 origin 时剥掉 Cookie/Authorization。 */
  async requestFollow(url: string, options: RequestOptions = {}, maxRedirects = 10): Promise<HttpResponse> {
    let current = url;
    const opts: RequestOptions = { ...options, headers: { ...(options.headers ?? {}) } };
    for (let i = 0; i <= maxRedirects; i++) {
      const res = await this.request(current, opts);
      if (!REDIRECT_STATUSES.includes(res.status) || !res.location) return res;
      const next = new URL(res.location, current).href;
      const method = (opts.method ?? "GET").toUpperCase();
      const hdrs = opts.headers ?? {};
      if ((res.status === 303 && method !== "HEAD") || ([301, 302].includes(res.status) && method === "POST")) {
        opts.method = "GET";
        delete opts.body;
        for (const key of Object.keys(hdrs)) if (["content-type", "content-length", "transfer-encoding"].includes(key.toLowerCase())) delete hdrs[key];
      }
      if (new URL(next).origin !== new URL(current).origin) {
        for (const key of Object.keys(hdrs)) if (["authorization", "cookie", "host", "proxy-authorization"].includes(key.toLowerCase())) delete hdrs[key];
      }
      current = next;
    }
    throw new TransportError("重定向次数过多", { code: "REDIRECT_LIMIT", url });
  }

  postForm(url: string, data: Record<string, string> | string, opts: RequestOptions = {}): Promise<HttpResponse> {
    return this.request(url, {
      ...opts,
      method: "POST",
      body: typeof data === "string" ? data : new URLSearchParams(data).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", ...(opts.headers ?? {}) },
    });
  }

  postJson(url: string, data: unknown, opts: RequestOptions = {}): Promise<HttpResponse> {
    return this.request(url, {
      ...opts,
      method: "POST",
      body: JSON.stringify(data),
      headers: { "Content-Type": "application/json", ...(opts.headers ?? {}) },
    });
  }

  destroy(): void {
    this.closed = true;
    this.httpAgent.destroy();
    this.httpsAgent.destroy();
  }
}

/** 从 HTML 里按 id/name 取 <input> 的 value */
export function inputValue(html: string, name: string): string | null {
  const tags = [...html.matchAll(/<input\b[^>]*>/gi)].map((m) => m[0]);
  const tag = tags.find((t) => new RegExp(`(?:id|name)=["']${name}["']`, "i").test(t));
  return tag?.match(/value=["']([^"']*)["']/i)?.[1] ?? null;
}
