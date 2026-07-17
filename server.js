const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Av98012@12";
const ROOT = __dirname;
const DATA_DIR = process.env.VERCEL ? path.join("/tmp", "vusani-ikhaya-data") : path.join(ROOT, "database");
const DB_FILE = path.join(DATA_DIR, "db.json");
const SEED_DB_FILE = path.join(ROOT, "database", "db.json");
const sessions = new Set();
const agentSessions = new Map();
const AGENT_PLACEMENT_COMMISSION = 100;

const defaultDB = {
  rooms: { pending: [], approved: [], taken: [], declined: [], removed: [] },
  reviews: { pending: [], approved: [], declined: [] },
  reports: { pending: [], approved: [], declined: [] },
  transports: { pending: [], approved: [], declined: [], removed: [] },
  agents: { accounts: [], profiles: [], landlords: [], reports: [], leads: [], viewings: [], support: [] },
  receipts: []
};

function normalizeSection(section, defaults) {
  const source = section && typeof section === "object" && !Array.isArray(section) ? section : {};
  return Object.fromEntries(
    Object.keys(defaults).map((status) => [
      status,
      Array.isArray(source[status]) ? source[status] : []
    ])
  );
}

function normalizeDB(db) {
  db = db || {};
  db.rooms = normalizeSection(db.rooms, defaultDB.rooms);
  db.reviews = normalizeSection(db.reviews, defaultDB.reviews);
  db.reports = normalizeSection(db.reports, defaultDB.reports);
  db.transports = normalizeSection(db.transports, defaultDB.transports);
  db.agents = db.agents && typeof db.agents === "object" && !Array.isArray(db.agents) ? db.agents : {};
  db.agents.accounts = Array.isArray(db.agents.accounts) ? db.agents.accounts : [];
  db.agents.profiles = Array.isArray(db.agents.profiles) ? db.agents.profiles : [];
  db.agents.landlords = Array.isArray(db.agents.landlords) ? db.agents.landlords : [];
  db.agents.reports = Array.isArray(db.agents.reports) ? db.agents.reports : [];
  db.agents.leads = Array.isArray(db.agents.leads) ? db.agents.leads : [];
  db.agents.viewings = Array.isArray(db.agents.viewings) ? db.agents.viewings : [];
  db.agents.support = Array.isArray(db.agents.support) ? db.agents.support : [];
  db.receipts = Array.isArray(db.receipts) ? db.receipts : [];
  return db;
}

function ensureDB() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    if (fs.existsSync(SEED_DB_FILE)) {
      fs.copyFileSync(SEED_DB_FILE, DB_FILE);
    } else {
      writeDB(defaultDB);
    }
  }
}

function readDB() {
  ensureDB();
  let parsed;
  try {
    const raw = fs.readFileSync(DB_FILE, "utf8").replace(/^\uFEFF/, "");
    parsed = raw.trim() ? JSON.parse(raw) : defaultDB;
  } catch {
    parsed = defaultDB;
  }
  return normalizeDB(parsed);
}

function writeDB(db) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(normalizeDB(db), null, 2));
}

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}

function sendMedia(res, src) {
  if (!src) return send(res, 404, { error: "Media not found" });
  if (/^https?:\/\//i.test(src)) {
    res.writeHead(302, { Location: src, "Cache-Control": "no-store" });
    res.end();
    return;
  }
  const match = String(src).match(/^data:((?:image|video)\/[a-z0-9.+-]+);base64,(.+)$/i);
  if (!match) return send(res, 404, { error: "Media not found" });
  res.writeHead(200, { "Content-Type": match[1], "Cache-Control": "public, max-age=3600" });
  res.end(Buffer.from(match[2], "base64"));
}

function encodePart(value) {
  return encodeURIComponent(String(value || ""));
}

function publicRoom(room) {
  return {
    ...room,
    images: (room.images || []).map((_, index) => `/api/room-media/${encodePart(room.id)}/image/${index}`),
    video: room.video ? `/api/room-media/${encodePart(room.id)}/video` : ""
  };
}

function publicTransport(driver) {
  return {
    id: driver.id,
    firstName: driver.firstName,
    surname: driver.surname,
    carPicture: driver.carPicture ? `/api/transport-media/${encodePart(driver.id)}/carPicture` : "",
    localPrice: driver.localPrice,
    outsidePrice: driver.outsidePrice,
    status: driver.status
  };
}

function adminMediaURL(section, status, id, field, index, token) {
  const base = `/api/admin/media/${encodePart(section)}/${encodePart(status)}/${encodePart(id)}/${encodePart(field)}`;
  const suffix = field === "images" ? `/${index}` : "";
  return `${base}${suffix}?token=${encodePart(token)}`;
}

function adminItem(item, section, status, token) {
  const next = { ...item };
  if (Array.isArray(next.images)) {
    next.images = next.images.map((_, index) => adminMediaURL(section, status, next.id, "images", index, token));
  }
  if (next.video) next.video = adminMediaURL(section, status, next.id, "video", 0, token);
  if (next.carPicture) next.carPicture = adminMediaURL(section, status, next.id, "carPicture", 0, token);
  if (next.idPicture) next.idPicture = adminMediaURL(section, status, next.id, "idPicture", 0, token);
  if (next.selfieWithId) next.selfieWithId = adminMediaURL(section, status, next.id, "selfieWithId", 0, token);
  return next;
}

function adminSection(sectionName, section, token) {
  return Object.fromEntries(
    Object.entries(section).map(([status, list]) => [
      status,
      (Array.isArray(list) ? list : []).map((item) => adminItem(item, sectionName, status, token))
    ])
  );
}

function adminDB(db, token) {
  return {
    rooms: adminSection("rooms", db.rooms, token),
    reviews: db.reviews,
    reports: db.reports,
    transports: adminSection("transports", db.transports, token),
    agents: db.agents,
    receipts: db.receipts
  };
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

function cleanUsername(value) {
  return cleanText(value, 80).toLowerCase().replace(/\s+/g, " ");
}

function cleanImages(images) {
  return Array.isArray(images)
    ? images.filter((src) => typeof src === "string" && /^(data:image\/|https?:\/\/)/i.test(src)).slice(0, 5)
    : [];
}

function cleanVideo(video) {
  return typeof video === "string" && /^(data:video\/|https?:\/\/)/i.test(video) ? video : "";
}

function cleanFiles(files, max = 8) {
  return Array.isArray(files)
    ? files.filter((file) => typeof file === "string").map((file) => cleanText(file, 180)).slice(0, max)
    : [];
}

function moneyNumber(value) {
  const parsed = Number(String(value || "").replace(/[^\d.]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function serviceFeeForRent(rent) {
  const amount = moneyNumber(rent);
  if (amount >= 800 && amount <= 1500) return 200;
  if (amount >= 1600 && amount <= 2000) return 250;
  if (amount >= 2100 && amount <= 3000) return 300;
  if (amount >= 3100 && amount <= 5000) return 400;
  return 0;
}

function monthKey(dateValue) {
  const value = cleanText(dateValue, 40);
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 7);
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 7);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function cleanReceipt(details) {
  const rentAmount = cleanText(details?.rentAmount || details?.rentPrice, 40);
  const fee = serviceFeeForRent(rentAmount) || moneyNumber(details?.serviceFee);
  return {
    id: cleanText(details?.id || `ART-${Date.now()}`, 80),
    date: cleanText(details?.date || new Date().toISOString().slice(0, 10), 20),
    tenantName: cleanText(details?.tenantName, 140),
    tenantNumber: cleanText(details?.tenantNumber, 80),
    paymentType: cleanText(details?.paymentType || "Cash", 80),
    roomAddress: cleanText(details?.roomAddress, 220),
    rentAmount,
    depositAmount: cleanText(details?.depositAmount, 80),
    serviceFee: fee,
    serviceFeeText: `R${fee}`,
    month: monthKey(details?.date || new Date().toISOString())
  };
}

function adminToken(req, url) {
  return String(req.headers.authorization || "").replace(/^Bearer\s+/i, "") || String(url?.searchParams.get("token") || "");
}

function requireAdmin(req, res, url) {
  const token = adminToken(req, url);
  if (!token || !sessions.has(token)) {
    send(res, 401, { error: "Admin login required" });
    return false;
  }
  return token;
}

function requireAgent(req, res) {
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const account = token ? agentSessions.get(token) : null;
  if (!account) {
    send(res, 401, { error: "Agent login required" });
    return null;
  }
  return account;
}

function agentOwns(item, account) {
  return item?.agentId === account.id || cleanUsername(item?.agentUsername) === cleanUsername(account.username);
}

function agentRooms(db, account) {
  return ["pending", "approved", "taken", "declined", "removed"].flatMap((status) =>
    (db.rooms[status] || []).filter((room) => room.source === "agent-portal" && agentOwns(room, account)).map((room) => ({ ...room, listStatus: status }))
  );
}

function moveItem(db, section, from, to, id) {
  if (!db[section] || !Array.isArray(db[section][from]) || !Array.isArray(db[section][to])) return;
  const item = db[section][from].find((entry) => entry.id === id);
  if (!item) return;
  db[section][from] = db[section][from].filter((entry) => entry.id !== id);
  db[section][to] = db[section][to].filter((entry) => entry.id !== id);
  db[section][to].unshift({ ...item, status: to, updatedAt: new Date().toISOString() });
}

function deleteItem(db, section, from, id) {
  if (!db[section] || !Array.isArray(db[section][from])) return;
  db[section][from] = db[section][from].filter((entry) => entry.id !== id);
}

async function api(req, res, url) {
  const db = readDB();

  if (req.method === "GET" && url.pathname.startsWith("/api/room-image/")) {
    const [, , , id, indexText] = url.pathname.split("/");
    const room = db.rooms.approved.find((entry) => entry.id === decodeURIComponent(id || ""));
    const index = Math.max(0, Number(indexText) || 0);
    return sendMedia(res, room?.images?.[index]);
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/room-media/")) {
    const [, , , id, kind, indexText] = url.pathname.split("/");
    const room = db.rooms.approved.find((entry) => entry.id === decodeURIComponent(id || ""));
    if (kind === "video") return sendMedia(res, room?.video);
    const index = Math.max(0, Number(indexText) || 0);
    return sendMedia(res, room?.images?.[index]);
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/transport-media/")) {
    const [, , , id, field] = url.pathname.split("/");
    const driver = db.transports.approved.find((entry) => entry.id === decodeURIComponent(id || ""));
    return sendMedia(res, field === "carPicture" ? driver?.carPicture : "");
  }

  if (req.method === "GET" && url.pathname === "/api/public") {
    send(res, 200, {
      rooms: db.rooms.approved.map(publicRoom),
      reviews: db.reviews.approved,
      transports: db.transports.approved.map(publicTransport)
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/rooms") {
    const body = await readBody(req);
    db.rooms.pending.unshift({
      id: "post-" + Date.now(),
      title: cleanText(body.title, 120),
      location: cleanText(body.location, 80),
      address: cleanText(body.address, 220),
      type: cleanText(body.type, 40),
      roomType: cleanText(body.roomType || "Any", 40),
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
    writeDB(db);
    send(res, 201, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/agent/login") {
    const body = await readBody(req);
    const username = cleanUsername(body.username);
    const password = cleanText(body.password, 120);
    const account = db.agents.accounts.find((entry) => cleanUsername(entry.username) === username && entry.password === password && entry.status !== "Suspended");
    if (!account) return send(res, 401, { error: "Incorrect agent login or suspended account" });
    const token = crypto.randomBytes(24).toString("hex");
    const safeAccount = {
      id: account.id,
      fullName: account.fullName,
      username: account.username,
      phone: account.phone,
      email: account.email,
      address: account.address || "",
      status: account.status || "Active",
      commissionRate: account.commissionRate || ""
    };
    agentSessions.set(token, safeAccount);
    send(res, 200, { token, agent: safeAccount });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/agent/summary") {
    const account = requireAgent(req, res);
    if (!account) return;
    const allRooms = agentRooms(db, account);
    const agentTaken = (db.rooms.taken || []).filter((room) => room.source === "agent-portal" && agentOwns(room, account));
    const now = new Date();
    const todayKey = now.toISOString().slice(0, 10);
    const currentMonth = now.toISOString().slice(0, 7);
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - now.getDay() + 1);
    weekStart.setHours(0, 0, 0, 0);
    const commissionFor = (rooms) => rooms.reduce((total, room) => total + moneyNumber(room.agentCommission || AGENT_PLACEMENT_COMMISSION), 0);
    const commissionEarned = agentTaken.reduce((total, room) => total + moneyNumber(room.agentCommission || AGENT_PLACEMENT_COMMISSION), 0);
    const commissionPending = 0;
    send(res, 200, {
      ok: true,
      agent: account,
      stats: {
        propertiesRegistered: allRooms.length,
        activeListings: (db.rooms.approved || []).filter((room) => room.source === "agent-portal" && agentOwns(room, account)).length,
        viewingsBooked: db.agents.viewings.filter((item) => agentOwns(item, account)).length,
        successfulPlacements: agentTaken.length,
        commissionToday: commissionFor(agentTaken.filter((room) => String(room.takenAt || "").slice(0, 10) === todayKey)),
        commissionWeek: commissionFor(agentTaken.filter((room) => new Date(room.takenAt || 0) >= weekStart)),
        commissionMonth: commissionFor(agentTaken.filter((room) => String(room.takenAt || "").slice(0, 7) === currentMonth)),
        commissionEarned,
        commissionPending
      },
      listings: allRooms
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/agent/change-password") {
    const account = requireAgent(req, res);
    if (!account) return;
    const body = await readBody(req);
    const currentPassword = cleanText(body.currentPassword, 120);
    const newPassword = cleanText(body.newPassword, 120);
    if (!newPassword || newPassword.length < 4) return send(res, 400, { error: "New password must be at least 4 characters" });
    const saved = db.agents.accounts.find((entry) => entry.id === account.id);
    if (!saved || saved.password !== currentPassword) return send(res, 401, { error: "Current password is incorrect" });
    saved.password = newPassword;
    saved.updatedAt = new Date().toISOString();
    writeDB(db);
    send(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/agent/property") {
    const account = requireAgent(req, res);
    if (!account) return;
    const body = await readBody(req);
    const location = cleanText(body.location, 100);
    const address = cleanText(body.address, 220);
    const propertyType = cleanText(body.propertyType || body.type, 60);
    const roomType = cleanText(body.roomType || propertyType || "Any", 60);
    const amount = cleanText(body.amount || body.monthlyRent, 40);
    const notes = [
      body.description && `Description: ${cleanText(body.description, 700)}`,
      body.rules && `Rules: ${cleanText(body.rules, 500)}`,
      body.landlordName && `Landlord: ${cleanText(body.landlordName, 140)} ${cleanText(body.landlordPhone, 80)}`,
      body.electricityIncluded && `Electricity included: ${cleanText(body.electricityIncluded, 30)}`,
      body.waterIncluded && `Water included: ${cleanText(body.waterIncluded, 30)}`,
      body.wifi && `Wi-Fi: ${cleanText(body.wifi, 30)}`,
      body.availableDate && `Available date: ${cleanText(body.availableDate, 40)}`,
      body.nearbySchools && `Nearby schools: ${cleanText(body.nearbySchools, 220)}`,
      body.nearbyTaxiRank && `Nearby taxi rank: ${cleanText(body.nearbyTaxiRank, 220)}`,
      body.nearbyMall && `Nearby mall: ${cleanText(body.nearbyMall, 220)}`,
      cleanFiles(body.documents, 8).length ? `Documents: ${cleanFiles(body.documents, 8).join(", ")}` : ""
    ].filter(Boolean).join("\n");
    db.rooms.pending.unshift({
      id: "agent-property-" + Date.now(),
      title: `${propertyType || "Property"} - ${location || address || "Pending address"}`,
      location,
      address,
      type: propertyType,
      roomType,
      amount,
      deposit: cleanText(body.deposit || "No deposit stated", 80),
      childFriendly: cleanText(body.childFriendly || "No", 10),
      parking: cleanText(body.parking || "No", 10),
      bath: cleanText(body.bath || "Not stated", 120),
      images: cleanImages(body.images),
      video: cleanVideo(body.video),
      posterName: cleanText(body.agentName || body.posterName, 100),
      posterContact: cleanText(body.agentPhone || body.posterContact, 160),
      notes: cleanText(notes, 1800),
      source: "agent-portal",
      agentId: account.id,
      agentUsername: account.username,
      agentName: account.fullName,
      landlordName: cleanText(body.landlordName, 140),
      landlordPhone: cleanText(body.landlordPhone, 80),
      status: "pending",
      createdAt: new Date().toISOString()
    });
    writeDB(db);
    send(res, 201, { ok: true, message: "Property sent to admin pending review" });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/agent/profile") {
    const account = requireAgent(req, res);
    if (!account) return;
    const body = await readBody(req);
    db.agents.profiles.unshift({
      id: "agent-profile-" + Date.now(),
      agentId: account.id,
      agentUsername: account.username,
      profilePicture: cleanImages([body.profilePicture])[0] || "",
      fullName: cleanText(body.fullName, 140),
      idNumber: cleanText(body.idNumber, 80),
      phone: cleanText(body.phone, 80),
      email: cleanText(body.email, 160),
      residentialAddress: cleanText(body.residentialAddress, 260),
      emergencyContact: cleanText(body.emergencyContact, 160),
      bankDetails: cleanText(body.bankDetails, 400),
      commissionRate: cleanText(body.commissionRate, 80),
      employmentStatus: cleanText(body.employmentStatus, 80),
      dateJoined: cleanText(body.dateJoined, 40),
      documents: cleanFiles(body.documents, 10),
      createdAt: new Date().toISOString()
    });
    writeDB(db);
    send(res, 201, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/agent/landlord") {
    const account = requireAgent(req, res);
    if (!account) return;
    const body = await readBody(req);
    db.agents.landlords.unshift({
      id: "agent-landlord-" + Date.now(),
      agentId: account.id,
      agentUsername: account.username,
      agentName: account.fullName,
      landlordName: cleanText(body.landlordName, 140),
      idNumber: cleanText(body.idNumber, 80),
      phone: cleanText(body.phone, 80),
      email: cleanText(body.email, 160),
      residentialAddress: cleanText(body.residentialAddress, 260),
      preferredContactMethod: cleanText(body.preferredContactMethod, 80),
      documents: cleanFiles(body.documents, 6),
      createdAt: new Date().toISOString()
    });
    writeDB(db);
    send(res, 201, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/agent/lead") {
    const account = requireAgent(req, res);
    if (!account) return;
    const body = await readBody(req);
    db.agents.leads.unshift({
      id: "agent-lead-" + Date.now(),
      agentId: account.id,
      agentUsername: account.username,
      agentName: account.fullName,
      leadName: cleanText(body.leadName, 140),
      phone: cleanText(body.phone, 80),
      budget: cleanText(body.budget, 80),
      preferredArea: cleanText(body.preferredArea, 120),
      moveInDate: cleanText(body.moveInDate, 40),
      interestedProperty: cleanText(body.interestedProperty, 220),
      notes: cleanText(body.notes, 800),
      status: cleanText(body.status || "New", 40),
      createdAt: new Date().toISOString()
    });
    writeDB(db);
    send(res, 201, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/agent/viewing") {
    const account = requireAgent(req, res);
    if (!account) return;
    const body = await readBody(req);
    db.agents.viewings.unshift({
      id: "agent-viewing-" + Date.now(),
      agentId: account.id,
      agentUsername: account.username,
      agentName: account.fullName,
      tenantName: cleanText(body.tenantName, 140),
      tenantPhone: cleanText(body.tenantPhone, 80),
      propertyAddress: cleanText(body.propertyAddress, 240),
      viewingDate: cleanText(body.viewingDate, 40),
      viewingTime: cleanText(body.viewingTime, 40),
      status: cleanText(body.status || "Upcoming", 60),
      notes: cleanText(body.notes, 800),
      createdAt: new Date().toISOString()
    });
    writeDB(db);
    send(res, 201, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/agent/report") {
    const account = requireAgent(req, res);
    if (!account) return;
    const body = await readBody(req);
    db.agents.reports.unshift({
      id: "agent-report-" + Date.now(),
      agentId: account.id,
      agentUsername: account.username,
      agentName: account.fullName,
      reportDate: cleanText(body.reportDate || new Date().toISOString().slice(0, 10), 40),
      landlordsVisited: cleanText(body.landlordsVisited, 40),
      propertiesFound: cleanText(body.propertiesFound, 40),
      registrations: cleanText(body.registrations, 40),
      photosUploaded: cleanText(body.photosUploaded, 40),
      challenges: cleanText(body.challenges, 1000),
      plans: cleanText(body.plans, 1000),
      createdAt: new Date().toISOString()
    });
    writeDB(db);
    send(res, 201, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/agent/support") {
    const account = requireAgent(req, res);
    if (!account) return;
    const body = await readBody(req);
    db.agents.support.unshift({
      id: "agent-support-" + Date.now(),
      agentId: account.id,
      agentUsername: account.username,
      agentName: account.fullName,
      type: cleanText(body.type || "Support Ticket", 80),
      message: cleanText(body.message, 1600),
      status: "Open",
      createdAt: new Date().toISOString()
    });
    writeDB(db);
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
    writeDB(db);
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
    writeDB(db);
    send(res, 201, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/transports") {
    const body = await readBody(req);
    db.transports.pending.unshift({
      id: "transport-" + Date.now(),
      firstName: cleanText(body.firstName, 100),
      surname: cleanText(body.surname, 100),
      phone: cleanText(body.phone, 80),
      email: cleanText(body.email, 160),
      carPicture: cleanImages([body.carPicture])[0] || "",
      idPicture: cleanImages([body.idPicture])[0] || "",
      localPrice: cleanText(body.localPrice, 80),
      outsidePrice: cleanText(body.outsidePrice, 80),
      notes: cleanText(body.notes, 800),
      status: "pending",
      createdAt: new Date().toISOString()
    });
    writeDB(db);
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
    const token = requireAdmin(req, res, url);
    if (!token) return;

    if (req.method === "GET" && url.pathname.startsWith("/api/admin/media/")) {
      const [, , , , section, status, id, field, indexText] = url.pathname.split("/");
      const list = db[decodeURIComponent(section || "")]?.[decodeURIComponent(status || "")] || [];
      const item = list.find((entry) => entry.id === decodeURIComponent(id || ""));
      if (field === "images") return sendMedia(res, item?.images?.[Math.max(0, Number(indexText) || 0)]);
      return sendMedia(res, item?.[decodeURIComponent(field || "")]);
    }

    if (req.method === "GET" && url.pathname === "/api/admin/data") return send(res, 200, adminDB(db, token));

    if (req.method === "POST" && url.pathname === "/api/admin/action") {
      const body = await readBody(req);
      if (body.action === "save-agent-account") {
        const agent = body.agent || {};
        const username = cleanUsername(agent.username);
        if (!username || !cleanText(agent.password, 120)) return send(res, 400, { error: "Agent username and password are required" });
        const existing = db.agents.accounts.find((entry) => entry.id === agent.id || cleanUsername(entry.username) === username);
        const saved = {
          id: existing?.id || "agent-account-" + Date.now(),
          fullName: cleanText(agent.fullName, 140),
          username,
          password: cleanText(agent.password, 120),
          phone: cleanText(agent.phone, 80),
          email: cleanText(agent.email, 160),
          address: cleanText(agent.address, 260),
          idPicture: cleanImages([agent.idPicture])[0] || existing?.idPicture || "",
          selfieWithId: cleanImages([agent.selfieWithId])[0] || existing?.selfieWithId || "",
          status: cleanText(agent.status || "Active", 40),
          commissionRate: cleanText(agent.commissionRate, 80),
          createdAt: existing?.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        db.agents.accounts = db.agents.accounts.filter((entry) => entry.id !== saved.id && cleanUsername(entry.username) !== username);
        db.agents.accounts.unshift(saved);
      }
      if (body.action === "delete-agent-account") {
        db.agents.accounts = db.agents.accounts.filter((entry) => entry.id !== body.id);
      }
      if (body.action === "set-agent-status") {
        const account = db.agents.accounts.find((entry) => entry.id === body.id);
        if (account) {
          account.status = cleanText(body.status || "Active", 40);
          account.updatedAt = new Date().toISOString();
        }
      }
      if (body.action === "reset-agent-password") {
        const account = db.agents.accounts.find((entry) => entry.id === body.id);
        const password = cleanText(body.password, 120);
        if (!password || password.length < 4) return send(res, 400, { error: "New password must be at least 4 characters" });
        if (account) {
          account.password = password;
          account.updatedAt = new Date().toISOString();
        }
      }
      if (body.action === "move") moveItem(db, body.section, body.from, body.to, body.id);
      if (body.action === "mark-taken") {
        const room = db.rooms.approved.find((entry) => entry.id === body.id);
        if (room) {
          const receipt = cleanReceipt({
            ...(body.receipt || {}),
            roomAddress: body.receipt?.roomAddress || room.address,
            rentAmount: body.receipt?.rentAmount || room.amount,
            depositAmount: body.receipt?.depositAmount || room.deposit
          });
          db.rooms.approved = db.rooms.approved.filter((entry) => entry.id !== body.id);
          db.rooms.taken = db.rooms.taken.filter((entry) => entry.id !== body.id);
          const agentCommission = room.source === "agent-portal" && (room.agentId || room.agentUsername) ? AGENT_PLACEMENT_COMMISSION : 0;
          const takenRoom = {
            ...room,
            status: "taken",
            receipt,
            takenAt: new Date().toISOString(),
            leasedByAgentId: room.agentId || "",
            leasedByAgentUsername: room.agentUsername || "",
            leasedByAgentName: room.agentName || "",
            agentCommission,
            agentCommissionText: agentCommission ? `R${agentCommission}` : "R0"
          };
          db.rooms.taken.unshift(takenRoom);
          db.receipts.unshift({ ...receipt, roomId: room.id, manual: false, agentId: room.agentId || "", agentName: room.agentName || "", agentCommission });
        }
      }
      if (body.action === "manual-receipt") {
        const receipt = cleanReceipt(body.receipt || {});
        const manualRoom = {
          id: `manual-${Date.now()}`,
          title: cleanText(body.title || "Manual receipt", 120),
          address: receipt.roomAddress,
          type: cleanText(body.type || "Manual room", 40),
          roomType: cleanText(body.roomType || "Any", 40),
          amount: receipt.rentAmount,
          deposit: receipt.depositAmount,
          images: [],
          video: "",
          status: "taken",
          receipt,
          manual: true,
          takenAt: new Date().toISOString()
        };
        db.rooms.taken.unshift(manualRoom);
        db.receipts.unshift({ ...receipt, roomId: manualRoom.id, manual: true });
      }
      if (body.action === "delete") deleteItem(db, body.section, body.from, body.id);
      if (body.action === "repost") {
        const section = db[body.section];
        const fromList = section && Array.isArray(section[body.from]) ? section[body.from] : [];
        const item = fromList.find((entry) => entry.id === body.id);
        if (item && Array.isArray(section.pending)) {
          section.pending.unshift({ ...item, id: "repost-" + Date.now(), status: "pending" });
        }
      }
      if (body.action === "remove-image") {
        const section = db[body.section];
        const fromList = section && Array.isArray(section[body.from]) ? section[body.from] : [];
        const room = fromList.find((entry) => entry.id === body.id);
        if (room) room.images = (room.images || []).filter((_, index) => index !== Number(body.index));
      }
      if (body.action === "remove-video") {
        const section = db[body.section];
        const fromList = section && Array.isArray(section[body.from]) ? section[body.from] : [];
        const room = fromList.find((entry) => entry.id === body.id);
        if (room) room.video = "";
      }
      writeDB(db);
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
  send(res, 200, fs.readFileSync(file), type);
}

async function requestHandler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    serveFile(req, res, url);
  } catch (error) {
    send(res, 500, { error: error.message || "Server error" });
  }
}

ensureDB();

if (require.main === module) {
  http.createServer(requestHandler).listen(PORT, () => console.log(`VUSANI IKHAYA PROPERTIES running at http://localhost:${PORT}`));
}

module.exports = requestHandler;
