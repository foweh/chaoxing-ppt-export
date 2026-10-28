// ==UserScript==
// @name         超星/学习通 课程 PPT 批量导出
// @namespace    https://local.reasonix/chaoxing-ppt-export
// @version      1.1.1
// @description  一键扫描当前课程所有章节的课件（PPT/PDF/Word 等），批量下载原文件。适用超星 mooc1 学生学习页面。
// @author       大肥鱼
// @match        *://mooc1.chaoxing.com/mycourse/studentstudy*
// @match        *://mooc1.chaoxing.com/mooc-ans/mycourse/studentstudy*
// @match        *://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/studentstudy*
// @match        *://*.chaoxing.com/*studentstudy*
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      chaoxing.com
// @connect      cldisk.com
// @connect      ananas.chaoxing.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  /* ============================ 可调参数 ============================ */
  const CFG = {
    parallel: 3,            // 同时下载的文件数（别开太大，超星会限流）
    chapterDelay: 250,      // 每扫完一章后的停顿(ms)
    statusDelay: 150,       // 每次取下载地址之间的停顿(ms)
    retry: 2,               // 单个请求失败重试次数
    cacheKey: 'cxppt:v1',   // localStorage 缓存前缀
  };

  const DOC_EXTS = ['.ppt', '.pptx', '.pps', '.ppsx', '.pot', '.potx', '.pdf',
                    '.doc', '.docx', '.xls', '.xlsx', '.wps', '.dps', '.key',
                    '.zip', '.rar', '.7z', '.txt'];

  /* ============================ 小工具 ============================ */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function el(tag, attrs, children) {
    const n = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === 'style') n.style.cssText = attrs[k];
      else if (k === 'text') n.textContent = attrs[k];
      else if (k === 'html') n.innerHTML = attrs[k];
      else if (k.startsWith('on') && typeof attrs[k] === 'function') n.addEventListener(k.slice(2), attrs[k]);
      else n.setAttribute(k, attrs[k]);
    }
    (children || []).forEach((c) => c && n.appendChild(c));
    return n;
  }

  function sanitizeName(s) {
    return String(s || '')
      .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 150) || 'file';
  }

  function fixProtocol(url) {
    if (!url) return url;
    if (location.protocol === 'https:' && url.startsWith('http:')) return 'https:' + url.slice(5);
    if (location.protocol === 'http:' && url.startsWith('https:')) return 'http:' + url.slice(6);
    return url;
  }

  // 统一成可用的绝对地址（//host/xx、/relative 都补齐）
  function normalizeUrl(url) {
    if (!url) return url;
    let u = String(url).trim();
    if (u.startsWith('//')) u = location.protocol + u;
    else if (u.startsWith('/')) u = location.origin + u;
    return fixProtocol(u);
  }

  // 从超星那种“类 JS 对象”文本里取字符串字段
  // 兼容 {"download":"…"} 和 {status:"success"} 两种写法（key 带不带引号都行）
  function pickField(text, key) {
    const re = new RegExp('(?:^|[{,])\\s*"?' + key + '"?\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"');
    const m = text.match(re);
    if (!m) return '';
    try { return JSON.parse('"' + m[1] + '"'); } catch (e) { return m[1]; }
  }

  /* ============================ 页面参数 ============================ */
  function readParams() {
    const p = new URLSearchParams(location.search);
    const courseId = p.get('courseId') || p.get('courseid') || window.courseid || window.courseId || window.stu_CourseId || '';
    const clazzId = p.get('clazzid') || p.get('clazzId') || window.stu_clazzId || window.clazzid || '';
    const cpi = p.get('cpi') || window.stu_cpi || window.cpi || '';
    return { courseId: String(courseId), clazzId: String(clazzId), cpi: String(cpi) };
  }

  function readCourseName() {
    try {
      const all = Array.from(document.scripts).map((s) => s.textContent || '').join('\n');
      const m = all.match(/courseName\s*:\s*"([^"]+)"/);
      if (m && m[1]) {
        let v = m[1];
        try { v = decodeURIComponent(v); } catch (e) { /* 原样使用 */ }
        if (v) return v;
      }
    } catch (e) { /* ignore */ }
    const t = document.querySelector('#coursetree .posCatalog_title');
    return (t && t.getAttribute('title')) || document.title || '课程';
  }

  function readChapters() {
    const out = [];
    const nodes = document.querySelectorAll('#coursetree .posCatalog_select[id^="cur"]');
    nodes.forEach((d) => {
      const kid = d.id.slice(3);
      if (!/^\d+$/.test(kid)) return;
      const nameEl = d.querySelector('.posCatalog_name');
      const sbarEl = d.querySelector('.posCatalog_sbar');
      const title = ((nameEl && (nameEl.getAttribute('title') || nameEl.textContent)) || '').trim();
      out.push({
        kid: kid,
        sbar: ((sbarEl && sbarEl.textContent) || '').trim(),
        title: title || ('章节' + kid),
        attachments: [],
      });
    });
    return out;
  }

  /* ============================ 扫描课件 ============================ */
  function cardsBases() {
    const bases = [];
    if (window._CP_) bases.push(window._CP_);
    ['/mooc-ans', '/mooc2-ans'].forEach((b) => { if (!bases.includes(b)) bases.push(b); });
    return bases;
  }

  function cardsUrl(base, kid, num) {
    const { courseId, clazzId, cpi } = st.params;
    const q = new URLSearchParams({
      clazzid: clazzId,
      courseid: courseId,
      knowledgeid: kid,
      num: String(num),
      ut: 's',
      cpi: cpi,
      v: '2025-0424-1038-4',
      mooc2: '1',
      isMicroCourse: 'false',
      editorPreview: '0',
      crossId: '0',
    });
    return location.origin + base + '/knowledge/cards?' + q.toString();
  }

  async function fetchText(url) {
    for (let i = 0; i <= CFG.retry; i++) {
      try {
        const r = await fetch(url, { credentials: 'include' });
        if (r.ok) return await r.text();
      } catch (e) { /* 重试 */ }
      await sleep(400 * (i + 1));
    }
    return null;
  }

  function normalizeExt(type, name) {
    let t = String(type || '').toLowerCase().trim();
    if (t && !t.startsWith('.')) t = '.' + t;
    if (!t && name) {
      const m = String(name).toLowerCase().match(/(\.[a-z0-9]{2,5})$/);
      if (m) t = m[1];
    }
    return t;
  }

  function isDocType(ext) {
    return DOC_EXTS.includes(ext);
  }

  // 从 cards 页面里顺手捡一个 fid（部分接口的 ?k= 参数要用）
  function captureFid(html) {
    if (st.fid) return;
    const m = html.match(/"fid"\s*:\s*"?(\d{2,8})"?/);
    if (m) st.fid = m[1];
  }

  function isPpt(ext, name) {
    if (['.ppt', '.pptx', '.pps', '.ppsx', '.pot', '.potx'].includes(ext)) return true;
    return /\.(ppt|pptx|pps|ppsx|pot|potx)$/i.test(String(name || ''));
  }

  // 从 knowledge/cards 的返回 HTML 里抽出所有 insertdoc 附件
  function collectAttachments(text, map) {
    const dec = text.replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&amp;/g, '&');

    const push = (o) => {
      if (!o || !o.objectid) return;
      const oid = String(o.objectid).toLowerCase();
      if (!/^[0-9a-f]{32}$/.test(oid) || map.has(oid)) return;
      const name = o.name || '';
      const ext = normalizeExt(o.type, name);
      if (ext && !isDocType(ext)) return;       // 视频/图片等非文档附件直接跳过
      if (!ext && !name) return;                // 既没类型又没名字的，跳过
      map.set(oid, {
        objectid: oid,
        name: name,
        ext: ext,
        size: Number(o.size) || 0,
        pagenum: String(o.pagenum || ''),
        isPpt: isPpt(ext, name),
        canDownload: String(o.download === undefined ? '1' : o.download) !== '0',
      });
    };

    // ① iframe 的 data="…"(HTML 已还原引号) —— 最可靠
    for (const m of dec.matchAll(/<iframe\b[^>]*insertdoc[^>]*>/gi)) {
      const tag = m[0];
      const dm = tag.match(/data="(\{[\s\S]*?\})"/);
      if (dm) {
        try { push(JSON.parse(dm[1])); continue; } catch (e) { /* 落到下面 */ }
      }
      const om = tag.match(/objectid="([0-9a-f]{32})"/i);
      if (om) push({ objectid: om[1] });
    }

    // ② 页面里的 mArg.attachments[*].property
    for (const m of dec.matchAll(/"property"\s*:\s*(\{[^}]*\})/g)) {
      try { push(JSON.parse(m[1])); } catch (e) { /* ignore */ }
    }
  }

  async function scanChapter(ch, idx) {
    const map = new Map();
    let okBase = null;
    let sawImg = false;
    // num 一般是章节序号（0 起），个别课程有偏移，拿空就多试几个
    const nums = Array.from(new Set([0, idx - 1, idx, 1, 2].filter((n) => n >= 0)));
    for (const num of nums) {
      for (const base of (okBase ? [okBase] : cardsBases())) {
        const html = await fetchText(cardsUrl(base, ch.kid, num));
        if (!html || html.length < 200) continue;
        okBase = base;
        collectAttachments(html, map);
        captureFid(html);
        if (!sawImg && /insertimg/i.test(html)) sawImg = true;
        break;
      }
      if (map.size) break;   // 已经拿到附件，不用再试其它 num
      await sleep(120);
    }
    ch.attachments = Array.from(map.values());
    ch.imgOnly = !map.size && sawImg;
    return ch;
  }

  /* ============================ 下载 ============================ */
  // 取原文件直链：/ananas/status/{objectid}?flag=normal（返回 {status:"success",download:"…",filename:"…"}）
  // 多试几种参数组合，失败时把每一步的响应片段带在 err.trace 里，方便诊断
  async function ananasStatus(objectid, verbose) {
    const bases = Array.from(new Set([location.origin, 'https://mooc1.chaoxing.com']));
    const paths = [
      '/ananas/status/' + objectid + '?flag=normal',
      '/ananas/status/' + objectid + '?download=1&flag=normal',
      '/mooc-ans/ananas/status/' + objectid + '?flag=normal',
    ];
    if (st.fid) paths.splice(1, 0, '/ananas/status/' + objectid + '?k=' + st.fid + '&flag=normal');

    const trace = [];
    for (const b of bases) {
      for (const p of paths) {
        let res;
        const url = b + p;
        try {
          res = await fetch(url, {
            credentials: 'include',
            headers: { 'X-Requested-With': 'XMLHttpRequest' },
          });
        } catch (e) {
          trace.push('网络错误 ' + url + ' → ' + e.message);
          continue;
        }
        if (!res.ok) { trace.push('HTTP ' + res.status + ' ' + url); continue; }
        const t = await res.text();
        if (t.length > 4000000) { trace.push('响应过大 ' + url); continue; }
        const download = pickField(t, 'download') || pickField(t, 'downloadUrl') || pickField(t, 'url');
        const status = pickField(t, 'status');
        const filename = pickField(t, 'filename');
        if (download) {
          const f = t.match(/"fid"\s*:\s*"?(\d{2,8})"?/);
          if (f && !st.fid) st.fid = f[1];
          return { status: status || 'success', download: normalizeUrl(download), filename };
        }
        trace.push('无 download 字段（status=' + (status || '无') + '） ' + url + ' ← ' + t.slice(0, 160).replace(/\s+/g, ' '));
      }
    }
    const err = new Error(trace.length ? trace[trace.length - 1] : '取下载地址失败');
    err.trace = trace;
    if (verbose) console.warn('[超星PPT导出] status 诊断\n' + trace.join('\n'));
    throw err;
  }

  function buildFileName(ch, att, serverName) {
    let base = att.name || serverName || att.objectid;
    let ext = att.ext || normalizeExt('', base);
    if (ext && !base.toLowerCase().endsWith(ext)) base += ext;
    const prefix = (ch.sbar ? ch.sbar + '_' : '') + ch.title + '__';
    return sanitizeName(prefix + base);
  }

  // 一级：GM_download（走浏览器下载器，跨域 + 自动带 Cookie）
  function gmDownload(url, name) {
    return new Promise((resolve) => {
      if (typeof GM_download !== 'function') return resolve('err:无 GM_download');
      let settled = false;
      const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
      try {
        GM_download({
          url: url,
          name: name,
          saveAs: false,
          conflictAction: 'uniquify',
          onload: () => finish('ok'),
          onerror: (e) => finish('err:' + ((e && (e.error || e.message)) || '下载失败')),
          ontimeout: () => finish('err:超时'),
        });
      } catch (e) { finish('err:' + e.message); }
    });
  }

  // 二级：GM_xmlhttpRequest 取 blob 再落盘（绕开 CORS / 白名单限制）
  function gmXhrDownload(url, name) {
    return new Promise((resolve) => {
      if (typeof GM_xmlhttpRequest !== 'function') return resolve('err:无 GM_xmlhttpRequest');
      const before = (r) => {
        if (r.status !== 200 || !r.response) return resolve('err:HTTP ' + r.status);
        const blobUrl = URL.createObjectURL(r.response);
        const a = el('a', { href: blobUrl, download: name, style: 'display:none' });
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
        resolve('ok');
      };
      const opts = {
        method: 'GET',
        url: url,
        responseType: 'blob',
        timeout: 120000,
        onload: before,
        onerror: () => resolve('err:xhr 请求失败'),
        ontimeout: () => resolve('err:xhr 超时'),
      };
      try {
        GM_xmlhttpRequest({ ...opts, headers: { Referer: location.href } });
      } catch (e) {
        // 个别管理器不允许设置 Referer，去掉再试一次
        try { GM_xmlhttpRequest(opts); } catch (e2) { resolve('err:' + e2.message); }
      }
    });
  }

  // 三级：直接 a[download]（最朴素，跨域时 download 属性可能被忽略，只算“已发起”）
  function anchorDownload(url, name) {
    try {
      const a = el('a', { href: url, download: name, target: '_blank', style: 'display:none' });
      document.body.appendChild(a);
      a.click();
      a.remove();
      return 'weak';
    } catch (e) { return 'err:' + e.message; }
  }

  // 依次降级，返回实际生效的方式；全挂才抛错
  async function saveFile(url, name) {
    const fails = [];
    let r = await gmDownload(url, name);
    if (r === 'ok') return 'GM_download';
    fails.push('GM_download → ' + r);
    r = await gmXhrDownload(url, name);
    if (r === 'ok') return 'GM_xhr';
    fails.push('GM_xhr → ' + r);
    r = anchorDownload(url, name);
    if (r === 'weak') return 'anchor(未确认)';
    fails.push('链接跳转 → ' + r);
    throw new Error(fails.join('；'));
  }

  /* ============================ 界面 ============================ */
  const st = {
    params: {},
    courseName: '',
    chapters: [],
    selected: new Set(),
    downloaded: new Set(),
    onlyPpt: true,
    busy: false,
    scannedAt: 0,
    fid: '',
    errors: [],
  };

  let ui = null;

  function cacheKey() { return CFG.cacheKey + ':' + (st.params.courseId || 'unknown'); }

  function saveCache() {
    try {
      localStorage.setItem(cacheKey(), JSON.stringify({
        ts: Date.now(),
        courseName: st.courseName,
        fid: st.fid,
        chapters: st.chapters,
        downloaded: Array.from(st.downloaded),
      }));
    } catch (e) { /* 存不下就算了 */ }
  }

  function loadCache() {
    try {
      const raw = localStorage.getItem(cacheKey());
      if (!raw) return false;
      const d = JSON.parse(raw);
      if (!d || !Array.isArray(d.chapters)) return false;
      st.chapters = d.chapters;
      st.courseName = d.courseName || st.courseName;
      st.fid = d.fid || '';
      st.scannedAt = d.ts || 0;
      st.downloaded = new Set(d.downloaded || []);
      return true;
    } catch (e) { return false; }
  }

  function logLine(msg) {
    if (!ui) return;
    ui.logBuf = (ui.logBuf || []).concat(String(msg)).slice(-80);
    ui.log.textContent = ui.logBuf.join('\n');
    ui.log.scrollTop = ui.log.scrollHeight;
  }

  function toast(msg) { logLine(msg); }

  function setStatus(msg) { if (ui && ui.status) ui.status.textContent = msg; }

  function totalAttachments() {
    return st.chapters.reduce((n, c) => n + ((c.attachments && c.attachments.length) || 0), 0);
  }

  function selectedItems() {
    const out = [];
    st.chapters.forEach((ch) => (ch.attachments || []).forEach((a) => {
      if (st.selected.has(a.objectid)) out.push({ ch, att: a });
    }));
    return out;
  }

  function refreshSummary() {
    if (!ui) return;
    const nCh = st.chapters.length;
    const nAtt = totalAttachments();
    const nSel = st.selected.size;
    const nPpt = st.chapters.reduce((n, c) => n + (c.attachments || []).filter((a) => a.isPpt).length, 0);
    ui.summary.textContent = `${st.courseName} · 章节 ${nCh} · 课件 ${nAtt}（PPT ${nPpt}）· 已选 ${nSel} · 已下 ${st.downloaded.size}`;
    ui.btnDownload.textContent = st.busy ? '下载中…' : `下载选中（${nSel}）`;
    ui.btnDownload.disabled = st.busy || nSel === 0;
    ui.btnScan.disabled = st.busy;
  }

  function itemRow(ch, att) {
    const label = el('label', { class: 'cxp-item', 'data-oid': att.objectid });
    const cb = el('input', { type: 'checkbox' });
    cb.checked = st.selected.has(att.objectid);
    cb.addEventListener('change', () => {
      if (cb.checked) st.selected.add(att.objectid); else st.selected.delete(att.objectid);
      refreshSummary();
    });
    const tag = el('span', { class: 'cxp-tag' + (att.isPpt ? ' cxp-ppt' : ''), text: att.isPpt ? 'PPT' : (att.ext || '文件') });
    const name = el('span', { class: 'cxp-name', text: att.name || att.objectid, title: att.name || att.objectid });
    const meta = el('span', { class: 'cxp-meta', text: att.size ? (att.size / 1024).toFixed(0) + ' KB' : '' });
    const open = el('button', { class: 'cxp-open', text: '↗', title: '手动下载此文件' });
    open.addEventListener('click', async (e) => {
      e.preventDefault(); e.stopPropagation();
      open.textContent = '…';
      try {
        const info = await ananasStatus(att.objectid);
        window.open(info.download, '_blank');
        open.textContent = '↗';
      } catch (err) { open.textContent = '✗'; open.title = err.message; }
    });
    label.append(cb, tag, name, meta, open);
    if (st.downloaded.has(att.objectid)) label.classList.add('cxp-done');
    return label;
  }

  function renderList() {
    if (!ui) return;
    const box = ui.list;
    box.textContent = '';
    if (!st.chapters.length) {
      box.appendChild(el('div', { class: 'cxp-empty', text: '还没有数据，点上面的「扫描全部章节」。' }));
      refreshSummary();
      return;
    }
    st.chapters.forEach((ch) => {
      const all = ch.attachments || [];
      const shown = st.onlyPpt ? all.filter((a) => a.isPpt) : all;
      const head = el('div', { class: 'cxp-chapter' });
      head.appendChild(el('span', { class: 'cxp-sbar', text: ch.sbar || '' }));
      head.appendChild(el('span', { class: 'cxp-ctitle', text: ch.title }));
      head.appendChild(el('span', { class: 'cxp-count', text: all.length ? `${shown.length}/${all.length}` : '无课件' }));
      box.appendChild(head);
      if (!shown.length) {
        box.appendChild(el('div', {
          class: 'cxp-none',
          text: all.length
            ? '（无 PPT，关掉「仅PPT」可看其它附件）'
            : (ch.imgOnly ? '（课件以图片形式插入，无原文件可下）' : '（无文档附件）'),
        }));
        return;
      }
      shown.forEach((a) => box.appendChild(itemRow(ch, a)));
    });
    refreshSummary();
  }

  function buildPanel() {
    const panel = el('div', { id: 'cxppt-panel' });

    const hd = el('div', { class: 'cxp-hd' });
    const title = el('span', { class: 'cxp-title', text: 'PPT 批量导出' });
    const min = el('button', { class: 'cxp-min', text: '–', title: '收起/展开' });
    hd.append(title, min);

    const body = el('div', { class: 'cxp-body' });
    const summary = el('div', { class: 'cxp-summary', text: '读取课程信息…' });

    const bar1 = el('div', { class: 'cxp-bar' });
    const btnScan = el('button', { class: 'cxp-btn cxp-primary', text: '扫描全部章节' });
    const btnAll = el('button', { class: 'cxp-btn', text: '全选' });
    const btnInv = el('button', { class: 'cxp-btn', text: '反选' });
    const btnPpt = el('button', { class: 'cxp-btn', text: '仅PPT：开' });
    bar1.append(btnScan, btnAll, btnInv, btnPpt);

    const bar2 = el('div', { class: 'cxp-bar' });
    const btnDownload = el('button', { class: 'cxp-btn cxp-primary', text: '下载选中（0）' });
    const btnCopy = el('button', { class: 'cxp-btn', text: '复制清单' });
    const btnJson = el('button', { class: 'cxp-btn', text: '导出清单' });
    const btnDiag = el('button', { class: 'cxp-btn', text: '诊断' });
    const btnClear = el('button', { class: 'cxp-btn', text: '重置下载记录' });
    bar2.append(btnDownload, btnCopy, btnJson, btnDiag, btnClear);

    const status = el('div', { class: 'cxp-status', text: '就绪' });
    const list = el('div', { class: 'cxp-list' });
    const log = el('div', { class: 'cxp-log', text: '' });

    body.append(summary, bar1, bar2, status, list, log);
    panel.append(hd, body);

    /* ---- 事件 ---- */
    min.addEventListener('click', () => panel.classList.toggle('cxp-collapsed'));

    btnScan.addEventListener('click', () => scanAll(true));

    btnAll.addEventListener('click', () => {
      st.chapters.forEach((ch) => (ch.attachments || []).forEach((a) => {
        if (st.onlyPpt && !a.isPpt) return;
        st.selected.add(a.objectid);
      }));
      renderList();
    });

    btnInv.addEventListener('click', () => {
      st.chapters.forEach((ch) => (ch.attachments || []).forEach((a) => {
        if (st.onlyPpt && !a.isPpt) return;
        if (st.selected.has(a.objectid)) st.selected.delete(a.objectid); else st.selected.add(a.objectid);
      }));
      renderList();
    });

    btnPpt.addEventListener('click', () => {
      st.onlyPpt = !st.onlyPpt;
      btnPpt.textContent = '仅PPT：' + (st.onlyPpt ? '开' : '关');
      renderList();
    });

    btnDownload.addEventListener('click', runDownloads);

    btnDiag.addEventListener('click', diagnose);

    btnCopy.addEventListener('click', () => {
      const lines = [];
      st.chapters.forEach((ch) => (ch.attachments || []).forEach((a) => {
        if (!st.selected.has(a.objectid)) return;
        lines.push([ch.sbar, ch.title, a.name, a.ext, a.size, a.objectid].join('\t'));
      }));
      copyText(lines.join('\n') || '（没有选中项）');
    });

    btnJson.addEventListener('click', () => {
      const data = {
        course: st.courseName,
        params: st.params,
        scannedAt: new Date(st.scannedAt || Date.now()).toISOString(),
        chapters: st.chapters,
      };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = el('a', { href: URL.createObjectURL(blob), download: sanitizeName(st.courseName + '_课件清单.json') });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    });

    btnClear.addEventListener('click', () => {
      st.downloaded.clear();
      saveCache();
      renderList();
      toast('已清空下载记录');
    });

    /* ---- 样式 ---- */
    const css = `
    #cxppt-panel{position:fixed;right:14px;top:70px;width:372px;max-height:calc(100vh - 90px);
      display:flex;flex-direction:column;z-index:2147483000;background:#1f2329;color:#e6e6e6;
      border:1px solid #3a4048;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.45);
      font:12px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;overflow:hidden}
    #cxppt-panel.cxp-collapsed .cxp-body{display:none}
    #cxppt-panel .cxp-hd{display:flex;align-items:center;justify-content:space-between;
      padding:8px 10px;background:#262b33;cursor:default;user-select:none}
    #cxppt-panel .cxp-title{font-weight:600;font-size:13px}
    #cxppt-panel .cxp-min{width:22px;height:20px;border:none;border-radius:4px;background:#343a43;color:#ddd;cursor:pointer}
    #cxppt-panel .cxp-body{padding:8px 10px;display:flex;flex-direction:column;gap:6px;overflow:hidden}
    #cxppt-panel .cxp-summary{color:#9fb3c8;word-break:break-all}
    #cxppt-panel .cxp-bar{display:flex;gap:6px;flex-wrap:wrap}
    #cxppt-panel .cxp-btn{flex:0 0 auto;padding:4px 9px;border:1px solid #3d4650;border-radius:6px;
      background:#2a3039;color:#dbe3ec;cursor:pointer;font-size:12px}
    #cxppt-panel .cxp-btn:hover:not(:disabled){background:#333b46}
    #cxppt-panel .cxp-btn:disabled{opacity:.5;cursor:not-allowed}
    #cxppt-panel .cxp-primary{background:#2f6feb;border-color:#2f6feb;color:#fff}
    #cxppt-panel .cxp-primary:hover:not(:disabled){background:#3b7bf5}
    #cxppt-panel .cxp-status{color:#8fd18f;min-height:16px;word-break:break-all}
    #cxppt-panel .cxp-list{overflow:auto;max-height:52vh;padding-right:2px}
    #cxppt-panel .cxp-chapter{display:flex;gap:6px;align-items:baseline;margin:8px 0 3px;
      padding:3px 4px;background:#262b33;border-radius:4px}
    #cxppt-panel .cxp-sbar{color:#7fb0ff;font-weight:600;min-width:26px}
    #cxppt-panel .cxp-ctitle{flex:1;color:#dfe7f1;font-weight:600;word-break:break-all}
    #cxppt-panel .cxp-count{color:#8794a3}
    #cxppt-panel .cxp-item{display:flex;gap:5px;align-items:center;padding:2px 4px 2px 10px;border-radius:4px;cursor:pointer}
    #cxppt-panel .cxp-item:hover{background:#2a313a}
    #cxppt-panel .cxp-item.cxp-done .cxp-name{color:#7ec87e}
    #cxppt-panel .cxp-item.cxp-err .cxp-name{color:#ff8f8f}
    #cxppt-panel .cxp-item input{margin:0;flex:0 0 auto}
    #cxppt-panel .cxp-tag{flex:0 0 auto;padding:0 4px;border-radius:3px;background:#3a4048;color:#aab6c4;font-size:11px}
    #cxppt-panel .cxp-tag.cxp-ppt{background:#1d4ed8;color:#fff}
    #cxppt-panel .cxp-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#cfd8e3}
    #cxppt-panel .cxp-meta{flex:0 0 auto;color:#7c8794}
    #cxppt-panel .cxp-open{flex:0 0 auto;border:none;background:transparent;color:#6ea8ff;cursor:pointer;font-size:12px;padding:0 2px}
    #cxppt-panel .cxp-none{color:#6c7783;padding:0 0 2px 12px}
    #cxppt-panel .cxp-empty{color:#8794a3;padding:10px 0}
    #cxppt-panel .cxp-log{color:#e0b25a;min-height:14px;word-break:break-all;font-size:11px;white-space:pre-wrap;max-height:110px;overflow:auto}
    `;
    document.head.appendChild(el('style', { text: css }));
    document.body.appendChild(panel);

    ui = { panel, summary, status, list, log, btnScan, btnDownload, btnPpt };
    refreshSummary();
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => toast('清单已复制到剪贴板'), () => fallback());
    } else fallback();
    function fallback() {
      const ta = el('textarea', { style: 'position:fixed;left:-9999px;top:0' });
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); toast('清单已复制'); } catch (e) { toast('复制失败，请手动复制'); }
      ta.remove();
    }
  }

  /* ============================ 主流程 ============================ */
  async function scanAll(force) {
    if (st.busy) return;
    if (!st.params.courseId || !st.params.clazzId) {
      setStatus('未识别到 courseId/clazzId，请确认在「学生学习」页打开');
      return;
    }
    st.busy = true;
    refreshSummary();
    const chapters = readChapters();
    if (!chapters.length) {
      setStatus('页面上没找到章节列表（#coursetree）');
      st.busy = false;
      refreshSummary();
      return;
    }
    st.chapters = chapters;
    st.selected.clear();
    st.scannedAt = Date.now();
    renderList();

    for (let i = 0; i < chapters.length; i++) {
      const ch = chapters[i];
      setStatus(`扫描 ${i + 1}/${chapters.length}：${ch.sbar} ${ch.title}`);
      try {
        await scanChapter(ch, i);
      } catch (e) {
        ch.attachments = [];
        toast(`扫描 ${ch.title} 出错：${e.message}`);
      }
      (ch.attachments || []).forEach((a) => {
        if (a.isPpt && !st.downloaded.has(a.objectid)) st.selected.add(a.objectid);
      });
      renderList();
      saveCache();
      await sleep(CFG.chapterDelay);
    }
    st.busy = false;
    const n = totalAttachments();
    setStatus(`扫描完成：${chapters.length} 章，共 ${n} 个文档附件，已默认勾选 PPT`);
    refreshSummary();
    saveCache();
  }

  async function runDownloads() {
    if (st.busy) return;
    const items = selectedItems();
    if (!items.length) { toast('没有选中任何文件'); return; }

    st.busy = true;
    st.errors = [];
    refreshSummary();
    const queue = items.slice();
    let done = 0, ok = 0, weak = 0, fail = 0;

    const worker = async () => {
      while (queue.length) {
        const it = queue.shift();
        done++;
        setStatus(`下载 ${done}/${items.length}：${it.att.name || it.att.objectid}`);
        try {
          const info = await ananasStatus(it.att.objectid);
          const name = buildFileName(it.ch, it.att, info.filename);
          const via = await saveFile(info.download, name);
          if (via.startsWith('anchor')) weak++; else ok++;
          st.downloaded.add(it.att.objectid);
          markItem(it.att.objectid, 'ok', via);
        } catch (e) {
          fail++;
          const why = e.message || String(e);
          markItem(it.att.objectid, 'err', why);
          logLine(`✗ ${it.ch.sbar} ${it.att.name || it.att.objectid} —— ${why}`);
          if (e.trace) e.trace.forEach((line) => logLine('   ' + line));
          st.errors.push(`${it.ch.sbar}\t${it.att.name}\t${why}`);
        }
        saveCache();
        await sleep(CFG.statusDelay);
      }
    };

    await Promise.all(Array.from({ length: Math.max(1, CFG.parallel) }, worker));
    st.busy = false;
    refreshSummary();
    setStatus(`下载结束：成功 ${ok}${weak ? `（另有 ${weak} 个仅发起、未确认）` : ''}，失败 ${fail}`);
    if (fail) logLine(`有 ${fail} 个失败，点「诊断」看详细原因，或点每行 ↗ 手动下载`);
  }

  function markItem(oid, cls, msg) {
    if (!ui) return;
    const node = ui.list.querySelector(`.cxp-item[data-oid="${oid}"]`);
    if (!node) return;
    const meta = node.querySelector('.cxp-meta');
    if (cls === 'ok') {
      node.classList.add('cxp-done');
      if (meta && msg) meta.textContent = msg;
    } else {
      node.classList.add('cxp-err');
      node.title = msg || '下载失败';
      if (meta) meta.textContent = '失败';
    }
  }

  // 诊断：对第一个选中（或第一个）附件跑一遍“取直链 + 下载”，把每一步结果摊开
  async function diagnose() {
    const sel = selectedItems();
    let att = sel.length ? sel[0].att : null;
    if (!att) {
      for (const ch of st.chapters) {
        if ((ch.attachments || []).length) { att = ch.attachments[0]; break; }
      }
    }
    if (!att) { logLine('先「扫描全部章节」，再点诊断'); return; }

    setStatus('诊断中…');
    logLine('—— 诊断开始 ——');
    logLine('objectid: ' + att.objectid + '   fid: ' + (st.fid || '未取到') + '   页面: ' + location.href);
    try {
      const info = await ananasStatus(att.objectid, true);
      logLine('✓ status 正常，直链：' + info.download);
      const via = await saveFile(info.download, '诊断_' + (att.name || att.objectid));
      logLine('✓ 保存方式：' + via);
      setStatus('诊断通过：接口和下载都正常');
    } catch (e) {
      logLine('✗ ' + (e.message || String(e)));
      (e.trace || []).forEach((l) => logLine('   ' + l));
      console.warn('[超星PPT导出] 诊断失败', e);
      setStatus('诊断失败，详情见下方日志');
    }
    copyText(ui.log.textContent);
  }

  function init() {
    if (document.getElementById('cxppt-panel')) return;
    if (!document.querySelector('#coursetree')) return;   // 不是章节页，不打扰
    st.params = readParams();
    st.courseName = readCourseName();
    buildPanel();
    if (loadCache()) {
      st.chapters.forEach((ch) => (ch.attachments || []).forEach((a) => {
        if (a.isPpt && !st.downloaded.has(a.objectid)) st.selected.add(a.objectid);
      }));
      renderList();
      setStatus('已载入上次扫描结果，可「扫描全部章节」刷新');
    } else {
      renderList();
      setStatus('就绪，点「扫描全部章节」开始');
    }
    console.log('[超星PPT导出] ready', st.params, st.courseName);
  }

  // 调试用：在控制台写 window.__CXPPT_DEBUG__ = true 后刷新，可拿到内部函数自测
  if (window.__CXPPT_DEBUG__) {
    window.__cxpptInternals = { collectAttachments, cardsUrl, pickField, readChapters, normalizeUrl, buildFileName, st };
  }

  // 章节树可能是异步渲染的，轮询等它出现
  let tries = 0;
  const timer = setInterval(() => {
    tries++;
    if (document.querySelector('#coursetree')) { clearInterval(timer); init(); }
    else if (tries > 40) clearInterval(timer);
  }, 500);
})();
