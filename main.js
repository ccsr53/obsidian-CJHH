'use strict';
/*
 * UI 汉化 (ui-zh) for Obsidian
 * ---------------------------------------------------------------
 * 设计原则（写死，别改）：
 *  1. 只写 DOM 的 Text.nodeValue 和少数属性，永不 innerHTML，永不改任何插件文件。
 *  2. 每个被改过的节点都留原文快照，可一键全量还原。
 *  3. 术语 / 标识符 / 路径 / 代码 一律不送翻译，<keep> 表里的词永远保持英文。
 *  4. 界面翻译是事件驱动的常驻观察（零轮询）；词条扫描只在你按按钮时跑。
 *  5. 不静默花钱：没有 Key 或没点按钮，绝不发网络请求。
 * ---------------------------------------------------------------
 * 结构：纯函数区 → DOM 守卫 → 静态提取 → 插件主体 → 设置页
 */

const { Plugin, PluginSettingTab, Setting, Notice, requestUrl, normalizePath, SuggestModal } = require('obsidian');

const DICT_SCHEMA = 1;
/** 单个插件一次扫描最多翻多少条（控制费用，可改） */
const SCAN_CAP = 450;

/* =====================================================================
 * 1. 纯函数区（不依赖 Obsidian / DOM，可单测）
 * ===================================================================*/

/** 词典查找用的归一化：小写、压空格、去首尾引号、去尾部冒号/省略号 */
function normKey(s) {
  return String(s)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '')
    .replace(/[:：.…]+$/g, '')
    .toLowerCase();
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 稳定短哈希，用于缓存键（FNV-1a 32bit 双轮） */
function hashKey(s) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 ^= c;
    h1 = (h1 + ((h1 << 1) + (h1 << 4) + (h1 << 7) + (h1 << 8) + (h1 << 24))) >>> 0;
    h2 = (h2 ^ ((c + i) & 0xff)) >>> 0;
    h2 = (h2 * 16777619) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

function hasCjk(s) {
  return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/.test(s);
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 术语大小写归一：Pdf → PDF、api → API、id → ID（只动独立单词） */
const CANONICAL_TERMS = {
  pdf: 'PDF', api: 'API', url: 'URL', json: 'JSON', yaml: 'YAML', html: 'HTML', css: 'CSS',
  svg: 'SVG', png: 'PNG', markdown: 'Markdown', dataviewjs: 'DataviewJS', dataview: 'Dataview',
  github: 'GitHub', git: 'Git', sql: 'SQL', ai: 'AI', llm: 'LLM', oauth: 'OAuth',
  webdav: 'WebDAV', http: 'HTTP', https: 'HTTPS', id: 'ID', ui: 'UI', ux: 'UX',
};
function canonTerms(s) {
  return String(s).replace(
    /\b(pdf|api|url|json|yaml|html|css|svg|png|markdown|dataviewjs|dataview|github|git|sql|ai|llm|oauth|webdav|http|https|id|ui|ux)\b/gi,
    (m) => CANONICAL_TERMS[m.toLowerCase()] || m
  );
}

/** 保留原文的首尾标点（冒号、问号、省略号、句点），避免 "Sync:" → "同步" 丢冒号 */
function applyPunct(orig, trans) {
  let out = String(trans).trim();
  const o = String(orig).trim();
  if (/[:：]$/.test(o) && !/[:：]$/.test(out)) out += '：';
  if (/\.{2,}$/.test(o)) {
    if (!/…$/.test(out)) out += '…';
  } else if (/…$/.test(o) && !/…$/.test(out)) {
    out += '…';
  }
  if (/[?？]$/.test(o) && !/[?？]$/.test(out)) out += '？';
  if (/[!！]$/.test(o) && !/[!！]$/.test(out)) out += '！';
  else if (!/\.{2,}$/.test(o) && /\.$/.test(o) && !/[。.!！?？…]$/.test(out)) out += '。';
  return out;
}

/** 是否值得作为「待译候选」：只挡明显不是界面文案的东西，不做翻译 */
function isCandidate(core) {
  const s = String(core).trim();
  if (s.length < 2 || s.length > 320) return false;
  if (!/[A-Za-z]/.test(s)) return false;
  if (hasCjk(s)) return false;
  if (/^[\s\d\p{P}\p{S}]+$/u.test(s)) return false;
  if (/[\\{}[\]<>=|^~`]/.test(s)) return false;
  if (/:\/\//.test(s)) return false;
  if (/\b[\w-]+\.(?:md|json|js|mjs|cjs|ts|css|png|jpe?g|gif|svg|pdf|canvas|base|txt|ya?ml|zip)\b/i.test(s)) return false;
  if (/^[#@][\w/-]+$/.test(s)) return false;
  // 快捷键组合：保持原样
  if (/^(Ctrl|Alt|Shift|Cmd|Meta|Option)\s*[+＋]\s*/i.test(s)) return false;
  // 字体栈 / CSS 值：不是界面文案
  if (/\b(serif|sans-serif|monospace)\b/i.test(s)) return false;
  if (/^["'].*["'],/.test(s)) return false;
  // 无空格 = 单词/标识符：只允许"看起来像按钮文案"的少量形态（首字母大写 + 短）
  if (!/\s/.test(s)) {
    if (/^[A-Z][a-z]+(?:[A-Z][a-z0-9]*)+$/.test(s)) return false; // SyncNow / OpenInNewTab
    if (s.length > 14) return false;
    if (!/^[A-Z][A-Za-z]+$/.test(s)) return false;
  }
  // 驼峰 / 下划线 / 全大写 标识符
  if (/^[a-z]+[A-Z]\w*$/.test(s)) return false;
  if (/^[A-Z0-9_]{2,}$/.test(s)) return false;
  if (/^v?\d+(?:\.\d+)+$/.test(s)) return false;
  return true;
}

/** 宽松 JSON 解析：容忍 ```json 包裹和前后废话 */
function parseJsonLoose(text) {
  const s = String(text).replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    return JSON.parse(s.slice(a, b + 1));
  } catch (e) {
    return null;
  }
}

/* =====================================================================
 * 2. DOM 守卫：哪些地方永远不碰
 * ===================================================================*/

/** 子树级跳过：笔记内容、编辑器、代码、公式、画布、表单值 */
const SKIP_SELECTOR = [
  '.cm-editor',
  '.markdown-source-view',
  '.markdown-reading-view',
  '.markdown-preview-view',
  '.markdown-embed',
  'code',
  'pre',
  'kbd',
  'samp',
  'var',
  'textarea',
  'select',
  '[contenteditable="true"]',
  'canvas',
  '.canvas-wrapper',
  '.excalidraw',
  '.pdf-embed',
  '.graph-view',
  '.local-graph',
  '.mjx-container',
  '.math',
  '.MathJax',
  '.ui-zh-self', // 本插件自己的界面
].join(',');

/* =====================================================================
 * 3. 静态提取：从插件 main.js 里捞候选 UI 字符串（只读，不改文件）
 * ===================================================================*/

const STR_RE = /"((?:[^"\\\n]|\\.){2,160})"|'((?:[^'\\\n]|\\.){2,160})'|`([^`\\$]{2,160})`/g;
const BAD_WORDS = /\b(?:function|return|var|let|const|import|require|undefined|null|true|false|classList|querySelector|addEventListener|prototype|constructor|display|position|margin|padding|width|height)\b/i;
const BAD_CHARS = /[{}<>=;|&$\\]/;

function unescapeJs(s) {
  return s
    .replace(/\\n/g, ' ')
    .replace(/\\t/g, ' ')
    .replace(/\\u([0-9a-fA-F]{4})/g, (m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\(["'`\\/])/g, '$1');
}

function isLikelyUi(s) {
  if (!s || s.length < 3 || s.length > 120) return false;
  if (!/[A-Za-z]{2}/.test(s)) return false;
  if (hasCjk(s)) return false;
  if (!/\s/.test(s) && !/:$/.test(s)) return false;
  if (BAD_CHARS.test(s) || BAD_WORDS.test(s)) return false;
  if (/^[\s\d\p{P}\p{S}]+$/u.test(s)) return false;
  if (/(?:px\b|rem\b|rgba?\(|hsl\(|url\(|@media)/.test(s)) return false;
  if (/^https?:/i.test(s)) return false;
  if (!/[a-z]{3}/.test(s)) return false;
  return true;
}

/** 常见界面动词：用来给候选排序，优先翻真正会显示的文案 */
const UI_VERBS = /\b(add|create|delete|remove|open|close|save|cancel|enable|disable|select|choose|enter|click|press|show|hide|set|edit|rename|move|copy|paste|export|import|download|upload|sync|refresh|reload|update|install|uninstall|reset|restore|apply|confirm|search|filter|sort|view|preview|toggle|switch|start|stop|run|test|check|clear|load|send|insert|format|configure|manage|connect|disconnect|login|logout|sign|upgrade|backup|notice|warning|error|failed|success|please|are you sure)\b/i;

/** 库内部字符串（日志、断言、类型标注）先剔掉，省 token */
function isNoiseString(s) {
  if (/^[a-z]/.test(s) && !/[:?…]$/.test(s)) return true;
  if (/[()]/.test(s)) return true;
  if (/^(use strict|object |\[object|assert|at |node:)/i.test(s)) return true;
  if (/^[a-z_$][\w$]*\s*[:=]/.test(s)) return true;
  return false;
}

function uiScore(s) {
  let n = 0;
  if (/[:?…]$/.test(s)) n += 3;
  if (/^[A-Z]/.test(s)) n += 2;
  if (UI_VERBS.test(s)) n += 2;
  if (s.length <= 40) n += 1;
  if (s.length > 80) n -= 2;
  if (/\b(assert|unexpected|deprecated|prototype|constructor|iterator|deserialize|serialize)\b/i.test(s)) n -= 3;
  if (/^\d/.test(s)) n -= 3;
  return n;
}

/** 从主题 / 片段的 CSS 里抠出 Style Settings 的界面文案（@settings 块） */
function extractCssSettingStrings(css) {
  const out = new Set();
  const blocks = String(css).match(/\/\*[\s\S]*?@settings[\s\S]*?\*\//g) || [];
  for (const block of blocks) {
    for (const line of block.split('\n')) {
      const m = /^\s*(?:name|title|description|heading)\s*:\s*(.+?)\s*$/.exec(line);
      if (!m) continue;
      const v = m[1]
        .replace(/^["']|["']$/g, '')
        .replace(/\\"/g, '"')
        .trim();
      if (!v || v.length < 2 || v.length > 160) continue;
      if (!/[A-Za-z]/.test(v) || hasCjk(v)) continue;
      out.add(v);
    }
  }
  return [...out];
}

function extractCandidates(source, cap) {
  const out = new Set();
  STR_RE.lastIndex = 0;
  let m;
  while ((m = STR_RE.exec(source))) {
    const raw = unescapeJs(m[1] ?? m[2] ?? m[3] ?? '').replace(/\s+/g, ' ').trim();
    if (!isLikelyUi(raw)) continue;
    if (out.size >= cap) break;
    out.add(raw);
  }
  return [...out];
}

/* =====================================================================
 * 4. 插件主体
 * ===================================================================*/

const DEFAULT_SETTINGS = {
  enabled: true,
  translatePlaceholders: true,
  translateAriaLabels: true,
  translateTitles: false,
  autoScanOnNewPlugin: false,
  keepExtra: [],
  excludeSelectors: '',
  llmEnabled: false,
  llmBaseUrl: 'https://api.deepseek.com',
  llmApiKey: '',
  llmModel: 'deepseek-chat',
  llmBatchSize: 40,
  statusBarMode: 'always',
  debug: false,
};

const DEFAULT_KEEP = [
  'Obsidian Publish', 'Obsidian Sync', 'Obsidian', 'Markdown', 'DataviewJS', 'Dataview',
  'Templater', 'Excalidraw', 'JavaScript', 'TypeScript', 'MathJax', 'Mermaid', 'LaTeX',
  'GitHub', 'GitLab', 'Google Drive', 'OneDrive', 'Dropbox', 'WebDAV', 'OAuth2', 'OAuth',
  'OpenAI', 'DeepSeek', 'Copilot', 'Claude', 'Gemini', 'Kanban', 'Canvas', 'JSON', 'YAML',
  'HTML', 'CSS', 'SVG', 'PNG', 'PDF', 'API Key', 'API', 'URL', 'URI', 'HTTP', 'HTTPS',
  'Git', 'Token', 'UUID', 'LLM', 'GitHub', 'ID', 'AI',
];

class UiZhPlugin extends Plugin {
  async onload() {
    try {
      await this.boot();
    } catch (e) {
      // 加载期异常写盘，便于排查（Obsidian 只会弹一句通用错误）
      try {
        const dir = this.manifest && this.manifest.dir ? this.manifest.dir : '.obsidian/plugins/ui-zh';
        await this.app.vault.adapter.write(normalizePath(`${dir}/boot-error.txt`), String((e && e.stack) || e));
      } catch (e2) { /* ignore */ }
      throw e;
    }
  }

  async boot() {
    await this.loadSettings();
    this.dict = { base: new Map(), plugins: new Map(), regex: [], version: 0 };
    this.glossary = { keep: [], fixed: {} };
    this.llmCache = new Map();
    this.state = { cache: {}, pending: {}, knownPlugins: {}, cacheOrder: [] };
    this.applied = []; // {kind:'text'|'attr', node|el, attr, original}
    this.doneText = new WeakSet();
    this.doneAttrs = new WeakMap();
    this.queue = [];
    this.queued = new Set();
    this.timer = null;
    this.saveTimer = null;
    this.translating = false;

    this.pluginIds = new Set();
    this.pluginNameToId = new Map();
    this.refreshPluginIndex();

    await this.loadDict();
    await this.loadState();
    this.prunePending();
    // 心跳：加载成功后立刻落盘，便于「插件到底有没有跑起来」这类问题自查
    this.state.boot = {
      at: Date.now(),
      version: this.manifest.version,
      base: this.dict.base.size,
      shards: this.dict.plugins.size,
      keepFiltered: this.keepFiltered || 0,
      dir: this.manifest.dir || null,
    };
    this.flushState();

    this.statusBar = this.addStatusBarItem();
    this.statusBar.addClass('ui-zh-status');
    this.statusBar.addEventListener('click', () => this.openSettings());
    this.updateStatusBar();

    this.addRibbonIcon('languages', 'UI 汉化：扫描当前界面并翻译', () => this.scanCurrentView(true));

    this.addCommand({ id: 'scan-current', name: '扫描当前界面文案', callback: () => this.scanCurrentView(true) });
    this.addCommand({ id: 'scan-current-now', name: '扫描当前界面并翻译（建议绑快捷键）', callback: () => this.scanCurrentView(true) });
    this.addCommand({ id: 'scan-plugin', name: '扫描指定插件', callback: () => this.pickPlugin() });
    this.addCommand({ id: 'scan-all', name: '扫描全部插件', callback: () => this.scanAllPlugins() });
    this.addCommand({ id: 'scan-theme', name: '扫描主题样式（Style Settings）', callback: () => this.scanThemeStyles() });
    this.addCommand({ id: 'translate-pending', name: '翻译待办文案', callback: () => this.translatePending() });
    this.addCommand({ id: 'toggle', name: '开关界面汉化', callback: () => this.toggleEnabled() });
    this.addCommand({ id: 'restore', name: '还原界面原文', callback: () => this.restoreAll(true) });
    this.addCommand({ id: 'reload-dict', name: '重新加载词典并重刷界面（改完术语表/词典用这个）', callback: () => this.reloadDictAndRescan() });
    this.addCommand({ id: 'export-pending', name: '导出待译清单到剪贴板', callback: () => this.exportPending() });

    // 允许从外部触发（可收藏为系统快捷方式）：obsidian://ui-zh?action=scan-all
    this.registerObsidianProtocolHandler('ui-zh', (p) => this.handleUri(p));

    this.addSettingTab(new UiZhSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      this.detectNewPlugins();
      if (this.settings.enabled) this.startObserver();
    });
  }

  onunload() {
    this.stopObserver();
    this.restoreAll(false);
    this.flushState();
  }

  openSettings() {
    this.app.setting.open();
    this.app.setting.openTabById(this.manifest.id);
  }

  /** 改完术语表 / 手改词典后：重载 + 还原 + 重扫 */
  async reloadDictAndRescan() {
    await this.loadDict();
    this.restoreAll(false);
    for (const d of this.allDocs()) {
      if (d && d.body) this.scanRoot(d.body);
    }
    new Notice(
      `UI 汉化：词典已重载（通用 ${this.dict.base.size} / 分片 ${this.dict.plugins.size}），按术语表屏蔽 ${this.keepFiltered || 0} 条`,
      7000
    );
  }

  /** obsidian://ui-zh?action=... 外部触发入口 */
  async handleUri(p) {
    const action = (p && (p.action || p[''])) || 'status';
    try {
      if (action === 'scan-all') {
        new Notice('UI 汉化：开始全部插件扫描');
        await this.scanAllPlugins();
      } else if (action === 'scan-plugin' && p.id) {
        await this.scanPluginById(String(p.id));
      } else if (action === 'scan-current') {
        await this.scanCurrentView(true);
      } else if (action === 'translate-pending') {
        await this.translatePending();
      } else if (action === 'restore') {
        this.restoreAll(true);
      } else if (action === 'toggle') {
        await this.toggleEnabled();
      } else {
        const n = Object.keys(this.state.pending || {}).length;
        new Notice(`UI 汉化：${this.settings.enabled ? 'ON' : 'OFF'} · 词条 ${this.dict.base.size} · 待译 ${n}`, 5000);
      }
    } catch (e) {
      new Notice('UI 汉化：执行失败 — ' + (e && e.message ? e.message : e), 8000);
    }
  }

  /* ---------------- 设置 ---------------- */

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) || {});
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /* ---------------- 插件清单 ---------------- */

  refreshPluginIndex() {
    this.pluginIds.clear();
    this.pluginNameToId.clear();
    const manifests = (this.app.plugins && this.app.plugins.manifests) || {};
    for (const [id, man] of Object.entries(manifests)) {
      this.pluginIds.add(id);
      if (man && man.name) this.pluginNameToId.set(man.name, id);
    }
  }

  detectNewPlugins() {
    const known = this.state.knownPlugins || {};
    const fresh = [];
    const manifests = (this.app.plugins && this.app.plugins.manifests) || {};
    for (const [id, man] of Object.entries(manifests)) {
      if (id === this.manifest.id) continue;
      const v = (man && man.version) || '';
      if (!known[id]) {
        known[id] = v;
        fresh.push({ id, name: (man && man.name) || id, v });
      } else if (known[id] !== v) {
        known[id] = v;
        fresh.push({ id, name: (man && man.name) || id, v, updated: true });
      }
    }
    this.state.knownPlugins = known;
    this.saveStateSoon();
    if (!fresh.length) return;
    const line = fresh.map((f) => `${f.name}${f.updated ? '(已更新)' : ''}`).join('、');
    new Notice(`UI 汉化：发现 ${fresh.length} 个插件变动（${line}）。\n需要翻译请点「扫描指定插件」。`, 8000);
    if (this.settings.autoScanOnNewPlugin && this.settings.llmEnabled) {
      for (const f of fresh) this.scanPluginById(f.id);
    }
  }

  /* ---------------- 词典 ---------------- */

  readJson(relPath) {
    const p = normalizePath(relPath);
    return this.app.vault.adapter.read(p).then((t) => JSON.parse(t));
  }

  dictDir() {
    return normalizePath(`${this.manifest.dir}/dict`);
  }

  async loadDict() {
    const base = new Map();
    const plugins = new Map();
    const regex = [];
    const dir = this.dictDir();

    const addEntries = (target, obj) => {
      if (!obj || typeof obj !== 'object') return;
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v !== 'string' || !v) continue;
        target.set(normKey(k), v);
      }
    };

    // base.json
    try {
      const j = await this.readJson(`${dir}/base.json`);
      addEntries(base, j.entries || j);
      if (Array.isArray(j.regex)) {
        for (const r of j.regex) {
          try {
            regex.push({ re: new RegExp(r.re, r.flags || ''), to: r.to });
          } catch (e) { /* 坏正则忽略 */ }
        }
      }
    } catch (e) { /* 缺文件正常 */ }

    // glossary.json
    try {
      const g = await this.readJson(`${dir}/glossary.json`);
      this.glossary = {
        keep: Array.isArray(g.keep) ? g.keep : [],
        fixed: g.fixed && typeof g.fixed === 'object' ? g.fixed : {},
      };
    } catch (e) {
      this.glossary = { keep: [], fixed: {} };
    }
    // glossary.fixed 里的固定译法并入通用词典（优先级最低，不覆盖已有词条）
    if (this.glossary.fixed) {
      const tmp = new Map();
      addEntries(tmp, this.glossary.fixed);
      for (const [k, v] of tmp) if (!base.has(k)) base.set(k, v);
    }

    // dict/plugins/*.json
    try {
      const list = await this.app.vault.adapter.list(`${dir}/plugins`);
      for (const f of list.files || []) {
        if (!f.endsWith('.json')) continue;
        const id = f.split('/').pop().replace(/\.json$/, '');
        try {
          const j = await this.readJson(f);
          const m = new Map();
          addEntries(m, j.entries || j);
          plugins.set(id, m);
        } catch (e) { /* 单文件坏了不影响其它 */ }
      }
    } catch (e) { /* 目录不存在 */ }

    // 术语表优先：keep 里出现的词，即使词典里已有译法也一律不翻
    try {
      const keepSet = new Set(
        [
          ...DEFAULT_KEEP,
          ...(this.glossary.keep || []),
          ...(this.settings.keepExtra || []),
          // 已装插件的显示名一律保留英文，也避免它们一直堆在待译里
          ...(this.pluginNameToId ? [...this.pluginNameToId.keys()] : []),
        ]
          .map((s) => normKey(s))
          .filter(Boolean)
      );
      let removed = 0;
      const strip = (map) => {
        for (const k of [...map.keys()]) {
          if (keepSet.has(k)) {
            map.delete(k);
            removed++;
          }
        }
      };
      strip(base);
      for (const m of plugins.values()) strip(m);
      this.keepFiltered = removed;
      this.keepSet = keepSet;
    } catch (e) {
      this.keepFiltered = 0;
      this.keepSet = new Set();
    }

    this.dict = { base, plugins, regex, version: Date.now() };
    this.log(`词典加载：通用 ${base.size} 条，插件 ${plugins.size} 个，正则 ${regex.length} 条，术语屏蔽 ${this.keepFiltered} 条`);
  }

  /** 查词：先插件分片，再通用，再正则 */
  lookup(text, ctxId) {
    const key = normKey(text);
    if (ctxId) {
      const m = this.dict.plugins.get(ctxId);
      if (m && m.has(key)) return m.get(key);
    }
    if (this.dict.base.has(key)) return this.dict.base.get(key);
    // 主题/Style Settings 文案走共享分片
    const themeShard = this.dict.plugins.get('_theme');
    if (themeShard && themeShard.has(key)) return themeShard.get(key);
    for (const r of this.dict.regex) {
      if (r.re.test(text)) return text.replace(r.re, r.to);
    }
    // LLM 译过的成品直接复用，不再请求
    const ck = this.cacheKey(text, this.settings.llmModel);
    if (this.llmCache.has(ck)) return this.llmCache.get(ck);
    return null;
  }

  /** 是否术语表里的词（保留英文，不算待译） */
  isKeepTerm(text) {
    if (!this.keepSet) return false;
    return this.keepSet.has(normKey(text));
  }

  /** 不分上下文的全量查词（用于清理待办、判断是否已收录） */
  lookupAny(text) {
    const key = normKey(text);
    if (this.dict.base.has(key)) return this.dict.base.get(key);
    for (const m of this.dict.plugins.values()) if (m.has(key)) return m.get(key);
    for (const r of this.dict.regex) if (r.re.test(text)) return text.replace(r.re, r.to);
    const ck = this.cacheKey(text, this.settings.llmModel);
    if (this.llmCache.has(ck)) return this.llmCache.get(ck);
    return null;
  }

  /* ---------------- 状态持久化 ---------------- */

  async loadState() {
    try {
      const j = await this.readJson(`${this.manifest.dir}/state.json`);
      this.state = {
        cache: j.cache || {},
        pending: j.pending || {},
        knownPlugins: j.knownPlugins || {},
        cacheOrder: j.cacheOrder || [],
      };
    } catch (e) { /* 首次运行 */ }
    for (const k of Object.keys(this.state.cache)) this.llmCache.set(k, this.state.cache[k]);
  }

  saveStateSoon() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flushState();
    }, 1500);
  }

  flushState() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    this.state.cache = Object.fromEntries(this.llmCache);
    // LRU 截断
    const keys = [...this.llmCache.keys()];
    if (keys.length > 8000) {
      for (const k of keys.slice(0, keys.length - 8000)) this.llmCache.delete(k);
      this.state.cache = Object.fromEntries(this.llmCache);
    }
    const payload = JSON.stringify(this.state);
    this.app.vault.adapter.write(normalizePath(`${this.manifest.dir}/state.json`), payload).catch(() => {});
  }

  log(...args) {
    if (this.settings && this.settings.debug) console.log('[ui-zh]', ...args);
  }

  /* ---------------- 开关 ---------------- */

  async toggleEnabled() {
    this.settings.enabled = !this.settings.enabled;
    await this.saveSettings();
    if (this.settings.enabled) {
      this.startObserver();
      new Notice('UI 汉化：已开启');
    } else {
      this.stopObserver();
      this.restoreAll(false);
      new Notice('UI 汉化：已关闭，界面已还原');
    }
    this.updateStatusBar();
  }

  updateStatusBar() {
    if (!this.statusBar) return;
    const mode = this.settings.statusBarMode || 'always';
    const n = Object.keys(this.state.pending || {}).length;
    if (mode === 'never' || (mode === 'pending' && n === 0)) {
      if (this.statusBar.style) this.statusBar.style.display = 'none';
      return;
    }
    if (this.statusBar.style) this.statusBar.style.display = '';
    const tag = this.settings.enabled ? '汉化 ON' : '汉化 OFF';
    this.statusBar.setText(mode === 'pending' ? `待译 ${n}` : `${tag}${n ? ` · 待译 ${n}` : ''}`);
    this.statusBar.setAttribute('aria-label', 'UI 汉化：点击打开设置');
  }

  /* ---------------- DOM 观察（事件驱动，零轮询） ---------------- */

  startObserver() {
    if (this.observers && this.observers.length) return;
    this.observers = [];
    this.observedDocs = new Set();
    this.attachWindow(window);
    // 设置弹窗可能是独立窗口（app.json: settingsPopoutWindow），必须一起观察
    this.installSettingsHook();
    for (const d of this.windowsDocs()) this.attachWindow(d.defaultView || d);
    this.registerEvent(
      this.app.workspace.on('window-open', (ww, win) => {
        this.attachWindow(win || (ww && (ww.win || ww)));
      })
    );
    this.registerEvent(this.app.workspace.on('layout-change', () => this.attachAllWindows()));
    // 首扫落地后的自检快照：证明「真的改了 DOM」，而不是只加载了词典
    setTimeout(() => {
      try {
        const sample = this.applied.slice(0, 6).map((r) =>
          r.kind === 'text'
            ? [r.original, r.node && r.node.isConnected ? r.node.nodeValue : null]
            : [r.original, r.el ? r.el.getAttribute(r.attr) : null]
        );
        this.state.bootScan = {
          at: Date.now(),
          applied: this.applied.length,
          pending: Object.keys(this.state.pending || {}).length,
          windows: this.observedDocs ? this.observedDocs.size : 0,
          sample,
        };
        this.flushState();
        this.log('首扫结果', this.state.bootScan);
      } catch (e) { /* ignore */ }
    }, 2500);
  }

  windowsDocs() {
    const out = [];
    try {
      const wins = (this.app.workspace && this.app.workspace.windows) || [];
      for (const w of wins) {
        const win = w && (w.win || w);
        if (win && win.document) out.push(win.document);
      }
    } catch (e) { /* ignore */ }
    // 设置弹窗在 Obsidian 1.15 默认是独立窗口，它不属于 workspace.windows
    try {
      const st = this.app.setting;
      let win = null;
      if (st && typeof st.getPopoutWindow === 'function') win = st.getPopoutWindow();
      if (!win && st && st.popout && st.popout.win) win = st.popout.win;
      if (win && win.document) out.push(win.document);
      if (st && st.modalEl && st.modalEl.ownerDocument && st.modalEl.ownerDocument !== document) {
        out.push(st.modalEl.ownerDocument);
      }
    } catch (e) { /* ignore */ }
    return out;
  }

  /** 设置窗口是懒创建的，挂一次 open 钩子，开窗后立刻补挂观察器 */
  installSettingsHook() {
    try {
      const st = this.app.setting;
      if (!st || st.__uiZhPatched || typeof st.open !== 'function') return;
      const self = this;
      const orig = st.open;
      st.__uiZhOrig = orig;
      st.open = function (...args) {
        const ret = orig.apply(this, args);
        setTimeout(() => {
          try {
            if (this.getPopoutWindow) self.attachWindow(this.getPopoutWindow());
            const d = this.modalEl && this.modalEl.ownerDocument;
            if (d && d !== document) self.attachWindow(d.defaultView);
            self.scanRoot((d && d.body) || document.body);
          } catch (e) { /* ignore */ }
        }, 250);
        return ret;
      };
      st.__uiZhPatched = true;
    } catch (e) { /* ignore */ }
  }

  uninstallSettingsHook() {
    try {
      const st = this.app.setting;
      if (st && st.__uiZhPatched && st.__uiZhOrig) {
        st.open = st.__uiZhOrig;
        delete st.__uiZhOrig;
        delete st.__uiZhPatched;
      }
    } catch (e) { /* ignore */ }
  }

  attachAllWindows() {
    const now = Date.now();
    if (this.lastAttachAt && now - this.lastAttachAt < 1200) return;
    this.lastAttachAt = now;
    for (const d of this.windowsDocs()) this.attachWindow(d.defaultView || d);
    // 设置窗口若是启动时自动恢复的，open 钩子不会触发，这里补一次
    try {
      const st = this.app.setting;
      const win = (st && st.getPopoutWindow && st.getPopoutWindow()) || (st && st.popout && st.popout.win);
      if (win) this.attachWindow(win);
    } catch (e) { /* ignore */ }
  }

  attachWindow(win) {
    if (!win || !win.document || !win.document.body) return;
    const doc = win.document;
    if (this.observedDocs.has(doc)) return;
    this.observedDocs.add(doc);
    const obs = new MutationObserver((muts) => this.onMutations(muts));
    obs.observe(doc.body, { childList: true, characterData: true, subtree: true });
    this.observers.push(obs);
    this.scanRoot(doc.body);
  }

  stopObserver() {
    for (const o of this.observers || []) {
      try { o.disconnect(); } catch (e) { /* ignore */ }
    }
    this.observers = [];
    this.observedDocs = new Set();
    this.uninstallSettingsHook();
    if (this.observer) {
      try { this.observer.disconnect(); } catch (e) { /* ignore */ }
      this.observer = null;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.queue = [];
    this.queued.clear();
  }

  onMutations(muts) {
    if (!this.settings.enabled) return;
    this.attachAllWindows();
    for (const m of muts) {
      if (m.type === 'characterData') {
        this.push(m.target);
      } else if (m.type === 'childList') {
        for (const n of m.addedNodes) this.push(n);
      }
    }
    this.schedule();
  }

  push(node) {
    if (!node) return;
    if (node.nodeType === 3) {
      if (this.queued.has(node)) return;
      this.queued.add(node);
      this.queue.push(node);
      return;
    }
    if (node.nodeType !== 1) return;
    if (node.nodeName === 'SCRIPT' || node.nodeName === 'STYLE' || node.nodeName === 'LINK') return;
    if (this.queued.has(node)) return;
    this.queued.add(node);
    this.queue.push(node);
  }

  schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.drain();
    }, 50);
  }

  drain() {
    const t0 = performance.now();
    while (this.queue.length && performance.now() - t0 < 12) {
      const n = this.queue.shift();
      this.queued.delete(n);
      try {
        this.processTree(n);
      } catch (e) {
        this.log('processTree 失败', e);
      }
    }
    if (this.queue.length) this.schedule();
  }

  isSkipped(el) {
    if (!el || !el.closest) return false;
    if (el.closest(SKIP_SELECTOR)) return true;
    const user = (this.settings.excludeSelectors || '').trim();
    if (user) {
      try {
        if (el.closest(user)) return true;
      } catch (e) { /* 用户选择器写错，忽略 */ }
    }
    if (el.isContentEditable) return true;
    return false;
  }

  ctxPluginId(el) {
    try {
      const leaf = el.closest('.workspace-leaf-content[data-type]');
      if (leaf) {
        const dt = leaf.getAttribute('data-type');
        if (dt) {
          if (this.pluginIds.has(dt)) return dt;
          for (const id of this.pluginIds) {
            if (dt === id || dt.startsWith(id + '-')) return id;
          }
        }
      }
      // 设置弹窗（含独立窗口）：优先用 Obsidian 自己记录的当前 tab
      const inModal = el.closest('.modal-container') || el.closest('.modal');
      if (inModal) {
        const st = this.app.setting;
        const tabId = st && (st.lastTabId || (st.activeTab && (st.activeTab.id || (st.activeTab.plugin && st.activeTab.plugin.manifest && st.activeTab.plugin.manifest.id))));
        if (tabId && this.pluginIds.has(tabId)) return tabId;
        const active = inModal.querySelector('.vertical-tab-nav-item.is-active');
        const name = active && active.textContent ? active.textContent.trim() : '';
        if (name && this.pluginNameToId.has(name)) return this.pluginNameToId.get(name);
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  processTree(root) {
    if (!this.settings.enabled || !root) return;
    if (root.nodeType === 3) return this.processText(root);
    if (root.nodeType !== 1) return;
    if (this.isSkipped(root)) return;

    this.processAttrs(root);

    if (this.settings.translatePlaceholders || this.settings.translateAriaLabels || this.settings.translateTitles) {
      let list = [];
      try {
        list = root.querySelectorAll('input[placeholder],textarea[placeholder],[aria-label],[title]');
      } catch (e) { list = []; }
      let i = 0;
      for (const n of list) {
        this.processAttrs(n);
        if (++i > 1500) break;
      }
    }

    const doc = root.ownerDocument || document;
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        n.parentElement && this.isSkipped(n.parentElement) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    let n;
    let guard = 0;
    while ((n = walker.nextNode())) {
      this.processText(n);
      if (++guard > 6000) break;
    }
  }

  processText(node) {
    if (!node || !node.isConnected) return;
    if (this.doneText.has(node)) return;
    const parent = node.parentElement;
    if (!parent || this.isSkipped(parent)) return;

    const raw = node.nodeValue;
    if (!raw) return;
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(raw);
    const core = m[2];
    if (!core) { this.doneText.add(node); return; }
    if (hasCjk(core)) { this.doneText.add(node); return; }

    const ctx = this.ctxPluginId(parent);
    const hit = this.lookup(core, ctx);
    if (!hit) {
      if (isCandidate(core)) this.notePending(core, ctx);
      else this.doneText.add(node);
      return;
    }
    const next = m[1] + applyPunct(core, hit) + m[3];
    if (next === raw) { this.doneText.add(node); return; }
    this.applied.push({ kind: 'text', node, original: raw });
    node.nodeValue = next;
    this.doneText.add(node);
  }

  processAttrs(el) {
    if (!el || el.nodeType !== 1) return;
    if (this.isSkipped(el)) return;
    const attrs = [];
    if (this.settings.translatePlaceholders && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.getAttribute('placeholder')) {
      if ((el.getAttribute('type') || '').toLowerCase() !== 'password') attrs.push('placeholder');
    }
    if (this.settings.translateAriaLabels && el.getAttribute('aria-label')) attrs.push('aria-label');
    if (this.settings.translateTitles && el.getAttribute('title')) attrs.push('title');
    if (!attrs.length) return;

    let seen = this.doneAttrs.get(el);
    if (!seen) { seen = new Set(); this.doneAttrs.set(el, seen); }

    const ctx = this.ctxPluginId(el);
    for (const attr of attrs) {
      if (seen.has(attr)) continue;
      const raw = el.getAttribute(attr);
      if (!raw || hasCjk(raw)) { if (raw) seen.add(attr); continue; }
      const hit = this.lookup(raw.trim(), ctx);
      if (!hit) {
        if (isCandidate(raw.trim())) this.notePending(raw.trim(), ctx);
        else seen.add(attr);
        continue;
      }
      this.applied.push({ kind: 'attr', el, attr, original: raw });
      el.setAttribute(attr, applyPunct(raw, hit));
      seen.add(attr);
    }
  }

  /* 还原 */
  restoreAll(notify) {
    let n = 0;
    for (let i = this.applied.length - 1; i >= 0; i--) {
      const r = this.applied[i];
      try {
        if (r.kind === 'text') {
          if (r.node) { r.node.nodeValue = r.original; n++; }
        } else if (r.el) {
          r.el.setAttribute(r.attr, r.original);
          n++;
        }
      } catch (e) { /* 节点已销毁 */ }
    }
    this.applied = [];
    this.doneText = new WeakSet();
    this.doneAttrs = new WeakMap();
    if (notify) {
      new Notice(`UI 汉化：已还原 ${n} 处原文`);
      if (this.settings.enabled) this.scanRoot(document.body);
    }
  }

  scanRoot(root) {
    if (!this.settings.enabled) return;
    // 首屏/重扫：不再入队重复节点
    this.push(root);
    this.schedule();
  }

  /* ---------------- 待译记录 ---------------- */

  notePending(text, ctx) {
    const key = normKey(text);
    if (!key) return;
    if (this.isKeepTerm(text)) return;
    if (this.lookupAny(text)) return;
    const store = this.state.pending;
    const count = Object.keys(store).length;
    if (!store[key] && count >= 4000) return;
    const rec = store[key] || { t: text, p: ctx || '', n: 0 };
    rec.n = (rec.n || 0) + 1;
    if (!rec.p && ctx) rec.p = ctx;
    store[key] = rec;
    this.saveStateSoon();
    this.updateStatusBar();
  }

  pendingList() {
    return Object.entries(this.state.pending).map(([k, v]) => ({ key: k, text: v.t, plugin: v.p || '', hits: v.n || 1 }));
  }

  /** 词典更新后，把已经有译文的待译条目清掉，避免待译数虚高 */
  prunePending() {
    let n = 0;
    for (const [k, v] of Object.entries(this.state.pending || {})) {
      if (!v || typeof v.t !== 'string') { delete this.state.pending[k]; n++; continue; }
      if (this.isKeepTerm(v.t) || this.lookupAny(v.t) || !isCandidate(v.t)) { delete this.state.pending[k]; n++; }
    }
    if (n) {
      this.saveStateSoon();
      this.updateStatusBar();
      this.log('清理已译待办', n);
    }
    return n;
  }

  async exportPending() {
    const list = this.pendingList();
    if (!list.length) return new Notice('UI 汉化：当前没有待译条目');
    const payload = JSON.stringify({ generatedAt: new Date().toISOString(), count: list.length, items: list }, null, 2);
    try {
      await navigator.clipboard.writeText(payload);
      new Notice(`UI 汉化：已复制 ${list.length} 条待译清单到剪贴板`);
    } catch (e) {
      new Notice('UI 汉化：复制失败，请看控制台');
      console.log(payload);
    }
  }

  /* ---------------- 术语保护 ---------------- */

  keepTerms() {
    const set = new Set([...DEFAULT_KEEP, ...(this.glossary.keep || []), ...(this.settings.keepExtra || [])]);
    return [...set].filter(Boolean).sort((a, b) => b.length - a.length);
  }

  protect(text) {
    const tokens = [];
    let out = String(text);
    for (const term of this.keepTerms()) {
      if (!term) continue;
      // 短词（AI / ID / Git）必须按整词匹配，否则会把 Email / Provider 拆碎
      const ascii = /^[A-Za-z0-9][A-Za-z0-9 .+#_-]*$/.test(term);
      let re;
      try {
        re = ascii
          ? new RegExp('(?<![A-Za-z0-9])' + escapeRe(term) + '(?![A-Za-z0-9])', 'gi')
          : new RegExp(escapeRe(term), 'gi');
      } catch (e) {
        re = new RegExp(escapeRe(term), 'gi');
      }
      out = out.replace(re, (m) => {
        tokens.push(m);
        return `@@K${tokens.length}@@`;
      });
    }
    return { masked: out, tokens };
  }

  restoreTokens(text, tokens) {
    let out = String(text);
    for (let i = 0; i < tokens.length; i++) {
      out = out.split(`@@K${i + 1}@@`).join(tokens[i]);
    }
    return out;
  }

  /** 质量闸门：不合格直接打回，绝不产出半截译文 */
  validate(src, trans, tokens) {
    if (!trans || typeof trans !== 'string') return 'empty';
    if (!/[A-Za-z\u4e00-\u9fff]/.test(trans)) return 'garbage';
    for (let i = 0; i < tokens.length; i++) {
      if (trans.includes(`@@K${i + 1}@@`)) continue;
      // 模型把术语直接写成了英文原文，等同保留成功，不必打回
      if (tokens[i] && trans.toLowerCase().includes(String(tokens[i]).toLowerCase())) continue;
      return 'token-lost';
    }
    const ratio = trans.length / Math.max(1, src.length);
    if (ratio > 4 || ratio < 0.15) return 'length';
    const cjk = (trans.match(/[\u4e00-\u9fff]/g) || []).length;
    const latin = (trans.match(/[A-Za-z]/g) || []).length;
    if (cjk === 0 && latin > 0) return 'not-translated';
    return null;
  }

  /* ---------------- LLM 通道 ---------------- */

  llmEndpoint() {
    let base = (this.settings.llmBaseUrl || '').trim().replace(/\/+$/, '');
    if (!base) return '';
    if (/\/chat\/completions$/.test(base)) return base;
    return base + '/chat/completions';
  }

  cacheKey(text, model) {
    return hashKey(`${model}|${DICT_SCHEMA}|${normKey(text)}`);
  }

  async llmTranslate(items, ctx) {
    // items: [{i, text}]
    const model = this.settings.llmModel || 'deepseek-chat';
    const keep = this.keepTerms();
    const prepared = items.map((it) => {
      const p = this.protect(it.text);
      return { i: it.i, masked: p.masked, tokens: p.tokens, src: it.text };
    });
    const payload = {
      context: (ctx && ctx.plugin) ? `插件：${ctx.plugin}` : '通用界面文案',
      glossary: keep,
      rules: [
        '术语表中的品牌/技术名词保持英文，不要翻译。',
        '保留所有 @@Kn@@ 占位符原样，不要增删或改写。',
        '按钮名 2-6 个汉字，设置项名称精炼，说明句可稍长但不要扩写。',
        '不要把 %s、{0}、{{var}}、${x} 这类变量翻译或改写。',
        '如果某条不是界面文案（代码片段、正则、日志、文件路径、CSS 值），译文返回空字符串 ""。',
        '不要在译文前后加引号、不要输出解释。',
      ],
      items: prepared.map((p) => ({ i: p.i, t: p.masked })),
    };
    const sys = '你是 Obsidian 插件界面的简体中文本地化译者。只输出 JSON 对象：{"<序号>":"译文"}，序号与输入一一对应。术语保持英文，占位符 @@Kn@@ 原样保留，非界面文案返回空字符串。';

    const body = {
      model,
      temperature: 0,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: JSON.stringify(payload) },
      ],
    };

    let res;
    try {
      res = await requestUrl({
        url: this.llmEndpoint(),
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.settings.llmApiKey}`,
        },
        body: JSON.stringify(Object.assign({ response_format: { type: 'json_object' } }, body)),
        throw: false,
      });
    } catch (e) {
      throw new Error('请求失败：' + (e && e.message ? e.message : e));
    }

    if (res.status >= 400) {
      // 有些兼容端点不认 response_format，去掉重试一次
      const retry = await requestUrl({
        url: this.llmEndpoint(),
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.settings.llmApiKey}`,
        },
        body: JSON.stringify(body),
        throw: false,
      });
      if (retry.status >= 400) {
        throw new Error(`接口 ${retry.status}：${(retry.text || '').slice(0, 200)}`);
      }
      res = retry;
    }

    let content = '';
    try {
      const j = res.json;
      content = j.choices[0].message.content;
    } catch (e) {
      throw new Error('返回格式异常');
    }
    const map = parseJsonLoose(content);
    if (!map) throw new Error('返回不是 JSON');

    const out = new Map();
    const rejects = [];
    for (const p of prepared) {
      const v = map[p.i] ?? map[String(p.i)];
      if (typeof v !== 'string') { rejects.push({ text: p.src, reason: 'missing' }); continue; }
      const bad = this.validate(p.src, v, p.tokens);
      if (bad) { rejects.push({ text: p.src, reason: bad }); continue; }
      const finalText = canonTerms(applyPunct(p.src, this.restoreTokens(v.trim(), p.tokens)));
      out.set(p.i, finalText);
      this.llmCache.set(this.cacheKey(p.src, model), finalText);
    }
    return { translations: out, rejects };
  }

  /** 打回原因汇总，方便一眼看出是"没翻"还是"术语丢了" */
  reasonSummary(rejects) {
    const names = { empty: '非界面', 'token-lost': '术语丢失', 'not-translated': '未翻译', length: '长度异常', missing: '缺项', garbage: '乱码' };
    const cnt = {};
    for (const r of rejects || []) cnt[r.reason] = (cnt[r.reason] || 0) + 1;
    return Object.entries(cnt)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${names[k] || k} ${v}`)
      .join('，');
  }

  /** 记住「不是界面文案」的条目，下次扫描不再送钱 */
  markNonUi(rejects) {
    if (!rejects || !rejects.length) return;
    const skip = this.state.skippedNonUi || (this.state.skippedNonUi = {});
    for (const r of rejects) {
      if (r.reason === 'empty') skip[this.cacheKey(r.text, this.settings.llmModel)] = 1;
    }
    this.saveStateSoon();
  }

  isNonUi(text) {
    const skip = this.state.skippedNonUi;
    if (!skip) return false;
    return !!skip[this.cacheKey(text, this.settings.llmModel)];
  }

  /** 分批跑并给进度提示 */
  async runBatches(list, onProgress, ctx) {
    const size = Math.max(5, Math.min(80, this.settings.llmBatchSize || 40));
    const batches = chunk(list, size);
    const done = new Map();
    const rejects = [];
    let idx = 0;
    for (const b of batches) {
      const items = b.map((t) => ({ i: idx++, text: t }));
      const res = await this.llmTranslate(items, ctx);
      for (const [i, v] of res.translations) done.set(b[i], v);
      rejects.push(...res.rejects);
      if (onProgress) onProgress(done.size, list.length);
      this.saveStateSoon();
      await sleep(120);
    }
    return { done, rejects };
  }

  async translatePending() {
    if (this.translating) return new Notice('UI 汉化：正在翻译中，请稍候');
    if (!this.settings.llmEnabled || !this.settings.llmApiKey) {
      return new Notice('UI 汉化：还没配 LLM。设置 → UI 汉化 → 填 Base URL / Key / 模型。');
    }
    const list = this.pendingList();
    if (!list.length) return new Notice('UI 汉化：没有待译条目');

    this.translating = true;
    const notice = new Notice('UI 汉化：开始翻译 0/' + list.length, 0);
    try {
      const { done, rejects } = await this.runBatches(
        list.map((x) => x.text),
        (d, total) => notice.setMessage(`UI 汉化：翻译中 ${d}/${total}`),
        { plugin: '' }
      );
      this.markNonUi(rejects);
      // 写入 dict/plugins/_auto.json
      const entries = {};
      for (const [src, dst] of done) entries[src] = dst;
      await this.mergePluginDict('_auto', entries);
      for (const item of list) {
        if (done.has(item.text)) delete this.state.pending[item.key];
      }
      await this.loadDict();
      this.restoreAll(false);
      this.scanRoot(document.body);
      this.saveStateSoon();
      this.updateStatusBar();
      notice.hide();
      new Notice(`UI 汉化：完成 ${done.size} 条${rejects.length ? `，打回 ${rejects.length} 条（${this.reasonSummary(rejects)}）` : ''}`, 8000);
      if (rejects.length) {
        this.lastRejects = rejects;
        this.log('打回条目', rejects);
      }
    } catch (e) {
      notice.hide();
      new Notice('UI 汉化：翻译失败 — ' + (e && e.message ? e.message : e), 8000);
    } finally {
      this.translating = false;
    }
  }

  async mergePluginDict(id, entries) {
    const file = normalizePath(`${this.dictDir()}/plugins/${id}.json`);
    let existing = {};
    try {
      const j = await this.readJson(file);
      existing = j.entries || j || {};
    } catch (e) { existing = {}; }
    const merged = Object.assign({}, existing, entries);
    const out = JSON.stringify({ schema: DICT_SCHEMA, id, generatedAt: new Date().toISOString(), entries: merged }, null, 2);
    try {
      await this.app.vault.adapter.write(file, out);
    } catch (e) {
      try {
        await this.app.vault.adapter.mkdir(normalizePath(`${this.dictDir()}/plugins`));
        await this.app.vault.adapter.write(file, out);
      } catch (e2) {
        new Notice('UI 汉化：写词典失败 ' + (e2 && e2.message ? e2.message : e2));
      }
    }
  }

  /* ---------------- 扫描：当前界面 ---------------- */

  allDocs() {
    const docs = [document];
    for (const d of this.windowsDocs()) if (!docs.includes(d)) docs.push(d);
    return docs;
  }

  async scanCurrentView(runTranslate) {
    const found = [];
    for (const doc of this.allDocs()) {
      if (!doc || !doc.body) continue;
      const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) =>
          n.parentElement && this.isSkipped(n.parentElement) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
      });
      let n;
      let guard = 0;
      while ((n = walker.nextNode())) {
        const core = (n.nodeValue || '').trim();
        if (!core || hasCjk(core)) continue;
        if (!isCandidate(core)) continue;
        if (this.lookup(core, this.ctxPluginId(n.parentElement))) continue;
        found.push(core);
        if (++guard > 3000) break;
      }
    }
    const uniq = [...new Set(found)];
    if (!uniq.length) return new Notice('UI 汉化：当前界面没有未译的英文文案');
    for (const t of uniq) this.notePending(t, null);
    new Notice(`UI 汉化：记录 ${uniq.length} 条待译（当前界面）。${this.settings.llmEnabled ? '开始翻译…' : '配置 Key 后可翻译。'}`, 6000);
    if (runTranslate && this.settings.llmEnabled) await this.translatePending();
  }

  /* ---------------- 扫描：指定插件（静态） ---------------- */

  pickPlugin() {
    const ids = [...this.pluginIds].filter((id) => id !== this.manifest.id).sort();
    new PluginPicker(this.app, ids, (id) => this.scanPluginById(id)).open();
  }

  async scanPluginById(id) {
    const notice = new Notice(`UI 汉化：读取 ${id}/main.js …`, 0);
    let unknown = [];
    try {
      const file = normalizePath(`${this.app.vault.configDir}/plugins/${id}/main.js`);
      let src = '';
      try {
        src = await this.app.vault.adapter.read(file);
      } catch (e) {
        notice.hide();
        return new Notice(`UI 汉化：读不到 ${id}/main.js`);
      }
      const candidates = extractCandidates(src, 6000);
      unknown = candidates
        .filter((s) => !this.lookup(s, id) && !this.llmCache.has(this.cacheKey(s, this.settings.llmModel)) && !this.isNonUi(s))
        .filter((s) => !isNoiseString(s))
        .sort((a, b) => uiScore(b) - uiScore(a));
      notice.hide();

      if (!unknown.length) {
        this.state.lastScan = Object.assign({}, this.state.lastScan, { [id]: { at: Date.now(), candidates: candidates.length, translated: 0, rejected: 0, skipped: '没有新的可翻文案' } });
        this.saveStateSoon();
        return new Notice(`UI 汉化：${id} 没有新的可翻文案`);
      }
      const cap = SCAN_CAP;
      if (unknown.length > cap) unknown = unknown.slice(0, cap);

      if (!this.settings.llmEnabled || !this.settings.llmApiKey) {
        for (const t of unknown) this.notePending(t, id);
        this.state.lastScan = Object.assign({}, this.state.lastScan, { [id]: { at: Date.now(), candidates: candidates.length, translated: 0, rejected: 0, pending: unknown.length } });
        this.saveStateSoon();
        return new Notice(`UI 汉化：${id} 记录 ${unknown.length} 条待译（未配 Key，暂不翻译）`, 8000);
      }

      this.translating = true;
      this.state.scanProgress = { id, phase: 'translate', done: 0, total: unknown.length, at: Date.now() };
      this.flushState();
      const n2 = new Notice(`UI 汉化：翻译 ${id} 0/${unknown.length}`, 0);
      try {
        const { done, rejects } = await this.runBatches(unknown, (d, total) => {
          n2.setMessage(`UI 汉化：翻译 ${id} ${d}/${total}`);
          this.state.scanProgress = { id, phase: 'translate', done: d, total, at: Date.now() };
          this.flushState();
        }, { plugin: id });
        this.markNonUi(rejects);
        const entries = {};
        for (const [s, d] of done) entries[s] = d;
        await this.mergePluginDict(id, entries);
        await this.loadDict();
        this.restoreAll(false);
        this.scanRoot(document.body);
        n2.hide();
        this.state.lastScan = Object.assign({}, this.state.lastScan, {
          [id]: {
            at: Date.now(),
            candidates: candidates.length,
            translated: done.size,
            rejected: rejects.length,
            rejectedSample: rejects.slice(0, 8),
          },
        });
        delete this.state.scanProgress;
        this.flushState();
        new Notice(`UI 汉化：${id} 完成 ${done.size} 条${rejects.length ? `，打回 ${rejects.length} 条（${this.reasonSummary(rejects)}）` : ''}`, 8000);
      } finally {
        this.translating = false;
      }
    } catch (e) {
      notice.hide();
      this.state.lastScan = Object.assign({}, this.state.lastScan, { [id]: { at: Date.now(), error: String((e && e.message) || e) } });
      delete this.state.scanProgress;
      this.flushState();
      new Notice('UI 汉化：扫描失败 — ' + (e && e.message ? e.message : e), 8000);
    }
  }

  /** Style Settings 的标题/说明来自主题 CSS 的 @settings 块，单独扫 */
  async scanThemeStyles() {
    const cfg = this.app.vault.configDir;
    const sources = [];
    try {
      const themes = await this.app.vault.adapter.list(normalizePath(`${cfg}/themes`));
      for (const folder of themes.folders || []) {
        const f = normalizePath(`${folder}/theme.css`);
        try { sources.push({ id: folder.split('/').pop(), css: await this.app.vault.adapter.read(f) }); } catch (e) { /* 无 theme.css */ }
      }
    } catch (e) { /* 没有 themes 目录 */ }
    try {
      const snippets = await this.app.vault.adapter.list(normalizePath(`${cfg}/snippets`));
      for (const f of snippets.files || []) {
        if (!f.endsWith('.css')) continue;
        try { sources.push({ id: f.split('/').pop().replace(/\.css$/, ''), css: await this.app.vault.adapter.read(f) }); } catch (e) { /* ignore */ }
      }
    } catch (e) { /* 没有 snippets 目录 */ }

    const found = new Set();
    for (const s of sources) for (const v of extractCssSettingStrings(s.css)) found.add(v);
    const unknown = [...found].filter((s) => !this.lookup(s, '_theme') && !this.lookup(s, 'obsidian-style-settings') && !this.llmCache.has(this.cacheKey(s, this.settings.llmModel)));

    new Notice(`UI 汉化：主题样式找到 ${found.size} 条文案，待翻 ${unknown.length} 条`, 6000);
    if (!unknown.length) return;
    if (!this.settings.llmEnabled || !this.settings.llmApiKey) {
      for (const t of unknown) this.notePending(t, 'obsidian-style-settings');
      return;
    }

    this.translating = true;
    const n = new Notice(`UI 汉化：翻译主题样式 0/${unknown.length}`, 0);
    try {
      const { done, rejects } = await this.runBatches(unknown, (d, total) => n.setMessage(`UI 汉化：翻译主题样式 ${d}/${total}`), { plugin: 'theme' });
      this.markNonUi(rejects);
      const entries = {};
      for (const [s, d] of done) entries[s] = d;
      await this.mergePluginDict('_theme', entries);
      await this.loadDict();
      this.restoreAll(false);
      this.scanRoot(document.body);
      n.hide();
      new Notice(`UI 汉化：主题样式写入 ${done.size} 条${rejects.length ? `，打回 ${rejects.length}` : ''}`, 6000);
    } finally {
      this.translating = false;
    }
  }

  async scanAllPlugins() {
    const ids = [...this.pluginIds].filter((id) => id !== this.manifest.id);
    this.state.batchRun = { at: Date.now(), ids, done: 0, total: ids.length };
    this.flushState();
    new Notice(`UI 汉化：开始扫描 ${ids.length} 个插件（串行，可随时关闭）`, 5000);
    for (const id of ids) {
      await this.scanPluginById(id);
      this.state.batchRun.done = (this.state.batchRun.done || 0) + 1;
      this.flushState();
      await sleep(400);
    }
    this.state.batchRun.finishedAt = Date.now();
    this.flushState();
    new Notice('UI 汉化：全部插件扫描结束', 5000);
  }
};

/* =====================================================================
 * 5. 测试钩子 + 设置页
 * ===================================================================*/

module.exports = UiZhPlugin;
module.exports.__pure = {
  normKey,
  isCandidate,
  isLikelyUi,
  applyPunct,
  hashKey,
  extractCandidates,
  parseJsonLoose,
  hasCjk,
  chunk,
};


class UiZhSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const p = this.plugin;
    containerEl.empty();
    containerEl.addClass('ui-zh-self');

    containerEl.createEl('h2', { text: 'UI 汉化' });
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: '只翻译界面显示层：不改插件文件、不动笔记内容，随时可一键还原。',
    });

    /* ---- 开关 ---- */
    new Setting(containerEl)
      .setName('启用界面汉化')
      .setDesc('关闭后立即还原所有已翻译文本。')
      .addToggle((t) =>
        t.setValue(p.settings.enabled).onChange(async (v) => {
          p.settings.enabled = v;
          await p.saveSettings();
          if (v) {
            p.startObserver();
            p.scanRoot(document.body);
          } else {
            p.stopObserver();
            p.restoreAll(false);
          }
          p.updateStatusBar();
        })
      );

    new Setting(containerEl)
      .setName('状态栏显示')
      .setDesc('右下角那个「汉化 ON · 待译 N」。不想看见就选「不显示」，功能不受影响。')
      .addDropdown((d) =>
        d
          .addOption('always', '一直显示')
          .addOption('pending', '只在有待译时显示')
          .addOption('never', '不显示')
          .setValue(p.settings.statusBarMode || 'always')
          .onChange(async (v) => {
            p.settings.statusBarMode = v;
            await p.saveSettings();
            p.updateStatusBar();
          })
      );

    new Setting(containerEl)
      .setName('翻译输入框占位提示')
      .setDesc('placeholder 文本，例如搜索框里的 “Search…”。')
      .addToggle((t) =>
        t.setValue(p.settings.translatePlaceholders).onChange(async (v) => {
          p.settings.translatePlaceholders = v;
          await p.saveSettings();
          p.restoreAll(false);
          p.scanRoot(document.body);
        })
      );

    new Setting(containerEl)
      .setName('翻译无障碍标签')
      .setDesc('aria-label，读屏与部分提示依赖它。')
      .addToggle((t) =>
        t.setValue(p.settings.translateAriaLabels).onChange(async (v) => {
          p.settings.translateAriaLabels = v;
          await p.saveSettings();
          p.restoreAll(false);
          p.scanRoot(document.body);
        })
      );

    new Setting(containerEl)
      .setName('翻译悬停提示')
      .setDesc('title 属性。部分插件把技术信息放在这里，默认关闭。')
      .addToggle((t) =>
        t.setValue(p.settings.translateTitles).onChange(async (v) => {
          p.settings.translateTitles = v;
          await p.saveSettings();
          p.restoreAll(false);
          p.scanRoot(document.body);
        })
      );

    /* ---- 扫描 ---- */
    containerEl.createEl('h3', { text: '扫描与翻译' });
    const pending = Object.keys(p.state.pending || {}).length;
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: `当前待译 ${pending} 条 · 通用词条 ${p.dict.base.size} 条 · 插件分片 ${p.dict.plugins.size} 个 · 术语屏蔽 ${p.keepFiltered || 0} 条`,
    });

    const lastScan = p.state.lastScan || {};
    const scanRows = Object.entries(lastScan).filter(([, v]) => v && v.at);
    if (scanRows.length) {
      const box = containerEl.createDiv({ cls: 'ui-zh-scanlog' });
      box.createEl('div', { text: '上次扫描结果', cls: 'setting-item-name' });
      for (const [id, v] of scanRows) {
        const when = new Date(v.at).toLocaleString();
        const line = v.error
          ? `${id}：失败 ${v.error}`
          : `${id}：候选 ${v.candidates || 0}，写入 ${v.translated || 0}${v.rejected ? `，打回 ${v.rejected}` : ''}${v.pending ? `，待译 ${v.pending}` : ''}`;
        box.createEl('div', { text: `${line}  ·  ${when}`, cls: 'setting-item-description' });
      }
    }

    new Setting(containerEl)
      .setName('扫描当前界面')
      .setDesc('只抓当前屏幕上未译的英文，1 秒内完成，最省 token。建议到「设置 → 快捷键」里给「扫描当前界面并翻译」绑一个键，这样看着任何插件设置页都能直接按。')
      .addButton((b) => b.setButtonText('扫描').onClick(() => p.scanCurrentView(true)));
    new Setting(containerEl)
      .setName('扫描指定插件')
      .setDesc('读该插件 main.js 提取界面文案（只读），覆盖它所有设置页与弹窗。')
      .addButton((b) => b.setButtonText('选择插件').onClick(() => p.pickPlugin()));
    new Setting(containerEl)
      .setName('扫描全部插件')
      .setDesc('串行跑一遍全部已装插件，首次使用时点一次即可。')
      .addButton((b) => b.setButtonText('全部扫描').onClick(async () => p.scanAllPlugins()));
    new Setting(containerEl)
      .setName('扫描主题样式')
      .setDesc('Style Settings 的标题/说明来自主题 CSS 的 @settings 块，插件 main.js 里没有，需要单独扫。')
      .addButton((b) => b.setButtonText('扫描主题').onClick(async () => p.scanThemeStyles()));
    new Setting(containerEl)
      .setName('翻译待办')
      .setDesc('把已记录的待译条目送 LLM，结果写入词典并立即生效。')
      .addButton((b) =>
        b.setButtonText('开始翻译').onClick(async () => {
          await p.translatePending();
        })
      );
    new Setting(containerEl)
      .setName('重新加载词典（应用术语表）')
      .setDesc('改完术语保护、或手改过 dict/*.json 之后点这个：重读词典 → 还原 → 重扫，不用重启 Obsidian。')
      .addButton((b) => b.setButtonText('重载').onClick(async () => p.reloadDictAndRescan()));
    new Setting(containerEl)
      .setName('还原原文')
      .setDesc('把界面恢复成英文，词典与缓存都保留。')
      .addButton((b) => b.setButtonText('还原').onClick(() => p.restoreAll(true)));
    new Setting(containerEl)
      .setName('清空待译队列')
      .setDesc(`当前 ${Object.keys(p.state.pending || {}).length} 条。清空只是不再统计，已翻好的词条不受影响。`)
      .addButton((b) =>
        b.setButtonText('清空').onClick(async () => {
          p.state.pending = {};
          p.saveStateSoon();
          p.updateStatusBar();
          new Notice('UI 汉化：待译队列已清空');
          this.display();
        })
      );
    new Setting(containerEl)
      .setName('导出待译清单')
      .setDesc('复制 JSON 到剪贴板，方便贴给模型或人工整理。')
      .addButton((b) => b.setButtonText('复制').onClick(() => p.exportPending()));

    /* ---- 术语 ---- */
    containerEl.createEl('h3', { text: '术语保护' });
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: '下面这些词永远不会被翻译（品牌、技术名词、插件名）。一行一个，或逗号分隔。',
    });
    const keepTa = containerEl.createEl('textarea', { cls: 'ui-zh-ta' });
    keepTa.placeholder = 'Obsidian\nMarkdown\nSync';
    keepTa.value = (p.settings.keepExtra || []).join('\n');
    keepTa.addEventListener('change', async () => {
      p.settings.keepExtra = keepTa.value
        .split(/[\n,，]/)
        .map((s) => s.trim())
        .filter(Boolean);
      await p.saveSettings();
    });
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: '内置术语：' + DEFAULT_KEEP.slice(0, 18).join('、') + ' …',
    });

    new Setting(containerEl)
      .setName('额外排除区域（CSS 选择器）')
      .setDesc('这些区域内的文本一律不动，例如 .my-plugin-canvas')
      .addText((t) =>
        t
          .setPlaceholder('.my-plugin-canvas')
          .setValue(p.settings.excludeSelectors || '')
          .onChange(async (v) => {
            p.settings.excludeSelectors = v;
            await p.saveSettings();
          })
      );

    /* ---- LLM ---- */
    containerEl.createEl('h3', { text: 'LLM 翻译通道（可选）' });
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: '不填也能用：纯词典模式离线运行。填了才能翻译词典里没有的新文案。',
    });

    new Setting(containerEl)
      .setName('启用 LLM 翻译')
      .addToggle((t) =>
        t.setValue(p.settings.llmEnabled).onChange(async (v) => {
          p.settings.llmEnabled = v;
          await p.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('接口地址')
      .setDesc('OpenAI 兼容。/chat/completions 会自动补。')
      .addText((t) =>
        t
          .setPlaceholder('https://api.deepseek.com')
          .setValue(p.settings.llmBaseUrl)
          .onChange(async (v) => {
            p.settings.llmBaseUrl = v.trim();
            await p.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('API Key')
      .addText((t) => {
        t.inputEl.type = 'password';
        t.setPlaceholder('sk-...')
          .setValue(p.settings.llmApiKey)
          .onChange(async (v) => {
            p.settings.llmApiKey = v.trim();
            await p.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('模型')
      .addText((t) =>
        t
          .setPlaceholder('deepseek-chat')
          .setValue(p.settings.llmModel)
          .onChange(async (v) => {
            p.settings.llmModel = v.trim() || 'deepseek-chat';
            await p.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('每次批条数')
      .setDesc('40 条一请求，费用与失败率比较平衡。')
      .addSlider((s) =>
        s
          .setLimits(5, 80, 5)
          .setValue(p.settings.llmBatchSize)
          .setDynamicTooltip()
          .onChange(async (v) => {
            p.settings.llmBatchSize = v;
            await p.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('测试连接')
      .setDesc('发一条极短的翻译请求，确认地址/Key/模型都对。')
      .addButton((b) =>
        b.setButtonText('测试').onClick(async () => {
          b.setDisabled(true);
          try {
            const r = await p.llmTranslate([{ i: 1, text: 'Settings' }]);
            const t = r.translations.get(1);
            new Notice(t ? `UI 汉化：连接正常，示例译文「${t}」` : 'UI 汉化：连上了，但译文为空');
          } catch (e) {
            new Notice('UI 汉化：连接失败 — ' + (e && e.message ? e.message : e), 8000);
          } finally {
            b.setDisabled(false);
          }
        })
      );

    new Setting(containerEl)
      .setName('清空翻译缓存')
      .setDesc(`当前缓存 ${p.llmCache.size} 条。清空后旧译文会重新请求。`)
      .addButton((b) =>
        b.setButtonText('清空').onClick(async () => {
          p.llmCache.clear();
          p.state.cache = {};
          p.flushState();
          new Notice('UI 汉化：缓存已清空');
        })
      );

    new Setting(containerEl)
      .setName('调试日志')
      .addToggle((t) =>
        t.setValue(!!p.settings.debug).onChange(async (v) => {
          p.settings.debug = v;
          await p.saveSettings();
        })
      );
  }
}

/* =====================================================================
 * 6. 插件选择器
 * ===================================================================*/

class PluginPicker extends SuggestModal {
  constructor(app, ids, onPick) {
    super(app);
    this.ids = ids;
    this.onPick = onPick;
    this.setPlaceholder('选择要扫描的插件…');
  }

  getSuggestions(query) {
    const q = (query || '').toLowerCase();
    return this.ids.filter((id) => !q || id.toLowerCase().includes(q)).slice(0, 50);
  }

  renderSuggestion(id, el) {
    const man = (this.app.plugins && this.app.plugins.manifests && this.app.plugins.manifests[id]) || {};
    el.createEl('div', { text: man.name || id });
    el.createEl('small', { text: id, cls: 'setting-item-description' });
  }

  onChooseSuggestion(id) {
    this.onPick(id);
  }
}
