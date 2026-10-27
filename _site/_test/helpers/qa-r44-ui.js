'use strict';
// _site/_test/helpers/qa-r44-ui.js
//
// The R44 lane's real-UI actions on the product's own permission and
// question cards.
//
// Every function below drives the DOM control the product itself renders:
// the 允许 / 拒绝 buttons of the tool permission card, the radio / checkbox /
// custom input and the 提交答案 button of the question card, and the
// product's own permission-mode menu. Nothing here fabricates an event, calls
// a product endpoint in place of the UI, or writes a card state by hand.
//
// The product marks its own cards:
//   tool card      <div class="perm" data-perm-id="..."> with .p-title,
//                  .p-sub, .btn-allow (允许), .btn-deny (拒绝) and, once it
//                  settles, .p-state (已允许 / 已拒绝)
//   question card  <section class="perm question-card" data-perm-id="...">
//                  with one .question-field per question, .question-option
//                  labels, an optional .question-custom input and a
//                  .question-submit button (提交答案)

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function waitUntil(fn, label, timeoutMs = 30000, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
      last = value;
    } catch (error) { last = error && error.message; }
    await wait(intervalMs);
  }
  const detail = last === undefined ? '' : ` (last: ${typeof last === 'string' ? last : JSON.stringify(last)})`;
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}${detail}`);
}

// --- the tool permission card ----------------------------------------------

const READ_TOOL_CARDS = `(() => {
  const cards = Array.from(document.querySelectorAll('.perm[data-perm-id]')).filter(node => !node.classList.contains('question-card'));
  return cards.map(node => {
    const title = node.querySelector('.p-title');
    const sub = node.querySelector('.p-sub');
    const state = node.querySelector('.p-state');
    const allow = node.querySelector('.btn-allow');
    const deny = node.querySelector('.btn-deny');
    const titleText = ((title && title.textContent) || '').trim();
    return {
      requestId: node.dataset.permId || '',
      title: titleText,
      toolName: titleText.split(/\\s+/)[0] || '',
      sub: ((sub && sub.textContent) || '').trim(),
      hasAllow: Boolean(allow),
      hasDeny: Boolean(deny),
      settledState: state ? (state.textContent || '').trim() : null,
      settled: Boolean(state),
      cardClass: node.className,
    };
  });
})()`;

async function readToolPermissionCards(browser) {
  return browser.evaluate(READ_TOOL_CARDS);
}

// The card of one specific request. The product renders the tool name of a
// permission card only in the EVENT summary, not in the card title (the card
// reads "Agent 请求执行操作"), so the card is identified by the request id
// the product itself put into `data-perm-id`.
async function findToolCard(browser, requestId) {
  const cards = await readToolPermissionCards(browser);
  return cards.find(card => card.requestId === requestId) || null;
}

// The event streams the PAGE itself opened, read from the recorder the
// frozen harness injects into every page it opens. The lane uses it to know
// that the page is subscribed to a session BEFORE a turn is sent.
async function readPageStreams(browser) {
  return browser.evaluate(`(() => {
    const streams = (window.__wbRecorder && window.__wbRecorder.streams) || [];
    return streams.map(entry => String(entry.url || ''));
  })()`);
}

// The events the PAGE itself received, read from the recorder the frozen
// harness injects into every page it opens. This is the browser's own
// receipt of the product's event stream.
async function readPageEvents(browser, type) {
  return browser.evaluate(`(() => {
    const log = (window.__wbRecorder && window.__wbRecorder.log) || [];
    const wanted = ${JSON.stringify(type || null)};
    const out = [];
    for (const entry of log) {
      if (wanted && entry.type !== wanted) continue;
      let event = null;
      try { event = JSON.parse(entry.data); } catch (error) { event = null; }
      out.push({ type: entry.type, event });
    }
    return out;
  })()`);
}

// What the page shows right now: the permission cards, the question cards and
// the product's own session state. Used as the driver-side diagnostic.
async function readDomDiagnostics(browser) {
  return browser.evaluate(`(() => {
    const col = document.getElementById('stream-col');
    return {
      permCount: document.querySelectorAll('.perm').length,
      permIds: Array.from(document.querySelectorAll('.perm[data-perm-id]')).map(node => node.dataset.permId || ''),
      questionCardCount: document.querySelectorAll('.perm.question-card').length,
      streamChildren: col ? col.childElementCount : null,
      streamTextLength: col ? (col.textContent || '').length : null,
      sessionState: (typeof state !== 'undefined' && state) ? (state.sessionState || null) : null,
      activeSessionId: (typeof state !== 'undefined' && state) ? (state.activeSessionId || null) : null,
      permissionMode: (typeof state !== 'undefined' && state) ? (state.permissionMode || null) : null,
      recordedEventTypes: ((window.__wbRecorder && window.__wbRecorder.log) || []).map(entry => entry.type),
    };
  })()`);
}

// The product's own 拒绝 button of the card with that requestId.
async function clickDeny(browser, requestId) {
  const result = await browser.evaluate(`(() => {
    const id = ${JSON.stringify(requestId)};
    const node = document.querySelector('.perm[data-perm-id="' + id.replace(/"/g, '\\\\"') + '"]:not(.question-card)');
    if (!node) return { clicked: false, reason: 'no such permission card' };
    const deny = node.querySelector('.btn-deny');
    if (!deny) return { clicked: false, reason: 'the card has no 拒绝 button' };
    deny.click();
    return { clicked: true, title: ((node.querySelector('.p-title') || {}).textContent || '').trim() };
  })()`);
  if (!result.clicked) throw new Error(`the 拒绝 button could not be clicked: ${result.reason || 'unknown'}`);
  return result;
}

// The product's own 允许 button of the card with that requestId.
async function clickAllow(browser, requestId) {
  const result = await browser.evaluate(`(() => {
    const id = ${JSON.stringify(requestId)};
    const node = document.querySelector('.perm[data-perm-id="' + id.replace(/"/g, '\\\\"') + '"]:not(.question-card)');
    if (!node) return { clicked: false, reason: 'no such permission card' };
    const allow = node.querySelector('.btn-allow');
    if (!allow) return { clicked: false, reason: 'the card has no 允许 button' };
    allow.click();
    return { clicked: true };
  })()`);
  if (!result.clicked) throw new Error(`the 允许 button could not be clicked: ${result.reason || 'unknown'}`);
  return result;
}

// The state the product itself rendered after it settled the card.
async function readSettledCard(browser, requestId) {
  return browser.evaluate(`(() => {
    const id = ${JSON.stringify(requestId)};
    const node = document.querySelector('.perm[data-perm-id="' + id.replace(/"/g, '\\\\"') + '"]');
    if (!node) return { found: false };
    const state = node.querySelector('.p-state');
    return {
      found: true,
      isQuestionCard: node.classList.contains('question-card'),
      settledState: state ? (state.textContent || '').trim() : null,
      settled: node.classList.contains('question-settled') || node.classList.contains('settled'),
      title: ((node.querySelector('.p-title') || node.querySelector('.question-title')) || {}).textContent || '',
      cardClass: node.className,
    };
  })()`);
}

// --- the user question card ------------------------------------------------

const READ_QUESTION_CARDS = `(() => {
  const cards = Array.from(document.querySelectorAll('.perm.question-card[data-perm-id]'));
  return cards.map(node => {
    const fields = Array.from(node.querySelectorAll('.question-field')).map(field => {
      const legend = field.querySelector('legend');
      const options = Array.from(field.querySelectorAll('.question-option')).map(label => {
        const input = label.querySelector('input');
        const text = label.querySelector('.question-option-label');
        return {
          label: ((text && text.textContent) || '').trim(),
          inputType: input ? input.type : null,
          checked: input ? input.checked === true : false,
          value: input ? input.value : null,
        };
      });
      const custom = field.querySelector('input.question-custom');
      return {
        legend: ((legend && legend.textContent) || '').trim(),
        options,
        customPresent: Boolean(custom),
        customValue: custom ? custom.value : null,
        customType: custom ? custom.type : null,
      };
    });
    const submit = node.querySelector('.question-submit');
    const title = node.querySelector('.question-title');
    return {
      requestId: node.dataset.permId || '',
      title: ((title && title.textContent) || '').trim(),
      settled: node.classList.contains('question-settled'),
      fields,
      submitDisabled: submit ? submit.disabled === true : null,
      submitText: submit ? (submit.textContent || '').trim() : null,
      errorText: ((node.querySelector('.question-error') || {}).textContent || '').trim(),
    };
  });
})()`;

async function readQuestionCards(browser) {
  return browser.evaluate(READ_QUESTION_CARDS);
}

// Click the radio of a single-select question by its visible label.
async function selectRadioOption(browser, requestId, fieldIndex, optionLabel) {
  const result = await browser.evaluate(`(() => {
    const id = ${JSON.stringify(requestId)};
    const index = ${Number(fieldIndex)};
    const label = ${JSON.stringify(optionLabel)};
    const node = document.querySelector('.perm.question-card[data-perm-id="' + id.replace(/"/g, '\\\\"') + '"]');
    if (!node) return { clicked: false, reason: 'no such question card' };
    const field = node.querySelectorAll('.question-field')[index];
    if (!field) return { clicked: false, reason: 'no such question field' };
    for (const option of Array.from(field.querySelectorAll('.question-option'))) {
      const text = option.querySelector('.question-option-label');
      if (((text && text.textContent) || '').trim() === label) {
        const input = option.querySelector('input');
        if (!input) return { clicked: false, reason: 'the option has no input' };
        input.click();
        return { clicked: true, checked: input.checked === true, inputType: input.type };
      }
    }
    return { clicked: false, reason: 'no option with that label' };
  })()`);
  if (!result.clicked) throw new Error(`the radio option could not be selected: ${result.reason || 'unknown'}`);
  return result;
}

// Tick the checkboxes of a multi-select question by their visible labels.
async function selectCheckboxOptions(browser, requestId, fieldIndex, optionLabels) {
  const labels = Array.isArray(optionLabels) ? optionLabels : [optionLabels];
  const result = await browser.evaluate(`(() => {
    const id = ${JSON.stringify(requestId)};
    const index = ${Number(fieldIndex)};
    const labels = ${JSON.stringify(labels)};
    const node = document.querySelector('.perm.question-card[data-perm-id="' + id.replace(/"/g, '\\\\"') + '"]');
    if (!node) return { clicked: false, reason: 'no such question card' };
    const field = node.querySelectorAll('.question-field')[index];
    if (!field) return { clicked: false, reason: 'no such question field' };
    const picked = [];
    for (const label of labels) {
      let hit = null;
      for (const option of Array.from(field.querySelectorAll('.question-option'))) {
        const text = option.querySelector('.question-option-label');
        if (((text && text.textContent) || '').trim() === label) { hit = option; break; }
      }
      if (!hit) return { clicked: false, reason: 'no option with label ' + label };
      const input = hit.querySelector('input');
      if (!input) return { clicked: false, reason: 'the option has no input' };
      input.click();
      picked.push({ label, checked: input.checked === true });
    }
    return { clicked: true, picked };
  })()`);
  if (!result.clicked) throw new Error(`the checkbox options could not be selected: ${result.reason || 'unknown'}`);
  return result;
}

// Type a custom answer into the product's own custom input of a question.
async function typeCustomAnswer(browser, requestId, fieldIndex, text) {
  const result = await browser.evaluate(`(() => {
    const id = ${JSON.stringify(requestId)};
    const index = ${Number(fieldIndex)};
    const value = ${JSON.stringify(text)};
    const node = document.querySelector('.perm.question-card[data-perm-id="' + id.replace(/"/g, '\\\\"') + '"]');
    if (!node) return { typed: false, reason: 'no such question card' };
    const field = node.querySelectorAll('.question-field')[index];
    if (!field) return { typed: false, reason: 'no such question field' };
    const custom = field.querySelector('input.question-custom');
    if (!custom) return { typed: false, reason: 'the question has no custom input' };
    custom.focus();
    custom.value = value;
    custom.dispatchEvent(new Event('input', { bubbles: true }));
    return { typed: true, value: custom.value, type: custom.type };
  })()`);
  if (!result.typed) throw new Error(`the custom answer could not be typed: ${result.reason || 'unknown'}`);
  return result;
}

// The product's own 提交答案 button.
async function clickSubmitAnswer(browser, requestId) {
  const result = await browser.evaluate(`(() => {
    const id = ${JSON.stringify(requestId)};
    const node = document.querySelector('.perm.question-card[data-perm-id="' + id.replace(/"/g, '\\\\"') + '"]');
    if (!node) return { clicked: false, reason: 'no such question card' };
    const submit = node.querySelector('.question-submit');
    if (!submit) return { clicked: false, reason: 'the card has no 提交答案 button' };
    const wasDisabled = submit.disabled === true;
    submit.click();
    return { clicked: true, wasDisabled };
  })()`);
  if (!result.clicked) throw new Error(`the 提交答案 button could not be clicked: ${result.reason || 'unknown'}`);
  return result;
}

// --- the product's own permission-mode menu ---------------------------------

// The product renders the permission modes in its own menu (默认防护 /
// 接受编辑 / 计划模式 / 完全访问). Selecting 完全访问 is the product's own
// bypass control; the lane uses it to prove that the bypass does not release
// a pending question.
async function selectPermissionMode(browser, label) {
  const opened = await browser.evaluate("(() => { const button = document.getElementById('btn-mode'); if (!button) return { opened: false, reason: 'no mode button' }; button.click(); const pop = document.getElementById('pop-mode'); return { opened: Boolean(pop) && pop.hidden === false, items: pop ? Array.from(pop.querySelectorAll('.pop-item')).map(item => ((item.querySelector('.grow') || item).textContent || '').trim()) : [] }; })()");
  if (!opened.opened) throw new Error(`the permission-mode menu did not open: ${opened.reason || 'unknown'}`);
  const clicked = await browser.evaluate(`(() => {
    const label = ${JSON.stringify(label)};
    const pop = document.getElementById('pop-mode');
    for (const item of Array.from(pop.querySelectorAll('.pop-item'))) {
      const text = ((item.querySelector('.grow') || item).textContent || '').trim();
      if (text === label) { item.click(); return { clicked: true, label: text }; }
    }
    return { clicked: false, items: Array.from(pop.querySelectorAll('.pop-item')).map(item => ((item.querySelector('.grow') || item).textContent || '').trim()) };
  })()`);
  if (!clicked.clicked) throw new Error(`the permission mode ${label} is not in the product's menu: ${JSON.stringify(clicked.items)}`);
  return clicked;
}

module.exports = {
  wait,
  waitUntil,
  readToolPermissionCards,
  findToolCard,
  readPageStreams,
  readPageEvents,
  readDomDiagnostics,
  clickDeny,
  clickAllow,
  readSettledCard,
  readQuestionCards,
  selectRadioOption,
  selectCheckboxOptions,
  typeCustomAnswer,
  clickSubmitAnswer,
  selectPermissionMode,
};
