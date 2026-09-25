let allCountries = [];
let selected     = new Set();
let regionFilter = '';
let running      = false;
let currentDrawerId = null;

const FIELD_META = {
  b2g:                      { label: 'B2G',                        section: 'E-invoicing Status' },
  b2b:                      { label: 'B2B',                        section: 'E-invoicing Status' },
  b2c:                      { label: 'B2C',                        section: 'E-invoicing Status' },
  b2g_date:                 { label: 'B2G Date',                   section: 'Implementation Dates' },
  b2g_staggered:            { label: 'B2G Staggered?',             section: 'Implementation Dates' },
  b2b_date:                 { label: 'B2B Date',                   section: 'Implementation Dates' },
  b2b_staggered:            { label: 'B2B Staggered?',             section: 'Implementation Dates' },
  b2c_date:                 { label: 'B2C Date',                   section: 'Implementation Dates' },
  b2c_staggered:            { label: 'B2C Staggered?',             section: 'Implementation Dates' },
  non_local_suppliers:      { label: 'Non-Local Suppliers',        section: 'Scope' },
  digital_services_suppliers:{ label: 'Digital Services Suppliers',section: 'Scope' },
  ap:                       { label: 'AP Transactions',            section: 'Scope' },
  ar:                       { label: 'AR Transactions',            section: 'Scope' },
  import_txn:               { label: 'Import Transactions',        section: 'Scope' },
  export_txn:               { label: 'Export Transactions',        section: 'Scope' },
  intra_eu_sales:           { label: 'Intra-EU Sales',             section: 'Scope' },
  intra_eu_purchases:       { label: 'Intra-EU Purchases',         section: 'Scope' },
  zero_rated:               { label: 'Zero-rated',                 section: 'Scope' },
  exempt:                   { label: 'Exempt',                     section: 'Scope' },
  e_reporting:              { label: 'E-reporting',                section: 'Scope' },
  tax_authority:            { label: 'Tax Authority',              section: 'Details' },
  format:                   { label: 'Invoice Format',             section: 'Details' },
  source:                   { label: 'Source URLs',                section: 'Details', full: true },
};

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  await loadCountries();
  renderGrid();
  renderTable();
  renderEditorSelect();
  loadStats();

  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    });
  });

  document.querySelectorAll('.rfbtn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.rfbtn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      regionFilter = btn.dataset.region;
      renderGrid();
    });
  });
}

async function loadCountries() {
  const res = await fetch('/api/countries');
  allCountries = await res.json();
}

async function loadStats() {
  const res = await fetch('/api/stats');
  const s   = await res.json();
  document.getElementById('st-total').textContent   = s.total   || 0;
  document.getElementById('st-done').textContent    = s.done    || 0;
  document.getElementById('st-pending').textContent = s.pending || 0;
  document.getElementById('st-error').textContent   = s.error   || 0;
}

// ── Grid ──────────────────────────────────────────────────────────────────────

function renderGrid() {
  const grid     = document.getElementById('country-grid');
  const filtered = regionFilter
    ? allCountries.filter(c => c.region === regionFilter)
    : allCountries;

  grid.innerHTML = filtered.map(c => {
    const isSel = selected.has(c.id);
    let cls = 'cc';
    if (isSel)              cls += ' selected';
    if (c.status === 'done')     cls += ' done';
    else if (c.status === 'fetching') cls += ' fetching';
    else if (c.status === 'error')    cls += ' error';

    let badges = '';
    if (c.status === 'done') {
      ['b2g','b2b','b2c'].forEach(k => {
        const v = c[k];
        if (v === 'Mandatory') badges += `<span class="badge badge-m">${k.toUpperCase()} M</span>`;
        else if (v === 'Voluntary') badges += `<span class="badge badge-v">${k.toUpperCase()} V</span>`;
        else if (v === 'N/A')  badges += `<span class="badge badge-na">${k.toUpperCase()}</span>`;
      });
    }

    return `<div class="${cls}" data-id="${c.id}" onclick="handleCardClick(${c.id})">
      <div class="cc-dot"></div>
      <div class="cc-region">${c.region}</div>
      <div class="cc-name">${c.country}</div>
      ${badges ? `<div class="cc-badges">${badges}</div>` : ''}
    </div>`;
  }).join('');

  updateSelCount();
}

function handleCardClick(id) {
  if (running) return;
  const c = allCountries.find(x => x.id === id);
  if (!c) return;

  // If already done and not selected, open the drawer (view mode)
  if (c.status === 'done' && !selected.has(id)) {
    openDrawer(id);
    return;
  }

  // Otherwise toggle selection
  if (selected.has(id)) {
    selected.delete(id);
    if (currentDrawerId === id) closeDrawer();
  } else {
    selected.add(id);
    if (c.status === 'done') openDrawer(id);
  }
  renderGrid();
  updateSelCount();
}

function updateSelCount() {
  document.getElementById('sel-count').textContent = selected.size + ' selected';
  document.getElementById('run-btn').disabled = selected.size === 0 || running;
}

function selectAll()     { allCountries.forEach(c => selected.add(c.id)); renderGrid(); }
function selectPending() {
  allCountries.filter(c => c.status === 'pending')
    .forEach(c => selected.add(c.id));
  renderGrid();
}
function clearSel() { selected.clear(); renderGrid(); closeDrawer(); updateSelCount(); }

async function resetSelected() {
  if (selected.size === 0) { alert('Select countries to reset first.'); return; }
  if (!confirm(`Reset data for ${selected.size} selected countries? This will clear all fetched data and set them back to Pending.`)) return;

  const ids = [...selected];
  try {
    const res  = await fetch('/api/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids })
    });
    const data = await res.json();
    if (data.ok) {
      // Update local state
      allCountries.forEach(c => {
        if (ids.includes(c.id)) {
          // Clear all fields
          Object.keys(c).forEach(k => {
            if (!['id','country','region','created_at'].includes(k)) c[k] = null;
          });
          c.status = 'pending';
        }
      });
      selected.clear();
      closeDrawer();
      renderGrid();
      renderTable();
      loadStats();
      updateSelCount();
    }
  } catch (err) {
    alert('Reset failed: ' + err.message);
  }
}
function selectErrors() {
  allCountries.filter(c => c.status === 'error').forEach(c => selected.add(c.id));
  renderGrid();
  updateSelCount();
}
async function refreshData() {
  window.location.reload();
}

async function refetchSources() {
  const btn = document.getElementById('refetch-btn');
  btn.disabled = true;
  btn.textContent = '🔗 Fetching Sources...';
  try {
    const res = await fetch('/api/refetch-sources', { method: 'POST' });
    const data = await res.json();
    btn.textContent = `✓ Updated ${data.updated} sources`;
    await loadCountries();
    renderGrid();
    renderTable();
    setTimeout(() => { btn.textContent = '🔗 Refresh Sources'; btn.disabled = false; }, 3000);
  } catch (err) {
    btn.textContent = '⚠ Error';
    btn.disabled = false;
  }
}

// ── Research ──────────────────────────────────────────────────────────────────

async function runResearch() {
  if (running || selected.size === 0) return;
  running = true;
  document.getElementById('run-btn').disabled = true;

  const progWrap  = document.getElementById('progress-wrap');
  const progFill  = document.getElementById('progress-fill');
  const progLabel = document.getElementById('progress-label');
  progWrap.style.display = 'block';

  const toRun = allCountries.filter(c => selected.has(c.id));
  const total = toRun.length;
  let done = 0;

  for (const c of toRun) {
    progLabel.textContent = `Fetching ${c.country}… (${done + 1}/${total})`;
    progFill.style.width  = Math.round(done / total * 100) + '%';
    c.status = 'fetching';
    renderGrid();

    try {
      const res  = await fetch(`/api/research/${c.id}`, { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        Object.assign(c, data.data, { status: 'done' });
      } else {
        c.status = 'error';
        progLabel.textContent = `⚠ ${c.country}: ${(data.error || 'unknown error').slice(0, 100)}`;
        console.error(`[${c.country}]`, data.error);
      }
    } catch (err) {
      c.status = 'error';
      console.error(`[${c.country}] fetch error:`, err);
    }

    done++;
    // llama-3.1-8b-instant has higher rate limits — 1s delay is enough
    // Every 20 countries, pause 5s just to be safe
    const pauseMs = (done % 20 === 0) ? 5000 : 1000;
    progLabel.textContent += ` (waiting ${pauseMs/1000}s…)`;
    await new Promise(r => setTimeout(r, pauseMs));
    progFill.style.width = Math.round(done / total * 100) + '%';
    renderGrid();
  }

  progLabel.textContent = `✓ Done — ${done} countries processed.`;
  running = false;
  updateSelCount();
  loadStats();
  renderTable();
}

async function recheckCurrent() {
  if (!currentDrawerId || running) return;
  const c = allCountries.find(x => x.id === currentDrawerId);
  if (!c) return;
  c.status = 'fetching';
  renderGrid();
  closeDrawer();
  try {
    const res  = await fetch(`/api/research/${c.id}`, { method: 'POST' });
    const data = await res.json();
    if (data.ok) Object.assign(c, data.data, { status: 'done' });
    else c.status = 'error';
  } catch {
    c.status = 'error';
  }
  renderGrid();
  loadStats();
  renderTable();
  if (c.status === 'done') openDrawer(c.id);
}

// ── Drawer ────────────────────────────────────────────────────────────────────

async function openDrawer(id) {
  // Always fetch fresh data from DB so source URLs are up to date
  try {
    const res = await fetch(`/api/country/${id}`);
    const fresh = await res.json();
    const idx = allCountries.findIndex(x => x.id === id);
    if (idx !== -1) Object.assign(allCountries[idx], fresh);
  } catch(e) {}

  const c = allCountries.find(x => x.id === id);
  if (!c) return;
  currentDrawerId = id;
  document.getElementById('drawer-title').textContent = `${c.country} (${c.region})`;

  const sections = {};
  for (const [key, meta] of Object.entries(FIELD_META)) {
    if (!sections[meta.section]) sections[meta.section] = [];
    sections[meta.section].push({ key, ...meta });
  }

  let html = '';
  for (const [sec, fields] of Object.entries(sections)) {
    html += `<div class="drawer-section">
      <div class="drawer-section-title">${sec}</div>
      <div class="field-grid">`;
    fields.forEach(f => {
      let val    = c[f.key] || '—';
      let valHtml = '';
      if (f.key === 'source') {
        if (!val || val === '—' || val === 'Information Not Available' || val === 'NOT_AVAILABLE') {
          valHtml = '<span class="na">Information Not Available</span>';
        } else {
          const urls = val.split('|').filter(u => u.trim() && u.trim().startsWith('http'));
          if (urls.length > 0) {
            valHtml = urls.map(u => `<a href="${u.trim()}" target="_blank" style="display:block;word-break:break-all;color:var(--accent)">${u.trim()}</a>`).join('');
          } else {
            valHtml = '<span class="na">Information Not Available</span>';
          }
        }
      } else {
        valHtml = `<span class="${val === 'N/A' || val === '—' ? 'na' : ''}">${val}</span>`;
      }
      html += `<div class="field-item${f.full ? ' full' : ''}">
        <div class="field-label">${f.label}</div>
        <div class="field-value">${valHtml}</div>
      </div>`;
    });
    html += '</div></div>';
  }

  document.getElementById('drawer-body').innerHTML = html;
  document.getElementById('drawer').classList.add('open');
  document.getElementById('drawer-overlay').classList.add('open');
}

function closeDrawer() {
  document.getElementById('drawer').classList.remove('open');
  document.getElementById('drawer-overlay').classList.remove('open');
  currentDrawerId = null;
}

// ── Table ─────────────────────────────────────────────────────────────────────

function pillFor(val) {
  if (!val || val === '—') return '<span class="pill pill-na">—</span>';
  if (val === 'Mandatory')  return '<span class="pill pill-m">Mandatory</span>';
  if (val === 'Voluntary')  return '<span class="pill pill-v">Voluntary</span>';
  if (val === 'N/A')        return '<span class="pill pill-na">N/A</span>';
  return val;
}

function renderTable() {
  const region = document.getElementById('res-region').value;
  const status = document.getElementById('res-status').value;
  const q      = document.getElementById('res-search').value.toLowerCase();

  const rows = allCountries.filter(c => {
    if (region && c.region !== region) return false;
    if (status && c.status !== status) return false;
    if (q && !c.country.toLowerCase().includes(q)) return false;
    return true;
  });

  document.getElementById('data-tbody').innerHTML = rows.map(c => {
    const srcLinks = (() => {
      if (!c.source || c.source === 'Information Not Available' || c.source === 'NOT_AVAILABLE') return '<span style="color:#666">Not Available</span>';
      const urls = c.source.split('|').filter(u => u.trim() && u.trim().startsWith('http'));
      return urls.length > 0 ? urls.map(u => `<a href="${u.trim()}" target="_blank">🔗</a>`).join(' ') : '<span style="color:#666">Not Available</span>';
    })();
    const sdot = `<span class="status-dot s-${c.status}"></span>${c.status}`;
    return `<tr onclick="openDrawer(${c.id})" style="cursor:pointer">
      <td>${c.region}</td>
      <td><strong>${c.country}</strong></td>
      <td>${pillFor(c.b2g)}</td>
      <td>${pillFor(c.b2b)}</td>
      <td>${pillFor(c.b2c)}</td>
      <td>${c.b2g_date || '—'}</td>
      <td>${c.b2b_date || '—'}</td>
      <td>${c.b2c_date || '—'}</td>
      <td>${c.non_local_suppliers || '—'}</td>
      <td>${c.digital_services_suppliers || '—'}</td>
      <td>${c.ap || '—'}</td>
      <td>${c.ar || '—'}</td>
      <td>${c.import_txn || '—'}</td>
      <td>${c.export_txn || '—'}</td>
      <td>${c.intra_eu_sales || '—'}</td>
      <td>${c.intra_eu_purchases || '—'}</td>
      <td>${c.zero_rated || '—'}</td>
      <td>${c.exempt || '—'}</td>
      <td>${c.e_reporting || '—'}</td>
      <td>${c.tax_authority || '—'}</td>
      <td>${c.format || '—'}</td>
      <td>${srcLinks}</td>
      <td>${sdot}</td>
    </tr>`;
  }).join('');
}

// ── Editor ────────────────────────────────────────────────────────────────────

function renderEditorSelect() {
  const sel = document.getElementById('edit-country-sel');
  sel.innerHTML = '<option value="">— Select a country —</option>' +
    allCountries.map(c => `<option value="${c.id}">${c.country} (${c.region})</option>`).join('');
}

const STATUS_OPTS = ['Mandatory','Voluntary','N/A'];
const YN_OPTS     = ['Y','N','N/A'];

function loadEditor() {
  const id   = parseInt(document.getElementById('edit-country-sel').value);
  const wrap = document.getElementById('editor-wrap');
  if (!id) {
    wrap.innerHTML = '<div class="editor-empty">Select a country above to edit its data.</div>';
    return;
  }
  const c = allCountries.find(x => x.id === id);
  if (!c) return;

  const mkSel = (name, val, opts) => `<select name="${name}">
    ${opts.map(o => `<option${o === val ? ' selected' : ''}>${o}</option>`).join('')}
  </select>`;

  wrap.innerHTML = `<form class="editor-form" onsubmit="saveEditor(event,${id})">
    <div class="ef-group"><div class="ef-label">B2G</div>${mkSel('b2g',c.b2g,STATUS_OPTS)}</div>
    <div class="ef-group"><div class="ef-label">B2B</div>${mkSel('b2b',c.b2b,STATUS_OPTS)}</div>
    <div class="ef-group"><div class="ef-label">B2C</div>${mkSel('b2c',c.b2c,STATUS_OPTS)}</div>
    <div class="ef-group"><div class="ef-label">B2G Date</div><input name="b2g_date" value="${c.b2g_date||''}"></div>
    <div class="ef-group"><div class="ef-label">B2G Staggered</div>${mkSel('b2g_staggered',c.b2g_staggered,YN_OPTS)}</div>
    <div class="ef-group"><div class="ef-label">B2B Date</div><input name="b2b_date" value="${c.b2b_date||''}"></div>
    <div class="ef-group"><div class="ef-label">B2B Staggered</div>${mkSel('b2b_staggered',c.b2b_staggered,YN_OPTS)}</div>
    <div class="ef-group"><div class="ef-label">B2C Date</div><input name="b2c_date" value="${c.b2c_date||''}"></div>
    <div class="ef-group"><div class="ef-label">B2C Staggered</div>${mkSel('b2c_staggered',c.b2c_staggered,YN_OPTS)}</div>
    <div class="ef-group"><div class="ef-label">Non-Local Suppliers</div>${mkSel('non_local_suppliers',c.non_local_suppliers,YN_OPTS)}</div>
    <div class="ef-group"><div class="ef-label">Digital Services Suppliers</div>${mkSel('digital_services_suppliers',c.digital_services_suppliers,YN_OPTS)}</div>
    <div class="ef-group"><div class="ef-label">AP Transactions</div>${mkSel('ap',c.ap,YN_OPTS)}</div>
    <div class="ef-group"><div class="ef-label">AR Transactions</div>${mkSel('ar',c.ar,YN_OPTS)}</div>
    <div class="ef-group"><div class="ef-label">Import Transactions</div>${mkSel('import_txn',c.import_txn,YN_OPTS)}</div>
    <div class="ef-group"><div class="ef-label">Export Transactions</div>${mkSel('export_txn',c.export_txn,YN_OPTS)}</div>
    <div class="ef-group"><div class="ef-label">Intra-EU Sales</div>${mkSel('intra_eu_sales',c.intra_eu_sales,YN_OPTS)}</div>
    <div class="ef-group"><div class="ef-label">Intra-EU Purchases</div>${mkSel('intra_eu_purchases',c.intra_eu_purchases,YN_OPTS)}</div>
    <div class="ef-group"><div class="ef-label">Zero-rated</div>${mkSel('zero_rated',c.zero_rated,YN_OPTS)}</div>
    <div class="ef-group"><div class="ef-label">Exempt</div>${mkSel('exempt',c.exempt,YN_OPTS)}</div>
    <div class="ef-group"><div class="ef-label">E-reporting</div>${mkSel('e_reporting',c.e_reporting,YN_OPTS)}</div>
    <div class="ef-group full"><div class="ef-label">Tax Authority</div><input name="tax_authority" value="${c.tax_authority||''}"></div>
    <div class="ef-group full"><div class="ef-label">Invoice Format</div><input name="format" value="${c.format||''}"></div>
    <div class="ef-group full"><div class="ef-label">Source URLs (pipe-separated)</div><textarea name="source">${c.source||''}</textarea></div>
    <div class="editor-actions">
      <button type="submit" class="btn btn-primary">💾 Save Changes</button>
      <span id="save-msg" style="font-size:12px;color:var(--green);display:none">Saved!</span>
    </div>
  </form>`;
}

async function saveEditor(e, id) {
  e.preventDefault();
  const form = e.target;
  const data = { status: 'done' };
  new FormData(form).forEach((v, k) => { data[k] = v; });
  const res = await fetch(`/api/country/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  if ((await res.json()).ok) {
    const c = allCountries.find(x => x.id === id);
    if (c) Object.assign(c, data);
    renderGrid();
    renderTable();
    loadStats();
    const msg = document.getElementById('save-msg');
    msg.style.display = 'inline';
    setTimeout(() => msg.style.display = 'none', 2000);
  }
}

init();
