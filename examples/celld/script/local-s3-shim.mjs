#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve, sep } from "node:path";

const args = new Map(process.argv.slice(2).map((arg, i, all) => [arg, all[i + 1]]));
const root = resolve(args.get("--root") || process.env.LOCAL_S3_ROOT || ".celld-s3");
const port = Number(args.get("--port") || process.env.PORT || 9000);
const host = args.get("--host") || process.env.HOST || "127.0.0.1";

await mkdir(root, { recursive: true });

const server = createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (error) {
    console.error(error);
    sendError(res, 500, "InternalError", error instanceof Error ? error.message : String(error));
  }
});

server.listen(port, host, () => {
  console.log(`local S3 shim listening on http://${host}:${port} (root ${root})`);
});

async function route(req, res) {
  const url = new URL(req.url ?? "/", `http://${req.headers.host || `${host}:${port}`}`);
  const [bucket, ...keyParts] = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

  if (!bucket) {
    return xml(res, 200, `<ListAllMyBucketsResult><Buckets></Buckets></ListAllMyBucketsResult>`);
  }

  if (keyParts.length === 0) {
    if (req.method === "HEAD") return empty(res, 200);
    if (
      req.method === "GET" &&
      (url.searchParams.has("list-type") || url.searchParams.has("prefix"))
    ) {
      return listBucket(res, bucket, url.searchParams.get("prefix") || "");
    }
    if (req.method === "GET")
      return xml(res, 200, `<ListBucketResult><Name>${esc(bucket)}</Name></ListBucketResult>`);
  }

  const key = keyParts.join("/");
  if (!key || key.includes("..")) return sendError(res, 400, "InvalidKey", "invalid key");

  if (req.method === "PUT") return putObject(req, res, bucket, key);
  if (req.method === "GET") return getObject(res, bucket, key, false);
  if (req.method === "HEAD") return getObject(res, bucket, key, true);
  if (req.method === "DELETE") return deleteObject(res, bucket, key);

  res.setHeader("allow", "GET, HEAD, PUT, DELETE");
  sendError(res, 405, "MethodNotAllowed", "method not allowed");
}

async function putObject(req, res, bucket, key) {
  const body = await readRequest(req);
  const file = objectPath(bucket, key);
  const metaFile = `${file}.meta.json`;
  const current = await objectMeta(file).catch(() => null);

  const ifNoneMatch = req.headers["if-none-match"];
  if (ifNoneMatch === "*" && current)
    return sendError(res, 412, "PreconditionFailed", "object exists");

  const ifMatch = req.headers["if-match"];
  if (ifMatch && (!current || stripQuotes(ifMatch) !== stripQuotes(current.etag))) {
    return sendError(res, 412, "PreconditionFailed", "etag mismatch");
  }

  const etag = `"${createHash("md5").update(body).digest("hex")}"`;
  const metadata = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (name.startsWith("x-amz-meta-")) metadata[name.slice("x-amz-meta-".length)] = String(value);
  }

  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, body);
  await writeFile(metaFile, JSON.stringify({ etag, metadata, mtime: Date.now() }));
  res.setHeader("etag", etag);
  empty(res, 200);
}

async function getObject(res, bucket, key, headOnly) {
  const file = objectPath(bucket, key);
  const meta = await objectMeta(file).catch(() => null);
  if (!meta) return sendError(res, 404, "NoSuchKey", "not found");
  const s = await stat(file);
  res.statusCode = 200;
  res.setHeader("content-length", String(s.size));
  res.setHeader("etag", meta.etag);
  res.setHeader("last-modified", s.mtime.toUTCString());
  for (const [name, value] of Object.entries(meta.metadata || {})) {
    res.setHeader(`x-amz-meta-${name}`, String(value));
  }
  if (headOnly) return res.end();
  res.end(await readFile(file));
}

async function deleteObject(res, bucket, key) {
  const file = objectPath(bucket, key);
  await rm(file, { force: true });
  await rm(`${file}.meta.json`, { force: true });
  empty(res, 204);
}

async function listBucket(res, bucket, prefix) {
  const bucketRoot = safeJoin(root, bucket);
  await mkdir(bucketRoot, { recursive: true });
  const keys = [];
  await walk(bucketRoot, async (file) => {
    if (file.endsWith(".meta.json")) return;
    const key = file
      .slice(bucketRoot.length + 1)
      .split(sep)
      .join("/");
    if (key.startsWith(prefix)) keys.push(key);
  });
  keys.sort();
  const contents = await Promise.all(
    keys.map(async (key) => {
      const file = objectPath(bucket, key);
      const [s, meta] = await Promise.all([stat(file), objectMeta(file)]);
      return [
        "<Contents>",
        `<Key>${esc(key)}</Key>`,
        `<LastModified>${s.mtime.toISOString()}</LastModified>`,
        `<ETag>${esc(meta.etag)}</ETag>`,
        `<Size>${s.size}</Size>`,
        "<StorageClass>STANDARD</StorageClass>",
        "</Contents>",
      ].join("");
    }),
  );
  xml(
    res,
    200,
    [
      '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">',
      `<Name>${esc(bucket)}</Name>`,
      `<Prefix>${esc(prefix)}</Prefix>`,
      "<KeyCount>",
      String(keys.length),
      "</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>",
      ...contents,
      "</ListBucketResult>",
    ].join(""),
  );
}

async function objectMeta(file) {
  const s = await stat(file);
  const metaFile = `${file}.meta.json`;
  try {
    return JSON.parse(await readFile(metaFile, "utf8"));
  } catch {
    const body = await readFile(file);
    return {
      etag: `"${createHash("md5").update(body).digest("hex")}"`,
      metadata: {},
      mtime: s.mtimeMs,
    };
  }
}

function objectPath(bucket, key) {
  return safeJoin(safeJoin(root, bucket), key);
}

function safeJoin(base, child) {
  const out = resolve(base, child);
  const normalizedBase = resolve(base);
  if (out !== normalizedBase && !out.startsWith(`${normalizedBase}${sep}`)) {
    throw new Error(`path escape: ${child}`);
  }
  return out;
}

async function walk(dir, visit) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path, visit);
    else if (entry.isFile()) await visit(path);
  }
}

function readRequest(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function empty(res, status) {
  res.statusCode = status;
  res.end();
}

function xml(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/xml");
  res.end(body);
}

function sendError(res, status, code, message) {
  xml(res, status, `<Error><Code>${esc(code)}</Code><Message>${esc(message)}</Message></Error>`);
}

function stripQuotes(value) {
  return String(value).replace(/^W\//, "").replace(/^"|"$/g, "");
}

function esc(value) {
  return String(value).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
}
