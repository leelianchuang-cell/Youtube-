// content.js — 注入 YouTube 页面的笔记面板

(function () {
  'use strict';

  let videoId = null;
  let capturedTime = 0;
  let hasCaptured = false;
  let clockTimer = null;
  let currentVideoData = null;

  // ── Storage 封装（content script 里重新实现，因为无法 import） ──
  const Store = {
    get: (key) => new Promise(r => chrome.storage.local.get(key, d => r(d[key] || null))),
    set: (key, val) => new Promise(r => chrome.storage.local.set({ [key]: val }, r)),

    async getAllVideos() {
      return (await this.get('videos')) || {};
    },
    async getVideo(vid) {
      const all = await this.getAllVideos();
      return all[vid] || null;
    },
    async upsertVideo(vid, meta) {
      const all = await this.getAllVideos();
      if (!all[vid]) {
        all[vid] = {
          id: vid,
          title: meta.title || '未知视频',
          url: meta.url || `https://www.youtube.com/watch?v=${vid}`,
          thumbnail: `https://img.youtube.com/vi/${vid}/mqdefault.jpg`,
          folderId: null,
          notes: [],
          createdAt: Date.now()
        };
      } else {
        if (meta.title) all[vid].title = meta.title;
      }
      all[vid].lastVisited = Date.now();
      await this.set('videos', all);
      return all[vid];
    },
    async addNote(vid, time, text) {
      const all = await this.getAllVideos();
      if (!all[vid]) return null;
      const note = { id: 'n_' + Date.now(), time, text, createdAt: Date.now() };
      all[vid].notes.push(note);
      all[vid].notes.sort((a, b) => a.time - b.time);
      await this.set('videos', all);
      return note;
    },
    async updateNote(vid, noteId, text) {
      const all = await this.getAllVideos();
      if (!all[vid]) return;
      const n = all[vid].notes.find(n => n.id === noteId);
      if (n) n.text = text;
      await this.set('videos', all);
    },
    async deleteNote(vid, noteId) {
      const all = await this.getAllVideos();
      if (!all[vid]) return;
      all[vid].notes = all[vid].notes.filter(n => n.id !== noteId);
      await this.set('videos', all);
    },
    async getFolders() {
      return (await this.get('folders')) || [];
    },
    async setVideoFolder(vid, folderId) {
      const all = await this.getAllVideos();
      if (all[vid]) {
        all[vid].folderId = folderId;
        await this.set('videos', all);
      }
    }
  };

  // ── 工具函数 ────────────────────────────────────────
  function getVideoId() {
    return new URL(window.location.href).searchParams.get('v');
  }

  function getPlayer() {
    return document.querySelector('video');
  }

  function formatTime(seconds) {
    const s = Math.floor(seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    return `${m}:${String(sec).padStart(2, '0')}`;
  }

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
  }

  function getVideoTitle() {
    return document.querySelector('h1.ytd-watch-metadata yt-formatted-string')?.textContent?.trim()
      || document.title.replace(' - YouTube', '')
      || '未知视频';
  }

  // ── 初始化 ─────────────────────────────────────────
  async function init() {
    videoId = getVideoId();
    if (!videoId) return;

    // 等待标题加载
    await new Promise(r => setTimeout(r, 1500));

    const title = getVideoTitle();
    currentVideoData = await Store.upsertVideo(videoId, {
      title,
      url: window.location.href
    });

    buildPanel();
    await refreshPanel();
    startClock();
    watchVideoChange();
  }

  // ── 构建面板 ────────────────────────────────────────
  function buildPanel() {
    if (document.getElementById('yt-notes-panel')) return;

    const panel = document.createElement('div');
    panel.id = 'yt-notes-panel';
    panel.innerHTML = `
      <div class="collapse-icon-wrap" id="expand-btn" title="展开笔记">📝</div>

      <div class="panel-header">
        <div class="panel-title">
          <span class="dot"></span>
          视频笔记
        </div>
        <div style="display:flex;gap:6px;align-items:center;">
          <button class="panel-toggle" id="folder-assign-btn" title="归档到文件夹">🗂</button>
          <button class="panel-toggle" id="collapse-btn" title="收起">◀</button>
        </div>
      </div>

      <div class="panel-content">
        <!-- 视频信息 -->
        <div class="video-info-bar" id="video-info-bar"></div>

        <!-- 文件夹选择器（隐藏） -->
        <div class="folder-picker" id="folder-picker" style="display:none;"></div>

        <!-- 添加笔记区域 -->
        <div class="add-note-area">
          <div class="timestamp-display">
            <span class="current-time" id="current-time-display">0:00</span>
            <button class="capture-btn" id="capture-btn">⏱ 标记时间点</button>
          </div>
          <textarea class="note-textarea" id="note-input"
            placeholder="输入笔记内容...（可不填，仅记录时间点）" rows="3"></textarea>
          <button class="save-note-btn" id="save-note-btn">💾 保存笔记</button>
        </div>

        <!-- 笔记列表 -->
        <div class="notes-list-header">
          <span class="notes-count" id="notes-count">共 0 条笔记</span>
          <button class="clear-all-btn" id="clear-all-btn">清空</button>
        </div>
        <div class="notes-list" id="notes-list"></div>
      </div>
    `;

    document.body.appendChild(panel);
    bindEvents();
  }

  // ── 刷新面板内容 ────────────────────────────────────
  async function refreshPanel() {
    currentVideoData = await Store.getVideo(videoId);
    if (!currentVideoData) return;

    const notes = currentVideoData.notes || [];
    const folders = await Store.getFolders();
    const folder = folders.find(f => f.id === currentVideoData.folderId);

    // 视频信息栏
    const infoBar = document.getElementById('video-info-bar');
    if (infoBar) {
      infoBar.innerHTML = `
        <div class="video-title-line" title="${escapeHtml(currentVideoData.title)}">
          🎬 ${escapeHtml(currentVideoData.title.slice(0, 40))}${currentVideoData.title.length > 40 ? '…' : ''}
        </div>
        ${folder ? `<div class="folder-tag" style="background:${folder.color}22;color:${folder.color};border-color:${folder.color}44">📁 ${escapeHtml(folder.name)}</div>` : '<div class="folder-tag-empty">未归档</div>'}
      `;
    }

    // 笔记计数
    const countEl = document.getElementById('notes-count');
    if (countEl) countEl.textContent = `共 ${notes.length} 条笔记`;

    renderNotes(notes);
  }

  // ── 渲染笔记列表 ────────────────────────────────────
  function renderNotes(notes) {
    const list = document.getElementById('notes-list');
    if (!list) return;

    if (!notes || notes.length === 0) {
      list.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🎬</div>
          <p>还没有笔记<br>点击「标记时间点」开始记录</p>
        </div>`;
      return;
    }

    list.innerHTML = notes.map(note => `
      <div class="note-card" data-id="${note.id}" data-time="${note.time}">
        <div class="note-card-top">
          <div class="note-timestamp">
            <span class="play-icon">▶</span>
            ${formatTime(note.time)}
          </div>
          <div class="note-actions">
            <button class="note-action-btn edit" data-id="${note.id}" title="编辑">✏️</button>
            <button class="note-action-btn delete" data-id="${note.id}" title="删除">🗑</button>
          </div>
        </div>
        <div class="note-text ${!note.text ? 'empty' : ''}">${note.text ? escapeHtml(note.text) : '（仅时间标记）'}</div>
      </div>
    `).join('');

    list.querySelectorAll('.note-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.note-action-btn')) return;
        jumpToTime(parseFloat(card.dataset.time));
      });
    });

    list.querySelectorAll('.note-action-btn.delete').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await Store.deleteNote(videoId, btn.dataset.id);
        await refreshPanel();
        showToast('笔记已删除');
      });
    });

    list.querySelectorAll('.note-action-btn.edit').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        startEdit(btn.dataset.id);
      });
    });
  }

  // ── 内联编辑 ────────────────────────────────────────
  function startEdit(noteId) {
    const card = document.querySelector(`.note-card[data-id="${noteId}"]`);
    if (!card) return;
    card.classList.add('editing');
    const textEl = card.querySelector('.note-text');
    const original = textEl.innerText === '（仅时间标记）' ? '' : textEl.innerText;
    const ta = document.createElement('textarea');
    ta.className = 'edit-textarea';
    ta.value = original;
    card.insertBefore(ta, textEl);
    ta.focus();

    async function finishEdit() {
      await Store.updateNote(videoId, noteId, ta.value.trim());
      await refreshPanel();
    }
    ta.addEventListener('blur', finishEdit);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) ta.blur();
      if (e.key === 'Escape') { ta.removeEventListener('blur', finishEdit); refreshPanel(); }
    });
  }

  // ── 文件夹选择器 ────────────────────────────────────
  async function showFolderPicker() {
    const picker = document.getElementById('folder-picker');
    if (picker.style.display !== 'none') { picker.style.display = 'none'; return; }

    const folders = await Store.getFolders();
    picker.innerHTML = `
      <div class="picker-title">归档到文件夹</div>
      <div class="picker-options">
        <div class="picker-option ${!currentVideoData?.folderId ? 'active' : ''}" data-id="">
          <span>📂</span> 不归档
        </div>
        ${folders.map(f => `
          <div class="picker-option ${currentVideoData?.folderId === f.id ? 'active' : ''}" data-id="${f.id}" style="border-color:${f.color}33">
            <span style="color:${f.color}">●</span> ${escapeHtml(f.name)}
          </div>
        `).join('')}
        <div class="picker-option new-folder-opt" data-id="__new__">
          <span>➕</span> 新建文件夹
        </div>
      </div>
    `;
    picker.style.display = 'block';

    picker.querySelectorAll('.picker-option').forEach(opt => {
      opt.addEventListener('click', async () => {
        const id = opt.dataset.id;
        if (id === '__new__') {
          const name = prompt('文件夹名称：');
          if (!name) return;
          const color = ['#6366f1','#f59e0b','#10b981','#ef4444','#3b82f6','#ec4899'][Math.floor(Math.random()*6)];
          const folders = await Store.getFolders();
          const newF = { id: 'f_' + Date.now(), name, color, createdAt: Date.now() };
          folders.push(newF);
          await new Promise(r => chrome.storage.local.set({ folders }, r));
          await Store.setVideoFolder(videoId, newF.id);
          showToast(`已创建「${name}」并归档`);
        } else {
          await Store.setVideoFolder(videoId, id || null);
          showToast(id ? '归档成功' : '已取消归档');
        }
        picker.style.display = 'none';
        currentVideoData = await Store.getVideo(videoId);
        await refreshPanel();
      });
    });
  }

  // ── 绑定事件 ────────────────────────────────────────
  function bindEvents() {
    document.getElementById('collapse-btn').addEventListener('click', () => {
      document.getElementById('yt-notes-panel').classList.add('collapsed');
    });
    document.getElementById('expand-btn').addEventListener('click', () => {
      document.getElementById('yt-notes-panel').classList.remove('collapsed');
    });
    document.getElementById('folder-assign-btn').addEventListener('click', showFolderPicker);

    document.getElementById('capture-btn').addEventListener('click', () => {
      const player = getPlayer();
      if (!player) { showToast('未找到播放器'); return; }
      capturedTime = player.currentTime;
      hasCaptured = true;
      const d = document.getElementById('current-time-display');
      d.style.color = '#a5b4fc';
      d.textContent = '⏱ ' + formatTime(capturedTime);
      setTimeout(() => { d.style.color = ''; }, 800);
      document.getElementById('note-input').focus();
      showToast(`已标记 ${formatTime(capturedTime)}`);
    });

    document.getElementById('save-note-btn').addEventListener('click', saveCurrentNote);
    document.getElementById('note-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveCurrentNote();
    });

    document.getElementById('clear-all-btn').addEventListener('click', async () => {
      const data = await Store.getVideo(videoId);
      if (!data || data.notes.length === 0) return;
      if (!confirm('确定清空本视频所有笔记？')) return;
      const all = await Store.getAllVideos();
      all[videoId].notes = [];
      await new Promise(r => chrome.storage.local.set({ videos: all }, r));
      await refreshPanel();
      showToast('已清空笔记');
    });
  }

  // ── 保存笔记 ────────────────────────────────────────
  async function saveCurrentNote() {
    const player = getPlayer();
    const input = document.getElementById('note-input');
    const text = input.value.trim();
    const time = hasCaptured ? capturedTime : (player ? player.currentTime : 0);

    await Store.addNote(videoId, time, text);
    await refreshPanel();

    input.value = '';
    hasCaptured = false;
    document.getElementById('current-time-display').textContent = formatTime(player ? player.currentTime : 0);
    showToast(`笔记已保存 @ ${formatTime(time)}`);
  }

  // ── 跳转时间 ────────────────────────────────────────
  function jumpToTime(time) {
    const player = getPlayer();
    if (!player) { showToast('未找到播放器'); return; }
    player.currentTime = time;
    player.play();
    showToast(`跳转到 ${formatTime(time)}`);
  }

  // ── 实时时钟 ────────────────────────────────────────
  function startClock() {
    if (clockTimer) clearInterval(clockTimer);
    clockTimer = setInterval(() => {
      if (hasCaptured) return;
      const player = getPlayer();
      const d = document.getElementById('current-time-display');
      if (d && player) d.textContent = formatTime(player.currentTime);
    }, 500);
  }

  // ── 监听 URL 变化 ────────────────────────────────────
  function watchVideoChange() {
    let lastUrl = window.location.href;
    new MutationObserver(async () => {
      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        const newId = getVideoId();
        if (newId && newId !== videoId) {
          videoId = newId;
          hasCaptured = false;
          await new Promise(r => setTimeout(r, 1500));
          const title = getVideoTitle();
          currentVideoData = await Store.upsertVideo(videoId, { title, url: window.location.href });
          await refreshPanel();
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  // ── Toast ───────────────────────────────────────────
  function showToast(msg) {
    let t = document.getElementById('yt-notes-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'yt-notes-toast';
      t.className = 'yt-toast';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove('show'), 2000);
  }

  // ── 启动 ────────────────────────────────────────────
  function waitAndInit() {
    const check = setInterval(() => {
      if (document.querySelector('video')) { clearInterval(check); init(); }
    }, 800);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', waitAndInit);
  } else {
    waitAndInit();
  }
})();
