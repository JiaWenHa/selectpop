'use strict';

(() => {
  const api = window.selectpop;
  if (!api) return;

  const $ = (id) => document.getElementById(id);
  const els = {
    nav: $('nav'),
    panel: $('panel'),
    title: $('section-title'),
    desc: $('section-desc'),
    save: $('save-state'),
    toast: $('toast'),
    openData: $('open-data'),
    openLog: $('open-log'),
  };

  const state = {
    settings: null,
    app: null,
    permission: null,
    options: null,
    hasApiKey: false,
    keyHint: '',
    section: 'general',
    saveTimer: null,
    toastTimer: null,
  };

  let pendingPatch = {};
  let modelSelect = null;
  let updateState = { state: 'idle', data: null, currentVersion: '' };

  const isMac = api.platform === 'darwin';

  /* ------------------------------ 小工具 ------------------------------ */

  const getPath = (object, path) =>
    path.split('.').reduce((acc, key) => (acc && typeof acc === 'object' ? acc[key] : undefined), object);

  function setPath(object, path, value) {
    const keys = path.split('.');
    let cursor = object;
    for (let i = 0; i < keys.length - 1; i += 1) {
      if (!cursor[keys[i]] || typeof cursor[keys[i]] !== 'object') cursor[keys[i]] = {};
      cursor = cursor[keys[i]];
    }
    cursor[keys[keys.length - 1]] = value;
    return object;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function svgIcon(name) {
    const paths = {
      general: '<circle cx="12" cy="12" r="3.2"/><path d="M12 3.5v2.2M12 18.3v2.2M4.9 4.9l1.6 1.6M17.5 17.5l1.6 1.6M3.5 12h2.2M18.3 12h2.2M4.9 19.1l1.6-1.6M17.5 6.5l1.6-1.6"/>',
      trigger: '<path d="M5 3.5l13 7.1-5.6 1.4-1.4 5.6z"/>',
      popup: '<rect x="3.2" y="4.2" width="17.6" height="12.6" rx="2.4"/><path d="M7 8.4h6M7 12h4"/>',
      ai: '<path d="M12 3.2l1.9 5 5 1.9-5 1.9-1.9 5-1.9-5-5-1.9 5-1.9z"/><circle cx="18.6" cy="18.4" r="1.6"/>',
      translate: '<path d="M3.6 6.4h8.6M7.9 4.2v2.2c0 3.7-2 6.2-4.3 7.6M5.2 10.6c1.1 2.2 3 3.6 5 4.2"/><path d="M13.6 19.4l3.4-8 3.4 8M14.9 16.8h4.2"/>',
      search: '<circle cx="10.8" cy="10.8" r="6.2"/><path d="M15.4 15.4l4.4 4.4"/>',
      advanced: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2.1"/><circle cx="9" cy="17" r="2.1"/>',
      about: '<circle cx="12" cy="12" r="8.4"/><path d="M12 11v5.4M12 7.8v.4"/>',
    };
    return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.general}</svg>`;
  }

  function showToast(message, kind = 'success') {
    els.toast.textContent = message;
    els.toast.dataset.kind = kind === 'error' ? 'error' : 'success';
    els.toast.hidden = false;
    els.toast.dataset.show = '1';
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => {
      els.toast.dataset.show = '0';
      setTimeout(() => {
        els.toast.hidden = true;
      }, 200);
    }, 1800);
  }

  function setSaveState(text, kind = 'ok') {
    els.save.textContent = text;
    els.save.dataset.kind = kind;
    els.save.dataset.show = '1';
    clearTimeout(setSaveState.timer);
    setSaveState.timer = setTimeout(() => {
      els.save.dataset.show = '0';
    }, 1600);
  }

  /* ------------------------------ 保存 ------------------------------ */

  function commit(path, value, { immediate = false } = {}) {
    setPath(state.settings, path, value);
    setPath(pendingPatch, path, value);
    if (immediate) {
      flush();
      return;
    }
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(flush, 180);
  }

  async function flush() {
    clearTimeout(state.saveTimer);
    state.saveTimer = null;
    const patch = pendingPatch;
    pendingPatch = {};
    if (!Object.keys(patch).length) return;
    const result = await api.set(patch);
    if (!result || result.ok === false) {
      setSaveState(result && result.message ? result.message : '保存失败', 'error');
      return;
    }
    if (result.settings) state.settings = result.settings;
    if (typeof result.hasApiKey === 'boolean') state.hasApiKey = result.hasApiKey;
    if (typeof result.keyHint === 'string') state.keyHint = result.keyHint;
    setSaveState('已保存');
    updateKeyPill();
  }

  /* ------------------------------ 配置结构 ------------------------------ */

  function buildSections() {
    const options = state.options || {};
    const languageOptions = (options.languages || []).map((lang) => ({ v: lang.code, t: lang.name }));
    const themeOptions = (options.themes || ['system', 'light', 'dark']).map((id) => ({
      v: id,
      t: { system: '跟随系统', light: '浅色', dark: '深色' }[id] || id,
    }));
    const modeOptions = (options.translateModes || ['auto', 'ai', 'web']).map((id) => ({
      v: id,
      t: { auto: '自动（有 Key 用 AI，否则打开网页）', ai: '总是用 DeepSeek', web: '总是打开网页' }[id] || id,
    }));
    const siteOptions = (options.translateSites || []).map((site) => ({ v: site.id, t: site.name }));
    const engineOptions = (options.searchEngines || []).map((engine) => ({ v: engine.id, t: engine.name }));
    const modelOptions = (options.models || []).map((model) => ({ v: model.id, t: model.name }));
    const logOptions = (options.logLevels || []).map((level) => ({ v: level, t: level }));

    return [
      {
        id: 'general',
        title: '常规',
        desc: '启动行为、外观与界面语言',
        icon: 'general',
        fields: [
          {
            path: 'app.enabled',
            type: 'switch',
            label: '启用 SelectPop',
            desc: '关闭后不响应划词和快捷键（托盘菜单里可以随时恢复）',
          },
          {
            path: 'app.launchAtLogin',
            type: 'switch',
            label: '开机自动启动',
            desc: '登录系统后在后台常驻，不弹主窗口',
          },
          { path: 'app.theme', type: 'select', label: '外观', options: themeOptions },
          {
            path: 'app.uiLang',
            type: 'select',
            label: '界面语言',
            desc: '影响弹窗按钮与 AI 回复的语言',
            options: [
              { v: 'zh-CN', t: '简体中文' },
              { v: 'en-US', t: 'English' },
            ],
          },
          { type: 'permission' },
        ],
      },
      {
        id: 'trigger',
        title: '划词',
        desc: '怎样触发弹窗',
        icon: 'trigger',
        fields: [
          {
            path: 'trigger.mouseSelection',
            type: 'switch',
            label: '鼠标划词',
            desc: '按住左键拖动选中文字后自动弹出',
          },
          {
            path: 'trigger.doubleClick',
            type: 'switch',
            label: '双击选词',
            desc: '双击单词或句子时也弹出',
          },
          {
            path: 'trigger.minDragPx',
            type: 'range',
            label: '最小拖动距离',
            desc: '拖动超过这个距离才认为是在划词，防止误触',
            min: 2,
            max: 40,
            step: 1,
            unit: 'px',
          },
          {
            path: 'trigger.hotkey',
            type: 'hotkey',
            label: '全局快捷键',
            desc: '选中文字后按快捷键弹出，弹窗里按数字键快速选择动作；留空表示不启用',
          },
          {
            path: 'trigger.copyDelayMs',
            type: 'range',
            label: '复制延迟',
            desc: '松开鼠标后等多久再发送复制（某些应用需要更长延迟）',
            min: 0,
            max: 400,
            step: 10,
            unit: 'ms',
          },
          {
            path: 'trigger.clipboardTimeoutMs',
            type: 'range',
            label: '取词超时',
            desc: '多久之内没读到新选区就放弃',
            min: 100,
            max: 1200,
            step: 50,
            unit: 'ms',
          },
          {
            path: 'clipboard.restore',
            type: 'switch',
            label: '还原剪贴板',
            desc: '取完选区后把剪贴板恢复成原来的内容',
          },
        ],
      },
      {
        id: 'popup',
        title: '弹窗',
        desc: '尺寸、字号与显示的动作',
        icon: 'popup',
        fields: [
          {
            path: 'popup.actions',
            type: 'actions',
            label: '显示的动作',
            desc: '弹窗里按顺序显示这些按钮，数字键 1-9 可快速触发',
            wide: true,
          },
          { path: 'popup.width', type: 'range', label: '宽度', min: 320, max: 560, step: 8, unit: 'px' },
          {
            path: 'popup.fontScale',
            type: 'range',
            label: '字号',
            min: 0.85,
            max: 1.4,
            step: 0.05,
            format: (value) => `${Math.round(value * 100)}%`,
          },
          {
            path: 'popup.maxPreviewChars',
            type: 'range',
            label: '预览长度',
            desc: '弹窗顶部最多显示多少个字',
            min: 40,
            max: 300,
            step: 10,
            unit: '字',
          },
          {
            path: 'popup.autoHideMs',
            type: 'range',
            label: '自动关闭',
            desc: '无操作后自动关闭弹窗，0 表示不自动关闭',
            min: 0,
            max: 10000,
            step: 500,
            format: (value) => (value === 0 ? '不自动关闭' : `${(value / 1000).toFixed(1)} 秒`),
          },
        ],
      },
      {
        id: 'ai',
        title: 'DeepSeek',
        desc: 'API Key、模型与生成参数',
        icon: 'ai',
        badge: state.hasApiKey ? '' : '未配置',
        fields: [
          { type: 'apikey' },
          {
            path: 'ai.baseUrl',
            type: 'text',
            label: 'API 地址',
            desc: '默认 https://api.deepseek.com，兼容 OpenAI 格式的代理也可填',
            placeholder: 'https://api.deepseek.com',
          },
          {
            path: 'ai.model',
            type: 'select',
            label: '模型',
            desc: '点「测试连接」后，可用模型会自动出现在下拉列表里',
            options: modelOptions,
          },
          {
            path: 'ai.temperature',
            type: 'range',
            label: '温度',
            desc: '越高越发散。翻译 1.3、解释 0.7、总结 0.5、润色 0.8 由动作自动决定，这里只作为兜底',
            min: 0,
            max: 2,
            step: 0.1,
            format: (value) => value.toFixed(1),
          },
          { path: 'ai.maxTokens', type: 'number', label: '最大输出 tokens', min: 64, max: 8192, step: 64 },
          {
            path: 'ai.maxInputChars',
            type: 'number',
            label: '原文最大字数',
            desc: '超过会截断，避免超出上下文',
            min: 200,
            max: 20000,
            step: 200,
            unit: '字',
          },
          {
            path: 'ai.timeoutMs',
            type: 'number',
            label: '超时时间',
            min: 5000,
            max: 180000,
            step: 5000,
            unit: 'ms',
            desc: '流式输出时，连续这么久没有新内容才算超时',
          },
          {
            path: 'ai.extraSystemPrompt',
            type: 'textarea',
            label: '附加系统提示词',
            desc: '会追加到所有 AI 动作里，比如「用简体中文回答，语气简洁」',
            placeholder: '例如：回答尽量短，只给结论和必要说明',
            wide: true,
          },
        ],
      },
      {
        id: 'translate',
        title: '翻译',
        desc: '翻译方式与目标语言',
        icon: 'translate',
        fields: [
          { path: 'translate.mode', type: 'select', label: '翻译方式', options: modeOptions, desc: '没有 API Key 时会自动退回网页翻译' },
          { path: 'translate.targetLang', type: 'select', label: '目标语言', options: languageOptions },
          { path: 'translate.webSite', type: 'select', label: '网页翻译站点', options: siteOptions, desc: '选择「总是打开网页」或未配置 Key 时使用' },
          {
            path: 'translate.aiPrompt',
            type: 'textarea',
            label: 'AI 翻译提示词',
            desc: '自定义 AI 翻译指令，会替换默认的「翻译成目标语言」。{lang} 会被替换成目标语言，<selected_text> 是选中的原文；留空则用默认',
            placeholder: '例如：把 <selected_text> 翻译成{lang}，保持学术论文风格，术语保留英文',
            wide: true,
          },
        ],
      },
      {
        id: 'search',
        title: '搜索',
        desc: '搜索引擎与自定义地址',
        icon: 'search',
        fields: [
          { path: 'search.engine', type: 'select', label: '搜索引擎', options: engineOptions },
          {
            path: 'search.customUrl',
            type: 'text',
            label: '自定义搜索地址',
            desc: '用 {query} 表示关键词，例如 https://www.google.com/search?q={query}',
            placeholder: 'https://example.com/search?q={query}',
            wide: true,
          },
        ],
      },
      {
        id: 'advanced',
        title: '高级',
        desc: '日志与本地数据',
        icon: 'advanced',
        fields: [
          { path: 'advanced.logLevel', type: 'select', label: '日志级别', options: logOptions, desc: '排查问题时可以临时调到 debug' },
          { type: 'storage' },
        ],
      },
      {
        id: 'about',
        title: '关于',
        desc: '版本信息',
        icon: 'about',
        fields: [{ type: 'about' }],
      },
    ];
  }

  /* ------------------------------ 控件 ------------------------------ */

  function rowShell(field, control, wide) {
    const row = el('div', 'row');
    if (wide) row.dataset.wide = '1';
    const text = el('div', 'row-text');
    text.appendChild(el('div', 'row-label', field.label));
    if (field.desc) text.appendChild(el('p', 'row-desc', field.desc));
    const wrap = el('div', 'row-control');
    if (control) wrap.appendChild(control);
    row.append(text, wrap);
    return row;
  }

  function controlSwitch(field) {
    const label = el('label', 'switch');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = Boolean(getPath(state.settings, field.path));
    const track = el('span', 'track');
    label.append(input, track);
    input.addEventListener('change', () => commit(field.path, input.checked, { immediate: true }));
    return label;
  }

  function controlSelect(field) {
    const select = document.createElement('select');
    const current = getPath(state.settings, field.path);
    const values = new Set();
    for (const option of field.options || []) {
      const node = document.createElement('option');
      node.value = option.v;
      node.textContent = option.t;
      select.appendChild(node);
      values.add(option.v);
    }
    const currentStr = current === undefined || current === null ? '' : String(current);
    // 当前值不在选项里时补一个选项，避免下拉框显示空白（也覆盖用户手动填过的自定义模型名）
    if (currentStr && !values.has(currentStr)) {
      const node = document.createElement('option');
      node.value = currentStr;
      node.textContent = currentStr;
      select.appendChild(node);
    }
    if (currentStr) select.value = currentStr;
    if (field.path === 'ai.model') modelSelect = select;
    select.addEventListener('change', () => commit(field.path, select.value, { immediate: true }));
    return select;
  }

  function controlRange(field) {
    const wrap = el('div', 'row-control');
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(field.min);
    input.max = String(field.max);
    input.step = String(field.step || 1);
    const current = Number(getPath(state.settings, field.path));
    input.value = String(current);
    const display = el('span', 'range-value', formatRange(field, current));
    input.addEventListener('input', () => {
      const value = Number(input.value);
      display.textContent = formatRange(field, value);
      commit(field.path, value);
    });
    input.addEventListener('change', () => {
      commit(field.path, Number(input.value), { immediate: true });
    });
    wrap.append(input, display);
    return wrap;
  }

  function formatRange(field, value) {
    if (field.format) return field.format(value);
    const digits = field.step && field.step < 1 ? 2 : 0;
    return `${Number(value).toFixed(digits)}${field.unit ? ` ${field.unit}` : ''}`;
  }

  function controlNumber(field) {
    const wrap = el('div', 'row-control');
    const input = document.createElement('input');
    input.type = 'number';
    input.min = String(field.min);
    input.max = String(field.max);
    input.step = String(field.step || 1);
    input.value = String(getPath(state.settings, field.path));
    input.addEventListener('change', () => {
      let value = Number(input.value);
      if (!Number.isFinite(value)) value = field.min;
      value = Math.min(Math.max(value, field.min), field.max);
      input.value = String(value);
      commit(field.path, value, { immediate: true });
    });
    wrap.appendChild(input);
    if (field.unit) wrap.appendChild(el('span', 'unit', field.unit));
    return wrap;
  }

  function controlText(field) {
    const wrap = el('div', 'row-control');
    const input = document.createElement('input');
    input.type = 'text';
    input.value = fetchCurrentText(field) ?? '';
    if (field.placeholder) input.placeholder = field.placeholder;
    if (field.wide) input.classList.add('wide');
    input.addEventListener('change', () => commit(field.path, input.value.trim(), { immediate: true }));
    wrap.appendChild(input);
    return wrap;
  }

  function fetchCurrentText(field) {
    const value = getPath(state.settings, field.path);
    return value === undefined ? '' : String(value);
  }

  /** 把「测试连接」返回的可用模型合并进模型下拉框（去重，保持当前选中值）。 */
  function refreshModelOptions(models) {
    if (!modelSelect || !Array.isArray(models) || !models.length) return;
    const current = modelSelect.value;
    const existing = new Set(Array.from(modelSelect.options).map((o) => o.value));
    for (const model of models) {
      const id = String(model).trim();
      if (!id || existing.has(id)) continue;
      const node = document.createElement('option');
      node.value = id;
      node.textContent = id;
      modelSelect.appendChild(node);
      existing.add(id);
    }
    if (current) modelSelect.value = current;
  }

  function controlTextarea(field) {
    const wrap = el('div', 'row-control');
    const area = document.createElement('textarea');
    area.value = fetchCurrentText(field);
    if (field.placeholder) area.placeholder = field.placeholder;
    area.addEventListener('change', () => commit(field.path, area.value.trim(), { immediate: true }));
    wrap.appendChild(area);
    return wrap;
  }

  function controlActions(field) {
    const grid = el('div', 'action-grid');
    const selected = new Set(getPath(state.settings, field.path) || []);
    const actions = (state.options && state.options.actions) || [];
    for (const action of actions) {
      const label = el('label', 'action-pick');
      label.dataset.on = selected.has(action.id) ? '1' : '0';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = selected.has(action.id);
      label.append(input, el('span', null, action.label));
      const kindLabel = { ai: 'AI', external: '浏览器', local: '本地', translate: '翻译' }[action.kind];
      if (kindLabel) label.append(el('span', 'kind', kindLabel));
      input.addEventListener('change', () => {
        const next = new Set(getPath(state.settings, field.path) || []);
        if (input.checked) next.add(action.id);
        else next.delete(action.id);
        if (!next.size) {
          input.checked = true;
          showToast('至少保留一个动作', 'error');
          return;
        }
        label.dataset.on = input.checked ? '1' : '0';
        const ordered = actions.map((a) => a.id).filter((id) => next.has(id));
        commit(field.path, ordered, { immediate: true });
      });
      grid.appendChild(label);
    }
    return grid;
  }

  const MODIFIER_SYMBOL = { CommandOrControl: '⌘', Command: '⌘', Super: '⌘', Control: 'Ctrl', Alt: 'Alt', Option: '⌥', Shift: '⇧' };

  function prettyHotkey(accelerator) {
    if (!accelerator) return '';
    if (!isMac) return accelerator.replace(/CommandOrControl/g, 'Ctrl').replace(/\+/g, ' + ');
    return accelerator
      .split('+')
      .map((part) => MODIFIER_SYMBOL[part] || part)
      .join('');
  }

  function keyFromEvent(event) {
    const code = event.code || '';
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit[0-9]$/.test(code)) return code.slice(5);
    if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
    const map = {
      Space: 'Space',
      Enter: 'Enter',
      NumpadEnter: 'Enter',
      Tab: 'Tab',
      Backspace: 'Backspace',
      Delete: 'Delete',
      Insert: 'Insert',
      Home: 'Home',
      End: 'End',
      PageUp: 'PageUp',
      PageDown: 'PageDown',
      ArrowUp: 'Up',
      ArrowDown: 'Down',
      ArrowLeft: 'Left',
      ArrowRight: 'Right',
      Minus: 'Minus',
      Equal: 'Plus',
      BracketLeft: '[',
      BracketRight: ']',
      Semicolon: ';',
      Quote: "'",
      Comma: ',',
      Period: '.',
      Slash: '/',
      Backslash: '\\',
      Backquote: '`',
    };
    if (map[code]) return map[code];
    if (event.key && event.key.length === 1) return event.key.toUpperCase();
    return '';
  }

  function controlHotkey(field) {
    const wrap = el('div', 'row-control');
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'hotkey-input';
    input.readOnly = true;
    input.value = prettyHotkey(getPath(state.settings, field.path));
    input.title = '点击后按下组合键，Backspace 清除';

    input.addEventListener('focus', () => {
      input.dataset.recording = '1';
      input.value = '按下组合键…';
    });

    input.addEventListener('blur', () => {
      input.dataset.recording = '0';
      input.value = prettyHotkey(getPath(state.settings, field.path));
    });

    input.addEventListener('keydown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        input.blur();
        return;
      }
      if (event.key === 'Backspace' || event.key === 'Delete') {
        commit(field.path, '', { immediate: true });
        input.blur();
        showToast('已关闭全局快捷键');
        return;
      }
      const parts = [];
      if (event.ctrlKey) parts.push('Control');
      if (event.metaKey) parts.push(isMac ? 'Command' : 'Super');
      if (event.altKey) parts.push('Alt');
      if (event.shiftKey) parts.push('Shift');
      const key = keyFromEvent(event);
      if (!key) return;
      if (!parts.length) {
        showToast('快捷键至少要包含一个修饰键', 'error');
        return;
      }
      if (parts.length === 1 && parts[0] === 'Shift' && /^[A-Z]$/.test(key)) {
        // Shift + 字母单独作为快捷键容易误触，要求再加一个修饰键
        showToast('请再加一个修饰键（Ctrl / Alt / ⌘）', 'error');
        return;
      }
      const accelerator = [...parts, key].join('+');
      api.validateHotkey(accelerator).then((result) => {
        if (!result || result.ok === false) {
          showToast((result && result.message) || '快捷键格式不正确', 'error');
          return;
        }
        commit(field.path, accelerator, { immediate: true });
        showToast(`已设置为 ${prettyHotkey(accelerator)}`);
        input.blur();
      });
    });

    wrap.appendChild(input);
    return wrap;
  }

  function controlPermission() {
    const wrap = el('div', 'row-control');
    const pill = el('span', 'pill', '—');
    const button = el('button', 'btn small', '去授权');
    button.type = 'button';
    wrap.append(pill, button);

    const refresh = async () => {
      const result = await api.checkPermission();
      const granted = Boolean(result && result.granted);
      pill.dataset.state = granted ? 'ok' : 'bad';
      pill.textContent = granted ? '已授权' : '未授权';
      button.hidden = granted || !isMac;
    };

    button.addEventListener('click', async () => {
      await api.promptPermission();
      showToast('请在系统设置里勾选 SelectPop，然后重启应用');
      setTimeout(refresh, 800);
    });

    refresh();
    return wrap;
  }

  function keyPill() {
    const pill = el('span', 'pill', '未配置');
    if (state.hasApiKey) {
      pill.dataset.state = 'ok';
      pill.textContent = state.keyHint ? `已配置 ${state.keyHint}` : '已配置';
    } else {
      pill.dataset.state = 'bad';
      pill.textContent = '未配置';
    }
    return pill;
  }

  function updateKeyPill() {
    const pill = document.querySelector('[data-role="key-pill"]');
    if (!pill) return;
    if (state.hasApiKey) {
      pill.dataset.state = 'ok';
      pill.textContent = state.keyHint ? `已配置 ${state.keyHint}` : '已配置';
    } else {
      pill.dataset.state = 'bad';
      pill.textContent = '未配置';
    }
  }

  function blockApiKey() {
    const block = el('div', 'key-block');
    const head = el('div', 'row');
    head.style.padding = '0';
    head.style.borderBottom = '0';
    const text = el('div', 'row-text');
    text.appendChild(el('div', 'row-label', 'DeepSeek API Key'));
    text.appendChild(
      el('p', 'row-desc', '只保存在本机（系统密钥库加密）。获取地址：platform.deepseek.com → API keys'),
    );
    const pill = keyPill();
    pill.dataset.role = 'key-pill';
    const ctl = el('div', 'row-control');
    ctl.appendChild(pill);
    head.append(text, ctl);

    const row = el('div', 'key-row');
    const input = document.createElement('input');
    input.type = 'password';
    input.placeholder = state.hasApiKey ? '输入新的 Key 可覆盖现有配置' : 'sk-...';
    input.autocomplete = 'off';
    input.spellcheck = false;

    const toggle = el('button', 'btn small', '显示');
    toggle.type = 'button';
    const test = el('button', 'btn small', '测试连接');
    test.type = 'button';
    const save = el('button', 'btn primary small', '保存');
    save.type = 'button';
    const clear = el('button', 'btn small', '清除');
    clear.type = 'button';
    clear.hidden = !state.hasApiKey;

    const resultLine = el('p', 'key-result');
    resultLine.hidden = true;

    const setResult = (message, kind) => {
      resultLine.hidden = !message;
      resultLine.textContent = message || '';
      resultLine.dataset.kind = kind || '';
    };

    toggle.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      toggle.textContent = show ? '隐藏' : '显示';
    });

    test.addEventListener('click', async () => {
      const key = input.value.trim();
      setResult('正在连接 DeepSeek…', '');
      test.disabled = true;
      try {
        const result = await api.testKey(key);
        if (result && result.ok) {
          refreshModelOptions(result.models);
          const models = Array.isArray(result.models) && result.models.length ? `（可用模型：${result.models.slice(0, 4).join(', ')}）` : '';
          let message = `连接成功 ${models}`;
          const currentModel = String(getPath(state.settings, 'ai.model') || '').trim();
          if (Array.isArray(result.models) && result.models.length && currentModel && !result.models.includes(currentModel)) {
            message += ' — 注意：当前模型不在可用列表里，请在下方「模型」栏修改';
          }
          setResult(message, 'ok');
        } else {
          setResult((result && result.message) || '连接失败', 'bad');
        }
      } finally {
        test.disabled = false;
      }
    });

    save.addEventListener('click', async () => {
      const key = input.value.trim();
      if (!key) {
        showToast('请先填入 API Key', 'error');
        return;
      }
      const result = await api.setKey(key);
      if (!result || result.ok === false) {
        showToast('保存失败', 'error');
        return;
      }
      state.hasApiKey = Boolean(result.hasApiKey);
      state.keyHint = result.keyHint || '';
      input.value = '';
      clear.hidden = !state.hasApiKey;
      updateKeyPill();
      setResult('已保存到本机', 'ok');
      showToast('API Key 已保存');
    });

    clear.addEventListener('click', async () => {
      const result = await api.setKey('');
      if (!result || result.ok === false) {
        showToast('清除失败', 'error');
        return;
      }
      state.hasApiKey = false;
      state.keyHint = '';
      clear.hidden = true;
      updateKeyPill();
      setResult('已清除 API Key，AI 动作会提示去配置', 'bad');
      showToast('已清除');
    });

    row.append(input, toggle, test, save, clear);
    block.append(head, row, resultLine);
    return block;
  }

  function blockStorage() {
    const block = el('div', 'key-block');
    const row = el('div', 'key-row');
    const openData = el('button', 'btn small', '打开配置目录');
    openData.type = 'button';
    openData.addEventListener('click', () => api.openDataDir());
    const openLog = el('button', 'btn small', '查看日志');
    openLog.type = 'button';
    openLog.addEventListener('click', () => api.openLog());
    const quit = el('button', 'btn small', '退出 SelectPop');
    quit.type = 'button';
    quit.addEventListener('click', () => api.quit());
    row.append(openData, openLog, quit);
    const tip = el('p', 'key-result', '配置保存在 userData 目录下的 settings.json，API Key 经过系统密钥库加密；日志在同目录的 logs 文件夹。');
    block.append(row, tip);
    return block;
  }

  function blockAbout() {
    const wrap = el('div', 'about');
    const logo = el('div', 'logo-lg');
    logo.innerHTML = '<svg viewBox="0 0 24 24"><path d="M5 4h14M5 9h9M5 14h14M5 19h6"/></svg>';
    wrap.appendChild(logo);
    wrap.appendChild(el('h3', null, 'SelectPop'));
    const version = (state.app && state.app.version) || '';
    wrap.appendChild(el('p', 'version', version ? `版本 ${version}` : '版本未知'));

    // 自动更新区块
    const updateText = () => {
      switch (updateState.state) {
        case 'checking':
          return '正在检查更新…';
        case 'available':
          return `发现新版本 ${updateState.data?.version || ''}，可下载。`;
        case 'not-available':
          return '已是最新版本。';
        case 'downloading':
          return `正在下载更新… ${Math.round(updateState.data?.percent || 0)}%`;
        case 'downloaded':
          return `新版本 ${updateState.data?.version || ''} 已下载，重启后安装。`;
        case 'error':
          return updateState.data?.message || '检查更新失败。';
        default:
          return updateState.currentVersion ? `当前版本 ${updateState.currentVersion}` : '';
      }
    };

    const updateBlock = el('div', 'update-block');
    updateBlock.appendChild(el('h4', null, '检查更新'));
    const updateStatus = el('p', 'update-status', updateText());
    const updateRow = el('div', 'update-actions');

    const checkBtn = el('button', 'btn small', '检查更新');
    checkBtn.type = 'button';
    checkBtn.addEventListener('click', async () => {
      checkBtn.disabled = true;
      updateStatus.textContent = '正在检查更新…';
      await api.checkUpdate();
      checkBtn.disabled = false;
    });

    const downloadBtn = el('button', 'btn small', '下载更新');
    downloadBtn.type = 'button';
    downloadBtn.hidden = updateState.state !== 'available';
    downloadBtn.addEventListener('click', async () => {
      downloadBtn.disabled = true;
      await api.downloadUpdate();
      downloadBtn.disabled = false;
    });

    const installBtn = el('button', 'btn small', '重启安装');
    installBtn.type = 'button';
    installBtn.hidden = updateState.state !== 'downloaded';
    installBtn.addEventListener('click', () => api.installUpdate());

    updateRow.append(checkBtn, downloadBtn, installBtn);
    updateBlock.append(updateStatus, updateRow);
    wrap.appendChild(updateBlock);

    const links = el('div', 'about-links');
    const link = (label, url) => {
      const button = el('button', 'btn small', label);
      button.type = 'button';
      button.addEventListener('click', () => api.openExternal(url));
      return button;
    };
    links.append(link('获取 API Key', 'https://platform.deepseek.com/api_keys'), link('DeepSeek 文档', 'https://api-docs.deepseek.com/'));
    wrap.appendChild(links);

    const kv = document.createElement('dl');
    kv.className = 'kv';
    const entries = [
      ['平台', state.app ? `${state.app.platform} ${state.app.arch}` : ''],
      ['Electron', state.app ? state.app.electron : ''],
      ['Node', state.app ? state.app.node : ''],
      ['数据目录', state.app ? state.app.userDataPath : ''],
      ['快捷键', state.app ? state.app.hotkey || '未启用' : ''],
    ];
    for (const [key, value] of entries) {
      kv.appendChild(el('dt', null, key));
      kv.appendChild(el('dd', null, value || '—'));
    }
    wrap.appendChild(kv);

    const tip = el('div', 'tip');
    tip.innerHTML = `<span>提示</span><span>选中文字后弹窗不出现？Windows 上某些以管理员身份运行的程序会拦截模拟按键，可尝试以管理员身份运行 SelectPop；macOS 需要在「隐私与安全性 → 辅助功能」里授权。</span>`;
    wrap.appendChild(tip);
    return wrap;
  }

  /* ------------------------------ 渲染 ------------------------------ */

  function renderNav(sections) {
    els.nav.textContent = '';
    for (const section of sections) {
      const button = el('button', 'nav-item');
      button.type = 'button';
      button.dataset.section = section.id;
      button.dataset.active = section.id === state.section ? '1' : '0';
      button.innerHTML = `${svgIcon(section.icon)}<span>${section.title}</span>${
        section.badge ? `<span class="tag">${section.badge}</span>` : ''
      }`;
      button.addEventListener('click', () => selectSection(section.id));
      els.nav.appendChild(button);
    }
  }

  function renderPanel() {
    const sections = buildSections();
    const section = sections.find((item) => item.id === state.section) || sections[0];
    els.title.textContent = section.title;
    els.desc.textContent = section.desc || '';
    els.panel.textContent = '';

    const group = el('div', 'group');
    for (const field of section.fields) {
      if (field.type === 'apikey') {
        group.appendChild(blockApiKey());
      } else if (field.type === 'storage') {
        group.appendChild(blockStorage());
      } else if (field.type === 'about') {
        group.appendChild(blockAbout());
      } else if (field.type === 'permission') {
        if (!isMac) continue;
        group.appendChild(rowShell({ label: '辅助功能权限', desc: '监听划词和模拟 Command+C 需要这个权限' }, controlPermission()));
      } else {
        let control = null;
        switch (field.type) {
          case 'switch':
            control = controlSwitch(field);
            break;
          case 'select':
            control = controlSelect(field);
            break;
          case 'range':
            control = controlRange(field);
            break;
          case 'number':
            control = controlNumber(field);
            break;
          case 'text':
            control = controlText(field);
            break;
          case 'textarea':
            control = controlTextarea(field);
            break;
          case 'hotkey':
            control = controlHotkey(field);
            break;
          case 'actions':
            control = controlActions(field);
            break;
          default:
            break;
        }
        if (!control) continue;
        group.appendChild(rowShell(field, control, field.wide || field.type === 'actions'));
      }
    }
    els.panel.appendChild(group);
    els.panel.scrollTop = 0;
  }

  function selectSection(id) {
    if (!id || state.section === id) {
      if (id && state.section === id) renderPanel();
      return;
    }
    state.section = id;
    for (const button of els.nav.querySelectorAll('.nav-item')) {
      button.dataset.active = button.dataset.section === id ? '1' : '0';
    }
    renderPanel();
  }

  /* ------------------------------ 启动 ------------------------------ */

  async function load() {
    const data = await api.get();
    if (!data) {
      showToast('读取设置失败', 'error');
      return;
    }
    state.settings = data.settings || {};
    state.app = data.app || {};
    updateState.currentVersion = data.app?.version || '';
    state.permission = data.permission || {};
    state.options = data.options || {};
    state.hasApiKey = Boolean(data.hasApiKey);
    state.keyHint = data.keyHint || '';

    const sections = buildSections();
    if (!sections.some((s) => s.id === state.section)) state.section = 'general';
    renderNav(sections);
    renderPanel();
  }

  els.openData.addEventListener('click', () => api.openDataDir());
  els.openLog.addEventListener('click', () => api.openLog());

  api.onChange((payload) => {
    if (!payload) return;
    if (payload.settings) {
      state.settings = payload.settings;
      // 用户正在编辑时不要重绘，免得丢焦点
      const active = document.activeElement;
      const editing = active && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName);
      if (!editing) renderPanel();
    }
    if (typeof payload.hasApiKey === 'boolean') {
      state.hasApiKey = payload.hasApiKey;
      state.keyHint = payload.keyHint || state.keyHint;
      updateKeyPill();
    }
    if (payload.app) state.app = payload.app;
  });

  api.onFocusSection((section) => {
    if (typeof section === 'string' && section) selectSection(section);
  });

  api.onUpdateStatus((payload) => {
    if (!payload) return;
    updateState = {
      state: payload.state || 'idle',
      data: payload.data || null,
      currentVersion: payload.currentVersion || updateState.currentVersion,
    };
    if (state.section === 'about') renderPanel();
  });

  load().catch((error) => {
    showToast(`加载设置失败：${error.message}`, 'error');
  });
})();
