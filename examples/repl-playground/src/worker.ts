// repl-playground — drive the durable REPL's model-facing `js` tool over HTTP.
//
// One PlaygroundHostDO per workspace name (`ws` query/body param, default
// "default"). Each DO hosts a real Workspace + durable REPL sessions and
// grants a fixed capability set. Every live capability call is counted, so
// replay discipline (zero live calls for committed cells) is observable.
//
// Endpoints (Authorization: Bearer <PLAYGROUND_TOKEN>, except /health):
//   GET  /health                                 → sanity check
//   GET  /tool?ws=NAME                           → generated js-tool name/description/inputSchema
//   POST /eval     { code, sessionName?, ws? }   → run one cell via the js tool definition
//   GET  /sessions?ws=NAME                       → sessions with cell counts
//   GET  /history?ws=NAME&session=main&effects=1 → committed cells (+ recorded effects)
//   GET  /counts?ws=NAME                         → live capability-call counters + real egress
//   GET  /outbox?ws=NAME                         → notifications "sent" by the notify capability
//   POST /restart  { ws? }                       → drop the in-memory Workspace (storage survives)
//   POST /reset    { ws? }                       → wipe the workspace: sessions, files, CRM, outbox

import { DurableObject } from "cloudflare:workers";
import { PLAYGROUND_PAGE } from "./page.js";
import {
  Workspace,
  capability,
  createJsToolDefinition,
  fetchCapability,
  renderJsResultText,
  workspaceFs,
  type CapabilityMeta,
  type ReplCapability,
  type ReplExecutionResult,
} from "@cloudflare/computer";

interface Env {
  LOADER: unknown;
  HOST: DurableObjectNamespace<PlaygroundHostDO>;
  PLAYGROUND_TOKEN: string;
  /** Optional Access team base URL, e.g. https://<team>.cloudflareaccess.com. Unset disables Access JWT auth. */
  ACCESS_TEAM?: string;
  /** Comma-separated Access application AUD tags accepted for this deployment. */
  ACCESS_AUDS?: string;
}

// ---------------------------------------------------------------------------
// Access JWT verification: browser requests come through Cloudflare Access,
// which injects a signed JWT in Cf-Access-Jwt-Assertion. Accepting a verified
// JWT (in addition to the bearer token) lets an Access-authenticated browser
// use the playground directly.

// Issuer and accepted AUDs come from per-environment vars in wrangler.jsonc,
// so the same worker deploys against any account's Access setup.

let accessKeys: { team: string; byKid: Map<string, CryptoKey>; fetchedAt: number } | undefined;

function b64urlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function accessSigningKeys(team: string): Promise<Map<string, CryptoKey>> {
  if (accessKeys !== undefined && accessKeys.team === team && Date.now() - accessKeys.fetchedAt < 3_600_000) {
    return accessKeys.byKid;
  }
  // realFetch: cert fetches must not pollute the egress replay counter.
  const res = await realFetch(`${team}/cdn-cgi/access/certs`);
  const { keys } = (await res.json()) as { keys: Array<JsonWebKey & { kid: string }> };
  const byKid = new Map<string, CryptoKey>();
  for (const jwk of keys) {
    byKid.set(
      jwk.kid,
      await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]),
    );
  }
  accessKeys = { team, byKid, fetchedAt: Date.now() };
  return byKid;
}

async function verifyAccessJwt(jwt: string, env: Env): Promise<boolean> {
  if (!env.ACCESS_TEAM || !env.ACCESS_AUDS) return false;
  try {
    const [headerPart, payloadPart, signaturePart] = jwt.split(".");
    if (signaturePart === undefined) return false;
    const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(headerPart))) as { kid?: string; alg?: string };
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(payloadPart))) as {
      iss?: string;
      exp?: number;
      aud?: string | string[];
    };
    if (header.alg !== "RS256" || header.kid === undefined) return false;
    if (payload.iss !== env.ACCESS_TEAM) return false;
    if (payload.exp === undefined || payload.exp * 1000 < Date.now()) return false;
    const allowed = new Set(env.ACCESS_AUDS.split(",").map((aud) => aud.trim()));
    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!auds.some((aud) => aud !== undefined && allowed.has(aud))) return false;
    const key = (await accessSigningKeys(env.ACCESS_TEAM)).get(header.kid);
    if (key === undefined) return false;
    return crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      b64urlToBytes(signaturePart) as unknown as BufferSource,
      new TextEncoder().encode(`${headerPart}.${payloadPart}`),
    );
  } catch {
    return false;
  }
}

// Count every real network egress from this worker (module scope, so it
// survives DO soft-restarts). Replayed fetch effects that incorrectly
// re-fired would show up here.
const realFetch = globalThis.fetch.bind(globalThis);
let egressCount = 0;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  egressCount += 1;
  return realFetch(input, init);
}) as typeof fetch;

// ---------------------------------------------------------------------------
// Fake CRM: deterministic seed, persisted in DO storage so mutations survive
// restarts. Deep enough for real multi-step work: filter, aggregate, update,
// comment — and errors (unknown ids throw, which record and replay).

interface CrmCustomer {
  id: string;
  name: string;
  email: string;
  plan: "free" | "pro" | "enterprise";
  mrr: number;
  since: string;
}

interface CrmComment {
  author: string;
  text: string;
  at: string;
}

interface CrmTicket {
  id: string;
  customerId: string;
  subject: string;
  status: "open" | "pending" | "closed";
  priority: "low" | "normal" | "high" | "urgent";
  tags: string[];
  createdAt: string;
  updatedAt: string;
  comments: CrmComment[];
}

interface CrmData {
  customers: CrmCustomer[];
  tickets: CrmTicket[];
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedCrm(): CrmData {
  const rand = mulberry32(42);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)];
  const names = [
    "Astrid Larsen", "Bruno Costa", "Chidi Okafor", "Dana Whitfield", "Emil Novak",
    "Freya Lindqvist", "Gustavo Reyes", "Hana Sato", "Imre Farkas", "Jolene Baptiste",
    "Kwame Mensah", "Line Dahl",
  ];
  const companies = [
    "northwind", "acme-labs", "globex", "initech", "umbra", "hooli",
    "stark-tools", "wayline", "vandelay", "prestige", "oceanic", "soylent",
  ];
  const plans = ["free", "pro", "enterprise"] as const;
  const customers: CrmCustomer[] = names.map((name, i) => {
    const plan = plans[i % 3 === 0 ? 2 : i % 2];
    return {
      id: `cus_${String(i + 1).padStart(3, "0")}`,
      name,
      email: `${name.split(" ")[0].toLowerCase()}@${companies[i]}.example`,
      plan,
      mrr: plan === "enterprise" ? 1200 + Math.floor(rand() * 3800) : plan === "pro" ? 49 + Math.floor(rand() * 200) : 0,
      since: new Date(Date.UTC(2024, Math.floor(rand() * 24), 1 + Math.floor(rand() * 27))).toISOString().slice(0, 10),
    };
  });
  const subjects = [
    "Webhook deliveries intermittently failing", "Cannot rotate API key from dashboard",
    "Latency spike on eu-west requests", "Billing invoice shows duplicate line item",
    "SSO login loops back to sign-in page", "Rate limits hit far below documented ceiling",
    "Export job stuck at 99%", "Custom domain certificate not renewing",
    "Sandbox data leaked into production view", "Pagination cursor expires too quickly",
    "Audit log missing delete events", "Team member cannot accept invite",
    "Search indexing lags by hours", "Attachment uploads over 10MB rejected",
    "Timezone wrong in scheduled reports", "API returns 500 on empty tag filter",
    "Usage graph flatlines on weekends", "Password reset email never arrives",
    "Dark mode resets on every deploy", "CSV import silently drops rows",
  ];
  const statuses = ["open", "open", "open", "pending", "pending", "closed", "closed", "closed"] as const;
  const priorities = ["low", "normal", "normal", "normal", "high", "high", "urgent"] as const;
  const tagPool = ["api", "billing", "auth", "performance", "ui", "data", "email", "regression"];
  const authors = ["support-bot", "casey (support)", "morgan (support)", "customer"];
  const tickets: CrmTicket[] = subjects.concat(subjects).map((subject, i) => {
    const created = Date.UTC(2026, 3 + Math.floor(rand() * 5), 1 + Math.floor(rand() * 27), Math.floor(rand() * 24));
    const status = pick(statuses);
    const commentCount = Math.floor(rand() * 4);
    const comments: CrmComment[] = [];
    for (let c = 0; c < commentCount; c += 1) {
      comments.push({
        author: pick(authors),
        text: pick([
          "Reproduced on our side, escalating.",
          "Any update on this? It's blocking our launch.",
          "We shipped a partial fix — can you confirm?",
          "Logs attached from the affected window.",
          "This started after the last maintenance window.",
        ]),
        at: new Date(created + (c + 1) * 86_400_000 * rand()).toISOString(),
      });
    }
    return {
      id: `tik_${String(i + 1).padStart(3, "0")}`,
      customerId: pick(customers).id,
      subject: i >= subjects.length ? `${subject} (again)` : subject,
      status,
      priority: pick(priorities),
      tags: [...new Set([pick(tagPool), pick(tagPool)])],
      createdAt: new Date(created).toISOString(),
      updatedAt: new Date(created + 86_400_000 * rand() * 10).toISOString(),
      comments,
    };
  });
  return { customers, tickets };
}

// ---------------------------------------------------------------------------
// Billing: invoices derived from CRM customers, refunds persist. Overlapping
// customer ids with `crm` make cross-grant joins natural.

interface BillingInvoice {
  id: string;
  customerId: string;
  amountUsd: number;
  status: "paid" | "open" | "overdue" | "refunded";
  issuedAt: string;
  dueAt: string;
}

interface BillingRefund {
  id: string;
  invoiceId: string;
  amountUsd: number;
  reason: string;
  at: string;
}

interface BillingData {
  invoices: BillingInvoice[];
  refunds: BillingRefund[];
}

function seedBilling(customers: CrmCustomer[]): BillingData {
  const rand = mulberry32(7);
  const invoices: BillingInvoice[] = [];
  for (const customer of customers) {
    if (customer.mrr === 0) continue;
    for (const month of [6, 7, 8]) {
      const issued = Date.UTC(2026, month, 1);
      const overdue = rand() < (month === 8 ? 0.3 : 0.12);
      invoices.push({
        id: `inv_${String(invoices.length + 1).padStart(3, "0")}`,
        customerId: customer.id,
        amountUsd: customer.mrr,
        status: month < 8 ? (overdue ? "overdue" : "paid") : overdue ? "overdue" : "open",
        issuedAt: new Date(issued).toISOString().slice(0, 10),
        dueAt: new Date(issued + 14 * 86_400_000).toISOString().slice(0, 10),
      });
    }
  }
  return { invoices, refunds: [] };
}

// ---------------------------------------------------------------------------
// Telemetry: deterministic metrics + logs with a planted incident — eu-west
// API latency/error spike on 2026-09-09 14:00–16:30 UTC — matching the CRM
// ticket "Latency spike on eu-west requests". Read-only, so module scope.

const TIMELINE_START = Date.UTC(2026, 8, 8);
const TIMELINE_END = Date.UTC(2026, 8, 11);
const INCIDENT_START = Date.UTC(2026, 8, 9, 14, 0);
const INCIDENT_END = Date.UTC(2026, 8, 9, 16, 30);

interface MetricPoint {
  t: string;
  v: number;
}

interface LogEntry {
  t: string;
  service: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  requestId: string;
}

function buildTelemetry(): { series: Map<string, MetricPoint[]>; logs: LogEntry[] } {
  const rand = mulberry32(1337);
  const inIncident = (t: number): boolean => t >= INCIDENT_START && t <= INCIDENT_END;
  const specs: Array<{ name: string; base: number; jitter: number; incident?: (base: number) => number; decimals: number }> = [
    { name: "api-eu-west.p99_ms", base: 180, jitter: 30, incident: (b) => b * 12 + 400, decimals: 0 },
    { name: "api-eu-west.error_rate", base: 0.002, jitter: 0.001, incident: () => 0.09, decimals: 4 },
    { name: "api-us-east.p99_ms", base: 150, jitter: 25, decimals: 0 },
    { name: "api-us-east.error_rate", base: 0.001, jitter: 0.0008, decimals: 4 },
    { name: "worker-jobs.queue_depth", base: 40, jitter: 25, incident: (b) => b * 4, decimals: 0 },
    { name: "web.p99_ms", base: 320, jitter: 60, decimals: 0 },
  ];
  const series = new Map<string, MetricPoint[]>();
  for (const spec of specs) {
    const points: MetricPoint[] = [];
    for (let t = TIMELINE_START; t < TIMELINE_END; t += 3_600_000) {
      const base = spec.incident !== undefined && inIncident(t) ? spec.incident(spec.base) : spec.base;
      const v = Number((base + (rand() - 0.5) * 2 * spec.jitter).toFixed(spec.decimals));
      points.push({ t: new Date(t).toISOString(), v: Math.max(0, v) });
    }
    series.set(spec.name, points);
  }

  const logs: LogEntry[] = [];
  const rid = (): string => Array.from({ length: 8 }, () => "0123456789abcdef"[Math.floor(rand() * 16)]).join("");
  const services = ["api-eu-west", "api-us-east", "worker-jobs", "web"];
  const noise: Array<[LogEntry["level"], string]> = [
    ["info", "request completed"],
    ["info", "cache hit ratio 0.94"],
    ["debug", "connection pool: 210/512 in use"],
    ["info", "deploy healthcheck passed"],
    ["warn", "slow query: 820ms on tickets_by_customer"],
  ];
  const incidentErrors = [
    "upstream timeout after 2000ms (pool=eu-west-3)",
    "connection pool exhausted: 512/512 in use",
    "retry budget exceeded for /v1/search",
    "health check failed: origin latency 4318ms",
  ];
  for (let t = TIMELINE_START; t < TIMELINE_END; t += 3_600_000) {
    for (const service of services) {
      const lines = 1 + Math.floor(rand() * 2);
      for (let i = 0; i < lines; i += 1) {
        const [level, message] = noise[Math.floor(rand() * noise.length)];
        logs.push({ t: new Date(t + rand() * 3_600_000).toISOString(), service, level, message, requestId: rid() });
      }
      if (service === "api-eu-west" && inIncident(t)) {
        for (let i = 0; i < 6; i += 1) {
          logs.push({
            t: new Date(t + rand() * 3_600_000).toISOString(),
            service,
            level: "error",
            message: incidentErrors[Math.floor(rand() * incidentErrors.length)],
            requestId: rid(),
          });
        }
        logs.push({ t: new Date(t + rand() * 3_600_000).toISOString(), service, level: "warn", message: "p99 latency above SLO (2500ms > 500ms)", requestId: rid() });
      }
    }
  }
  logs.sort((a, b) => a.t.localeCompare(b.t));
  return { series, logs };
}

const TELEMETRY = buildTelemetry();

const TEAM_MEMBERS = [
  { name: "Priya Nair", email: "priya@acme.example", area: "api" },
  { name: "Tomás Silva", email: "tomas@acme.example", area: "web" },
  { name: "Ada Krogh", email: "ada@acme.example", area: "billing" },
  { name: "Lukas Meier", email: "lukas@acme.example", area: "infra" },
];

interface OutboxMessage {
  to: string;
  subject: string;
  body?: string;
  at: string;
}

function preview(value: unknown, max = 400): string {
  try {
    if (value === undefined) return "undefined";
    const json = JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? `${v}n` : v));
    return (json ?? String(value)).slice(0, max);
  } catch {
    return `[unserializable ${typeof value}]`;
  }
}

// bigint-safe JSON response (ReplExecutionResult.value may hold bigints).
function json(data: unknown, status = 200): Response {
  return new Response(
    JSON.stringify(data, (_k, v: unknown) => (typeof v === "bigint" ? `${v}n` : v)),
    { status, headers: { "content-type": "application/json" } },
  );
}

export class PlaygroundHostDO extends DurableObject<Env> {
  #workspace: Workspace | undefined;
  #counts: Record<string, number> = {};
  #crm: CrmData | undefined;
  #billing: BillingData | undefined;
  #outbox: OutboxMessage[] | undefined;

  #ws(): Workspace {
    this.#workspace ??= new Workspace({ storage: this.ctx.storage as never });
    return this.#workspace;
  }

  #sql(): SqlStorage {
    return (this.ctx.storage as unknown as { sql: SqlStorage }).sql;
  }

  #count(name: string): void {
    this.#counts[name] = (this.#counts[name] ?? 0) + 1;
  }

  async #data(): Promise<CrmData> {
    this.#crm ??= (await this.ctx.storage.get<CrmData>("crm-data")) ?? seedCrm();
    return this.#crm;
  }

  #saveCrm(): void {
    void this.ctx.storage.put("crm-data", this.#crm);
  }

  async #billingData(): Promise<BillingData> {
    this.#billing ??=
      (await this.ctx.storage.get<BillingData>("billing-data")) ?? seedBilling((await this.#data()).customers);
    return this.#billing;
  }

  #saveBilling(): void {
    void this.ctx.storage.put("billing-data", this.#billing);
  }

  async #mail(): Promise<OutboxMessage[]> {
    this.#outbox ??= (await this.ctx.storage.get<OutboxMessage[]>("outbox")) ?? [];
    return this.#outbox;
  }

  // Wrap a capability target so every method call bumps a live-call counter
  // before hitting the real implementation. `this` stays the underlying
  // object; plain-object children are wrapped recursively so nested paths
  // like crm.tickets.update count too.
  #counted<T extends object>(target: T, prefix: string): T {
    const self = this;
    const wrap = (obj: object, path: string): object => {
      return new Proxy(obj, {
        get(t, prop) {
          const value = Reflect.get(t, prop, t);
          if (typeof prop === "symbol") return value;
          if (typeof value === "function") {
            return (...args: unknown[]) => {
              self.#count(`${path}.${prop}`);
              return (value as (...a: unknown[]) => unknown).apply(t, args);
            };
          }
          if (
            value !== null &&
            typeof value === "object" &&
            Object.getPrototypeOf(value) === Object.prototype
          ) {
            return wrap(value, `${path}.${prop}`);
          }
          return value;
        },
        apply(t, _thisArg, args) {
          self.#count(path);
          return Reflect.apply(t as unknown as (...a: unknown[]) => unknown, t, args);
        },
      }) as object;
    };
    return wrap(target, prefix) as T;
  }

  async #capabilities(): Promise<Record<string, ReplCapability>> {
    const data = await this.#data();
    const outbox = await this.#mail();

    const byId = <T extends { id: string }>(rows: T[], id: string, kind: string): T => {
      const row = rows.find((r) => r.id === id);
      if (row === undefined) throw new Error(`No ${kind} with id ${JSON.stringify(id)}.`);
      return row;
    };

    const crmTarget = {
      customers: {
        list: () =>
          data.customers.map(({ id, name, plan, mrr }) => ({ id, name, plan, mrr })),
        get: (id: string) => byId(data.customers, id, "customer"),
      },
      tickets: {
        list: (filter?: { status?: string; priority?: string; customerId?: string }) =>
          data.tickets
            .filter(
              (t) =>
                (filter?.status === undefined || t.status === filter.status) &&
                (filter?.priority === undefined || t.priority === filter.priority) &&
                (filter?.customerId === undefined || t.customerId === filter.customerId),
            )
            .map(({ id, customerId, subject, status, priority, updatedAt }) => ({
              id, customerId, subject, status, priority, updatedAt,
            })),
        get: (id: string) => byId(data.tickets, id, "ticket"),
        update: (id: string, patch: { status?: CrmTicket["status"]; priority?: CrmTicket["priority"]; tags?: string[] }) => {
          const ticket = byId(data.tickets, id, "ticket");
          if (patch.status !== undefined) ticket.status = patch.status;
          if (patch.priority !== undefined) ticket.priority = patch.priority;
          if (patch.tags !== undefined) ticket.tags = patch.tags;
          ticket.updatedAt = new Date().toISOString();
          this.#saveCrm();
          return ticket;
        },
        comment: (id: string, text: string) => {
          const ticket = byId(data.tickets, id, "ticket");
          ticket.comments.push({ author: "agent", text, at: new Date().toISOString() });
          ticket.updatedAt = new Date().toISOString();
          this.#saveCrm();
          return ticket;
        },
        stats: () => {
          const byStatus: Record<string, number> = {};
          const byPriority: Record<string, number> = {};
          for (const t of data.tickets) {
            byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
            byPriority[t.priority] = (byPriority[t.priority] ?? 0) + 1;
          }
          return { total: data.tickets.length, byStatus, byPriority };
        },
      },
    };
    // Dotted doc keys address nested methods — help() supports them at
    // runtime; the CapabilityMeta type only models top-level methods, hence
    // the cast.
    const crmDocs = {
      "customers.list": "customers.list() → [{ id, name, plan, mrr }]",
      "customers.get": "customers.get(id) → full customer record",
      "tickets.list": "tickets.list({ status?, priority?, customerId? }) → ticket summaries",
      "tickets.get": "tickets.get(id) → full ticket, including comments",
      "tickets.update": "tickets.update(id, { status?, priority?, tags? }) → updated ticket",
      "tickets.comment": "tickets.comment(id, text) → ticket after appending your comment",
      "tickets.stats": "tickets.stats() → { total, byStatus, byPriority }",
    } as CapabilityMeta<typeof crmTarget>["docs"];

    // Counting happens in the #counted proxy — not here too.
    const billingData = await this.#billingData();
    const billingTarget = {
      invoices: {
        list: (filter?: { customerId?: string; status?: BillingInvoice["status"] }) =>
          billingData.invoices.filter(
            (inv) =>
              (filter?.customerId === undefined || inv.customerId === filter.customerId) &&
              (filter?.status === undefined || inv.status === filter.status),
          ),
        get: (id: string) => byId(billingData.invoices, id, "invoice"),
      },
      refunds: {
        create: (invoiceId: string, reason: string, amountUsd?: number) => {
          const invoice = byId(billingData.invoices, invoiceId, "invoice");
          if (invoice.status === "refunded") throw new Error(`Invoice ${invoiceId} is already refunded.`);
          const amount = amountUsd ?? invoice.amountUsd;
          if (amount <= 0 || amount > invoice.amountUsd) {
            throw new Error(`Refund amount must be between 0 and ${invoice.amountUsd} (invoice total).`);
          }
          invoice.status = "refunded";
          const refund: BillingRefund = {
            id: `ref_${String(billingData.refunds.length + 1).padStart(3, "0")}`,
            invoiceId,
            amountUsd: amount,
            reason,
            at: new Date().toISOString(),
          };
          billingData.refunds.push(refund);
          this.#saveBilling();
          return refund;
        },
        list: () => billingData.refunds,
      },
      revenue: {
        summary: () => {
          const byPlanCustomer = new Map<string, number>();
          let paid = 0;
          let outstanding = 0;
          let overdueCount = 0;
          for (const inv of billingData.invoices) {
            if (inv.status === "paid") paid += inv.amountUsd;
            if (inv.status === "open" || inv.status === "overdue") outstanding += inv.amountUsd;
            if (inv.status === "overdue") overdueCount += 1;
            byPlanCustomer.set(inv.customerId, (byPlanCustomer.get(inv.customerId) ?? 0) + inv.amountUsd);
          }
          return { totalPaidUsd: paid, outstandingUsd: outstanding, overdueCount, invoices: billingData.invoices.length };
        },
      },
    };
    const billingDocs = {
      "invoices.list": "invoices.list({ customerId?, status? }) → invoices; status: paid | open | overdue | refunded",
      "invoices.get": "invoices.get(id) → one invoice",
      "refunds.create": "refunds.create(invoiceId, reason, amountUsd?) → refund record; marks the invoice refunded",
      "refunds.list": "refunds.list() → refunds issued so far",
      "revenue.summary": "revenue.summary() → { totalPaidUsd, outstandingUsd, overdueCount, invoices }",
    } as CapabilityMeta<typeof billingTarget>["docs"];

    const metricsTarget = {
      names: () => [...TELEMETRY.series.keys()],
      query: (name: string, range?: { from?: string; to?: string }) => {
        const points = TELEMETRY.series.get(name);
        if (points === undefined) {
          throw new Error(`Unknown series ${JSON.stringify(name)}. Known: ${[...TELEMETRY.series.keys()].join(", ")}`);
        }
        const from = range?.from ?? "";
        const to = range?.to ?? "\uffff";
        return { name, points: points.filter((p) => p.t >= from && p.t <= to) };
      },
    };
    const metricsDocs = {
      names: "names() → available series names",
      query: 'query(name, { from?, to? }) → { name, points: [{ t, v }] }; hourly points, ISO timestamps, 3-day window',
    } as CapabilityMeta<typeof metricsTarget>["docs"];

    const logsTarget = {
      services: () => [...new Set(TELEMETRY.logs.map((l) => l.service))],
      search: (filter?: { service?: string; level?: LogEntry["level"]; q?: string; from?: string; to?: string; limit?: number }) => {
        const limit = Math.min(filter?.limit ?? 20, 200);
        const q = filter?.q?.toLowerCase();
        const matches = TELEMETRY.logs.filter(
          (l) =>
            (filter?.service === undefined || l.service === filter.service) &&
            (filter?.level === undefined || l.level === filter.level) &&
            (filter?.from === undefined || l.t >= filter.from) &&
            (filter?.to === undefined || l.t <= filter.to) &&
            (q === undefined || l.message.toLowerCase().includes(q)),
        );
        return { total: matches.length, entries: matches.slice(0, limit) };
      },
    };
    const logsDocs = {
      services: "services() → service names",
      search: "search({ service?, level?, q?, from?, to?, limit? }) → { total, entries } chronological; limit ≤ 200 (default 20)",
    } as CapabilityMeta<typeof logsTarget>["docs"];

    const teamTarget = {
      members: TEAM_MEMBERS,
      oncall: (area: string) => {
        const member = TEAM_MEMBERS.find((m) => m.area === area);
        if (member === undefined) {
          throw new Error(`No on-call for area ${JSON.stringify(area)}. Areas: ${TEAM_MEMBERS.map((m) => m.area).join(", ")}`);
        }
        return member;
      },
    };
    const teamDocs = {
      oncall: "oncall(area) → { name, email, area }; members is a plain data snapshot",
    } as CapabilityMeta<typeof teamTarget>["docs"];

    const sendNotification = (to: string, subject: string, body?: string) => {
      const message: OutboxMessage = { to, subject, body, at: new Date().toISOString() };
      outbox.push(message);
      void this.ctx.storage.put("outbox", outbox);
      return { sent: true, id: `msg_${String(outbox.length).padStart(3, "0")}` };
    };

    const fs = workspaceFs(this.#ws() as never);
    const fetchCap = fetchCapability({
      allow: ["example.com", "www.example.com", "api.github.com", "jsonplaceholder.typicode.com"],
    });

    return {
      crm: capability(this.#counted(crmTarget, "crm"), {
        description: "Acme support CRM: customers and support tickets (shared live data — updates persist)",
        docs: crmDocs,
      }),
      billing: capability(this.#counted(billingTarget, "billing"), {
        description: "Acme billing: invoices per CRM customer, refunds (persist), revenue summary",
        docs: billingDocs,
      }),
      metrics: capability(this.#counted(metricsTarget, "metrics"), {
        description: "Service metrics (p99 latency, error rate, queue depth) — hourly series, 2026-09-08 → 2026-09-11 UTC",
        docs: metricsDocs,
      }),
      logs: capability(this.#counted(logsTarget, "logs"), {
        description: "Searchable service logs for the same 3-day window as metrics",
        docs: logsDocs,
      }),
      team: capability(this.#counted(teamTarget, "team"), {
        description: "Engineering roster: members data + on-call lookup by area",
        docs: teamDocs,
      }),
      notify: capability(this.#counted(sendNotification, "notify"), {
        description: "notify(to, subject, body?) — send a notification email to a recipient",
      }),
      fs: capability(this.#counted(fs.target as object, "fs"), fs.meta as never),
      fetch: capability(this.#counted(fetchCap.target as object, "fetch"), fetchCap.meta as never),
    } as Record<string, ReplCapability>;
  }

  async #tool() {
    return createJsToolDefinition({
      workspace: this.#ws() as never,
      loader: this.env.LOADER as never,
      capabilities: (await this.#capabilities()) as never,
      timeoutMs: 30_000,
    });
  }

  async toolInfo(): Promise<Record<string, unknown>> {
    const tool = await this.#tool();
    return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
  }

  async evalCell(code: string, sessionName?: string): Promise<Record<string, unknown>> {
    const tool = await this.#tool();
    const started = Date.now();
    let result: ReplExecutionResult;
    try {
      result = await tool.run({ code, ...(sessionName === undefined ? {} : { sessionName }) });
    } catch (error) {
      // Caller mistakes (non-string code etc.) — everything else returns
      // structured on the result.
      const err = error as Error;
      return { ok: false, callerError: `${err.name}: ${err.message}`, ms: Date.now() - started };
    }
    return {
      ok: result.error === undefined,
      session: sessionName ?? "main",
      ms: Date.now() - started,
      executionCount: result.executionCount,
      value: "value" in result ? result.value : undefined,
      valuePreview: preview(result.value),
      rendered: renderJsResultText(result),
      results: result.results,
      logs: result.logs,
      error: result.error,
      counts: { ...this.#counts, egress: egressCount },
    };
  }

  sessions(): Array<Record<string, unknown>> {
    try {
      return this.#sql()
        .exec(
          "SELECT session, COUNT(*) AS cells, MAX(created_at) AS lastActivity FROM repl_cells GROUP BY session ORDER BY lastActivity DESC",
        )
        .toArray()
        .map((row) => ({
          session: row.session,
          cells: row.cells,
          lastActivity: new Date(Number(row.lastActivity)).toISOString(),
        }));
    } catch {
      return []; // no cells committed yet — table doesn't exist
    }
  }

  history(session: string, includeEffects: boolean): Record<string, unknown> {
    let cells: Array<Record<string, unknown>>;
    try {
      cells = this.#sql()
        .exec("SELECT seq, code, grants, created_at FROM repl_cells WHERE session = ? ORDER BY seq", session)
        .toArray()
        .map((row) => ({
          seq: row.seq,
          code: row.code,
          grants: Object.keys(JSON.parse(String(row.grants)) as Record<string, unknown>),
          at: new Date(Number(row.created_at)).toISOString(),
        }));
    } catch {
      return { session, cells: [] };
    }
    if (includeEffects) {
      const effects = this.#sql()
        .exec(
          "SELECT cell_seq, call_seq, kind, value FROM repl_effects WHERE session = ? ORDER BY cell_seq, call_seq",
          session,
        )
        .toArray()
        .map((row) => ({
          cell: row.cell_seq,
          call: row.call_seq,
          kind: row.kind,
          value: String(row.value).slice(0, 500),
        }));
      return { session, cells, effects };
    }
    return { session, cells };
  }

  async counts(): Promise<Record<string, number>> {
    return { ...this.#counts, egress: egressCount, outbox: (await this.#mail()).length };
  }

  async outbox(): Promise<OutboxMessage[]> {
    return this.#mail();
  }

  // Simulated DO eviction: in-memory state dies, storage survives. The next
  // eval reloads sessions from SQLite and replays. Live handles held by
  // sessions go stale — exactly like production.
  restart(): { restarted: true } {
    this.#workspace = undefined;
    return { restarted: true };
  }

  // Full wipe: sessions, workspace files, CRM mutations, outbox, counters.
  async reset(): Promise<{ reset: true }> {
    this.#workspace = undefined;
    this.#crm = undefined;
    this.#billing = undefined;
    this.#outbox = undefined;
    this.#counts = {};
    await this.ctx.storage.deleteAll();
    return { reset: true };
  }
}

// ---------------------------------------------------------------------------
// Human-readable grant reference for the sidebar (/grants). Hand-written to
// read like .d.ts — the in-session help() derives the same surface by
// reflection, this is the curated human view.

const GRANT_DECLS: Array<{ name: string; description: string; decl: string; example: string }> = [
  {
    name: "crm",
    description: "Acme support CRM. Shared live data — updates persist across sessions and restarts.",
    decl: `declare const crm: {
  customers: {
    list(): Promise<Array<{ id: string; name: string; plan: "free" | "pro" | "enterprise"; mrr: number }>>;
    get(id: string): Promise<Customer>;              // throws on unknown id
  };
  tickets: {
    list(filter?: { status?: "open" | "pending" | "closed";
                    priority?: "low" | "normal" | "high" | "urgent";
                    customerId?: string }): Promise<TicketSummary[]>;
    get(id: string): Promise<Ticket>;                // full record incl. comments
    update(id: string, patch: { status?; priority?; tags? }): Promise<Ticket>;
    comment(id: string, text: string): Promise<Ticket>;
    stats(): Promise<{ total: number; byStatus: {}; byPriority: {} }>;
  };
};`,
    example: 'const urgent = (await crm.tickets.list({ status: "open" })).filter(t => t.priority === "urgent")',
  },
  {
    name: "billing",
    description: "Invoices per CRM customer (same customer ids — join them). Refunds persist.",
    decl: `declare const billing: {
  invoices: {
    list(filter?: { customerId?: string;
                    status?: "paid" | "open" | "overdue" | "refunded" }): Promise<Invoice[]>;
    get(id: string): Promise<Invoice>;
  };
  refunds: {
    create(invoiceId: string, reason: string, amountUsd?: number): Promise<Refund>;
    list(): Promise<Refund[]>;
  };
  revenue: {
    summary(): Promise<{ totalPaidUsd: number; outstandingUsd: number; overdueCount: number; invoices: number }>;
  };
};`,
    example: 'await billing.invoices.list({ status: "overdue" })',
  },
  {
    name: "metrics",
    description: "Hourly service metrics, 2026-09-08 → 2026-09-11 UTC. Something interesting happened to eu-west on the 9th…",
    decl: `declare const metrics: {
  names(): Promise<string[]>;   // e.g. "api-eu-west.p99_ms", "api-eu-west.error_rate",
                                //      "worker-jobs.queue_depth", "web.p99_ms"
  query(name: string, range?: { from?: string; to?: string }):
    Promise<{ name: string; points: Array<{ t: string; v: number }> }>;
};`,
    example: 'const spikes = (await metrics.query("api-eu-west.p99_ms")).points.filter(p => p.v > 1000)',
  },
  {
    name: "logs",
    description: "Searchable service logs covering the same 3-day window as metrics.",
    decl: `declare const logs: {
  services(): Promise<string[]>;
  search(filter?: { service?: string; level?: "debug" | "info" | "warn" | "error";
                    q?: string;          // substring match on message
                    from?: string; to?: string;   // ISO timestamps
                    limit?: number }     // default 20, max 200
  ): Promise<{ total: number; entries: Array<{ t; service; level; message; requestId }> }>;
};`,
    example: 'await logs.search({ service: "api-eu-west", level: "error", limit: 5 })',
  },
  {
    name: "team",
    description: "Engineering roster. `members` is plain data — snapshotted into your cell, no call needed.",
    decl: `declare const team: {
  members: Array<{ name: string; email: string; area: string }>;  // data snapshot
  oncall(area: "api" | "web" | "billing" | "infra"): Promise<{ name; email; area }>;
};`,
    example: 'await team.oncall("api")',
  },
  {
    name: "notify",
    description: "Send a notification email. Messages land in the outbox (button above) — nothing real is sent.",
    decl: `declare function notify(to: string, subject: string, body?: string):
  Promise<{ sent: true; id: string }>;`,
    example: 'await notify((await team.oncall("api")).email, "eu-west latency incident", "summary at /incident.md")',
  },
  {
    name: "fs",
    description: "Workspace filesystem — durable files, shared across sessions in this workspace.",
    decl: `declare const fs: {
  readFile(path: string): Promise<string>;
  readFileBytes(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  readdir(path: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;     // recursive
  rm(path: string): Promise<void>;
  stat(path: string): Promise<{ type: "file" | "dir"; size: number }>;
};`,
    example: 'await fs.writeFile("/incident.md", report); await fs.readdir("/")',
  },
  {
    name: "fetch",
    description: "HTTP fetch, allowlisted hosts only — anything else throws EgressDeniedError.",
    decl: `declare function fetch(url: string, init?: { method?; headers?; body? }): Promise<{
  status: number; ok: boolean; statusText: string; url: string;
  headers: Record<string, string>;
  text(): Promise<string>;    // repeatable
  json(): Promise<unknown>;
}>;
// allowed: example.com, www.example.com, api.github.com, jsonplaceholder.typicode.com`,
    example: 'const repo = await (await fetch("https://api.github.com/repos/cloudflare/workerd")).json()',
  },
];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true, worker: "repl-playground" });

    const auth = request.headers.get("authorization");
    const accessJwt = request.headers.get("cf-access-jwt-assertion");
    const authorized =
      (Boolean(env.PLAYGROUND_TOKEN) && auth === `Bearer ${env.PLAYGROUND_TOKEN}`) ||
      (accessJwt !== null && (await verifyAccessJwt(accessJwt, env)));
    if (!authorized) return json({ error: "unauthorized" }, 401);

    if (url.pathname === "/" && request.method === "GET") {
      return new Response(PLAYGROUND_PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (url.pathname === "/grants") return json({ grants: GRANT_DECLS });

    const body: Record<string, unknown> =
      request.method === "POST" ? ((await request.json()) as Record<string, unknown>) : {};
    const ws = String(body.ws ?? url.searchParams.get("ws") ?? "default");
    const stub = env.HOST.get(env.HOST.idFromName(ws));

    try {
      if (url.pathname === "/tool") return json({ ws, ...((await stub.toolInfo()) as Record<string, unknown>) });
      if (url.pathname === "/eval" && request.method === "POST") {
        if (typeof body.code !== "string") return json({ error: "`code` (string) is required" }, 400);
        const sessionName = body.sessionName === undefined ? undefined : String(body.sessionName);
        return json({ ws, ...((await stub.evalCell(body.code, sessionName)) as Record<string, unknown>) });
      }
      if (url.pathname === "/sessions") return json({ ws, sessions: await stub.sessions() });
      if (url.pathname === "/history") {
        const session = url.searchParams.get("session") ?? "main";
        const includeEffects = url.searchParams.get("effects") === "1";
        return json({ ws, ...((await stub.history(session, includeEffects)) as Record<string, unknown>) });
      }
      if (url.pathname === "/counts") return json({ ws, counts: await stub.counts() });
      if (url.pathname === "/outbox") return json({ ws, outbox: await stub.outbox() });
      if (url.pathname === "/restart" && request.method === "POST") return json({ ws, ...(await stub.restart()) });
      if (url.pathname === "/reset" && request.method === "POST") return json({ ws, ...(await stub.reset()) });
      return json({ error: "not found" }, 404);
    } catch (error) {
      const err = error as Error;
      return json({ error: err.message, stack: err.stack?.slice(0, 1000) }, 500);
    }
  },
};
