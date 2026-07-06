(function () {
  if (!["http:", "https:"].includes(window.location.protocol)) {
    return;
  }
  window.ALEXANDRA_ADMIN_BACKEND_READY = true;

  const TOKEN_KEY = "alexandra-admin-token";
  const TOKEN_VERSION_KEY = "alexandra-admin-token-version";
  const TOKEN_VERSION = "stable-admin-token-20260706";
  if (sessionStorage.getItem(TOKEN_VERSION_KEY) !== TOKEN_VERSION) {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem("alexandra-admin-logged-in");
    sessionStorage.setItem(TOKEN_VERSION_KEY, TOKEN_VERSION);
  }
  const viewMap = {
    pending: ["rooms", "pending"],
    approved: ["rooms", "approved"],
    taken: ["rooms", "taken"],
    declined: ["rooms", "declined"],
    removed: ["rooms", "removed"],
    "review-pending": ["reviews", "pending"],
    "review-approved": ["reviews", "approved"],
    "review-declined": ["reviews", "declined"],
    "report-pending": ["reports", "pending"],
    "report-approved": ["reports", "approved"],
    "report-declined": ["reports", "declined"],
    "transport-pending": ["transports", "pending"],
    "transport-approved": ["transports", "approved"],
    "transport-declined": ["transports", "declined"],
    "transport-removed": ["transports", "removed"],
    "transport-request-pending": ["transportRequests", "pending"],
    "transport-request-contacted": ["transportRequests", "contacted"],
    "transport-request-declined": ["transportRequests", "declined"]
  };

  const storageMap = {
    "alexandra-room-pending": ["rooms", "pending"],
    "alexandra-room-approved": ["rooms", "approved"],
    "alexandra-room-taken": ["rooms", "taken"],
    "alexandra-room-declined": ["rooms", "declined"],
    "alexandra-room-removed": ["rooms", "removed"],
    "alexandra-review-pending": ["reviews", "pending"],
    "alexandra-review-approved": ["reviews", "approved"],
    "alexandra-review-declined": ["reviews", "declined"],
    "alexandra-report-pending": ["reports", "pending"],
    "alexandra-report-approved": ["reports", "approved"],
    "alexandra-report-declined": ["reports", "declined"],
    "alexandra-transport-pending": ["transports", "pending"],
    "alexandra-transport-approved": ["transports", "approved"],
    "alexandra-transport-declined": ["transports", "declined"],
    "alexandra-transport-removed": ["transports", "removed"],
    "alexandra-transport-request-pending": ["transportRequests", "pending"],
    "alexandra-transport-request-contacted": ["transportRequests", "contacted"],
    "alexandra-transport-request-declined": ["transportRequests", "declined"]
  };

  function token() {
    return sessionStorage.getItem(TOKEN_KEY) || "";
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      headers: {
        "Content-Type": "application/json",
        ...(token() ? { Authorization: `Bearer ${token()}` } : {}),
        ...(options.headers || {})
      },
      ...options
    });
    let body = {};
    try {
      body = await response.json();
    } catch {
      body = {};
    }
    if (!response.ok) throw new Error(body.error || body.message || `Request failed with status ${response.status}`);
    return body;
  }

  function syncLocalStorage(db) {
    Object.entries(storageMap).forEach(([key, [section, status]]) => {
      localStorage.setItem(key, JSON.stringify(db[section][status] || []));
    });
    localStorage.setItem("alexandra-room-drive-folder", db.settings.driveFolder || "");
    localStorage.setItem("alexandra-visitors", JSON.stringify(db.visitors || {}));
    localStorage.setItem("alexandra-receipts", JSON.stringify(db.receipts || []));
  }

  function updateServerCounts(db) {
    const serverCounts = document.querySelector("#serverCounts");
    if (!serverCounts) return;
    const rooms = db.rooms || {};
    serverCounts.innerHTML = `
      <span>Pending<strong>${(rooms.pending || []).length}</strong></span>
      <span>Approved<strong>${(rooms.approved || []).length}</strong></span>
      <span>Taken<strong>${(rooms.taken || []).length}</strong></span>
      <span>Declined<strong>${(rooms.declined || []).length}</strong></span>
      <span>Removed<strong>${(rooms.removed || []).length}</strong></span>
    `;
  }

  async function refreshAdmin() {
    try {
      const status = await api("/api/status").catch((error) => ({ ok: false, message: error.message }));
      const db = await api("/api/admin/data");
      syncLocalStorage(db);
      updateServerCounts(db);
      loadDriveLink();
      renderRooms();
      renderDashboard();
      updateTabCounts();
      if (!status.ok) showNotice(`Database setup problem: ${status.message}`);
      return db;
    } catch (error) {
      showNotice(`Admin server problem: ${error.message}`);
      throw error;
    }
  }

  async function adminAction(payload, message) {
    await api("/api/admin/action", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    await refreshAdmin();
    if (message) showNotice(message);
  }

  document.querySelector("#loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    try {
      const data = await api("/api/admin/login", {
        method: "POST",
        body: JSON.stringify({ password: document.querySelector("#adminPassword").value })
      });
      sessionStorage.setItem(TOKEN_KEY, data.token);
      sessionStorage.setItem(SESSION_KEY, "yes");
      document.querySelector("#loginError").classList.remove("is-visible");
      renderAuth();
      await refreshAdmin();
    } catch (error) {
      const loginError = document.querySelector("#loginError");
      loginError.textContent = error.message || "Could not connect to admin server.";
      loginError.classList.add("is-visible");
    }
  }, true);

  document.querySelector("#logoutButton").addEventListener("click", (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(SESSION_KEY);
    renderAuth();
  }, true);

  document.querySelector("#refreshAdminButton").addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    try {
      const db = await refreshAdmin();
      showNotice(`Admin refreshed. Pending rooms on live server: ${(db.rooms?.pending || []).length}.`);
    } catch (error) {
      showNotice(`Could not refresh admin: ${error.message}`);
    }
  }, true);

  const createTestPendingButton = document.querySelector("#createTestPendingButton");
  if (createTestPendingButton) {
    createTestPendingButton.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      try {
        await adminAction({ action: "create-test-pending" }, "Test pending post created. Open the Pending tab.");
        state.view = "pending";
        setActiveTab();
        renderRooms();
      } catch (error) {
        showNotice(`Could not create test pending post: ${error.message}`);
      }
    }, true);
  }

  roomList.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;

    event.preventDefault();
    event.stopImmediatePropagation();

    const [section, from] = viewMap[state.view];
    const id = button.dataset.id;
    const action = button.dataset.action;

    if (action === "approve") return adminAction({ action: "move", section, from, to: "approved", id }, "Post approved and now visible on the public site.");
    if (action === "decline") return adminAction({ action: "move", section, from, to: "declined", id }, "Post declined.");
    if (action === "taken") {
      const room = getList(APPROVED_KEY).find((item) => item.id === id);
      if (room) openTakenForm(room);
      return;
    }
    if (action === "fill-receipt") {
      const room = getList(TAKEN_KEY).find((item) => item.id === id);
      if (room) openTakenForm(room);
      return;
    }
    if (action === "download-receipt") {
      const room = getList(TAKEN_KEY).find((item) => item.id === id);
      if (room) downloadReceipt(room);
      return;
    }
    if (action === "lease") {
      const room = getList(TAKEN_KEY).find((item) => item.id === id) || getList(APPROVED_KEY).find((item) => item.id === id);
      if (room) downloadLease(room);
      return;
    }
    if (action === "remove") return adminAction({ action: "move", section, from, to: "removed", id }, "Room removed from the public site.");
    if (action === "approve-review") return adminAction({ action: "move", section, from, to: "approved", id }, "Review approved and now visible on the public site.");
    if (action === "decline-review") return adminAction({ action: "move", section, from, to: "declined", id }, "Review declined.");
    if (action === "approve-report") return adminAction({ action: "move", section, from, to: "approved", id }, "Scam report approved.");
    if (action === "decline-report") return adminAction({ action: "move", section, from, to: "declined", id }, "Scam report declined.");
    if (action === "approve-transport") return adminAction({ action: "move", section, from, to: "approved", id }, "Moving car approved and now visible publicly.");
    if (action === "decline-transport") return adminAction({ action: "move", section, from, to: "declined", id }, "Moving car declined.");
    if (action === "remove-transport") return adminAction({ action: "move", section, from, to: "removed", id }, "Moving car removed from public view.");
    if (action === "contacted-request") return adminAction({ action: "move", section, from, to: "contacted", id }, "Transport request marked as contacted.");
    if (action === "decline-request") return adminAction({ action: "move", section, from, to: "declined", id }, "Transport request declined.");
    if (action === "delete") return adminAction({ action: "delete", section, from, id }, "Post deleted.");
    if (action === "edit-room") {
      const room = (JSON.parse(localStorage.getItem(Object.entries(storageMap).find(([, value]) => value[0] === section && value[1] === from)?.[0] || "[]")) || []).find((entry) => entry.id === id);
      if (!room) return;
      const title = prompt("Room title", room.title || "");
      if (title === null) return;
      const address = prompt("Room address", room.address || "");
      if (address === null) return;
      const amount = prompt("Rent amount", room.amount || "");
      if (amount === null) return;
      const deposit = prompt("Deposit amount", room.deposit || "");
      if (deposit === null) return;
      return adminAction({ action: "update", section, from, id, updates: { title, address, amount, deposit } }, "Room post updated.");
    }
    if (action === "repost") return adminAction({ action: "repost", section, from, id }, "Room copied back to Pending for review.");
    if (action === "remove-image") return adminAction({ action: "remove-image", section, from, id, index: button.dataset.index }, "Picture removed from this room post.");
    if (action === "remove-video") return adminAction({ action: "remove-video", section, from, id }, "Video removed from this room post.");
    if (action === "recheck-review") {
      state.view = "review-pending";
      setActiveTab();
      return adminAction({ action: "move", section, from, to: "pending", id }, "Review moved back to Pending.");
    }
    if (action === "recheck-report") {
      state.view = "report-pending";
      setActiveTab();
      return adminAction({ action: "move", section, from, to: "pending", id }, "Report moved back to Scam Reports.");
    }
  }, true);

  const saveDrive = document.querySelector("#saveDrive");
  if (saveDrive) {
    saveDrive.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      await api("/api/admin/drive", {
        method: "POST",
        body: JSON.stringify({ driveFolder: driveFolder.value.trim() })
      });
      await refreshAdmin();
      showNotice("Google Drive folder link saved in the database.");
    }, true);
  }

  takenForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    const room = getList(APPROVED_KEY).find((item) => item.id === takenRoomId.value);
    const existingTakenRoom = getList(TAKEN_KEY).find((item) => item.id === takenRoomId.value);
    const selectedRoom = room || existingTakenRoom;
    if (!selectedRoom) return showNotice("Could not find the room to save receipt details.");
    const takenDetails = takenDetailsFromForm(selectedRoom);
    await api("/api/admin/action", {
      method: "POST",
      body: JSON.stringify({ action: room ? "mark-taken" : "update-taken", id: selectedRoom.id, takenDetails })
    });
    await refreshAdmin();
    const takenRoom = getList(TAKEN_KEY).find((item) => item.id === selectedRoom.id);
    state.view = "taken";
    setActiveTab();
    setReceiptSectionReady(false);
    takenRoomLabel.textContent = "Select an approved room and click Mark As Taken. This section will then unlock so you can fill in landlord, tenant, payment, service fee, and moving-in details before downloading the receipt.";
    takenForm.reset();
    if (takenRoom) downloadReceipt(takenRoom);
    showNotice(room ? "Room marked as taken. Receipt opened for PDF saving." : "Taken room receipt updated and opened for download.");
  }, true);

  const rentInput = document.querySelector("#receiptRentAmount");
  if (rentInput) {
    rentInput.addEventListener("input", () => {
      const fee = serviceFeeForRent(rentInput.value);
      receiptServiceFee.innerHTML = serviceFeeOptions(rentInput.value)
        .map((amount) => `<option value="${amount}">R${amount}</option>`)
        .join("");
      serviceFeeHint.textContent = fee
        ? `Calculated service fee for ${money(rentInput.value)} rent: R${fee}.`
        : "Rent does not fall inside a service-fee band. Choose the correct commission manually.";
    });
  }

  function validateManualFields() {
    const requiredFields = [
      ["#receiptLandlordName", "landlord full name"],
      ["#receiptLandlordContact", "landlord contact number"],
      ["#receiptTenantName", "tenant full name"],
      ["#receiptTenantContact", "tenant mobile number"],
      ["#receiptRoomAddress", "room address"],
      ["#receiptRentAmount", "rent amount"],
      ["#receiptDepositAmount", "deposit amount"],
      ["#receiptPaymentDate", "payment date"],
      ["#receiptMoveInDate", "moving in date"]
    ];
    for (const [selector, label] of requiredFields) {
      const field = document.querySelector(selector);
      if (!field.value.trim()) {
        field.focus();
        showNotice(`Please fill in ${label} before creating the document.`);
        return false;
      }
    }
    if (document.querySelector("#receiptPaymentType").value === "Other" && !document.querySelector("#receiptPaymentTypeOther").value.trim()) {
      document.querySelector("#receiptPaymentTypeOther").focus();
      showNotice("Please write the payment type.");
      return false;
    }
    return true;
  }

  const manualReceiptButton = document.querySelector("#manualReceiptButton");
  if (manualReceiptButton) {
    manualReceiptButton.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!validateManualFields()) return;
      const manualRoom = {
        id: "manual-" + Date.now(),
        title: "Manual receipt",
        address: document.querySelector("#receiptRoomAddress").value.trim(),
        amount: document.querySelector("#receiptRentAmount").value.trim(),
        deposit: document.querySelector("#receiptDepositAmount").value.trim()
      };
      const takenDetails = takenDetailsFromForm(manualRoom);
      await api("/api/admin/action", {
        method: "POST",
        body: JSON.stringify({ action: "manual-receipt", title: manualRoom.title, takenDetails })
      });
      await refreshAdmin();
      const takenRoom = getList(TAKEN_KEY).find((item) => item.takenDetails?.receiptNumber === takenDetails.receiptNumber);
      state.view = "taken";
      setActiveTab();
      renderRooms();
      downloadReceipt(takenRoom || { ...manualRoom, takenDetails, status: "taken" });
      showNotice("Manual taken room saved under Taken and receipt opened for download.");
    }, true);
  }

  const manualLeaseButton = document.querySelector("#manualLeaseButton");
  if (manualLeaseButton) {
    manualLeaseButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!validateManualFields()) return;
      const manualRoom = {
        id: "manual-lease-" + Date.now(),
        title: "Manual lease agreement",
        address: document.querySelector("#receiptRoomAddress").value.trim(),
        amount: document.querySelector("#receiptRentAmount").value.trim(),
        deposit: document.querySelector("#receiptDepositAmount").value.trim(),
        takenDetails: {
          ...takenDetailsFromForm({
            address: document.querySelector("#receiptRoomAddress").value.trim(),
            amount: document.querySelector("#receiptRentAmount").value.trim(),
            deposit: document.querySelector("#receiptDepositAmount").value.trim()
          })
        }
      };
      downloadLease(manualRoom);
    }, true);
  }

  if (token()) {
    sessionStorage.setItem(SESSION_KEY, "yes");
    refreshAdmin().catch(() => {
      sessionStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(SESSION_KEY);
      renderAuth();
    });
  } else {
    sessionStorage.removeItem(SESSION_KEY);
    renderAuth();
  }

  setInterval(() => {
    if (!token() || sessionStorage.getItem(SESSION_KEY) !== "yes") return;
    refreshAdmin().catch(() => {});
  }, 30000);
})();
