// Token Launch Radar dashboard, model radar-3: renders window.RADAR with no network.
// Sorting, filters, watchlist-only toggle, value bars, and a detail view for
// every protocol with the model's factor-by-factor working. Deep links:
// #detail=<slug> opens a protocol, #cat=<category> filters by category.

(function () {
  var R = window.RADAR;
  if (!R) return;

  var $ = function (id) { return document.getElementById(id); };
  var rowsEl = $('rows'), detailEl = $('detail'), countEl = $('count');
  var qEl = $('q'), catEl = $('cat'), chainEl = $('chain'), viewEl = $('view'), sortEl = $('sort'), watchEl = $('watchonly');
  var state = { q: '', cat: '', chain: '', view: 'board', sort: 'rank', watchOnly: false, selected: null };
  var topValue = R.rows.length ? R.rows[0].implied_value_usd : 1;

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function money(n) {
    if (n == null) return '—';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + Math.round(n);
  }
  function pct(n) {
    if (n == null) return '—';
    var v = n.toFixed(1) + '%';
    return n >= 0 ? '+' + v : v;
  }
  function pctClass(n) {
    return n == null ? '' : n >= 0 ? 'up' : 'down';
  }

  // Header figures and the summary strip.
  $('meta').innerHTML = '<strong>' + R.board_size + ' rows</strong>' +
    R.watchlist_size + ' on the watchlist · ' + R.early_size + ' early finds · snapshot ' + esc(R.as_of);
  var totalValue = 0, topCat = '', topCatValue = 0, catTotals = {};
  R.rows.forEach(function (r) {
    totalValue += r.implied_value_usd;
    var c = r.category || 'Uncategorised';
    catTotals[c] = (catTotals[c] || 0) + r.implied_value_usd;
    if (catTotals[c] > topCatValue) { topCatValue = catTotals[c]; topCat = c; }
  });
  $('stats').innerHTML =
    '<div><span>Board implied value</span><strong>' + money(totalValue) + '</strong></div>' +
    '<div><span>Top protocol</span><strong>' + esc(R.rows.length ? R.rows[0].name : '—') + '</strong></div>' +
    '<div><span>Top category</span><strong>' + esc(topCat) + '</strong></div>' +
    '<div><span>Watchlist TVL</span><strong>' + money(R.rows.filter(function (r) { return r.on_watchlist; }).reduce(function (a, r) { return a + r.tvl_usd; }, 0)) + '</strong></div>';
  $('model-line').textContent = 'Model ' + R.model_version + ': size is TVL^0.9, priced by the category median market-cap/TVL ratio (clamped 0.01–1.5), then growth ×0.75, category momentum ×0.5, log-scaled maturity 0.70–1.00 over 4 years, and a chain factor up to 1.15. Ratios and momentum are medians of the token protocols in each category, falling back to the global median.';
  $('board-note').textContent = 'Ranks are by implied value, highest first. The bar under each value is its share of rank 1. The Live token view shows the market’s own values, never a model’s.';

  // Fill the filter dropdowns from the data.
  var cats = {}, chains = {};
  R.rows.forEach(function (r) {
    if (r.category) cats[r.category] = true;
    r.chains.forEach(function (c) { chains[c] = true; });
  });
  Object.keys(cats).sort().forEach(function (c) {
    var o = document.createElement('option'); o.value = c; o.textContent = c; catEl.appendChild(o);
  });
  Object.keys(chains).sort().forEach(function (c) {
    var o = document.createElement('option'); o.value = c; o.textContent = c; chainEl.appendChild(o);
  });

  function isWatch(r) { return !!r.on_watchlist; }

  function currentRows() {
    var list = state.view === 'live' ? R.live : R.rows;
    var q = state.q.trim().toLowerCase();
    return list.filter(function (r) {
      if (q && r.name.toLowerCase().indexOf(q) < 0 && r.slug.toLowerCase().indexOf(q) < 0) return false;
      if (state.cat && r.category !== state.cat) return false;
      if (state.chain && r.chains.indexOf(state.chain) < 0) return false;
      if (state.watchOnly && state.view === 'board' && !isWatch(r)) return false;
      return true;
    });
  }

  function sortRows(list) {
    var key = state.sort;
    var copy = list.slice();
    if (key === 'rank') copy.sort(function (a, b) { return (a.rank || 0) - (b.rank || 0); });
    else if (key === 'value') copy.sort(function (a, b) { return (b.implied_value_usd || b.mcap_usd || 0) - (a.implied_value_usd || a.mcap_usd || 0); });
    else if (key === 'tvl') copy.sort(function (a, b) { return b.tvl_usd - a.tvl_usd; });
    else if (key === 'growth') copy.sort(function (a, b) { return (b.change_7d == null ? -1e9 : b.change_7d) - (a.change_7d == null ? -1e9 : a.change_7d); });
    return copy;
  }

  function render() {
    var list = sortRows(currentRows());
    var html = '';
    list.forEach(function (r) {
      var value = state.view === 'live' ? r.mcap_usd : r.implied_value_usd;
      var bar = state.view === 'live' ? '' : '<div class="valbar"><i style="width:' + Math.max(2, Math.round(value / topValue * 100)) + '%"></i></div>';
      html += '<tr data-slug="' + esc(r.slug) + '"' + (state.selected === r.slug ? ' class="selected"' : '') + '>' +
        '<td class="rank num">' + (state.view === 'live' ? '—' : r.rank) + '</td>' +
        '<td><strong>' + esc(r.name) + '</strong>' + (isWatch(r) ? '<span class="badge">WATCHLIST</span>' : '') + '<br><span class="fine">' + esc(r.slug) + '</span></td>' +
        '<td>' + esc(r.category || '—') + '</td>' +
        '<td>' + esc(r.chains.slice(0, 3).join(', ')) + (r.chains.length > 3 ? ' +' + (r.chains.length - 3) : '') + '</td>' +
        '<td class="num">' + money(r.tvl_usd) + '</td>' +
        '<td class="num ' + pctClass(r.change_7d) + '">' + pct(r.change_7d) + '</td>' +
        '<td class="num valcell"><strong>' + money(value) + '</strong>' + bar + '</td></tr>';
    });
    rowsEl.innerHTML = html || '<tr><td colspan="7">No protocols match these filters.</td></tr>';
    countEl.textContent = list.length + ' of ' + (state.view === 'live' ? R.live_size : R.board_size) + ' shown';
  }

  function showDetail(slug) {
    var r = null;
    for (var i = 0; i < R.rows.length; i++) if (R.rows[i].slug === slug) r = R.rows[i];
    if (!r) { detailEl.classList.add('hidden'); state.selected = null; render(); return; }
    state.selected = slug;
    var m = r.model;
    var steps = r.farm_steps.map(function (s, i) {
      var cost = s.match(/Cost: (.*?)\. Time: (.*?)\.?$/);
      var body = cost ? s.slice(0, cost.index).trim() : s;
      var foot = cost ? '<br><span class="fine">Cost: ' + esc(cost[1]) + ' · Time: ' + esc(cost[2]) + '</span>' : '';
      return '<li><b>Step ' + (i + 1) + '.</b> ' + esc(body) + foot + '</li>';
    }).join('');
    detailEl.innerHTML = '<button class="close" id="close-detail">Close</button>' +
      '<h2>' + esc(r.name) + (isWatch(r) ? '<span class="badge">WATCHLIST</span>' : '') + '</h2>' +
      '<p class="fine">' + esc(r.slug) + ' · ' + esc(r.category || 'Uncategorised') + ' · ' + esc(r.chains.join(', ')) + '</p>' +
      '<div class="facts">' +
      '<div>Implied value<strong>' + money(r.implied_value_usd) + '</strong></div>' +
      '<div>TVL<strong>' + money(r.tvl_usd) + '</strong></div>' +
      '<div>7-day change<strong class="' + pctClass(r.change_7d) + '">' + pct(r.change_7d) + '</strong></div>' +
      '<div>Listed<strong>' + esc(r.listed_at || 'not recorded') + '</strong></div>' +
      '<div>Age<strong>' + (r.age_days == null ? 'not recorded' : r.age_days + ' days') + '</strong></div>' +
      '<div>Chains<strong>' + r.chains.length + '</strong></div>' +
      '</div>' +
      '<h3>How the value is worked out</h3>' +
      '<table class="model"><tbody>' +
      '<tr><td>Size value (TVL with diminishing returns, TVL^0.9)</td><td>' + money(m.size_value_usd) + '</td></tr>' +
      '<tr><td>Category ratio (median market-cap/TVL of its category’s token protocols)</td><td>× ' + m.category_ratio + '</td></tr>' +
      '<tr><td>Growth (7-day change ' + m.growth_pct + '%)</td><td>× ' + m.growth_multiplier + '</td></tr>' +
      '<tr><td>Category momentum (median 7-day change of its category’s token protocols, ' + m.momentum_pct + '%)</td><td>× ' + m.momentum_multiplier + '</td></tr>' +
      '<tr><td>Maturity (' + m.age_years + ' years with no token, log-scaled)</td><td>× ' + m.maturity_multiplier + '</td></tr>' +
      '<tr><td>Chain factor (' + r.chains.length + ' chain' + (r.chains.length === 1 ? '' : 's') + ')</td><td>× ' + m.chain_factor + '</td></tr>' +
      '<tr><td><strong>Implied value</strong></td><td><strong>' + money(r.implied_value_usd) + '</strong></td></tr>' +
      '</tbody></table>' +
      '<p class="fine">This protocol records no token in the snapshot. The implied value is this entry’s own claim, not a prediction that a token will be issued.</p>' +
      '<h3>How to farm it</h3><ol>' + steps + '</ol>';
    detailEl.classList.remove('hidden');
    $('close-detail').addEventListener('click', function () {
      state.selected = null; detailEl.classList.add('hidden'); render();
      history.replaceState(null, '', location.pathname);
    });
    render();
    detailEl.scrollIntoView({ block: 'nearest' });
  }

  rowsEl.addEventListener('click', function (e) {
    var tr = e.target.closest('tr[data-slug]');
    if (!tr) return;
    if (state.view === 'live') return;
    location.hash = 'detail=' + tr.getAttribute('data-slug');
    showDetail(tr.getAttribute('data-slug'));
  });

  document.querySelectorAll('#board thead th[data-sort]').forEach(function (th) {
    th.addEventListener('click', function () {
      sortEl.value = th.getAttribute('data-sort');
      state.sort = sortEl.value;
      render();
    });
  });

  qEl.addEventListener('input', function () { state.q = qEl.value; render(); });
  catEl.addEventListener('change', function () { state.cat = catEl.value; render(); });
  chainEl.addEventListener('change', function () { state.chain = chainEl.value; render(); });
  watchEl.addEventListener('change', function () { state.watchOnly = watchEl.checked; render(); });
  viewEl.addEventListener('change', function () {
    state.view = viewEl.value;
    state.selected = null; detailEl.classList.add('hidden');
    render();
  });
  sortEl.addEventListener('change', function () { state.sort = sortEl.value; render(); });

  window.addEventListener('hashchange', function () {
    var m = location.hash.match(/detail=([^&]+)/);
    if (m) showDetail(decodeURIComponent(m[1]));
  });

  // Deep links on first load.
  var m = location.hash.match(/detail=([^&]+)/);
  var c = location.hash.match(/cat=([^&]+)/);
  if (c) { state.cat = decodeURIComponent(c[1]); catEl.value = state.cat; }
  if (m) showDetail(decodeURIComponent(m[1])); else render();
})();
