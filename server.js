const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Av98012@12";
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "database");
const DB_FILE = path.join(DATA_DIR, "db.json");
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const SUPABASE_STATE_KEY = "main";
const sessions = new Set();
let supabase = null;
let supabaseAttempted = false;

const defaultDB = {
  rooms: { pending: [], approved: [], taken: [], declined: [], removed: [] },
  reviews: { pending: [], approved: [], declined: [] },
  reports: { pending: [], approved: [], declined: [] },
  transports: { pending: [], approved: [], declined: [], removed: [] },
  transportRequests: { pending: [], contacted: [], declined: [] },
  receipts: [],
  visitors: {},
  settings: { driveFolder: "" }
};

function normalizeDB(db) {
  db = db || {};
  db.rooms = { ...defaultDB.rooms, ...(db.rooms || {}) };
  db.reviews = { ...defaultDB.reviews, ...(db.reviews || {}) };
  db.reports = { ...defaultDB.reports, ...(db.reports || {}) };
  db.transports = { ...defaultDB.transports, ...(db.transports || {}) };
  db.transportRequests = { ...defaultDB.transportRequests, ...(db.transportRequests || {}) };
  db.receipts = Array.isArray(db.receipts) ? db.receipts : [];
  db.visitors = { ...defaultDB.visitors, ...(db.visitors || {}) };
  db.settings = { ...defaultDB.settings, ...(db.settings || {}) };
  return db;
}

function getSupabase() {
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) return null;
  if (supabaseAttempted) return supabase;
  supabaseAttempted = true;
  try {
    const { createClient } = require("@supabase/supabase-js");
    supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
  } catch (error) {
    console.warn("Supabase is configured but @supabase/supabase-js is not installed. Falling back to local db.json.");
  }
  return supabase;
}

function ensureDB() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) writeLocalDB(defaultDB);
}

function readLocalDB() {
  ensureDB();
  return normalizeDB(JSON.parse(fs.readFileSync(DB_FILE, "utf8")));
}

function writeLocalDB(db) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

async function readDB() {
  const client = getSupabase();
  if (!client) return readLocalDB();

  const { data, error } = await client
    .from("app_state")
    .select("data")
    .eq("key", SUPABASE_STATE_KEY)
    .maybeSingle();

  if (error) throw error;
  if (data?.data) return normalizeDB(data.data);

  const seedDB = readLocalDB();
  await writeDB(seedDB);
  return normalizeDB(seedDB);
}

async function writeDB(db) {
  const nextDB = normalizeDB(db);
  const client = getSupabase();
  if (!client) {
    writeLocalDB(nextDB);
    return;
  }

  const { error } = await client
    .from("app_state")
    .upsert({
      key: SUPABASE_STATE_KEY,
      data: nextDB,
      updated_at: new Date().toISOString()
    }, { onConflict: "key" });

  if (error) throw error;
}

async function databaseStatus() {
  const client = getSupabase();
  if (!client) {
    return {
      mode: "local-db-json",
      supabaseConfigured: false,
      ok: true,
      message: "Supabase variables are not configured, so the server is using database/db.json."
    };
  }

  const { data, error } = await client
    .from("app_state")
    .select("key, updated_at")
    .eq("key", SUPABASE_STATE_KEY)
    .maybeSingle();

  if (error) {
    return {
      mode: "supabase",
      supabaseConfigured: true,
      ok: false,
      message: error.message
    };
  }

  return {
    mode: "supabase",
    supabaseConfigured: true,
    ok: true,
    hasMainState: Boolean(data),
    updatedAt: data?.updated_at || null
  };
}

function send(res, status, body, type = "application/json", cacheControl = "no-store") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": cacheControl });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 80 * 1024 * 1024) reject(new Error("Request too large"));
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
  });
}

function cleanText(value, max = 600) {
  return String(value || "").trim().slice(0, max);
}

function cleanImages(images) {
  return Array.isArray(images)
    ? images.filter((src) => typeof src === "string" && /^(data:image\/|https?:\/\/)/i.test(src)).slice(0, 5)
    : [];
}

function cleanVideo(video) {
  return typeof video === "string" && /^(data:video\/|https?:\/\/)/i.test(video) ? video : "";
}

function moneyNumber(value) {
  const parsed = Number(String(value || "").replace(/[^\d.]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function serviceFeeForRent(rent) {
  const amount = moneyNumber(rent);
  if (amount >= 500 && amount <= 1000) return 200;
  if (amount >= 1900 && amount <= 2500) return 250;
  if (amount >= 2600 && amount <= 3000) return 300;
  if (amount >= 3100 && amount <= 5000) return 400;
  if (amount > 5000) return 500;
  return 0;
}

function monthKey(dateValue) {
  const value = cleanText(dateValue, 40);
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 7);
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 7);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function requireAdmin(req, res) {
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token || !sessions.has(token)) {
    send(res, 401, { error: "Admin login required" });
    return false;
  }
  return true;
}

function moveItem(db, section, from, to, id) {
  const item = db[section][from].find((entry) => entry.id === id);
  if (!item) return;
  db[section][from] = db[section][from].filter((entry) => entry.id !== id);
  db[section][to] = db[section][to].filter((entry) => entry.id !== id);
  db[section][to].unshift({ ...item, status: to, updatedAt: new Date().toISOString() });
}

function deleteItem(db, section, from, id) {
  db[section][from] = db[section][from].filter((entry) => entry.id !== id);
}

function cleanTakenDetails(details) {
  const rentPrice = cleanText(details?.rentPrice, 40);
  const calculatedFee = serviceFeeForRent(rentPrice);
  const serviceFeeAmount = calculatedFee || Math.max(0, Number(details?.serviceFeeAmount) || moneyNumber(details?.serviceFee));
  return {
    companyName: "Alexandra Rooms To Rent",
    landlordName: cleanText(details?.landlordName, 140),
    landlordContact: cleanText(details?.landlordContact, 80),
    tenantName: cleanText(details?.tenantName, 140),
    tenantContact: cleanText(details?.tenantContact, 80),
    roomAddress: cleanText(details?.roomAddress, 220),
    serviceFee: `R${serviceFeeAmount}`,
    serviceFeeAmount,
    rentPrice,
    deposit: cleanText(details?.deposit, 80),
    paymentDate: cleanText(details?.paymentDate, 20),
    commissionMonth: cleanText(details?.commissionMonth, 20) || monthKey(details?.paymentDate),
    moveInDate: cleanText(details?.moveInDate, 20),
    paymentType: cleanText(details?.paymentType, 40),
    receiptNumber: cleanText(details?.receiptNumber || `ART-${Date.now()}`, 60),
    printedAt: cleanText(details?.printedAt || new Date().toLocaleString("en-ZA"), 80)
  };
}

function markTaken(db, id, takenDetails) {
  const room = db.rooms.approved.find((entry) => entry.id === id);
  if (!room) return;
  db.rooms.approved = db.rooms.approved.filter((entry) => entry.id !== id);
  db.rooms.taken = db.rooms.taken.filter((entry) => entry.id !== id);
  const nextRoom = {
    ...room,
    takenDetails: cleanTakenDetails(takenDetails),
    status: "taken",
    takenAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    retainedUntil: "1 year from payment date"
  };
  db.rooms.taken.unshift(nextRoom);
  db.receipts.unshift({ id: nextRoom.takenDetails.receiptNumber, roomId: nextRoom.id, ...nextRoom.takenDetails });
}

async function api(req, res, url) {
  const db = await readDB();

  if (req.method === "GET" && url.pathname === "/api/public") {
    const rooms = db.rooms.approved.map(({ posterName, posterContact, ...room }) => room);
    const transports = db.transports.approved.map(({ driverName, driverContact, ...transport }) => transport);
    const reports = [
      ...db.reports.approved,
      ...db.reports.pending
    ].map(({ reporterContact, ...report }) => report);
    send(res, 200, { rooms, reviews: db.reviews.approved, reports, transports });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/counts") {
    send(res, 200, {
      rooms: {
        pending: db.rooms.pending.length,
        approved: db.rooms.approved.length,
        taken: db.rooms.taken.length,
        declined: db.rooms.declined.length,
        removed: db.rooms.removed.length
      },
      reviews: {
        pending: db.reviews.pending.length,
        approved: db.reviews.approved.length,
        declined: db.reviews.declined.length
      },
      transports: {
        pending: db.transports.pending.length,
        approved: db.transports.approved.length,
        removed: db.transports.removed.length
      }
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/visit") {
    const body = await readBody(req);
    const page = cleanText(body.page || "home", 80);
    const month = cleanText(body.month || new Date().toISOString().slice(0, 7), 20);
    db.visitors[month] = db.visitors[month] || {};
    db.visitors[month][page] = (Number(db.visitors[month][page]) || 0) + 1;
    await writeDB(db);
    send(res, 201, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/rooms") {
    const body = await readBody(req);
    db.rooms.pending.unshift({
      id: "post-" + Date.now(),
      title: cleanText(body.title, 120),
      address: cleanText(body.address, 220),
      location: cleanText(body.location, 120),
      type: cleanText(body.type, 40),
      amount: cleanText(body.amount, 40),
      deposit: cleanText(body.deposit || "No deposit stated", 80),
      childFriendly: cleanText(body.childFriendly, 10),
      parking: cleanText(body.parking, 10),
      bath: cleanText(body.bath, 120),
      images: cleanImages(body.images),
      video: cleanVideo(body.video),
      posterName: cleanText(body.posterName, 100),
      posterContact: cleanText(body.posterContact, 160),
      notes: cleanText(body.notes, 800),
      status: "pending",
      createdAt: new Date().toISOString()
    });
    await writeDB(db);
    send(res, 201, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/reviews") {
    const body = await readBody(req);
    db.reviews.pending.unshift({
      id: "review-" + Date.now(),
      roomId: cleanText(body.roomId, 80),
      roomTitle: cleanText(body.roomTitle, 140),
      name: cleanText(body.name, 100),
      rating: Math.max(1, Math.min(5, Number(body.rating) || 5)),
      comment: cleanText(body.comment, 800),
      status: "pending",
      createdAt: new Date().toISOString()
    });
    await writeDB(db);
    send(res, 201, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/reports") {
    const body = await readBody(req);
    db.reports.pending.unshift({
      id: "report-" + Date.now(),
      room: cleanText(body.room, 180),
      reporterContact: cleanText(body.reporterContact, 160),
      reason: cleanText(body.reason, 1000),
      status: "pending",
      createdAt: new Date().toISOString()
    });
    await writeDB(db);
    send(res, 201, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/transports") {
    const body = await readBody(req);
    db.transports.pending.unshift({
      id: "transport-" + Date.now(),
      driverName: cleanText(body.driverName, 140),
      driverContact: cleanText(body.driverContact, 120),
      carName: cleanText(body.carName, 140),
      price: cleanText(body.price, 80),
      area: cleanText(body.area, 160),
      image: cleanImages([body.image])[0] || "",
      notes: cleanText(body.notes, 600),
      status: "pending",
      createdAt: new Date().toISOString()
    });
    await writeDB(db);
    send(res, 201, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/transport-requests") {
    const body = await readBody(req);
    db.transportRequests.pending.unshift({
      id: "transport-request-" + Date.now(),
      transportId: cleanText(body.transportId, 80),
      transportTitle: cleanText(body.transportTitle, 160),
      date: cleanText(body.date, 20),
      time: cleanText(body.time, 20),
      pickup: cleanText(body.pickup, 180),
      phone: cleanText(body.phone, 120),
      notes: cleanText(body.notes, 600),
      status: "pending",
      createdAt: new Date().toISOString()
    });
    await writeDB(db);
    send(res, 201, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/admin/login") {
    const body = await readBody(req);
    if (body.password !== ADMIN_PASSWORD) return send(res, 401, { error: "Incorrect password" });
    const token = crypto.randomBytes(24).toString("hex");
    sessions.add(token);
    send(res, 200, { token });
    return;
  }

  if (url.pathname.startsWith("/api/admin/")) {
    if (!requireAdmin(req, res)) return;
    if (req.method === "GET" && url.pathname === "/api/admin/data") return send(res, 200, db);

    if (req.method === "POST" && url.pathname === "/api/admin/action") {
      const body = await readBody(req);
      if (body.action === "move") moveItem(db, body.section, body.from, body.to, body.id);
      if (body.action === "mark-taken") markTaken(db, body.id, body.takenDetails);
      if (body.action === "update-taken") {
        const room = db.rooms.taken.find((entry) => entry.id === body.id);
        if (room) {
          room.takenDetails = cleanTakenDetails(body.takenDetails || {});
          room.updatedAt = new Date().toISOString();
          db.receipts.unshift({ id: room.takenDetails.receiptNumber, roomId: room.id, ...room.takenDetails });
        }
      }
      if (body.action === "manual-receipt") {
        const details = cleanTakenDetails(body.takenDetails || {});
        const manualRoom = {
          id: `manual-${Date.now()}`,
          title: cleanText(body.title || "Manual taken room", 120),
          address: details.roomAddress,
          amount: details.rentPrice,
          deposit: details.deposit,
          type: cleanText(body.type || "Manual room", 40),
          images: [],
          video: "",
          posterName: details.landlordName,
          posterContact: details.landlordContact,
          takenDetails: details,
          status: "taken",
          manual: true,
          takenAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        db.rooms.taken.unshift(manualRoom);
        db.receipts.unshift({ id: details.receiptNumber, roomId: manualRoom.id, manual: true, ...details });
      }
      if (body.action === "update") {
        const list = db[body.section]?.[body.from];
        const item = list?.find((entry) => entry.id === body.id);
        if (item) Object.assign(item, body.updates || {}, { updatedAt: new Date().toISOString() });
      }
      if (body.action === "delete") deleteItem(db, body.section, body.from, body.id);
      if (body.action === "repost") {
        const room = db.rooms[body.from].find((entry) => entry.id === body.id);
        if (room) db.rooms.pending.unshift({ ...room, id: "repost-" + Date.now(), status: "pending" });
      }
      if (body.action === "remove-image") {
        const room = db.rooms[body.from].find((entry) => entry.id === body.id);
        if (room) room.images = (room.images || []).filter((_, index) => index !== Number(body.index));
      }
      if (body.action === "remove-video") {
        const room = db.rooms[body.from].find((entry) => entry.id === body.id);
        if (room) room.video = "";
      }
      await writeDB(db);
      send(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/admin/drive") {
      const body = await readBody(req);
      db.settings.driveFolder = cleanText(body.driveFolder, 500);
      await writeDB(db);
      send(res, 200, { ok: true });
      return;
    }
  }

  send(res, 404, { error: "Not found" });
}

function serveFile(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const file = path.join(ROOT, path.normalize(pathname).replace(/^(\.\.[/\\])+/, ""));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    send(res, 404, { error: "Not found" });
    return;
  }
  const ext = path.extname(file).toLowerCase();
  const type = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".zip": "application/zip" }[ext] || "application/octet-stream";
  const cache = ext === ".html" ? "no-cache" : "public, max-age=3600";
  send(res, 200, fs.readFileSync(file), type, cache);
}

ensureDB();
http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === "/health") return send(res, 200, { ok: true, service: "Alexandra Rooms To Rent" });
    if (url.pathname === "/api/status") return send(res, 200, await databaseStatus());
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    serveFile(req, res, url);
  } catch (error) {
    send(res, 500, { error: error.message || "Server error" });
  }
}).listen(PORT, () => console.log(`Alexandra Rooms To Rent running at http://localhost:${PORT}`));
