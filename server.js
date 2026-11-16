const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, "data");
const UPLOAD_DIR = path.join(ROOT_DIR, "uploads");
const DB_FILE = path.join(DATA_DIR, "courses.json");
const RAG_FILE = path.join(DATA_DIR, "rag-materials.json");
const PORT = Number(process.env.PORT || 3000);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".hwp": "application/x-hwp",
  ".zip": "application/zip"
};

function ensureStorage() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ courses: [] }, null, 2), "utf8");
  }
  if (!fs.existsSync(RAG_FILE)) {
    fs.writeFileSync(RAG_FILE, JSON.stringify({ materials: [] }, null, 2), "utf8");
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function readBody(req, limitBytes = 50 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error("요청 본문이 너무 큽니다."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sanitizeFileName(fileName) {
  const parsed = path.parse(fileName || "upload.bin");
  const base = parsed.name.replace(/[^\w가-힣.-]+/g, "_").slice(0, 80) || "upload";
  const ext = parsed.ext.replace(/[^\w.]+/g, "").slice(0, 16);
  return `${base}${ext}`;
}

function parseMultipart(buffer, contentType) {
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) throw new Error("multipart boundary를 찾을 수 없습니다.");

  const boundary = Buffer.from(`--${boundaryMatch[1] || boundaryMatch[2]}`);
  const parts = [];
  let start = buffer.indexOf(boundary);

  while (start !== -1) {
    start += boundary.length;
    if (buffer[start] === 45 && buffer[start + 1] === 45) break;
    if (buffer[start] === 13 && buffer[start + 1] === 10) start += 2;

    const headerEnd = buffer.indexOf(Buffer.from("\r\n\r\n"), start);
    if (headerEnd === -1) break;

    const headerText = buffer.slice(start, headerEnd).toString("utf8");
    let bodyStart = headerEnd + 4;
    let nextBoundary = buffer.indexOf(boundary, bodyStart);
    if (nextBoundary === -1) break;

    let bodyEnd = nextBoundary;
    if (buffer[bodyEnd - 2] === 13 && buffer[bodyEnd - 1] === 10) bodyEnd -= 2;

    const disposition = headerText.match(/content-disposition:\s*form-data;([^\r\n]+)/i);
    const name = disposition?.[1].match(/name="([^"]+)"/i)?.[1];
    const filename = disposition?.[1].match(/filename="([^"]*)"/i)?.[1];
    const type = headerText.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim() || "application/octet-stream";

    parts.push({ name, filename, type, data: buffer.slice(bodyStart, bodyEnd) });
    start = nextBoundary;
  }

  return parts;
}

function readRagDb() {
  const db = JSON.parse(fs.readFileSync(RAG_FILE, "utf8"));
  return { materials: Array.isArray(db.materials) ? db.materials : [] };
}

function writeRagDb(db) {
  fs.writeFileSync(RAG_FILE, JSON.stringify({ ...db, updatedAt: new Date().toISOString() }, null, 2), "utf8");
}

function normalizeText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function tokenize(text) {
  const normalized = normalizeText(text).toLowerCase();
  const wordTokens = normalized.match(/[a-z0-9가-힣]{2,}/g) || [];
  const koCompact = normalized.replace(/[^가-힣]/g, "");
  const koBigrams = [];

  for (let i = 0; i < koCompact.length - 1; i += 1) {
    koBigrams.push(koCompact.slice(i, i + 2));
  }

  return [...new Set([...wordTokens, ...koBigrams])];
}

function chunkText(text, size = 900, overlap = 160) {
  const compact = normalizeText(text);
  if (!compact) return [];

  const chunks = [];
  let start = 0;

  while (start < compact.length) {
    const end = Math.min(start + size, compact.length);
    chunks.push(compact.slice(start, end));
    if (end === compact.length) break;
    start = Math.max(0, end - overlap);
  }

  return chunks;
}

function buildMaterial({ courseId, title, sourceName, text, file }) {
  const cleanedText = normalizeText(text);
  const chunks = chunkText(cleanedText).map((content, index) => ({
    id: `chunk-${index + 1}`,
    index,
    content,
    tokens: tokenize(content)
  }));

  return {
    id: `rag-${Date.now()}-${crypto.randomUUID()}`,
    courseId,
    title: title || sourceName || "교수자 자료",
    sourceName: sourceName || title || "직접 입력",
    file: file || null,
    length: cleanedText.length,
    chunkCount: chunks.length,
    chunks,
    createdAt: new Date().toISOString()
  };
}

function searchRag(courseId, query, limit = 5) {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  const queryTokenSet = new Set(queryTokens);
  const db = readRagDb();
  const scored = [];

  db.materials
    .filter((material) => material.courseId === courseId)
    .forEach((material) => {
      material.chunks.forEach((chunk) => {
        const matches = chunk.tokens.filter((token) => queryTokenSet.has(token));
        const score = matches.length / Math.sqrt(Math.max(chunk.tokens.length, 1));
        if (score > 0) {
          scored.push({
            materialId: material.id,
            title: material.title,
            sourceName: material.sourceName,
            file: material.file,
            chunkId: chunk.id,
            chunkIndex: chunk.index,
            score,
            matchedTerms: [...new Set(matches)].slice(0, 8),
            content: chunk.content
          });
        }
      });
    });

  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

function serveStatic(req, res) {
  const requestPath = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname);
  const normalized = requestPath === "/" ? "/index.html" : requestPath;
  const filePath = path.resolve(ROOT_DIR, `.${normalized}`);

  if (!filePath.startsWith(ROOT_DIR)) {
    sendJson(res, 403, { error: "접근할 수 없는 경로입니다." });
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      sendJson(res, 404, { error: "파일을 찾을 수 없습니다." });
      return;
    }
    res.writeHead(200, { "Content-Type": MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream" });
    res.end(content);
  });
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/api/health" && req.method === "GET") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (url.pathname === "/api/courses" && req.method === "GET") {
    const db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    sendJson(res, 200, { courses: Array.isArray(db.courses) ? db.courses : [] });
    return;
  }

  if (url.pathname === "/api/courses" && req.method === "PUT") {
    const body = await readBody(req);
    const payload = JSON.parse(body.toString("utf8") || "{}");
    if (!Array.isArray(payload.courses)) {
      sendJson(res, 400, { error: "courses 배열이 필요합니다." });
      return;
    }
    fs.writeFileSync(DB_FILE, JSON.stringify({ courses: payload.courses, updatedAt: new Date().toISOString() }, null, 2), "utf8");
    sendJson(res, 200, { ok: true, count: payload.courses.length });
    return;
  }

  if (url.pathname === "/api/uploads" && req.method === "POST") {
    const contentType = req.headers["content-type"] || "";
    const body = await readBody(req);
    const parts = parseMultipart(body, contentType);
    const filePart = parts.find((part) => part.filename);
    if (!filePart) {
      sendJson(res, 400, { error: "업로드 파일이 필요합니다." });
      return;
    }

    const originalName = sanitizeFileName(filePart.filename);
    const savedName = `${Date.now()}-${crypto.randomUUID()}-${originalName}`;
    const savedPath = path.join(UPLOAD_DIR, savedName);
    fs.writeFileSync(savedPath, filePart.data);

    sendJson(res, 201, {
      file: {
        originalName,
        savedName,
        size: filePart.data.length,
        type: filePart.type,
        url: `/uploads/${encodeURIComponent(savedName)}`,
        uploadedAt: new Date().toISOString()
      }
    });
    return;
  }

  if (url.pathname === "/api/rag/materials" && req.method === "GET") {
    const courseId = url.searchParams.get("courseId");
    const db = readRagDb();
    const materials = db.materials
      .filter((material) => !courseId || material.courseId === courseId)
      .map(({ chunks, ...material }) => material);

    sendJson(res, 200, { materials });
    return;
  }

  if (url.pathname === "/api/rag/materials" && req.method === "POST") {
    const body = await readBody(req);
    const payload = JSON.parse(body.toString("utf8") || "{}");
    if (!payload.courseId || !payload.text) {
      sendJson(res, 400, { error: "courseId와 text가 필요합니다." });
      return;
    }

    const material = buildMaterial(payload);
    if (material.chunkCount === 0) {
      sendJson(res, 400, { error: "색인할 텍스트가 없습니다." });
      return;
    }

    const db = readRagDb();
    db.materials.push(material);
    writeRagDb(db);

    const { chunks, ...summary } = material;
    sendJson(res, 201, { material: summary });
    return;
  }

  if (url.pathname === "/api/rag/search" && req.method === "POST") {
    const body = await readBody(req);
    const payload = JSON.parse(body.toString("utf8") || "{}");
    if (!payload.courseId || !payload.query) {
      sendJson(res, 400, { error: "courseId와 query가 필요합니다." });
      return;
    }

    sendJson(res, 200, {
      results: searchRag(payload.courseId, payload.query, Number(payload.limit || 5))
    });
    return;
  }

  sendJson(res, 404, { error: "API 경로를 찾을 수 없습니다." });
}

ensureStorage();

http.createServer((req, res) => {
  if (req.url.startsWith("/api/")) {
    handleApi(req, res).catch((error) => sendJson(res, 500, { error: error.message }));
    return;
  }
  serveStatic(req, res);
}).listen(PORT, () => {
  console.log(`AI EdTech backend: http://localhost:${PORT}`);
});
