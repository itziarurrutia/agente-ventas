"use strict";

const messagesEl = document.getElementById("messages");
const welcomeEl = document.getElementById("welcome");
const form = document.getElementById("composer");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send");
const newChatBtn = document.getElementById("new-chat");
const toolTemplate = document.getElementById("tool-template");

let conversationId = null;
let busy = false;

// ---------- Markdown mínimo y seguro (escapa todo el HTML primero) ----------

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function inline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
}

function splitRow(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

function renderMarkdown(src) {
  const lines = src.replace(/\r/g, "").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith("```")) {
      const code = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) code.push(lines[i++]);
      i++;
      out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = Math.min(heading[1].length + 2, 6); // h3..h6 dentro de la burbuja
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    if (line.trim().startsWith("|") && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || "")) {
      const header = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(splitRow(lines[i++]));
      out.push(
        "<table><thead><tr>" + header.map((h) => `<th>${inline(h)}</th>`).join("") + "</tr></thead><tbody>" +
        rows.map((r) => "<tr>" + r.map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>").join("") +
        "</tbody></table>"
      );
      continue;
    }

    const listMatch = line.match(/^\s*([-*+]|\d+\.)\s+/);
    if (listMatch) {
      const ordered = /\d/.test(listMatch[1]);
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        items.push(`<li>${inline(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, ""))}</li>`);
        i++;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }

    if (/^\s*(---|\*\*\*)\s*$/.test(line)) { out.push("<hr>"); i++; continue; }
    if (!line.trim()) { i++; continue; }

    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\s*\||\s*([-*+]|\d+\.)\s)/.test(lines[i])) {
      para.push(inline(lines[i++]));
    }
    if (para.length === 0) para.push(inline(lines[i++])); // línea que no encaja en nada
    out.push(`<p>${para.join("<br>")}</p>`);
  }
  return out.join("");
}

// ---------- Tabla con el resultado de query_sales ----------

const numberFormat = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 2 });

function renderRows(rows) {
  if (!rows.length) return "<p>Sin filas.</p>";
  const cols = Object.keys(rows[0]);
  const cell = (v) => (typeof v === "number" ? numberFormat.format(v) : escapeHtml(String(v ?? "")));
  return (
    "<table><thead><tr>" + cols.map((c) => `<th>${escapeHtml(c)}</th>`).join("") + "</tr></thead><tbody>" +
    rows.map((r) => "<tr>" + cols.map((c) => `<td>${cell(r[c])}</td>`).join("") + "</tr>").join("") +
    "</tbody></table>"
  );
}

// ---------- Mensajes en pantalla ----------

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addUserMessage(text) {
  welcomeEl.hidden = true;
  const msg = document.createElement("div");
  msg.className = "msg user";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text;
  msg.append(bubble);
  messagesEl.append(msg);
  scrollToBottom();
}

/** Respuesta del asistente: una secuencia de bloques de texto y de consultas SQL. */
function createAssistantMessage() {
  const msg = document.createElement("div");
  msg.className = "msg assistant";
  const bubble = document.createElement("div");
  bubble.className = "bubble typing";
  msg.append(bubble);
  messagesEl.append(msg);
  scrollToBottom();

  const tools = new Map();
  let textEl = null;
  let text = "";
  let frame = 0;

  const flush = () => {
    frame = 0;
    if (textEl) textEl.innerHTML = renderMarkdown(text);
    scrollToBottom();
  };

  return {
    appendText(delta) {
      if (!textEl) {
        textEl = document.createElement("div");
        textEl.className = "content";
        bubble.append(textEl);
        text = "";
      }
      text += delta;
      if (!frame) frame = requestAnimationFrame(flush);
    },
    startTool(id, sql) {
      if (frame) { cancelAnimationFrame(frame); flush(); }
      textEl = null; // el texto posterior va en un bloque nuevo, debajo de la consulta
      const node = toolTemplate.content.firstElementChild.cloneNode(true);
      node.querySelector(".tool-sql").textContent = sql || "(sin SQL)";
      bubble.append(node);
      tools.set(id, node);
      scrollToBottom();
    },
    endTool(id, success, result, error) {
      const node = tools.get(id);
      if (!node) return;
      const meta = node.querySelector(".tool-meta");
      const resultEl = node.querySelector(".tool-result");
      let data = null;
      try { data = result ? JSON.parse(result) : null; } catch { /* no es JSON */ }
      const failure = error || (data && data.error);
      node.querySelector(".tool-status").textContent = success && !failure ? "✅" : "⚠️";
      if (failure) {
        meta.textContent = "· error";
        meta.className = "tool-meta fail";
        resultEl.innerHTML = `<p>${escapeHtml(failure)}</p>`;
      } else if (data && Array.isArray(data.rows)) {
        meta.textContent = `· ${data.count} fila${data.count === 1 ? "" : "s"}${data.truncated ? " (truncado)" : ""}`;
        meta.className = "tool-meta ok";
        resultEl.innerHTML = renderRows(data.rows);
      } else if (result) {
        resultEl.innerHTML = `<pre>${escapeHtml(result)}</pre>`;
      }
    },
    showError(message) {
      const err = document.createElement("div");
      err.className = "content";
      err.innerHTML = `<p>⚠️ ${escapeHtml(message)}</p>`;
      bubble.append(err);
      if (!text && tools.size === 0) bubble.classList.add("error");
    },
    finish() {
      if (frame) { cancelAnimationFrame(frame); flush(); }
      bubble.classList.remove("typing");
      if (!bubble.childElementCount) bubble.textContent = "(sin respuesta)";
      scrollToBottom();
    },
  };
}

// ---------- Comunicación con la API (Server-Sent Events sobre fetch) ----------

async function readEvents(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const data = chunk.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
      if (data) onEvent(JSON.parse(data));
    }
  }
}

async function ask(question) {
  if (busy) return;
  setBusy(true);
  addUserMessage(question);
  const reply = createAssistantMessage();

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversation_id: conversationId, message: question }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      if (response.status === 404) conversationId = null; // el servidor se reinició
      throw new Error(typeof body.detail === "string" ? body.detail : `Error HTTP ${response.status}`);
    }
    await readEvents(response, (event) => {
      switch (event.type) {
        case "start": conversationId = event.conversation_id; break;
        case "delta": reply.appendText(event.text); break;
        case "tool_start": reply.startTool(event.id, event.sql); break;
        case "tool_end": reply.endTool(event.id, event.success, event.result, event.error); break;
        case "error": reply.showError(event.message); break;
      }
    });
  } catch (err) {
    reply.showError(err.message || String(err));
  } finally {
    reply.finish();
    setBusy(false);
    input.focus();
  }
}

function setBusy(value) {
  busy = value;
  sendBtn.disabled = value;
  newChatBtn.disabled = value;
  document.querySelectorAll(".suggestions button").forEach((b) => (b.disabled = value));
}

function autoresize() {
  input.style.height = "auto";
  input.style.height = `${input.scrollHeight}px`;
}

// ---------- Eventos de la interfaz ----------

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const question = input.value.trim();
  if (!question || busy) return;
  input.value = "";
  autoresize();
  ask(question);
});

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    form.requestSubmit();
  }
});
input.addEventListener("input", autoresize);

document.querySelectorAll(".suggestions button").forEach((button) => {
  button.addEventListener("click", () => ask(button.textContent));
});

newChatBtn.addEventListener("click", () => {
  if (conversationId) fetch(`/api/chat/${conversationId}`, { method: "DELETE" }).catch(() => {});
  conversationId = null;
  messagesEl.querySelectorAll(".msg").forEach((m) => m.remove());
  welcomeEl.hidden = false;
  input.focus();
});

fetch("/api/info")
  .then((r) => r.json())
  .then((info) => (document.getElementById("model").textContent = info.model))
  .catch(() => {});

input.focus();
