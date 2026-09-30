// ============================================================
// JARVIS FRONTEND — D1 ACCOUNT VERSION
// ============================================================

const BASE_URL = "https://jarvis.hpgrc204.workers.dev";
const API_URL = BASE_URL + "/ask";
const STATUS_URL = BASE_URL + "/device/status?device=JARVIS-ESP32-01";
const DEVICE_ID = "JARVIS-ESP32-01";

const TOKEN_KEY = "jarvis_session_token";
const SETTINGS_KEY = "jarvis_settings_v3";
const USER_KEY = "jarvis_user_v4";

let currentUser = null;
let conversations = [];
let currentConversationId = null;
let isSending = false;
let deviceTimer = null;

const chat = document.getElementById("chat");
const chatArea = document.getElementById("chatArea");
const input = document.getElementById("prompt");
const send = document.getElementById("send");
const welcome = document.getElementById("welcome");
const sidebar = document.getElementById("sidebar");
const sidebarOverlay = document.getElementById("sidebarOverlay");
const conversationList = document.getElementById("conversationList");
const aiDot = document.getElementById("aiDot");
const aiStatus = document.getElementById("aiStatus");
const deviceDot = document.getElementById("deviceDot");
const sideDeviceDot = document.getElementById("sideDeviceDot");
const deviceStatus = document.getElementById("deviceStatus");
const profileModal = document.getElementById("profileModal");
const settingsModal = document.getElementById("settingsModal");
const authModal = document.getElementById("authModal");
const profileName = document.getElementById("profileName");
const profileEmail = document.getElementById("profileEmail");
const accountStatus = document.getElementById("accountStatus");

function getToken() {
    return localStorage.getItem(TOKEN_KEY);
}

function setToken(token) {
    if (token) {
        localStorage.setItem(TOKEN_KEY, token);
    } else {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USER_KEY);
    }
}

function cacheUser(user) {
    currentUser = user || null;
    if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
    else localStorage.removeItem(USER_KEY);
}

function getCachedUser() {
    try { return JSON.parse(localStorage.getItem(USER_KEY) || "null"); }
    catch { return null; }
}

function authHeaders(json = false) {
    const headers = {};
    if (json) headers["Content-Type"] = "application/json";
    const token = getToken();
    if (token) headers.Authorization = "Bearer " + token;
    return headers;
}

async function api(path, options = {}) {
    const response = await fetch(BASE_URL + path, {
        ...options,
        headers: {
            ...authHeaders(Boolean(options.body)),
            ...(options.headers || {})
        }
    });

    let data = {};
    try { data = await response.json(); } catch {}

    if (!response.ok) {
        const error = new Error(data.error || "Request failed");
        error.status = response.status;
        throw error;
    }
    return data;
}

function getSettings() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}"); } catch {}
    return {
        autoDevice: true,
        enterSend: true,
        ...saved
    };
}

function saveSettings(settings) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function initials(name) {
    const clean = (name || "Guest").trim();
    return clean ? clean.charAt(0).toUpperCase() : "G";
}

// ------------------------------------------------------------
// AUTH
// ------------------------------------------------------------

function showAuth(mode = "login", message = "") {
    authModal.classList.add("open");
    setAuthMode(mode);
    const status = document.getElementById("authStatus");
    status.textContent = message;
}

function hideAuth() {
    authModal.classList.remove("open");
}

function setAuthMode(mode) {
    const login = mode === "login";
    document.getElementById("loginForm").style.display = login ? "block" : "none";
    document.getElementById("registerForm").style.display = login ? "none" : "block";
    document.getElementById("loginTab").classList.toggle("active", login);
    document.getElementById("registerTab").classList.toggle("active", !login);
    document.getElementById("authTitle").textContent = login ? "Welcome back" : "Create your JARVIS account";
    document.getElementById("authSubtitle").textContent = login
        ? "Sign in to access your saved conversations and profile."
        : "Your conversations will be stored in your JARVIS account.";
}

async function login() {
    const email = document.getElementById("loginEmail").value.trim();
    const password = document.getElementById("loginPassword").value;
    const status = document.getElementById("authStatus");
    const button = document.getElementById("loginSubmit");

    if (!email || !password) {
        status.textContent = "Enter your email and password.";
        return;
    }

    button.disabled = true;
    status.textContent = "Signing in...";

    try {
        const data = await api("/auth/login", {
            method: "POST",
            body: JSON.stringify({ email, password })
        });
        setToken(data.token);
        cacheUser(data.user);
        hideAuth();
        await loadAccount();
    } catch (error) {
        status.textContent = error.message;
    } finally {
        button.disabled = false;
    }
}

async function register() {
    const name = document.getElementById("registerName").value.trim();
    const email = document.getElementById("registerEmail").value.trim();
    const password = document.getElementById("registerPassword").value;
    const confirm = document.getElementById("registerConfirm").value;
    const status = document.getElementById("authStatus");
    const button = document.getElementById("registerSubmit");

    if (!name || !email || !password || !confirm) {
        status.textContent = "Complete all fields.";
        return;
    }
    if (password !== confirm) {
        status.textContent = "Passwords do not match.";
        return;
    }
    if (password.length < 8) {
        status.textContent = "Password must be at least 8 characters.";
        return;
    }

    button.disabled = true;
    status.textContent = "Creating account...";

    try {
        const data = await api("/auth/register", {
            method: "POST",
            body: JSON.stringify({ name, email, password })
        });
        setToken(data.token);
        cacheUser(data.user);
        hideAuth();
        await loadAccount();
    } catch (error) {
        status.textContent = error.message;
    } finally {
        button.disabled = false;
    }
}

async function logout() {
    try {
        await api("/auth/logout", { method: "POST" });
    } catch {}

    setToken(null);
    cacheUser(null);
    conversations = [];
    currentConversationId = null;
    renderConversationList();
    renderCurrentConversation();
    updateProfileUI();
    showAuth("login", "You have been signed out.");
}

// ------------------------------------------------------------
// ACCOUNT / CONVERSATIONS
// ------------------------------------------------------------

async function loadAccount() {
    const token = getToken();
    if (!token) {
        currentUser = null;
        showAuth("login");
        return false;
    }

    // Restore the cached profile immediately so refresh does not flash the login screen.
    currentUser = getCachedUser();
    updateProfileUI();

    try {
        const me = await api("/auth/me");
        cacheUser(me.user);
        updateProfileUI();

        // Load the list first; do not block the UI by opening a conversation automatically.
        const data = await api("/conversations");
        conversations = data.conversations || [];
        currentConversationId = conversations[0]?.id || null;
        renderConversationList();

        if (currentConversationId) {
            // Load the first conversation after the shell is already rendered.
            requestAnimationFrame(() => openConversation(currentConversationId));
        } else {
            renderCurrentConversation();
        }
        return true;
    } catch (error) {
        // Only invalidate the session when the server explicitly rejects it.
        if (error.status === 401) {
            setToken(null);
            currentUser = null;
            showAuth("login", "Your session expired. Please sign in again.");
            return false;
        }
        console.warn("Account restore failed temporarily:", error);
        // Keep the cached account visible during transient network errors.
        renderConversationList();
        renderCurrentConversation();
        return true;
    }
}

async function createConversation(title = "New conversation") {
    try {
        const data = await api("/conversations", {
            method: "POST",
            body: JSON.stringify({ title })
        });
        const conversation = data.conversation;
        conversations.unshift(conversation);
        currentConversationId = conversation.id;
        renderConversationList();
        renderCurrentConversation();
        return conversation;
    } catch (error) {
        console.error(error);
        return null;
    }
}

async function openConversation(id) {
    try {
        const data = await api("/conversations/" + encodeURIComponent(id));
        currentConversationId = id;
        const conversation = conversations.find(c => c.id === id);
        if (conversation && data.conversation) Object.assign(conversation, data.conversation);

        chat.innerHTML = "";
        const messages = data.messages || [];
        welcome.style.display = messages.length ? "none" : "block";
        messages.forEach(message => {
            addMessageElement(message.role === "assistant" ? "jarvis" : message.role, message.content);
        });
        renderConversationList();
        scrollChat();
    } catch (error) {
        console.error(error);
    }
}

function renderConversationList() {
    conversationList.innerHTML = "";
    if (!conversations.length) {
        const empty = document.createElement("div");
        empty.className = "conversation-item";
        empty.style.cursor = "default";
        empty.innerHTML = '<span class="conv-icon">⌁</span><span class="conv-title">No conversations yet</span>';
        conversationList.appendChild(empty);
        return;
    }

    conversations.slice(0, 50).forEach(conversation => {
        const button = document.createElement("button");
        button.className = "conversation-item" + (conversation.id === currentConversationId ? " active" : "");
        button.innerHTML = '<span class="conv-icon">◌</span><span class="conv-title"></span>';
        button.querySelector(".conv-title").textContent = conversation.title || "New conversation";
        button.addEventListener("click", () => {
            openConversation(conversation.id);
            closeSidebarMobile();
        });
        conversationList.appendChild(button);
    });
}

function renderCurrentConversation() {
    chat.innerHTML = "";
    welcome.style.display = "block";
    scrollChat();
}

// ------------------------------------------------------------
// CHAT UI
// ------------------------------------------------------------

function addMessageElement(role, text) {
    const message = document.createElement("div");
    message.className = "message " + role;

    const avatar = document.createElement("div");
    avatar.className = "message-avatar";
    avatar.textContent = role === "user" ? initials(currentUser?.name) : "J";

    const body = document.createElement("div");
    body.className = "message-body";

    const name = document.createElement("div");
    name.className = "message-name";
    name.textContent = role === "user" ? (currentUser?.name || "YOU").toUpperCase() : "JARVIS";

    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = text;

    body.appendChild(name);
    body.appendChild(bubble);
    message.appendChild(avatar);
    message.appendChild(body);
    chat.appendChild(message);
    return bubble;
}

function addThinkingMessage() {
    welcome.style.display = "none";
    const message = document.createElement("div");
    message.className = "message jarvis";
    message.innerHTML = '<div class="message-avatar">J</div><div class="message-body"><div class="message-name">JARVIS</div><div class="bubble"><span class="typing"><span></span><span></span><span></span></span></div></div>';
    chat.appendChild(message);
    scrollChat();
    return message.querySelector(".bubble");
}

function scrollChat() {
    requestAnimationFrame(() => chatArea.scrollTop = chatArea.scrollHeight);
}

// ------------------------------------------------------------
// AI
// ------------------------------------------------------------

async function askJarvis(prompt) {
    if (!prompt || isSending || !currentUser) return;

    if (!currentConversationId) {
        const conversation = await createConversation(prompt.slice(0, 60));
        if (!conversation) return;
    }

    input.value = "";
    resizeInput();
    welcome.style.display = "none";
    addMessageElement("user", prompt);

    isSending = true;
    send.disabled = true;
    aiDot.classList.remove("offline");
    aiStatus.textContent = "THINKING";
    const thinkingBubble = addThinkingMessage();

    try {
        const data = await api("/ask", {
            method: "POST",
            body: JSON.stringify({
                prompt,
                conversation_id: currentConversationId
            })
        });

        thinkingBubble.textContent = data.response || "No response received.";
        if (data.command) thinkingBubble.classList.add("command-success");
        aiStatus.textContent = "AI READY";

        const conversation = conversations.find(c => c.id === currentConversationId);
        if (conversation) {
            conversation.updated_at = Date.now();
            conversations.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
        }
        renderConversationList();
    } catch (error) {
        console.error(error);
        thinkingBubble.textContent = error.status === 401
            ? "Your session expired. Please sign in again."
            : "I could not connect to the JARVIS AI server.";
        aiDot.classList.add("offline");
        aiStatus.textContent = "AI OFFLINE";
        if (error.status === 401) {
            setToken(null);
            currentUser = null;
            showAuth("login", "Please sign in again.");
        }
    } finally {
        isSending = false;
        send.disabled = false;
        scrollChat();
        input.focus();
    }
}

// ------------------------------------------------------------
// PROFILE UI
// ------------------------------------------------------------

function updateProfileUI() {
    const name = currentUser?.name || "Guest";
    const email = currentUser?.email || "Sign in to JARVIS";

    document.getElementById("sidebarName").textContent = name;
    document.getElementById("sidebarEmail").textContent = email;
    document.getElementById("sidebarAvatar").textContent = initials(name);
    document.getElementById("topProfile").textContent = initials(name);

    document.querySelectorAll(".message.user .message-avatar").forEach(el => el.textContent = initials(name));
    document.querySelectorAll(".message.user .message-name").forEach(el => el.textContent = name.toUpperCase());
}

function openProfile() {
    if (!currentUser) {
        showAuth("login");
        return;
    }
    profileName.value = currentUser.name || "";
    profileEmail.value = currentUser.email || "";
    accountStatus.textContent = "Account stored securely in JARVIS D1.";
    profileModal.classList.add("open");
}

// ------------------------------------------------------------
// EVENTS
// ------------------------------------------------------------

document.querySelectorAll("[data-prompt]").forEach(button => {
    button.addEventListener("click", () => askJarvis(button.dataset.prompt));
});

document.getElementById("send").addEventListener("click", () => askJarvis(input.value.trim()));

input.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey && getSettings().enterSend) {
        event.preventDefault();
        askJarvis(input.value.trim());
    }
});
input.addEventListener("input", resizeInput);

function resizeInput() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 150) + "px";
}

document.getElementById("newChat").addEventListener("click", async () => {
    if (!currentUser) return showAuth("login");
    await createConversation();
    closeSidebarMobile();
    input.focus();
});

document.getElementById("profileBtn").addEventListener("click", openProfile);
document.getElementById("topProfile").addEventListener("click", openProfile);
document.getElementById("loginTab").addEventListener("click", () => setAuthMode("login"));
document.getElementById("registerTab").addEventListener("click", () => setAuthMode("register"));
document.getElementById("loginSubmit").addEventListener("click", login);
document.getElementById("registerSubmit").addEventListener("click", register);
document.getElementById("logoutBtn").addEventListener("click", async () => {
    profileModal.classList.remove("open");
    await logout();
});

document.getElementById("saveProfile").addEventListener("click", () => {
    accountStatus.textContent = "Profile changes are currently managed by the account backend.";
});

document.getElementById("clearLocalData").addEventListener("click", () => {
    localStorage.removeItem(SETTINGS_KEY);
    accountStatus.textContent = "Only local UI settings were cleared. Your D1 account and conversations remain safe.";
});

// Settings
function loadSettingsUI() {
    const settings = getSettings();
    document.getElementById("autoDevice").checked = settings.autoDevice;
    document.getElementById("enterSend").checked = settings.enterSend;
}

document.getElementById("settingsBtn").addEventListener("click", () => {
    loadSettingsUI();
    settingsModal.classList.add("open");
});
document.getElementById("autoDevice").addEventListener("change", event => {
    const settings = getSettings();
    settings.autoDevice = event.target.checked;
    saveSettings(settings);
    if (settings.autoDevice) startDevicePolling();
    else if (deviceTimer) { clearInterval(deviceTimer); deviceTimer = null; }
});
document.getElementById("enterSend").addEventListener("change", event => {
    const settings = getSettings();
    settings.enterSend = event.target.checked;
    saveSettings(settings);
});

document.querySelectorAll("[data-close]").forEach(button => {
    button.addEventListener("click", () => document.getElementById(button.dataset.close).classList.remove("open"));
});
[profileModal, settingsModal, authModal].forEach(modal => {
    modal.addEventListener("click", event => {
        if (event.target === modal && modal !== authModal) modal.classList.remove("open");
    });
});

// Device status
async function checkDeviceStatus() {
    try {
        const response = await fetch(STATUS_URL + "&t=" + Date.now(), { cache: "no-store" });
        if (!response.ok) throw new Error();
        const data = await response.json();
        data.online ? setDeviceOnline(data) : setDeviceOffline();
    } catch (error) {
        console.warn("ESP32 status check failed:", error);
        // Do not instantly flip a known-online device to offline because of one
        // transient network/KV read failure. The next poll will correct it.
    }
}

function setDeviceOnline(data) {
    deviceDot.classList.remove("offline");
    sideDeviceDot.classList.remove("offline");
    deviceStatus.textContent = "ESP32 ONLINE";
    document.getElementById("devicePanelStatus").textContent = "Online";
    document.getElementById("devicePanelSub").textContent = "Connected to JARVIS";
    document.getElementById("deviceIcon").classList.add("online");
    document.getElementById("deviceIP").textContent = data.ip || "—";
    document.getElementById("deviceRSSI").textContent = data.rssi !== undefined ? data.rssi + " dBm" : "—";
    document.getElementById("deviceLastSeen").textContent = new Date().toLocaleTimeString();
    document.getElementById("devicePill").title = DEVICE_ID;
}

function setDeviceOffline() {
    deviceDot.classList.add("offline");
    sideDeviceDot.classList.add("offline");
    deviceStatus.textContent = "ESP32 OFFLINE";
    document.getElementById("devicePanelStatus").textContent = "Offline";
    document.getElementById("devicePanelSub").textContent = "Waiting for device";
    document.getElementById("deviceIcon").classList.remove("online");
    document.getElementById("deviceIP").textContent = "—";
    document.getElementById("deviceRSSI").textContent = "—";
    document.getElementById("deviceLastSeen").textContent = "—";
}

function startDevicePolling() {
    if (deviceTimer) clearInterval(deviceTimer);
    checkDeviceStatus();
    if (getSettings().autoDevice) deviceTimer = setInterval(() => {
        if (document.visibilityState === "visible") checkDeviceStatus();
    }, 10000);
}

document.getElementById("deviceBtn").addEventListener("click", () => {
    document.getElementById("devicePanel").classList.add("open");
    checkDeviceStatus();
});
document.getElementById("devicePill").addEventListener("click", () => {
    document.getElementById("devicePanel").classList.add("open");
    checkDeviceStatus();
});
document.getElementById("closeDevice").addEventListener("click", () => document.getElementById("devicePanel").classList.remove("open"));

// Mobile
 document.getElementById("openSidebar").addEventListener("click", () => {
    sidebar.classList.add("open");
    sidebarOverlay.classList.add("open");
});
document.getElementById("closeSidebar").addEventListener("click", closeSidebarMobile);
sidebarOverlay.addEventListener("click", closeSidebarMobile);
function closeSidebarMobile() {
    sidebar.classList.remove("open");
    sidebarOverlay.classList.remove("open");
}

// Voice
const micBtn = document.getElementById("micBtn");
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SpeechRecognition) {
    const recognition = new SpeechRecognition();
    recognition.lang = "en-US";
    recognition.continuous = false;
    recognition.interimResults = false;
    micBtn.addEventListener("click", () => {
        try { recognition.start(); micBtn.classList.add("listening"); } catch {}
    });
    recognition.onresult = event => {
        input.value = event.results[0][0].transcript;
        resizeInput();
        input.focus();
    };
    recognition.onend = () => micBtn.classList.remove("listening");
    recognition.onerror = () => micBtn.classList.remove("listening");
} else {
    micBtn.style.display = "none";
}

async function init() {
    updateProfileUI();
    loadSettingsUI();

    // Render immediately. Network work happens afterward.
    if (getToken()) {
        currentUser = getCachedUser();
        updateProfileUI();
        renderConversationList();
        renderCurrentConversation();
        loadAccount();
    } else {
        renderConversationList();
        renderCurrentConversation();
        showAuth("login");
    }

    startDevicePolling();
    input.focus();
}

init();
