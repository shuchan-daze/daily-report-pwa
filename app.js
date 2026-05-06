const yen = new Intl.NumberFormat('ja-JP');

function normalizeText(text) {
  return (text || '')
    .replace(/[０-９]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0))
    .replace(/[，]/g, ',')
    .replace(/[￥]/g, '¥')
    .replace(/[−ー―]/g, '-')
    .replace(/\r/g, '\n');
}

function extractAmounts(text) {
  const normalized = normalizeText(text);
  const lines = normalized.split('\n').map(l => l.trim()).filter(Boolean);
  const items = [];

  lines.forEach((line, lineIndex) => {
    const lower = line.toLowerCase();
    const isTotalLine = /(合計|総計|小計|total|計\s*$)/i.test(line);

    // ¥1,230 / 1,230円 / 1230 の候補を拾う
    const regex = /(?:¥\s*)?([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{3,6})(?:\s*円)?/g;
    let match;
    while ((match = regex.exec(line)) !== null) {
      const raw = match[1];
      const value = Number(raw.replace(/,/g, ''));
      if (!Number.isFinite(value)) continue;

      // OCRゴミ除外：0、0000、時刻っぽい数字、極端に小さい数字は捨てる
      if (value <= 0) continue;
      if (/^0+$/.test(raw.replace(/,/g, ''))) continue;
      if (value < 300) continue;
      if (value > 999999) continue;

      // 行内に時刻だけがある場合の 1234 誤認識を減らす
      const around = line.slice(Math.max(0, match.index - 4), match.index + raw.length + 4);
      if (/\d{1,2}:\d{2}/.test(around) && raw.length <= 4 && !/[¥円,]/.test(line)) {
        continue;
      }

      items.push({ value, raw, line, lineIndex, isTotalLine });
    }
  });

  return items;
}

function removeLikelyTotals(items) {
  // 合計行は売上1件としては扱わない。参考にはdebugで残す。
  return items.filter(item => !item.isTotalLine);
}

function matchDailyToReceipts(dailyItems, receiptItems, tolerance = 0) {
  const receiptPool = receiptItems.map((item, index) => ({ ...item, index, used: false }));

  const rows = dailyItems.map((daily, i) => {
    let best = null;
    for (const receipt of receiptPool) {
      if (receipt.used) continue;
      const diff = Math.abs(receipt.value - daily.value);
      if (diff <= tolerance) {
        if (!best || diff < best.diff) best = { receipt, diff };
      }
    }

    if (best) {
      best.receipt.used = true;
      return {
        no: i + 1,
        daily,
        receipt: best.receipt,
        status: best.diff === 0 ? '一致' : '差額あり',
        className: best.diff === 0 ? 'ok' : 'diff',
        memo: best.diff === 0 ? '' : `差額 ${yen.format(best.diff)}円`
      };
    }

    return {
      no: i + 1,
      daily,
      receipt: null,
      status: 'レシートなし',
      className: 'missing',
      memo: '貸切・割引・メーター外・OCR漏れ候補'
    };
  });

  const unmatched = receiptPool.filter(r => !r.used);
  return { rows, unmatched };
}

function renderSummary(dailyItems, receiptItems, rows, unmatched) {
  const dailyTotal = dailyItems.reduce((sum, item) => sum + item.value, 0);
  const matchedTotal = rows.filter(r => r.receipt).reduce((sum, r) => sum + r.daily.value, 0);
  const missingCount = rows.filter(r => !r.receipt).length;
  const diffCount = rows.filter(r => r.className === 'diff').length;

  document.getElementById('summary').innerHTML = `
    <div class="summary-card"><div class="label">日報件数</div><div class="value">${dailyItems.length}</div></div>
    <div class="summary-card"><div class="label">日報合計</div><div class="value">${yen.format(dailyTotal)}円</div></div>
    <div class="summary-card"><div class="label">一致・採用</div><div class="value">${yen.format(matchedTotal)}円</div></div>
    <div class="summary-card"><div class="label">要確認</div><div class="value">${missingCount + diffCount + unmatched.length}</div></div>
  `;
}

function renderTable(rows) {
  const tbody = document.querySelector('#resultTable tbody');
  tbody.innerHTML = '';
  rows.forEach(row => {
    const tr = document.createElement('tr');
    tr.className = row.className;
    tr.innerHTML = `
      <td>${row.no}</td>
      <td>${yen.format(row.daily.value)}円</td>
      <td>${row.receipt ? `${yen.format(row.receipt.value)}円` : '-'}</td>
      <td>${row.status}</td>
      <td>${row.memo}</td>
    `;
    tbody.appendChild(tr);
  });
}

function renderUnmatched(unmatched) {
  const el = document.getElementById('unmatchedReceipts');
  if (!unmatched.length) {
    el.innerHTML = '<span class="note">残りなし</span>';
    return;
  }
  el.innerHTML = unmatched.map(item => `<span class="chip">${yen.format(item.value)}円</span>`).join('');
}

function analyze() {
  const tolerance = Number(document.getElementById('tolerance').value || 0);
  const dailyRaw = extractAmounts(document.getElementById('dailyText').value);
  const receiptRaw = extractAmounts(document.getElementById('receiptText').value);
  const dailyItems = removeLikelyTotals(dailyRaw);
  const receiptItems = removeLikelyTotals(receiptRaw);
  const { rows, unmatched } = matchDailyToReceipts(dailyItems, receiptItems, tolerance);

  renderSummary(dailyItems, receiptItems, rows, unmatched);
  renderTable(rows);
  renderUnmatched(unmatched);

  document.getElementById('debugOutput').textContent = JSON.stringify({
    dailyRaw,
    receiptRaw,
    dailyUsed: dailyItems,
    receiptUsed: receiptItems,
    unmatched
  }, null, 2);
}

function saveState() {
  const data = {
    dailyText: document.getElementById('dailyText').value,
    receiptText: document.getElementById('receiptText').value,
    tolerance: document.getElementById('tolerance').value,
    savedAt: new Date().toISOString()
  };
  localStorage.setItem('daily-reconcile-test', JSON.stringify(data));
  alert('保存しました');
}

function loadState() {
  const raw = localStorage.getItem('daily-reconcile-test');
  if (!raw) return alert('保存データがありません');
  const data = JSON.parse(raw);
  document.getElementById('dailyText').value = data.dailyText || '';
  document.getElementById('receiptText').value = data.receiptText || '';
  document.getElementById('tolerance').value = data.tolerance || 0;
  analyze();
}

function resetAll() {
  if (!confirm('入力と保存データを消しますか？')) return;
  localStorage.removeItem('daily-reconcile-test');
  document.getElementById('dailyText').value = '';
  document.getElementById('receiptText').value = '';
  document.getElementById('tolerance').value = 0;
  analyze();
}

document.getElementById('analyzeBtn').addEventListener('click', analyze);
document.getElementById('saveBtn').addEventListener('click', saveState);
document.getElementById('loadBtn').addEventListener('click', loadState);
document.getElementById('resetBtn').addEventListener('click', resetAll);
document.querySelectorAll('[data-clear]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.getElementById(btn.dataset.clear).value = '';
  });
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}

analyze();
