// Frontend for the domain mail viewer. Receive-only: list, read, delete. No send.

const state = {
  items: [],
  cursor: null,      // created_at cursor for "load more"
  loading: false,
  hasMore: true,
  selectedId: null,
  query: "",
};

const els = {
  list: document.getElementById("list"),
  count: document.getElementById("count"),
  refresh: document.getElementById("refresh"),
  theme: document.getElementById("theme"),
  search: document.getElementById("search"),
  loadMore: document.getElementById("loadMore"),
  reader: document.getElementById("reader"),
};

function fmtDate(isoOrStr) {
  if (!isoOrStr) return "";
  const d = new Date(isoOrStr);
  if (isNaN(d)) return String(isoOrStr);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return Math.floor(diff / 60) + " 分钟前";
  if (diff < 86400) return Math.floor(diff / 3600) + " 小时前";
  return d.toLocaleString("zh-CN", { hour12: false });
}

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function renderList() {
  const q = state.query.toLowerCase();
  const filtered = state.items.filter((m) => {
    if (!q) return true;
    return (
      (m.from_addr || "").toLowerCase().includes(q) ||
      (m.from_name || "").toLowerCase().includes(q) ||
      (m.subject || "").toLowerCase().includes(q)
    );
  });

  els.count.textContent = state.items.length;

  if (filtered.length === 0) {
    els.list.innerHTML = `<li class="empty-state">${state.items.length ? "无匹配邮件" : "暂无邮件"}</li>`;
    return;
  }

  els.list.innerHTML = filtered
    .map((m) => {
      const active = m.id === state.selectedId ? " active" : "";
      const attach = m.attach_count > 0 ? `<span class="attach-dot">📎${m.attach_count}</span>` : "";
      return `
      <li class="mail-item${active}" data-id="${m.id}">
        <div class="mail-row1">
          <span class="mail-from">${escapeHtml(m.from_name || m.from_addr)}</span>
          <span class="mail-date">${fmtDate(m.date || m.created_at)}</span>
        </div>
        <div class="mail-subject">${escapeHtml(m.subject || "(无主题)")} ${attach}</div>
        <div class="mail-to">→ ${escapeHtml(m.to_addr || "")}</div>
      </li>`;
    })
    .join("");
}

async function loadItems(reset = false) {
  if (state.loading) return;
  if (reset) {
    state.items = [];
    state.cursor = null;
    state.hasMore = true;
  }
  if (!state.hasMore) return;

  state.loading = true;
  try {
    let url = "/api/emails?limit=50";
    if (state.cursor) url += `&before=${state.cursor}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("load failed: " + res.status);
    const rows = await res.json();
    if (rows.length < 50) state.hasMore = false;
    if (rows.length > 0) state.cursor = rows[rows.length - 1].created_at;
    state.items = state.items.concat(rows);
    renderList();
  } catch (e) {
    if (state.items.length === 0) {
      els.list.innerHTML = `<li class="empty-state">加载失败：${escapeHtml(e.message)}</li>`;
    }
  } finally {
    state.loading = false;
    els.loadMore.classList.toggle("hidden", !state.hasMore);
  }
}

async function openEmail(id) {
  state.selectedId = id;
  renderList();
  els.reader.innerHTML = `<div class="placeholder"><div class="placeholder-icon">⏳</div><p>加载中…</p></div>`;
  try {
    const res = await fetch(`/api/emails/${id}`);
    if (!res.ok) throw new Error("fetch failed: " + res.status);
    const m = await res.json();

    const atts = Array.isArray(m.attach_meta) ? m.attach_meta : [];
    const attHtml = atts.length
      ? `<div class="attach-box">${atts
          .map(
            (a) =>
              `<span class="attach-chip">📎 <b>${escapeHtml(a.name)}</b> · ${escapeHtml(a.type)} · ${(
                a.size / 1024
              ).toFixed(1)} KB</span>`
          )
          .join("")}</div>`
      : "";

    let bodyHtml = "";
    if (m.body_html) {
      const clean = window.DOMPurify
        ? DOMPurify.sanitize(m.body_html, { FORBID_TAGS: ["script", "iframe", "object", "embed", "form"], FORBID_ATTR: ["onerror", "onload", "onclick", "style"] })
        : m.body_html;
      const doc = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${clean}</body></html>`;
      const blob = new Blob([doc], { type: "text/html" });
      const src = URL.createObjectURL(blob);
      bodyHtml = `<div class="iframe-wrap"><iframe src="${src}" sandbox="allow-same-origin"></iframe></div>`;
    } else {
      bodyHtml = `<div class="body-text">${escapeHtml(m.body_text || "(无正文)")}</div>`;
    }

    els.reader.innerHTML = `
      <div class="reader-header">
        <h2 class="reader-subject">${escapeHtml(m.subject || "(无主题)")}</h2>
        <div class="meta-grid">
          <span class="meta-label">发件人</span><span class="meta-value">${escapeHtml(
            (m.from_name ? m.from_name + " " : "") + "<" + m.from_addr + ">"
          )}</span>
          <span class="meta-label">收件人</span><span class="meta-value">${escapeHtml(m.to_addr || "")}</span>
          <span class="meta-label">日期</span><span class="meta-value">${escapeHtml(m.date || "")}</span>
          <span class="meta-label">大小</span><span class="meta-value">${((m.raw_size || 0) / 1024).toFixed(1)} KB</span>
        </div>
        ${attHtml}
      </div>
      ${bodyHtml}
      <div style="margin-top:20px; text-align:right;">
        <button class="btn btn-ghost" id="delBtn" style="width:auto;color:var(--danger);border-color:var(--danger)">删除此邮件</button>
      </div>`;

    const del = document.getElementById("delBtn");
    del.addEventListener("click", () => deleteEmail(m.id));
  } catch (e) {
    els.reader.innerHTML = `<div class="error-banner">加载失败：${escapeHtml(e.message)}</div>`;
  }
}

async function deleteEmail(id) {
  if (!confirm("确定删除这封邮件？")) return;
  const res = await fetch(`/api/emails/${id}`, { method: "DELETE" });
  if (res.ok) {
    state.items = state.items.filter((m) => m.id !== id);
    state.selectedId = null;
    els.reader.innerHTML = `<div class="placeholder"><div class="placeholder-icon">📬</div><p>已删除</p></div>`;
    renderList();
  } else {
    alert("删除失败");
  }
}

// Events
els.list.addEventListener("click", (e) => {
  const li = e.target.closest(".mail-item");
  if (li) openEmail(Number(li.dataset.id));
});
els.refresh.addEventListener("click", () => loadItems(true));
els.loadMore.addEventListener("click", () => loadItems(false));
let searchTimer;
els.search.addEventListener("input", (e) => {
  state.query = e.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(renderList, 150);
});
els.theme.addEventListener("click", () => {
  const cur = document.documentElement.getAttribute("data-theme");
  const next = cur === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  els.theme.textContent = next === "dark" ? "☀️" : "🌙";
  try { localStorage.setItem("theme", next); } catch (_) {}
});

// Init
(function init() {
  try {
    const saved = localStorage.getItem("theme");
    if (saved === "dark") {
      document.documentElement.setAttribute("data-theme", "dark");
      els.theme.textContent = "☀️";
    }
  } catch (_) {}
  loadItems(true);
})();
