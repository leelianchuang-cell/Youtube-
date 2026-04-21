// popup.js v2 — 左侧文件夹 + 右侧视频列表

const COLORS = ['#6366f1','#f59e0b','#10b981','#ef4444','#3b82f6','#ec4899','#f97316','#14b8a6'];

// ── Storage ─────────────────────────────────────────────
const Store = {
  get: k => new Promise(r => chrome.storage.local.get(k, d => r(d[k] || null))),
  set: (k, v) => new Promise(r => chrome.storage.local.set({ [k]: v }, r)),
  async getFolders() { return (await this.get('folders')) || []; },
  async getAllVideos() { return (await this.get('videos')) || {}; },
  async saveFolder(name, color) {
    const folders = await this.getFolders();
    const f = { id: 'f_' + Date.now(), name, color, createdAt: Date.now() };
    folders.push(f);
    await this.set('folders', folders);
    return f;
  },
  async deleteFolder(fid) {
    const [folders, videos] = await Promise.all([this.getFolders(), this.getAllVideos()]);
    await Promise.all([
      this.set('folders', folders.filter(f => f.id !== fid)),
      this.set('videos', Object.fromEntries(
        Object.entries(videos).map(([k, v]) => [k, v.folderId === fid ? { ...v, folderId: null } : v])
      ))
    ]);
  },
  async setVideoFolder(vid, fid) {
    const videos = await this.getAllVideos();
    if (videos[vid]) { videos[vid].folderId = fid || null; await this.set('videos', videos); }
  },
  async deleteVideo(vid) {
    const videos = await this.getAllVideos();
    delete videos[vid];
    await this.set('videos', videos);
  }
};

// ── 工具 ─────────────────────────────────────────────────
function formatTime(s) {
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}
function pad(n) { return String(n).padStart(2, '0'); }
function formatDate(ts) {
  const d = new Date(ts);
  return `${d.getMonth()+1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── 状态 ─────────────────────────────────────────────────
let selectedFolderId = '__all__'; // '__all__' | '__none__' | 'f_xxx'
let searchQuery = '';
let pickerColor = COLORS[0];
let openMoveMenu = null; // 当前打开的移动菜单 vid

// ── 主渲染 ───────────────────────────────────────────────
async function render() {
  const [folders, videosMap] = await Promise.all([Store.getFolders(), Store.getAllVideos()]);
  const allVideos = Object.values(videosMap).sort((a, b) => (b.lastVisited || 0) - (a.lastVisited || 0));
  renderSidebar(folders, allVideos);
  renderVideoList(folders, allVideos);
}

// ── 左侧文件夹导航 ───────────────────────────────────────
function renderSidebar(folders, allVideos) {
  const nav = document.getElementById('folder-nav');

  const items = [
    { id: '__all__', label: '全部视频', color: '#6366f1', count: allVideos.length },
    { id: '__none__', label: '未归档', color: '#4a4a6a', count: allVideos.filter(v => !v.folderId).length },
    ...folders.map(f => ({
      id: f.id,
      label: f.name,
      color: f.color,
      count: allVideos.filter(v => v.folderId === f.id).length,
      deletable: true
    }))
  ];

  nav.innerHTML = items.map(item => `
    <div class="nav-item ${selectedFolderId === item.id ? 'active' : ''}" data-fid="${item.id}">
      <div class="nav-dot" style="background:${item.color}"></div>
      <div class="nav-label" title="${esc(item.label)}">${esc(item.label)}</div>
      <div class="nav-count">${item.count}</div>
      ${item.deletable ? `<button class="nav-del" data-fid="${item.id}" title="删除">✕</button>` : ''}
    </div>
  `).join('');

  // 点击切换
  nav.querySelectorAll('.nav-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.nav-del')) return;
      selectedFolderId = el.dataset.fid;
      render();
    });
  });

  // 删除文件夹
  nav.querySelectorAll('.nav-del').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('删除此文件夹？（视频笔记不受影响，只是取消归档）')) return;
      if (selectedFolderId === btn.dataset.fid) selectedFolderId = '__all__';
      await Store.deleteFolder(btn.dataset.fid);
      render();
    });
  });
}

// ── 右侧视频列表 ─────────────────────────────────────────
function renderVideoList(folders, allVideos) {
  // 筛选
  let videos = allVideos.filter(v => {
    if (selectedFolderId === '__all__') return true;
    if (selectedFolderId === '__none__') return !v.folderId;
    return v.folderId === selectedFolderId;
  });

  // 搜索
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    videos = videos.filter(v =>
      v.title.toLowerCase().includes(q) ||
      (v.notes || []).some(n => n.text && n.text.toLowerCase().includes(q))
    );
  }

  // 更新标题
  const titleEl = document.getElementById('main-title');
  const countEl = document.getElementById('main-count');

  if (selectedFolderId === '__all__') {
    titleEl.innerHTML = '全部视频';
  } else if (selectedFolderId === '__none__') {
    titleEl.innerHTML = '未归档视频';
  } else {
    const folder = folders.find(f => f.id === selectedFolderId);
    if (folder) {
      titleEl.innerHTML = `<span class="folder-badge" style="background:${folder.color}"></span>${esc(folder.name)}`;
    }
  }
  countEl.textContent = `${videos.length} 个视频`;

  const listEl = document.getElementById('video-list');

  if (videos.length === 0) {
    listEl.innerHTML = `
      <div class="empty">
        <div class="ei">${searchQuery ? '🔍' : '🎬'}</div>
        <p>${searchQuery ? '没有找到匹配的视频' : '这里还没有视频<br>打开 YouTube 视频并保存笔记后会出现在这里'}</p>
      </div>
    `;
    return;
  }

  listEl.innerHTML = videos.map(v => {
    const folder = folders.find(f => f.id === v.folderId);
    const notes = v.notes || [];
    return `
      <div class="video-card" data-vid="${v.id}">
        <div class="video-card-top">
          <img class="video-thumb" src="${v.thumbnail}" alt="" onerror="this.style.opacity='.3'">
          <div class="video-info">
            <div class="video-title" title="${esc(v.title)}">${esc(v.title)}</div>
            <div class="video-meta">
              <span class="badge-notes">📝 ${notes.length} 条笔记</span>
              ${folder ? `<span class="badge-folder" style="color:${folder.color};border-color:${folder.color}44;background:${folder.color}11">● ${esc(folder.name)}</span>` : ''}
              <span class="badge-date">${formatDate(v.lastVisited || v.createdAt)}</span>
            </div>
          </div>
          <div class="card-btns">
            <button class="icon-btn go" data-vid="${v.id}" data-url="${esc(v.url)}" title="打开视频">▶</button>
            <button class="icon-btn move" data-vid="${v.id}" title="移动到文件夹">🗂</button>
            <button class="icon-btn" data-vid="${v.id}" title="删除记录" data-action="del">✕</button>
          </div>
        </div>

        <!-- 移动文件夹菜单 -->
        <div class="move-menu" id="move-${v.id}">
          <div class="move-opt ${!v.folderId?'current':''}" data-vid="${v.id}" data-fid="">
            <span style="color:#4a4a6a">●</span> 未归档
          </div>
          ${folders.map(f => `
            <div class="move-opt ${v.folderId===f.id?'current':''}" data-vid="${v.id}" data-fid="${f.id}">
              <span style="color:${f.color}">●</span> ${esc(f.name)}
            </div>
          `).join('')}
        </div>

        <!-- 笔记展开区 -->
        <div class="notes-panel" id="notes-${v.id}">
          ${notes.length === 0
            ? '<div style="padding:10px 12px;color:#3a3a5a;font-size:11px;text-align:center">暂无笔记</div>'
            : notes.map(n => `
                <div class="note-row">
                  <span class="note-time" data-vid="${v.id}" data-time="${n.time}">${formatTime(n.time)}</span>
                  <span class="note-body">${n.text ? esc(n.text) : '<em style="color:#3a3a5a">仅时间标记</em>'}</span>
                </div>
              `).join('')
          }
          <div class="notes-footer">
            <a class="open-link" href="${esc(v.url)}" target="_blank">▶ 打开视频</a>
          </div>
        </div>
      </div>
    `;
  }).join('');

  // 点击卡片展开笔记
  listEl.querySelectorAll('.video-card-top').forEach(top => {
    top.addEventListener('click', (e) => {
      if (e.target.closest('.card-btns')) return;
      const vid = top.closest('.video-card').dataset.vid;
      const panel = document.getElementById('notes-' + vid);
      if (panel) panel.classList.toggle('open');
    });
  });

  // 打开视频
  listEl.querySelectorAll('.icon-btn.go').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      chrome.tabs.create({ url: btn.dataset.url });
    });
  });

  // 点击时间点跳转
  listEl.querySelectorAll('.note-time').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const url = `https://www.youtube.com/watch?v=${el.dataset.vid}&t=${Math.floor(el.dataset.time)}`;
      chrome.tabs.create({ url });
    });
  });

  // 删除视频
  listEl.querySelectorAll('.icon-btn[data-action="del"]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('删除该视频的所有笔记？')) return;
      await Store.deleteVideo(btn.dataset.vid);
      render();
    });
  });

  // 移动文件夹按钮
  listEl.querySelectorAll('.icon-btn.move').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const vid = btn.dataset.vid;
      const menu = document.getElementById('move-' + vid);
      if (!menu) return;
      // 关掉其他菜单
      document.querySelectorAll('.move-menu.open').forEach(m => {
        if (m !== menu) m.classList.remove('open');
      });
      menu.classList.toggle('open');
    });
  });

  // 移动选项点击
  listEl.querySelectorAll('.move-opt').forEach(opt => {
    opt.addEventListener('click', async (e) => {
      e.stopPropagation();
      const vid = opt.dataset.vid;
      const fid = opt.dataset.fid || null;
      await Store.setVideoFolder(vid, fid);
      document.querySelectorAll('.move-menu.open').forEach(m => m.classList.remove('open'));
      render();
    });
  });

  // 点击其他地方关闭菜单
  document.addEventListener('click', () => {
    document.querySelectorAll('.move-menu.open').forEach(m => m.classList.remove('open'));
  }, { once: true });
}

// ── 新建文件夹弹窗 ───────────────────────────────────────
function initNewFolderModal() {
  const overlay = document.getElementById('new-folder-overlay');
  const colorRow = document.getElementById('color-row');

  // 颜色选择
  colorRow.innerHTML = COLORS.map(c => `
    <div class="cswatch ${c === pickerColor ? 'sel' : ''}" style="background:${c}" data-c="${c}"></div>
  `).join('');

  colorRow.querySelectorAll('.cswatch').forEach(sw => {
    sw.addEventListener('click', () => {
      colorRow.querySelectorAll('.cswatch').forEach(s => s.classList.remove('sel'));
      sw.classList.add('sel');
      pickerColor = sw.dataset.c;
    });
  });

  document.getElementById('new-folder-btn').addEventListener('click', () => {
    overlay.classList.add('open');
    document.getElementById('folder-name-input').value = '';
    document.getElementById('folder-name-input').focus();
  });

  document.getElementById('cancel-modal').addEventListener('click', () => {
    overlay.classList.remove('open');
  });

  document.getElementById('confirm-modal').addEventListener('click', async () => {
    const name = document.getElementById('folder-name-input').value.trim();
    if (!name) { document.getElementById('folder-name-input').focus(); return; }
    await Store.saveFolder(name, pickerColor);
    overlay.classList.remove('open');
    render();
  });

  document.getElementById('folder-name-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('confirm-modal').click();
    if (e.key === 'Escape') overlay.classList.remove('open');
  });
}

// ── 搜索 ─────────────────────────────────────────────────
document.getElementById('search-input').addEventListener('input', (e) => {
  searchQuery = e.target.value;
  render();
});

// ── 启动 ─────────────────────────────────────────────────
initNewFolderModal();
render();
