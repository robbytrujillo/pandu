/**
 * script.js — Pandu Chatbot Logic
 * Menghubungkan UI ke Langflow via MCP Streamable HTTP (JSON-RPC over SSE)
 *
 * Protokol:
 *  - POST ke endpoint MCP Streamable HTTP dengan body JSON-RPC 2.0
 *  - Response dikembalikan sebagai Server-Sent Events (SSE)
 *  - Tool yang dipanggil: qna_pedoman_siswa_sma_ihbs
 *
 * Arsitektur:
 *  - Semua state disimpan dalam objek `state`
 *  - Fungsi diberi nama eksplisit dan dikomentari
 *  - Tidak menggunakan library eksternal apapun
 */

"use strict";

/* ============================================================
   KONFIGURASI MCP — Langflow Streamable HTTP
   ============================================================ */

const API_CONFIG = {
  /**
   * Endpoint MCP Streamable HTTP Langflow.
   * Format: /api/v1/mcp/project/{project_id}/streamable
   */
  mcpUrl:
    "http://127.0.0.1:7860/api/v1/mcp/project/31a9c7a1-3185-4fab-9bcb-6345b3375770/streamable",

  /** API Key untuk header x-api-key */
  apiKey: "sk-NAM30YykXagezhm6LuJC6-aU5RV7LDF1nx3f5y8vqK0",

  /** Nama tool MCP yang tersedia di project ini */
  toolName: "qna_pedoman_siswa_sma_ihbs",

  /** Session ID persisten selama sesi browser (untuk konteks percakapan) */
  sessionId: generateSessionId(),

  /** Counter untuk JSON-RPC request ID (harus unik per request) */
  _rpcIdCounter: 1,
};

/** Menghasilkan JSON-RPC request ID yang unik dan auto-increment. */
function nextRpcId() {
  return API_CONFIG._rpcIdCounter++;
}

/**
 * Membuat session ID unik berbasis timestamp + random string.
 * @returns {string}
 */
function generateSessionId() {
  return "pandu-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

/* ============================================================
   STATE APLIKASI
   ============================================================ */

const state = {
  /** Apakah sedang menunggu respons AI */
  isLoading: false,
  /** Apakah pesan pertama sudah dikirim (untuk sembunyikan welcome card) */
  hasStarted: false,
};

/* ============================================================
   REFERENSI ELEMEN DOM
   ============================================================ */

const chatContainer = document.getElementById("chat-container");
const chatForm      = document.getElementById("chat-form");
const userInput     = document.getElementById("user-input");
const sendBtn       = document.getElementById("send-btn");
const welcomeCard   = document.getElementById("welcome-card");
const themeToggle   = document.getElementById("theme-toggle");
const chips         = document.querySelectorAll(".chip");

/* ============================================================
   TEMA — DARK / LIGHT MODE
   ============================================================ */

/**
 * Kunci localStorage untuk menyimpan preferensi tema user.
 */
const THEME_KEY = "pandu-theme";

/**
 * Menerapkan tema ke elemen <html> via atribut data-theme.
 * @param {"light"|"dark"} theme
 */
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  // Perbarui aria-label tombol toggle agar aksesibel
  themeToggle.setAttribute(
    "aria-label",
    theme === "dark" ? "Ganti ke tema terang" : "Ganti ke tema gelap"
  );
}

/**
 * Membaca preferensi tema dari localStorage.
 * Fallback ke preferensi sistem OS jika belum pernah dipilih.
 * @returns {"light"|"dark"}
 */
function getSavedTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === "light" || saved === "dark") return saved;
  // Ikuti preferensi OS (prefers-color-scheme)
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/**
 * Toggle tema antara light dan dark, lalu simpan ke localStorage.
 */
function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme") || "light";
  const next    = current === "dark" ? "light" : "dark";
  applyTheme(next);
  localStorage.setItem(THEME_KEY, next);
}

/* ============================================================
   INISIALISASI
   ============================================================ */

/** Jalankan setelah DOM siap */
function init() {
  // Terapkan tema tersimpan sebelum render (cegah flash)
  applyTheme(getSavedTheme());

  // Isi tahun copyright otomatis
  const yearEl = document.getElementById("copyright-year");
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  // Event: tombol toggle tema
  themeToggle.addEventListener("click", toggleTheme);

  // Event: submit form (klik tombol kirim)
  chatForm.addEventListener("submit", handleFormSubmit);

  // Event: tekan Enter untuk kirim, Shift+Enter untuk baris baru
  userInput.addEventListener("keydown", handleInputKeydown);

  // Event: auto-resize textarea saat mengetik
  userInput.addEventListener("input", autoResizeTextarea);

  // Event: klik suggestion chip
  chips.forEach((chip) => {
    chip.addEventListener("click", () => handleChipClick(chip));
  });

  // Fokus ke input saat halaman dimuat
  userInput.focus();
}

/* ============================================================
   EVENT HANDLERS
   ============================================================ */

/**
 * Menangani submit form chatbot.
 * @param {SubmitEvent} event
 */
function handleFormSubmit(event) {
  event.preventDefault();
  sendMessage();
}

/**
 * Menangani keydown pada textarea:
 *   Enter          → kirim pesan
 *   Shift + Enter  → baris baru
 * @param {KeyboardEvent} event
 */
function handleInputKeydown(event) {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
}

/**
 * Menangani klik pada chip saran pertanyaan.
 * Mengisi textarea dengan teks chip dan langsung mengirim.
 * @param {HTMLButtonElement} chip
 */
function handleChipClick(chip) {
  const text = chip.dataset.text;
  if (!text) return;
  userInput.value = text;
  autoResizeTextarea();
  sendMessage();
}

/* ============================================================
   LOGIKA KIRIM PESAN
   ============================================================ */

/**
 * Membaca input, menampilkan pesan user, lalu memanggil API AI.
 */
async function sendMessage() {
  const messageText = userInput.value.trim();
  if (!messageText || state.isLoading) return;

  // Sembunyikan welcome card saat percakapan dimulai
  if (!state.hasStarted) {
    hideWelcomeCard();
    state.hasStarted = true;
  }

  // Tampilkan pesan user di UI
  appendUserMessage(messageText);

  // Bersihkan input & reset ukuran textarea
  userInput.value = "";
  autoResizeTextarea();

  // Tampilkan indikator typing AI
  const typingEl = appendTypingIndicator();

  // Nonaktifkan input selama loading
  setLoadingState(true);

  try {
    // Panggil API dan dapatkan respons
    const aiReply = await fetchAIResponse(messageText);
    removeTypingIndicator(typingEl);
    appendAIMessage(aiReply);
  } catch (error) {
    removeTypingIndicator(typingEl);
    appendAIMessage(
      "Maaf, terjadi kesalahan saat menghubungi server. Silakan coba lagi."
    );
    console.error("[Pandu] Error fetching AI response:", error);
  } finally {
    setLoadingState(false);
    userInput.focus();
  }
}

/* ============================================================
   API CALL — MCP Streamable HTTP (JSON-RPC 2.0 over SSE)
   ============================================================ */

/**
 * Memanggil tool Langflow via MCP Streamable HTTP dan mengembalikan teks respons.
 *
 * Protokol MCP Streamable HTTP:
 *  1. POST JSON-RPC 2.0 ke endpoint /streamable
 *  2. Response berupa text/event-stream (SSE) dengan format:
 *       event: message
 *       data: {"jsonrpc":"2.0","id":N,"result":{...}}
 *  3. Baca stream baris per baris, parse "data:" lines sebagai JSON
 *  4. Ekstrak teks dari result.content[].text
 *
 * @param {string} userMessage - Teks pertanyaan user
 * @returns {Promise<string>} - Teks jawaban AI
 */
async function fetchAIResponse(userMessage) {
  // Buat body JSON-RPC 2.0 untuk memanggil tool MCP
  const rpcBody = {
    jsonrpc: "2.0",
    id: nextRpcId(),
    method: "tools/call",
    params: {
      name: API_CONFIG.toolName,
      arguments: {
        input_value:          userMessage,
        sender:               "User",
        sender_name:          "Siswa",
        session_id:           API_CONFIG.sessionId,
        should_store_message: true,
      },
    },
  };

  const response = await fetch(API_CONFIG.mcpUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept":        "application/json, text/event-stream",
      "x-api-key":     API_CONFIG.apiKey,
    },
    body: JSON.stringify(rpcBody),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  // Baca SSE stream dan kumpulkan semua event "data:" menjadi teks
  return await readMcpSseStream(response);
}

/**
 * Membaca response SSE (Server-Sent Events) dari MCP endpoint baris per baris.
 * Mengumpulkan semua event JSON-RPC dan mengekstrak teks dari result.content[].text
 *
 * Format SSE yang diharapkan:
 *   event: message
 *   data: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"..."}]}}
 *
 * @param {Response} response - Fetch Response object dengan body SSE
 * @returns {Promise<string>} - Teks hasil yang digabung
 */
async function readMcpSseStream(response) {
  const reader  = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer    = "";
  let resultText = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    // Decode chunk dan tambahkan ke buffer
    buffer += decoder.decode(value, { stream: true });

    // Proses baris-baris yang sudah lengkap (diakhiri \n)
    const lines = buffer.split("\n");
    // Simpan baris terakhir yang mungkin belum lengkap
    buffer = lines.pop();

    for (const line of lines) {
      const trimmed = line.trim();

      // Baris SSE yang membawa data dimulai dengan "data:"
      if (!trimmed.startsWith("data:")) continue;

      const jsonStr = trimmed.slice(5).trim(); // hapus prefix "data:"
      if (!jsonStr || jsonStr === "[DONE]") continue;

      try {
        const rpcMsg = JSON.parse(jsonStr);
        const extracted = extractTextFromMcpResult(rpcMsg);
        if (extracted) resultText += extracted;
      } catch {
        // Abaikan baris yang bukan JSON valid
      }
    }
  }

  // Proses sisa buffer setelah stream selesai
  if (buffer.trim().startsWith("data:")) {
    try {
      const jsonStr = buffer.trim().slice(5).trim();
      const rpcMsg  = JSON.parse(jsonStr);
      const extracted = extractTextFromMcpResult(rpcMsg);
      if (extracted) resultText += extracted;
    } catch { /* abaikan */ }
  }

  return resultText.trim() || "Maaf, saya tidak mendapatkan respons dari server.";
}

/**
 * Mengekstrak teks dari berbagai kemungkinan struktur respons JSON-RPC MCP.
 *
 * Langflow MCP mengembalikan dua kemungkinan struktur result:
 *  A. result.content[].text  (format MCP tool result standar)
 *  B. result.output          (format alternatif Langflow)
 *
 * @param {Object} rpcMsg - Objek JSON-RPC yang sudah di-parse
 * @returns {string} - Teks yang diekstrak, atau string kosong
 */
function extractTextFromMcpResult(rpcMsg) {
  // Jika ada error JSON-RPC, lempar sebagai Error
  if (rpcMsg?.error) {
    throw new Error(`MCP Error ${rpcMsg.error.code}: ${rpcMsg.error.message}`);
  }

  const result = rpcMsg?.result;
  if (!result) return "";

  // Format A: result.content adalah array of {type, text}
  if (Array.isArray(result.content)) {
    return result.content
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text)
      .join("");
  }

  // Format B: result.output langsung berupa string
  if (typeof result.output === "string") {
    return result.output;
  }

  // Format C: result sendiri adalah string
  if (typeof result === "string") {
    return result;
  }

  return "";
}

/* ============================================================
   RENDER PESAN DI UI
   ============================================================ */

/**
 * Menampilkan gelembung pesan dari user di chat container.
 * @param {string} text - Teks pesan user
 */
function appendUserMessage(text) {
  const row = document.createElement("div");
  row.className = "msg-row-user";

  row.innerHTML = `
    <div class="bubble-user">${escapeHtml(text)}</div>
    <div class="avatar avatar-user" aria-hidden="true">S</div>
  `;

  chatContainer.appendChild(row);
  scrollToBottom();
}

/**
 * Menampilkan gelembung respons AI di chat container.
 * Mendukung rendering Markdown sederhana.
 * @param {string} markdownText - Teks respons AI (bisa berisi Markdown)
 */
function appendAIMessage(markdownText) {
  const row = document.createElement("div");
  row.className = "msg-row-ai";

  row.innerHTML = `
    <div class="avatar avatar-ai" aria-hidden="true">AI</div>
    <div class="bubble-ai">${renderMarkdown(markdownText)}</div>
  `;

  chatContainer.appendChild(row);
  scrollToBottom();
}

/**
 * Menampilkan animasi typing (tiga titik bouncing) saat AI memproses.
 * @returns {HTMLElement} - Elemen typing indicator (untuk dihapus nanti)
 */
function appendTypingIndicator() {
  const row = document.createElement("div");
  row.className = "msg-row-ai";
  row.id = "typing-row";

  row.innerHTML = `
    <div class="avatar avatar-ai" aria-hidden="true">AI</div>
    <div class="typing-indicator" aria-label="AI sedang mengetik">
      <span class="typing-dot"></span>
      <span class="typing-dot"></span>
      <span class="typing-dot"></span>
    </div>
  `;

  chatContainer.appendChild(row);
  scrollToBottom();
  return row;
}

/**
 * Menghapus elemen typing indicator dari DOM.
 * @param {HTMLElement} el - Elemen yang akan dihapus
 */
function removeTypingIndicator(el) {
  if (el && el.parentNode) {
    el.parentNode.removeChild(el);
  }
}

/* ============================================================
   UTILITAS UI
   ============================================================ */

/**
 * Mengaktifkan atau menonaktifkan state loading pada input & tombol kirim.
 * @param {boolean} loading
 */
function setLoadingState(loading) {
  state.isLoading = loading;
  sendBtn.disabled = loading;
  userInput.disabled = loading;
}

/**
 * Menyembunyikan welcome card dengan animasi fade-out.
 */
function hideWelcomeCard() {
  welcomeCard.style.transition = "opacity 0.3s ease, max-height 0.4s ease";
  welcomeCard.style.opacity = "0";
  welcomeCard.style.maxHeight = welcomeCard.offsetHeight + "px";
  setTimeout(() => {
    welcomeCard.style.maxHeight = "0";
    welcomeCard.style.overflow = "hidden";
    welcomeCard.style.padding = "0";
    welcomeCard.style.margin = "0";
    welcomeCard.style.border = "none";
  }, 300);
}

/**
 * Menggulir chat container ke paling bawah (pesan terbaru).
 * Menggunakan smooth scroll untuk UX yang lebih baik.
 */
function scrollToBottom() {
  chatContainer.scrollTo({
    top: chatContainer.scrollHeight,
    behavior: "smooth",
  });
  // Fallback untuk browser lama
  setTimeout(() => {
    chatContainer.scrollTop = chatContainer.scrollHeight;
  }, 100);
}

/**
 * Auto-resize textarea mengikuti jumlah baris konten.
 * Batas maksimum: 144px (diatur via Tailwind max-h-36).
 */
function autoResizeTextarea() {
  userInput.style.height = "auto";
  userInput.style.height = Math.min(userInput.scrollHeight, 144) + "px";
}

/* ============================================================
   MARKDOWN RENDERER (ringan, tanpa library)
   ============================================================ */

/**
 * Mengubah teks Markdown sederhana menjadi HTML aman.
 * Mendukung: bold, italic, kode inline, heading, list, baris baru.
 * @param {string} text - Teks Markdown
 * @returns {string} - HTML string
 */
function renderMarkdown(text) {
  // 1. Escape HTML terlebih dahulu untuk keamanan
  let html = escapeHtml(text);

  // 2. Heading: ### ## #
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.+)$/gm,  "<h2>$1</h2>");
  html = html.replace(/^# (.+)$/gm,   "<h1>$1</h1>");

  // 3. Bold & Italic: **text**, *text*
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.+?)\*/g,     "<em>$1</em>");

  // 4. Kode inline: `code`
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

  // 5. List item (*, -, •)
  html = html.replace(/^[\*\-•]\s+(.+)$/gm, "<li>$1</li>");
  // Bungkus blok <li> berurutan dengan <ul>
  html = html.replace(/(<li>.*<\/li>(\n|$))+/gs, (match) => "<ul>" + match + "</ul>");

  // 6. List item bernomor (1. 2. dst)
  html = html.replace(/^\d+\.\s+(.+)$/gm, "<li>$1</li>");

  // 7. Baris kosong → paragraf
  html = html
    .split(/\n{2,}/)
    .map((para) => {
      const trimmed = para.trim();
      // Jangan bungkus elemen blok dengan <p>
      if (!trimmed) return "";
      if (/^<(h[1-3]|ul|ol|li|pre|blockquote)/.test(trimmed)) return trimmed;
      return "<p>" + trimmed.replace(/\n/g, "<br />") + "</p>";
    })
    .join("\n");

  return html;
}

/**
 * Meng-escape karakter HTML khusus untuk mencegah XSS.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  return str
    .replace(/&/g,  "&amp;")
    .replace(/</g,  "&lt;")
    .replace(/>/g,  "&gt;")
    .replace(/"/g,  "&quot;")
    .replace(/'/g,  "&#39;");
}

/* ============================================================
   BOOTSTRAP
   ============================================================ */

// Jalankan inisialisasi setelah DOM selesai dimuat
document.addEventListener("DOMContentLoaded", init);
