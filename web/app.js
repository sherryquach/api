// ===== GSC — SEO Command Deck =====

const state = {
  rows: [],
  loading: true,
  error: null,
  sessionExpired: false,
  search: '',
  sortField: 'clicks',
  sortDir: 'desc',
  activeMetrics: new Set(['clicks', 'impressions']),
  embedUrl: null,
  embedExpiresAt: null,
  embedError: null,
  embedLoading: true,
};

const root = document.getElementById('app');

function fmtNum(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('en-US').format(Math.round(n));
}

function fmtPct(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return (n * 100).toFixed(1) + '%';
}

function fmtPos(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return n.toFixed(1);
}

function esc(str) {
  const div = document.createElement('div');
  div.textContent = String(str ?? '');
  return div.innerHTML;
}

async function fetchJSON(url, options) {
  const res = await fetch(url, options);
  if (res.status === 401) {
    state.sessionExpired = true;
    render();
    throw new Error('session-expired');
  }
  if (!res.ok) {
    let msg = 'Request failed (' + res.status + ')';
    try {
      const body = await res.json();
      if (body && body.error) msg = body.error;
    } catch (e) {}
    throw new Error(msg);
  }
  return res.json();
}

async function loadData() {
  state.loading = true;
  state.error = null;
  render();
  try {
    const data = await fetchJSON('api/keywords');
    state.rows = data.rows || [];
    state.loading = false;
    render();
  } catch (err) {
    if (err.message === 'session-expired') return;
    state.loading = false;
    state.error = err.message || 'Could not load Search Console data.';
    render();
  }
}

async function loadEmbed() {
  state.embedLoading = true;
  state.embedError = null;
  render();
  try {
    const data = await fetchJSON('api/dashboard');
    state.embedUrl = data.url;
    state.embedExpiresAt = data.expiresAt;
    state.embedLoading = false;
    render();
  } catch (err) {
    if (err.message === 'session-expired') return;
    state.embedLoading = false;
    state.embedError = err.message || 'Dashboard is unavailable right now.';
    render();
  }
}

// ---------- Derived analytics ----------

function groupByQuery(rows) {
  const map = new Map();
  for (const r of rows) {
    const key = r.query || '(unknown query)';
    if (!map.has(key)) {
      map.set(key, { query: key, page: r.page || '', clicks: 0, impressions: 0, positions: [], ctrs: [], byDate: new Map() });
    }
    const g = map.get(key);
    g.clicks += Number(r.clicks) || 0;
    g.impressions += Number(r.impressions) || 0;
    if (r.position !== null && r.position !== undefined && !Number.isNaN(Number(r.position))) g.positions.push(Number(r.position));
    if (r.ctr !== null && r.ctr !== undefined && !Number.isNaN(Number(r.ctr))) g.ctrs.push(Number(r.ctr));
    if (!g.page && r.page) g.page = r.page;
    const d = r.date || r._stream_time;
    if (d) {
      const dateKey = String(d).slice(0, 10);
      if (!g.byDate.has(dateKey)) g.byDate.set(dateKey, { clicks: 0, impressions: 0, positions: [] });
      const dd = g.byDate.get(dateKey);
      dd.clicks += Number(r.clicks) || 0;
      dd.impressions += Number(r.impressions) || 0;
      if (r.position !== null && r.position !== undefined && !Number.isNaN(Number(r.position))) dd.positions.push(Number(r.position));
    }
  }
  const out = [];
  for (const g of map.values()) {
    const avgPos = g.positions.length ? g.positions.reduce((a, b) => a + b, 0) / g.positions.length : null;
    const avgCtr = g.ctrs.length ? g.ctrs.reduce((a, b) => a + b, 0) / g.ctrs.length : (g.impressions ? g.clicks / g.impressions : null);
    const dateEntries = Array.from(g.byDate.entries()).sort((a, b) => a[0] < b[0] ? -1 : 1);
    let trend = 'flat';
    let trendDelta = 0;
    if (dateEntries.length >= 2) {
      const mid = Math.floor(dateEntries.length / 2);
      const firstHalf = dateEntries.slice(0, mid).flatMap(([, v]) => v.positions);
      const secondHalf = dateEntries.slice(mid).flatMap(([, v]) => v.positions);
      if (firstHalf.length && secondHalf.length) {
        const a = firstHalf.reduce((s, v) => s + v, 0) / firstHalf.length;
        const b = secondHalf.reduce((s, v) => s + v, 0) / secondHalf.length;
        trendDelta = a - b;
        trend = trendDelta > 0.3 ? 'up' : trendDelta < -0.3 ? 'down' : 'flat';
      }
    }
    out.push({
      query: g.query,
      page: g.page,
      clicks: g.clicks,
      impressions: g.impressions,
      position: avgPos,
      ctr: avgCtr,
      trend,
      trendDelta,
      dateEntries,
    });
  }
  return out;
}

function scorePriority(kw) {
  let score = 0;
  if (kw.position !== null) {
    if (kw.position >= 8 && kw.position <= 20) score += 40;
    else if (kw.position > 20 && kw.position <= 35) score += 25;
    else if (kw.position < 8) score += 10;
  }
  score += Math.min(30, Math.log10((kw.impressions || 0) + 1) * 10);
  if (kw.ctr !== null && kw.impressions > 50) {
    const expectedCtr = kw.position && kw.position <= 10 ? 0.08 : 0.03;
    if (kw.ctr < expectedCtr) score += 15;
  }
  if (kw.trend === 'down') score += 10;
  return score;
}

function priorityReason(kw) {
  const parts = [];
  if (kw.position !== null && kw.position >= 8 && kw.position <= 20) {
    parts.push('sits just outside page one — small gains in relevance could push it into top results');
  } else if (kw.position !== null && kw.position > 20) {
    parts.push('ranks well back; needs stronger on-page targeting or backlinks to compete');
  } else if (kw.position !== null && kw.position < 8) {
    parts.push('already ranks well — protect this position with fresh, relevant content');
  }
  if (kw.impressions > 500) parts.push('high search demand');
  if (kw.ctr !== null && kw.impressions > 50 && kw.position && kw.position <= 10 && kw.ctr < 0.08) {
    parts.push('click-through is below what its ranking should earn — the title or snippet may need work');
  }
  if (kw.trend === 'down') parts.push('trending down over the recent period');
  if (!parts.length) parts.push('steady performer worth monitoring');
  return parts.join('; ') + '.';
}

function buildAdvice(keywords) {
  const advice = [];
  const declining = keywords.filter(k => k.trend === 'down');
  const lowCtrHighPos = keywords.filter(k => k.position !== null && k.position <= 10 && k.ctr !== null && k.impressions > 50 && k.ctr < 0.06);
  const nearPageOne = keywords.filter(k => k.position !== null && k.position > 10 && k.position <= 20);

  advice.push({
    tone: 'moss',
    title: 'Refresh what is slipping',
    body: declining.length
      ? `${declining.length} keyword${declining.length === 1 ? '' : 's'} lost ground recently, including "${declining[0].query}". Update the target page with current information, add internal links from newer posts, and confirm the content still matches what searchers expect.`
      : 'No keywords are trending down right now — nothing urgent to defend. Keep publishing on a steady cadence to maintain momentum.',
  });

  advice.push({
    tone: 'signal',
    title: 'Rewrite thin title tags & meta',
    body: lowCtrHighPos.length
      ? `${lowCtrHighPos.length} page${lowCtrHighPos.length === 1 ? '' : 's'} rank on page one but earn fewer clicks than expected, such as "${lowCtrHighPos[0].query}". Sharpen the title with a clear benefit and add a compelling meta description to lift click-through without changing rank.`
      : 'Click-through rates look healthy relative to ranking position across your top pages.',
  });

  advice.push({
    tone: 'gold',
    title: 'Push page-two keywords forward',
    body: nearPageOne.length
      ? `${nearPageOne.length} keyword${nearPageOne.length === 1 ? '' : 's'} rank between 11–20, close enough to page one to move with focused effort — start with "${nearPageOne[0].query}". Add depth to the page, earn a few relevant backlinks, and interlink from related product or blog pages.`
      : 'No keywords currently sit just outside page one — check back as rankings shift.',
  });

  return advice;
}

// ---------- Chart rendering ----------

const METRIC_COLORS = {
  clicks: '#1f5c4d',
  impressions: '#d9622b',
  position: '#b8912f',
};

const METRIC_LABELS = {
  clicks: 'Clicks',
  impressions: 'Impressions',
  position: 'Avg. position',
};

function buildDailySeries(rows) {
  const byDate = new Map();
  for (const r of rows) {
    const d = r.date || r._stream_time;
    if (!d) continue;
    const key = String(d).slice(0, 10);
    if (!byDate.has(key)) byDate.set(key, { date: key, clicks: 0, impressions: 0, positions: [] });
    const entry = byDate.get(key);
    entry.clicks += Number(r.clicks) || 0;
    entry.impressions += Number(r.impressions) || 0;
    if (r.position !== null && r.position !== undefined && !Number.isNaN(Number(r.position))) entry.positions.push(Number(r.position));
  }
  const list = Array.from(byDate.values()).sort((a, b) => a.date < b.date ? -1 : 1);
  return list.map(e => ({
    date: e.date,
    clicks: e.clicks,
    impressions: e.impressions,
    position: e.positions.length ? e.positions.reduce((a, b) => a + b, 0) / e.positions.length : null,
  }));
}

function renderChartSvg(series, activeMetrics) {
  if (!series.length) {
    return '<div class="chart-empty">Not enough dated activity yet to plot a trend.</div>';
  }
  const width = 900;
  const height = 260;
  const padL = 40, padR = 16, padT = 16, padB = 30;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const metrics = Array.from(activeMetrics);
  let svgParts = [];

  const n = series.length;
  const xFor = i => padL + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);

  for (let i = 0; i <= 4; i++) {
    const y = padT + (plotH / 4) * i;
    svgParts.push(`<line x1="${padL}" y1="${y.toFixed(1)}" x2="${width - padR}" y2="${y.toFixed(1)}" stroke="#d8d1bf" stroke-width="1" />`);
  }

  metrics.forEach(metric => {
    const values = series.map(s => s[metric]).filter(v => v !== null && v !== undefined);
    if (!values.length) return;
    let min = Math.min(...values);
    let max = Math.max(...values);
    if (metric === 'position') { const t = min; min = max; max = t; }
    if (min === max) { min -= 1; max += 1; }

    const yFor = v => {
      if (v === null || v === undefined) return null;
      const norm = (v - min) / (max - min);
      return padT + plotH - norm * plotH;
    };

    const pts = series.map((s, i) => {
      const y = yFor(s[metric]);
      return y === null ? null : `${xFor(i).toFixed(1)},${y.toFixed(1)}`;
    }).filter(Boolean);

    const color = METRIC_COLORS[metric];
    svgParts.push(`<polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" />`);

    series.forEach((s, i) => {
      const y = yFor(s[metric]);
      if (y === null) return;
      svgParts.push(`<circle cx="${xFor(i).toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="${color}"><title>${esc(METRIC_LABELS[metric])} ${esc(s.date)}: ${metric === 'position' ? fmtPos(s[metric]) : fmtNum(s[metric])}</title></circle>`);
    });
  });

  const labelEvery = Math.max(1, Math.ceil(n / 6));
  series.forEach((s, i) => {
    if (i % labelEvery !== 0 && i !== n - 1) return;
    svgParts.push(`<text x="${xFor(i).toFixed(1)}" y="${height - 8}" font-size="10" fill="#4b5450" text-anchor="middle" font-family="Courier New, monospace">${esc(s.date.slice(5))}</text>`);
  });

  return `<div class="chart-wrap"><svg class="chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Trend chart of ${metrics.map(m => METRIC_LABELS[m]).join(' and ')} over time">${svgParts.join('')}</svg></div>`;
}

// ---------- Rendering ----------

function iconSvg(name) {
  const icons = {
    external: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M7 4H4a1 1 0 00-1 1v11a1 1 0 001 1h11a1 1 0 001-1v-3M12 3h5v5M8.5 11.5L17 3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    search: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="9" cy="9" r="6"/><path d="M17 17l-4-4" stroke-linecap="round"/></svg>',
    shop: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 8l1-4h10l1 4M4 8v8a1 1 0 001 1h10a1 1 0 001-1V8M4 8h12M8 12v2a2 2 0 004 0v-2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    up: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 13l5-5 3 3 6-7" stroke-linecap="round" stroke-linejoin="round"/><path d="M13 4h5v5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    down: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7l5 5 3-3 6 7" stroke-linecap="round" stroke-linejoin="round"/><path d="M13 16h5v-5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    flat: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 10h12" stroke-linecap="round"/></svg>',
    compass: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="10" cy="10" r="7.5"/><path d="M12.5 7.5l-1.5 4-4 1.5 1.5-4z"/></svg>',
    edit: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M13.5 3.5l3 3L7 16H4v-3z" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    link: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8 12l4-4M7 14L5 12a3 3 0 010-4l2-2a3 3 0 014 0M13 6l2 2a3 3 0 010 4l-2 2a3 3 0 01-4 0" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    alert: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M10 3l8 14H2z" stroke-linejoin="round"/><path d="M10 8v4M10 14.5v.1" stroke-linecap="round"/></svg>',
    empty: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="3" width="14" height="14" rx="2"/><path d="M7 13l3-3 3 3M10 6v6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };
  return icons[name] || '';
}

function markSvg() {
  return `<svg class="mark" viewBox="0 0 52 52" fill="none" aria-hidden="true">
    <rect x="1" y="1" width="50" height="50" rx="4" fill="#123c32"/>
    <path d="M9 36 L18 22 L25 30 L33 15 L43 18" stroke="#d9622b" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="43" cy="18" r="3" fill="#d9622b"/>
  </svg>`;
}

function positionTier(pos) {
  if (pos === null || pos === undefined) return 'tier-low';
  if (pos <= 10) return 'tier-top';
  if (pos <= 20) return 'tier-mid';
  return 'tier-low';
}

function priorityTier(score) {
  if (score >= 55) return 'high';
  if (score >= 30) return 'medium';
  return 'low';
}

function renderStatStrip(keywords, series) {
  const totalClicks = keywords.reduce((s, k) => s + k.clicks, 0);
  const totalImpr = keywords.reduce((s, k) => s + k.impressions, 0);
  const avgPos = (() => {
    const vals = keywords.filter(k => k.position !== null).map(k => k.position);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  })();
  const avgCtr = totalImpr ? totalClicks / totalImpr : null;

  let posDelta = null;
  if (series.length >= 4) {
    const mid = Math.floor(series.length / 2);
    const first = series.slice(0, mid).map(s => s.position).filter(v => v !== null);
    const second = series.slice(mid).map(s => s.position).filter(v => v !== null);
    if (first.length && second.length) {
      const a = first.reduce((x, y) => x + y, 0) / first.length;
      const b = second.reduce((x, y) => x + y, 0) / second.length;
      posDelta = a - b;
    }
  }

  const deltaHtml = posDelta === null ? '' : `<span class="stat-delta ${posDelta > 0.2 ? 'up' : posDelta < -0.2 ? 'down' : 'flat'}">${iconSvg(posDelta > 0.2 ? 'up' : posDelta < -0.2 ? 'down' : 'flat')} ${Math.abs(posDelta).toFixed(1)} pos ${posDelta > 0.2 ? 'better' : posDelta < -0.2 ? 'worse' : 'change'}</span>`;

  return `
    <div class="stat-card">
      <span class="stat-label">Total clicks</span>
      <span class="stat-value">${fmtNum(totalClicks)}</span>
    </div>
    <div class="stat-card">
      <span class="stat-label">Total impressions</span>
      <span class="stat-value">${fmtNum(totalImpr)}</span>
    </div>
    <div class="stat-card">
      <span class="stat-label">Average position</span>
      <span class="stat-value">${fmtPos(avgPos)}</span>
      ${deltaHtml}
    </div>
    <div class="stat-card">
      <span class="stat-label">Average CTR</span>
      <span class="stat-value">${fmtPct(avgCtr)}</span>
    </div>
  `;
}

function renderKeywordTable(keywords) {
  let filtered = keywords;
  if (state.search.trim()) {
    const q = state.search.trim().toLowerCase();
    filtered = filtered.filter(k => k.query.toLowerCase().includes(q) || (k.page || '').toLowerCase().includes(q));
  }
  filtered = filtered.slice().sort((a, b) => {
    const dir = state.sortDir === 'asc' ? 1 : -1;
    const av = a[state.sortField];
    const bv = b[state.sortField];
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return 0;
  });

  const withPriority = filtered.map(k => ({ ...k, priorityScore: scorePriority(k) }));

  const rowsHtml = withPriority.slice(0, 60).map(k => {
    const trendIcon = k.trend === 'up' ? iconSvg('up') : k.trend === 'down' ? iconSvg('down') : iconSvg('flat');
    const trendText = k.trend === 'up' ? 'Improving' : k.trend === 'down' ? 'Declining' : 'Steady';
    const tier = priorityTier(k.priorityScore);
    const tierLabel = tier === 'high' ? 'High' : tier === 'medium' ? 'Medium' : 'Low';
    return `<tr>
      <td class="kw-query">${esc(k.query)}</td>
      <td class="kw-page" title="${esc(k.page)}">${esc(k.page || '—')}</td>
      <td><span class="pos-pill ${positionTier(k.position)}">${fmtPos(k.position)}</span></td>
      <td>${fmtNum(k.clicks)}</td>
      <td>${fmtNum(k.impressions)}</td>
      <td>${fmtPct(k.ctr)}</td>
      <td><span class="trend-cell ${k.trend}">${trendIcon} ${trendText}</span></td>
      <td><span class="priority-badge ${tier}">${tierLabel}</span></td>
    </tr>`;
  }).join('');

  const sortArrow = field => state.sortField === field ? (state.sortDir === 'asc' ? '▲' : '▼') : '';

  return `
    <div class="table-toolbar">
      <div class="search-field">
        ${iconSvg('search')}
        <input type="search" id="kw-search" placeholder="Search keywords or pages…" value="${esc(state.search)}" aria-label="Search keywords or pages" />
      </div>
      <select class="sort-select" id="kw-sort" aria-label="Sort keywords by">
        <option value="clicks" ${state.sortField === 'clicks' ? 'selected' : ''}>Sort: Clicks</option>
        <option value="impressions" ${state.sortField === 'impressions' ? 'selected' : ''}>Sort: Impressions</option>
        <option value="position" ${state.sortField === 'position' ? 'selected' : ''}>Sort: Position</option>
        <option value="ctr" ${state.sortField === 'ctr' ? 'selected' : ''}>Sort: CTR</option>
      </select>
    </div>
    <div class="kw-table-scroll">
      <table class="kw-table">
        <thead>
          <tr>
            <th>Query</th>
            <th>Landing page</th>
            <th><button type="button" data-sort="position">Position ${sortArrow('position')}</button></th>
            <th><button type="button" data-sort="clicks">Clicks ${sortArrow('clicks')}</button></th>
            <th><button type="button" data-sort="impressions">Impressions ${sortArrow('impressions')}</button></th>
            <th><button type="button" data-sort="ctr">CTR ${sortArrow('ctr')}</button></th>
            <th>Trend</th>
            <th>Priority</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml || `<tr><td colspan="8" style="text-align:center; padding:32px; color:var(--muted);">No keywords match "${esc(state.search)}".</td></tr>`}
        </tbody>
      </table>
    </div>
    <p class="table-footnote">Showing ${Math.min(60, filtered.length)} of ${filtered.length} keyword${filtered.length === 1 ? '' : 's'}. Priority reflects ranking opportunity, search demand, and CTR gap.</p>
  `;
}

function renderPriorityQueue(keywords) {
  const scored = keywords.map(k => ({ ...k, priorityScore: scorePriority(k) }))
    .sort((a, b) => b.priorityScore - a.priorityScore)
    .slice(0, 6);

  if (!scored.length) {
    return `<div class="state-block">${iconSvg('empty')}<p>No keywords to prioritize yet.</p></div>`;
  }

  return `<ol class="priority-list">
    ${scored.map((k, i) => `
      <li class="priority-item">
        <span class="priority-rank">${String(i + 1).padStart(2, '0')}</span>
        <div class="priority-body">
          <p class="priority-query">${esc(k.query)}</p>
          <p class="priority-reason">${esc(priorityReason(k))}</p>
          <div class="priority-stats">
            <span>Pos <strong>${fmtPos(k.position)}</strong></span>
            <span>Clicks <strong>${fmtNum(k.clicks)}</strong></span>
            <span>Impr. <strong>${fmtNum(k.impressions)}</strong></span>
          </div>
        </div>
      </li>
    `).join('')}
  </ol>`;
}

function renderAdvice(keywords) {
  const advice = buildAdvice(keywords);
  return advice.map(a => `
    <div class="advice-card ${a.tone}">
      <span class="advice-icon">${iconSvg(a.tone === 'signal' ? 'edit' : a.tone === 'gold' ? 'compass' : 'link')}</span>
      <h3 class="advice-title">${esc(a.title)}</h3>
      <p class="advice-body">${esc(a.body)}</p>
    </div>
  `).join('');
}

function renderEmbed() {
  if (state.embedLoading) {
    return `<div class="embed-frame-wrap"><div class="embed-state"><div class="skel" style="width:32px;height:32px;border-radius:50%;"></div><span>Loading your Search Console dashboard…</span></div></div>`;
  }
  if (state.embedError) {
    return `<div class="embed-frame-wrap"><div class="embed-state">${iconSvg('alert')}<span>${esc(state.embedError)}</span></div></div>`;
  }
  if (!state.embedUrl) {
    return `<div class="embed-frame-wrap"><div class="embed-state">${iconSvg('empty')}<span>Dashboard is not configured yet.</span></div></div>`;
  }
  return `<div class="embed-frame-wrap"><iframe src="${esc(state.embedUrl)}" title="GSC performance dashboard" loading="lazy"></iframe></div>`;
}

function render() {
  if (state.sessionExpired) {
    root.innerHTML = `
      <div class="app-shell">
        <div class="masthead">
          <div class="masthead-id">${markSvg()}<div><h1 class="masthead-title">Rank<em>watch</em></h1><p class="masthead-sub">Search Console Intelligence</p></div></div>
        </div>
        <div class="session-banner">
          ${iconSvg('alert')}
          <span>Something interrupted this view. Reload the page to reconnect.</span>
        </div>
      </div>`;
    return;
  }

  const keywords = groupByQuery(state.rows);
  const series = buildDailySeries(state.rows);

  root.innerHTML = `
    <div class="app-shell">
      <header class="masthead">
        <div class="masthead-id">
          ${markSvg()}
          <div>
            <h1 class="masthead-title">Rank<em>watch</em></h1>
            <p class="masthead-sub">Search Console Intelligence</p>
          </div>
        </div>
        <div class="masthead-meta">
          <span class="viewer-chip"><span class="viewer-dot"></span>Live GSC feed</span>
          <span class="masthead-date" id="today-date"></span>
        </div>
      </header>

      <nav class="console-bar" aria-label="External consoles">
        <a class="console-link" href="https://search.google.com/search-console" target="_blank" rel="noopener noreferrer">
          ${iconSvg('search')} Open Google Search Console ${iconSvg('external')}<span class="cl-arrow"></span>
        </a>
        <a class="console-link shopify" href="https://admin.shopify.com" target="_blank" rel="noopener noreferrer">
          ${iconSvg('shop')} Open Shopify Admin ${iconSvg('external')}<span class="cl-arrow"></span>
        </a>
      </nav>

      ${state.error ? `
        <div class="session-banner">
          ${iconSvg('alert')}
          <span>${esc(state.error)}</span>
        </div>
      ` : ''}

      <section class="section" aria-label="Key metrics">
        <div class="stat-strip">
          ${state.loading ? Array.from({length:4}).map(()=>'<div class="stat-card"><div class="skel skel-stat"></div></div>').join('') : renderStatStrip(keywords, series)}
        </div>
      </section>

      <section class="section" aria-labelledby="trend-heading">
        <div class="section-head">
          <div>
            <span class="section-eyebrow">Over time</span>
            <h2 class="section-title" id="trend-heading">Ranking trends</h2>
          </div>
          <p class="section-note">Daily performance across every tracked query, so you can spot momentum shifts early.</p>
        </div>
        <div class="trend-panel">
          <div class="trend-controls" role="group" aria-label="Chart metrics">
            <button type="button" class="metric-toggle" data-metric="clicks" aria-pressed="${state.activeMetrics.has('clicks')}"><span class="swatch" style="background:${METRIC_COLORS.clicks}"></span>Clicks</button>
            <button type="button" class="metric-toggle" data-metric="impressions" aria-pressed="${state.activeMetrics.has('impressions')}"><span class="swatch" style="background:${METRIC_COLORS.impressions}"></span>Impressions</button>
            <button type="button" class="metric-toggle" data-metric="position" aria-pressed="${state.activeMetrics.has('position')}"><span class="swatch" style="background:${METRIC_COLORS.position}"></span>Avg. position</button>
          </div>
          ${state.loading ? '<div class="skel skel-chart"></div>' : renderChartSvg(series, state.activeMetrics)}
        </div>
      </section>

      <section class="section" aria-labelledby="kw-heading">
        <div class="section-head">
          <div>
            <span class="section-eyebrow">Every query</span>
            <h2 class="section-title" id="kw-heading">Top keywords</h2>
          </div>
          <p class="section-note">Search, sort, and scan performance and priority for each ranking query.</p>
        </div>
        <div class="split-grid">
          <div class="table-panel">
            ${state.loading ? `<div style="padding:18px;">${Array.from({length:6}).map(()=>'<div class="skel skel-row"></div>').join('')}</div>` : (state.error ? `<div class="state-block">${iconSvg('alert')}<p class="state-title">Couldn't load keywords</p><p>${esc(state.error)}</p><button type="button" class="retry-btn" id="retry-btn">Try again</button></div>` : (keywords.length ? renderKeywordTable(keywords) : `<div class="state-block">${iconSvg('empty')}<p class="state-title">No keyword data yet</p><p>Once Search Console data syncs, your queries will appear here.</p></div>`))}
          </div>
          <div class="priority-panel">
            <div class="section-head" style="padding:16px 20px 12px; margin-bottom:0; border-bottom:1px solid var(--line);">
              <div>
                <span class="section-eyebrow">Act next</span>
                <h2 class="section-title" style="font-size:17px;">Priority queue</h2>
              </div>
            </div>
            ${state.loading ? `<div style="padding:16px 20px;">${Array.from({length:4}).map(()=>'<div class="skel skel-row"></div>').join('')}</div>` : (keywords.length ? renderPriorityQueue(keywords) : `<div class="state-block">${iconSvg('empty')}<p>Nothing to prioritize yet.</p></div>`)}
          </div>
        </div>
      </section>

      <section class="section" aria-labelledby="advice-heading">
        <div class="section-head">
          <div>
            <span class="section-eyebrow">Playbook</span>
            <h2 class="section-title" id="advice-heading">Advice for ranking dynamically</h2>
          </div>
          <p class="section-note">Generated from your current data, refreshed each time your rankings shift.</p>
        </div>
        <div class="advice-grid">
          ${state.loading ? Array.from({length:3}).map(()=>'<div class="advice-card"><div class="skel" style="height:120px;"></div></div>').join('') : (keywords.length ? renderAdvice(keywords) : `<div class="state-block">${iconSvg('empty')}<p>Advice will appear once keyword data is available.</p></div>`)}
        </div>
      </section>

      <section class="section" aria-labelledby="embed-heading">
        <div class="section-head">
          <div>
            <span class="section-eyebrow">Full detail</span>
            <h2 class="section-title" id="embed-heading">Search Console dashboard</h2>
          </div>
          <p class="section-note">The complete GSC dashboard, embedded for deeper analysis.</p>
        </div>
        <div class="embed-panel">
          ${renderEmbed()}
        </div>
      </section>

      <footer class="app-footer">
        <span>Rankwatch — built on your live Search Console feed.</span>
        <span>Data refreshes automatically as new crawls arrive.</span>
      </footer>
    </div>
  `;

  const dateEl = document.getElementById('today-date');
  if (dateEl) {
    dateEl.textContent = new Date().toLocaleDateString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
  }

  attachHandlers();
}

function attachHandlers() {
  const searchInput = document.getElementById('kw-search');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      state.search = e.target.value;
      render();
      const el = document.getElementById('kw-search');
      if (el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    });
  }

  const sortSelect = document.getElementById('kw-sort');
  if (sortSelect) {
    sortSelect.addEventListener('change', (e) => {
      state.sortField = e.target.value;
      render();
    });
  }

  document.querySelectorAll('[data-sort]').forEach(btn => {
    btn.addEventListener('click', () => {
      const field = btn.getAttribute('data-sort');
      if (state.sortField === field) {
        state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sortField = field;
        state.sortDir = 'desc';
      }
      render();
    });
  });

  document.querySelectorAll('.metric-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const metric = btn.getAttribute('data-metric');
      if (state.activeMetrics.has(metric)) {
        if (state.activeMetrics.size > 1) state.activeMetrics.delete(metric);
      } else {
        state.activeMetrics.add(metric);
      }
      render();
    });
  });

  const retryBtn = document.getElementById('retry-btn');
  if (retryBtn) {
    retryBtn.addEventListener('click', () => loadData());
  }
}

loadData();
loadEmbed();
