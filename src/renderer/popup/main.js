'use strict';

(() => {
  const api = window.selectpop;
  if (!api) return;

  const $ = (id) => document.getElementById(id);

  const els = {
    card: $('card'),
    preview: $('preview'),
    meta: $('meta'),
    badge: $('source-badge'),
    actions: $('actions'),
    result: $('result'),
    resultTitle: $('result-title'),
    resultSub: $('result-sub'),
    spinner: $('spinner'),
    answer: $('answer'),
    notice: $('notice'),
    noticeText: $('notice-text'),
    noticeAction: $('notice-action'),
    copyResult: $('copy-result'),
    retry: $('retry'),
    stop: $('stop'),
    close: $('close'),
    toast: $('toast'),
  };

  const ICONS = {
    copy: '<rect x="6" y="6" width="7" height="7.5" rx="1.6"/><path d="M4 10.5V4.4c0-.8.6-1.4 1.4-1.4H10"/>',
    translate:
      '<path d="M2.4 4.8h6.2M5.5 2.8v2c0 2.7-1.5 4.6-3.1 5.7M3.9 8.4c.8 1.6 2.2 2.6 3.7 3"/><path d="M9.4 13.2l2.5-5.8 2.5 5.8M10.4 11.3h3"/>',
    search: '<circle cx="7.1" cy="7.1" r="4.1"/><path d="M10.2 10.2l3.2 3.2"/>',
    spark:
      '<path d="M8 2.2l1.2 3.2 3.2 1.2-3.2 1.2L8 11l-1.2-3.2L3.6 6.6l3.2-1.2z"/><circle cx="12.4" cy="12.2" r="1.1"/>',
    list: '<path d="M5.8 4.4h7.6M5.8 8h7.6M5.8 11.6h5.2"/><circle cx="3.2" cy="4.4" r=".85"/><circle cx="3.2" cy="8" r=".85"/><circle cx="3.2" cy="11.6" r=".85"/>',
    pen: '<path d="M10.6 2.7l2.7 2.7-7.4 7.4-3.2.9.9-3.1z"/>',
    check: '<path d="M3.2 8.4l3.4 3.4 6.2-6.4"/>',
    dot: '<circle cx="8" cy="8" r="3.2"/>',
  };

  const SOURCE_LABEL = { mouse: '划词', hotkey: '快捷键', clipboard: '剪贴板', smoke: '预览' };

  const state = {
    actions: [],
    text: '',
    previewText: '',
    hasApiKey: false,
    streaming: false,
    activeAction: null,
    lastAction: null,
    userScrolled: false,
    toastTimer: null,
    lastHeight: 0,
    lastWidth: 0,
    frame: 0,
  };

  /* ------------------------------ 工具函数 ------------------------------ */

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (ch) => {
      switch (ch) {
        case '&':
          return '&amp;';
        case '<':
          return '&lt;';
        case '>':
          return '&gt;';
        case '"':
          return '&quot;';
        default:
          return '&#39;';
      }
    });
  }

  function inline(text) {
    let out = escapeHtml(text);
    out = out.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    out = out.replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" data-external="1" title="$2">$1</a>',
    );
    return out;
  }

  /** 极简 Markdown：够用来渲染模型输出的标题 / 列表 / 粗体 / 代码 / 链接 */
  function renderMarkdown(source) {
    const lines = String(source || '').replace(/\r\n?/g, '\n').split('\n');
    const html = [];
    let listType = null;
    let paragraph = [];
    let index = 0;
    let fence = null;

    const flushParagraph = () => {
      if (paragraph.length) {
        html.push(`<p>${paragraph.map(inline).join('<br>')}</p>`);
        paragraph = [];
      }
    };
    const closeList = () => {
      if (listType) {
        html.push(`</${listType}>`);
        listType = null;
      }
    };

    while (index < lines.length) {
      const line = lines[index];

      if (/^\s*```/.test(line)) {
        flushParagraph();
        closeList();
        if (fence) {
          html.push(`<pre><code>${escapeHtml(fence.join('\n'))}</code></pre>`);
          fence = null;
        } else {
          fence = [];
        }
        index += 1;
        continue;
      }
      if (fence) {
        fence.push(line);
        index += 1;
        continue;
      }

      if (!line.trim()) {
        flushParagraph();
        closeList();
        index += 1;
        continue;
      }

      const heading = line.match(/^(#{1,4})\s+(.*)$/);
      if (heading) {
        flushParagraph();
        closeList();
        const level = Math.min(heading[1].length + 1, 4);
        html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
        index += 1;
        continue;
      }

      if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
        flushParagraph();
        closeList();
        html.push('<hr>');
        index += 1;
        continue;
      }

      if (/^\s*>\s?/.test(line)) {
        flushParagraph();
        closeList();
        const quote = [];
        while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
          quote.push(lines[index].replace(/^\s*>\s?/, ''));
          index += 1;
        }
        html.push(`<blockquote><p>${quote.map(inline).join('<br>')}</p></blockquote>`);
        continue;
      }

      const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
      const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (bullet || ordered) {
        flushParagraph();
        const wanted = bullet ? 'ul' : 'ol';
        if (listType !== wanted) {
          closeList();
          html.push(`<${wanted}>`);
          listType = wanted;
        }
        html.push(`<li>${inline((bullet || ordered)[1])}</li>`);
        index += 1;
        continue;
      }

      if (listType) closeList();
      paragraph.push(line);
      index += 1;
    }

    if (fence) html.push(`<pre><code>${escapeHtml(fence.join('\n'))}</code></pre>`);
    flushParagraph();
    closeList();
    return html.join('');
  }

  /* ------------------------------ 高度自适应 ------------------------------ */

  function measure() {
    const rect = els.card.getBoundingClientRect();
    const height = Math.ceil(rect.height) + 18;
    const width = Math.ceil(rect.width) + 16;
    if (Math.abs(height - state.lastHeight) < 2 && Math.abs(width - state.lastWidth) < 2) return;
    state.lastHeight = height;
    state.lastWidth = width;
    api.resize(height, width);
  }

  const scheduleMeasure = () => {
    requestAnimationFrame(measure);
  };

  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(scheduleMeasure).observe(els.card);
  }

  /* ------------------------------ 四角拖拽调整大小 ------------------------------ */

  const RESIZE_MIN_W = 320;
  const RESIZE_MAX_W = 560;

  function initResize() {
    const handles = Array.from(els.card.querySelectorAll('.rz'));
    if (!handles.length) return;

    let drag = null;

    function cardSize() {
      const rect = els.card.getBoundingClientRect();
      return { w: rect.width, h: rect.height };
    }

    function onDown(e) {
      if (e.button !== 0) return;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      const size = cardSize();
      drag = {
        dir: e.currentTarget.dataset.dir,
        startX: e.screenX,
        startY: e.screenY,
        startW: size.w,
        startH: size.h,
      };
      document.body.classList.add('resizing');
      e.preventDefault();
    }

    function onMove(e) {
      if (!drag) return;
      const dx = e.screenX - drag.startX;
      const dy = e.screenY - drag.startY;

      let w = drag.startW;
      if (drag.dir.includes('e')) w += dx;
      else if (drag.dir.includes('w')) w -= dx;
      w = Math.round(Math.max(RESIZE_MIN_W, Math.min(w, RESIZE_MAX_W)));

      // 高度：向下/向上拖设置卡片最小高度（内容更多时仍会自然撑高，不会裁内容）
      let minH = drag.startH;
      if (drag.dir.includes('s')) minH += dy;
      else if (drag.dir.includes('n')) minH -= dy;
      minH = Math.round(Math.max(0, Math.min(minH, 662)));
      els.card.style.minHeight = minH > 120 ? `${minH}px` : '';

      // 宽度通过主进程调窗口宽度，卡片撑满窗口
      api.resize(state.lastHeight || 120, w + 16);
      scheduleMeasure();
      e.preventDefault();
    }

    function onUp() {
      if (!drag) return;
      drag = null;
      document.body.classList.remove('resizing');
      scheduleMeasure();
    }

    for (const handle of handles) handle.addEventListener('pointerdown', onDown);
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
  }

  /* ------------------------------ 渲染 ------------------------------ */

  function iconFor(name) {
    const path = ICONS[name] || ICONS.dot;
    return `<svg viewBox="0 0 16 16" aria-hidden="true">${path}</svg>`;
  }

  function renderActions() {
    els.actions.textContent = '';
    state.actions.forEach((action, position) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chip';
      button.dataset.action = action.id;
      button.title = action.kind === 'ai' && !state.hasApiKey ? `${action.label}（需配置 API Key）` : action.label;
      button.innerHTML = `${iconFor(action.icon)}<span>${escapeHtml(action.label)}</span>${
        position < 9 ? `<span class="kbd">${position + 1}</span>` : ''
      }`;
      button.addEventListener('click', () => run(action.id));
      els.actions.appendChild(button);
    });
  }

  function setActiveChip(actionId) {
    for (const chip of els.actions.querySelectorAll('.chip')) {
      chip.dataset.active = chip.dataset.action === actionId ? '1' : '0';
    }
  }

  function setBusy(busy) {
    state.streaming = busy;
    els.spinner.hidden = !busy;
    els.stop.hidden = !busy;
    els.answer.classList.toggle('caret', busy);
  }

  function paintAnswer() {
    els.answer.innerHTML = renderMarkdown(state.text) || '<p class="placeholder">正在思考…</p>';
    if (!state.userScrolled) els.answer.scrollTop = els.answer.scrollHeight;
    scheduleMeasure();
  }

  const schedulePaint = () => {
    if (state.frame) return;
    state.frame = requestAnimationFrame(() => {
      state.frame = 0;
      paintAnswer();
    });
  };

  function showNotice(message, actionLabel, handler) {
    if (!message) {
      els.notice.hidden = true;
      return;
    }
    els.noticeText.textContent = message;
    els.notice.hidden = false;
    if (actionLabel && handler) {
      els.noticeAction.hidden = false;
      els.noticeAction.textContent = actionLabel;
      els.noticeAction.onclick = handler;
    } else {
      els.noticeAction.hidden = true;
      els.noticeAction.onclick = null;
    }
    scheduleMeasure();
  }

  function toast(message, kind = 'success') {
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
    }, 1500);
  }

  function setFooter({ canCopy, canRetry }) {
    els.copyResult.hidden = !canCopy;
    els.retry.hidden = !canRetry;
  }

  /* ------------------------------ 会话初始化 ------------------------------ */

  function start(payload) {
    state.actions = Array.isArray(payload.actions) ? payload.actions : [];
    state.hasApiKey = Boolean(payload.hasApiKey);
    state.text = '';
    state.streaming = false;
    state.activeAction = null;
    state.userScrolled = false;

    document.documentElement.style.setProperty('--font-scale', String(payload.fontScale || 1));

    els.preview.textContent = payload.preview || payload.text || '';
    state.previewText = payload.text || payload.preview || '';

    const parts = [];
    if (payload.charCount) parts.push(`${payload.charCount} 字`);
    if (payload.targetLangName) parts.push(`译为${payload.targetLangName}`);
    if (payload.source && payload.source !== 'mouse') parts.push(SOURCE_LABEL[payload.source] || '');
    els.meta.textContent = parts.filter(Boolean).join(' · ');

    if (payload.source) {
      els.badge.hidden = false;
      els.badge.textContent = SOURCE_LABEL[payload.source] || '';
    } else {
      els.badge.hidden = true;
    }

    els.result.hidden = true;
    els.answer.textContent = '';
    els.resultTitle.textContent = '';
    els.resultSub.textContent = '';
    els.notice.hidden = true;
    els.spinner.hidden = true;
    els.stop.hidden = true;
    setFooter({ canCopy: false, canRetry: false });

    renderActions();
    els.card.style.animation = 'none';
    void els.card.offsetHeight;
    els.card.style.animation = '';
    state.lastHeight = 0;
    state.lastWidth = 0;
    els.card.style.minHeight = '';
    scheduleMeasure();
  }

  /* ------------------------------ 动作执行 ------------------------------ */

  async function run(actionId) {
    if (state.streaming) return;
    clearNoticeIfTransient();
    state.lastAction = actionId;
    setActiveChip(actionId);
    const result = await api.action(actionId);
    if (result && result.ok === false && result.reason && result.reason !== 'untrusted') {
      const messages = {
        'no-key': '还没配置 DeepSeek API Key',
        'empty-query': '没有可搜索的内容',
        'empty-text': '没有可翻译的内容',
        'no-session': '这次选区已失效，重新划词试试',
        disabled: '这个动作已在设置中关闭',
      };
      const message = messages[result.reason];
      if (message) showNotice(message, result.reason === 'no-key' ? '去填写' : null, () => api.openSettings('ai'));
    }
  }

  function clearNoticeIfTransient() {
    // 报错横幅在下一次动作时清掉；缺少 Key 的横幅保留，方便用户去设置
    if (els.notice.dataset.kind !== 'need-key') showNotice(null);
  }

  function beginAnswer(event) {
    state.text = '';
    state.userScrolled = false;
    els.result.hidden = false;
    els.answer.textContent = '';
    els.resultTitle.textContent = event.title || '';
    els.resultSub.textContent = event.subtitle || (event.truncated ? '原文较长，已截断' : '');
    setBusy(true);
    setFooter({ canCopy: false, canRetry: false });
    clearNoticeIfTransient();
    paintAnswer();
  }

  function handleEvent(event) {
    if (!event || typeof event !== 'object') return;
    switch (event.type) {
      case 'action-start':
        beginAnswer(event);
        break;

      case 'delta':
        if (!els.result.hidden) {
          state.text += event.text || '';
          schedulePaint();
        }
        break;

      case 'done': {
        if (event.text) state.text = event.text;
        setBusy(false);
        state.answerDone = true;
        paintAnswer();
        setFooter({ canCopy: Boolean(state.text), canRetry: true });
        if (event.usage) {
          const { prompt_tokens: prompt, completion_tokens: completion } = event.usage;
          if (completion) els.resultSub.textContent = `${completion} tokens`;
        }
        break;
      }

      case 'error':
        setBusy(false);
        els.answer.classList.remove('caret');
        els.notice.dataset.kind = 'error';
        showNotice(event.message || '请求失败，请稍后重试', '重试', () => api.retry());
        setFooter({ canCopy: Boolean(state.text), canRetry: true });
        break;

      case 'aborted':
        setBusy(false);
        els.answer.classList.remove('caret');
        if (!state.text) showNotice('已停止生成');
        setFooter({ canCopy: Boolean(state.text), canRetry: true });
        break;

      case 'need-key':
        els.notice.dataset.kind = 'need-key';
        showNotice(
          event.message || '需要先配置 DeepSeek API Key 才能使用 AI 功能',
          '去填写',
          () => api.openSettings('ai'),
        );
        break;

      case 'toast':
        toast(event.message || '', event.kind === 'error' ? 'error' : 'success');
        break;

      default:
        break;
    }
  }

  /* ------------------------------ 事件绑定 ------------------------------ */

  els.close.addEventListener('click', () => api.close());
  els.stop.addEventListener('click', () => api.stop());
  els.retry.addEventListener('click', () => {
    els.retry.hidden = true;
    api.retry();
  });
  els.copyResult.addEventListener('click', async () => {
    const text = state.text || state.previewText;
    if (!text) return;
    const result = await api.copyText(text);
    toast(result && result.ok ? '已复制结果' : '复制失败', result && result.ok ? 'success' : 'error');
  });

  els.answer.addEventListener('scroll', () => {
    const { scrollTop, scrollHeight, clientHeight } = els.answer;
    state.userScrolled = scrollTop + clientHeight < scrollHeight - 12;
  });

  els.answer.addEventListener('click', (event) => {
    const anchor = event.target.closest('a[data-external]');
    if (!anchor) return;
    event.preventDefault();
    api.openExternal(anchor.getAttribute('href'));
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      api.close();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      els.copyResult.click();
      return;
    }
    if (!event.metaKey && !event.ctrlKey && !event.altKey && /^[1-9]$/.test(event.key)) {
      const action = state.actions[Number(event.key) - 1];
      if (action) {
        event.preventDefault();
        run(action.id);
      }
    }
  });

  document.addEventListener('contextmenu', (event) => event.preventDefault());

  api.onInit(start);
  api.onEvent(handleEvent);
  initResize();
  api.onSettings((settings) => {
    if (!settings) return;
    const hasKey = Boolean(settings.hasApiKey);
    if (hasKey && !state.hasApiKey) toast('API Key 已保存');
    state.hasApiKey = hasKey;
    if (hasKey && els.notice.dataset.kind === 'need-key') showNotice(null);
    renderActions();
  });
})();
