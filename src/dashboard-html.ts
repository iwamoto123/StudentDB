/**
 * ダッシュボードの画面（単一HTML・依存ライブラリなし）
 * デザインはCLAUDE.mdのルールに従う: #458BC3 / #DF8D33、角丸なし、ピル型バッジ不可
 *
 * 対応済みチェックは保存ボタンなしの自動保存。チェックした瞬間にAPIへ送り、
 * 画面下部に「保存しました」を表示する。失敗時はチェックを元に戻して知らせる。
 */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>学習進捗ダッシュボード</title>
<style>
  :root { --primary: #458BC3; --primary-dark: #2e6a9e; --accent: #DF8D33; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Noto Sans JP', sans-serif; color: #1f2937; background: #fff; }
  header { background: var(--primary-dark); border-bottom: 4px solid var(--accent); color: #fff; padding: 14px 20px; display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 4px; }
  header h1 { font-size: 18px; margin: 0; }
  header .user { font-size: 13px; opacity: .9; }
  main { max-width: 1080px; margin: 0 auto; padding: 16px 20px 60px; }
  nav.tabs { display: flex; gap: 0; border-bottom: 2px solid #e5e7eb; margin-bottom: 16px; }
  nav.tabs button { border: none; background: none; padding: 10px 18px; font-size: 14px; cursor: pointer; color: #6b7280; border-bottom: 3px solid transparent; margin-bottom: -2px; }
  nav.tabs button.active { color: var(--primary-dark); border-bottom-color: var(--primary); font-weight: 600; }
  nav.tabs .badge { display: inline-block; margin-left: 6px; padding: 0 6px; font-size: 11px; border: 1px solid #fca5a5; color: #b91c1c; background: #fef2f2; }
  h2 { font-size: 16px; border-left: 4px solid var(--primary); padding-left: 10px; margin: 24px 0 12px; }
  .cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 14px; }
  @media (max-width: 640px) { .cards { grid-template-columns: repeat(2, 1fr); } }
  .card { border: 1px solid #e5e7eb; border-top: 3px solid #d1d5db; padding: 10px 12px; cursor: pointer; background: #fff; text-align: left; font-family: inherit; }
  .card .num { font-size: 22px; font-weight: 700; line-height: 1.2; }
  .card .lbl { font-size: 12px; color: #6b7280; }
  .card.action { border-top-color: #dc2626; }
  .card.action .num { color: #b91c1c; }
  .card.watch { border-top-color: var(--accent); }
  .card.watch .num { color: #b45309; }
  .card.ok { border-top-color: #16a34a; }
  .card.ok .num { color: #15803d; }
  .card.alerts { border-top-color: var(--primary); }
  .card.alerts .num { color: var(--primary-dark); }
  .card.selected { background: #f5f9fc; outline: 2px solid var(--primary); }
  .tablewrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { background: #f3f4f6; text-align: left; padding: 8px 10px; border-bottom: 1px solid #e5e7eb; white-space: nowrap; position: sticky; top: 0; }
  td { padding: 8px 10px; border-bottom: 1px solid #f0f0f0; }
  tr.clickable { cursor: pointer; }
  tr.clickable:hover { background: #f5f9fc; }
  tr.resolved td { color: #9ca3af; }
  .filters { display: flex; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; align-items: center; }
  .filters select, .filters input[type="search"] { padding: 6px 8px; font-size: 13px; border: 1px solid #d1d5db; background: #fff; }
  .filters .count { font-size: 12px; color: #6b7280; margin-left: auto; }
  .filters label.chk { font-size: 13px; color: #4b5563; cursor: pointer; white-space: nowrap; }
  .state { display: inline-block; border: 1px solid; padding: 1px 8px; font-size: 12px; white-space: nowrap; }
  .state.ok { color: #15803d; border-color: #86efac; background: #f0fdf4; }
  .state.watch { color: #b45309; border-color: var(--accent); background: #fff7ed; }
  .state.action { color: #b91c1c; border-color: #fca5a5; background: #fef2f2; }
  .muted { color: #9ca3af; }
  .gap-over { color: #b91c1c; font-weight: 600; }
  .box { background: #f9fafb; border-left: 4px solid var(--primary); padding: 12px 14px; margin: 10px 0; font-size: 13px; }
  .backlink { color: var(--primary-dark); cursor: pointer; font-size: 13px; text-decoration: underline; }
  .cal { display: grid; grid-template-columns: repeat(7, 22px); gap: 3px; }
  .cal .head { font-size: 10px; color: #6b7280; text-align: center; }
  .cal .day { width: 22px; height: 22px; background: #e5e7eb; }
  .cal .day.on { background: var(--primary); }
  .cal .day.today { outline: 2px solid var(--accent); }
  .legend { font-size: 12px; color: #6b7280; margin-top: 6px; }
  .legend .sw { display: inline-block; width: 12px; height: 12px; vertical-align: -1px; }
  ul.msgs { list-style: none; padding: 0; margin: 0; font-size: 13px; }
  ul.msgs li { padding: 7px 4px; border-bottom: 1px solid #f0f0f0; }
  ul.msgs .meta { color: #6b7280; font-size: 11px; margin-bottom: 2px; }
  ul.msgs .staff .name { color: var(--primary-dark); font-weight: 600; }
  .detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
  @media (max-width: 760px) { .detail-grid { grid-template-columns: 1fr; } }
  .loading { color: #9ca3af; padding: 30px 0; text-align: center; }
  label.resolve { font-size: 12px; white-space: nowrap; cursor: pointer; }
  .hint { font-size: 12px; color: #6b7280; margin: 6px 0 10px; }
  #toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); background: #1f2937; color: #fff; font-size: 13px; padding: 10px 18px; opacity: 0; transition: opacity .2s; pointer-events: none; max-width: 90%; }
  #toast.show { opacity: 1; }
  #toast.err { background: #b91c1c; }
  .reload { font-size: 12px; color: var(--primary-dark); cursor: pointer; text-decoration: underline; margin-left: 8px; white-space: nowrap; }
  .pager { display: flex; align-items: center; gap: 12px; margin: 4px 0 14px; flex-wrap: wrap; }
  .pager button { border: 1px solid var(--primary); background: #fff; color: var(--primary-dark); padding: 8px 18px; font-size: 14px; cursor: pointer; font-family: inherit; }
  .pager button:hover:not(:disabled) { background: #f5f9fc; }
  .pager button:disabled { border-color: #d1d5db; color: #9ca3af; cursor: default; }
  .pager .pos { font-size: 13px; color: #4b5563; }
  .pager .keyhint { font-size: 11px; color: #9ca3af; margin-left: auto; }
</style>
</head>
<body>
<header>
  <h1>学習進捗ダッシュボード</h1>
  <span class="user" id="user"></span>
</header>
<main>
  <nav class="tabs">
    <button id="tab-students" class="active">生徒一覧</button>
    <button id="tab-action">要対応<span class="badge" id="action-badge" style="display:none"></span></button>
    <button id="tab-alerts">アラート<span class="badge" id="alert-badge" style="display:none"></span></button>
  </nav>
  <div id="content"><div class="loading">読み込み中…</div></div>
</main>
<div id="toast"></div>
<script>
(function () {
  var content = document.getElementById('content');
  var tabS = document.getElementById('tab-students');
  var tabAct = document.getElementById('tab-action');
  var tabA = document.getElementById('tab-alerts');
  var badge = document.getElementById('alert-badge');
  var actionBadge = document.getElementById('action-badge');
  var overview = null;
  var actionList = [];
  var actionIdx = 0;
  var actionMode = false;
  var filters = { business: '', teacher: '', state: '', q: '', onlyAlerts: false };
  var showResolved = false;

  var BIZ = { shiratani: '白谷塾', localmedi: 'ローカルメディ' };
  var STATUS = { trial: '体験中', enrolled: '塾生' };
  var KIND = {
    no_report: '日報停止',
    unanswered_by_student: '生徒側が未返信',
    unanswered_by_teacher: '未回答の質問',
    no_lesson: '個別指導未実施',
    weekly_report_missing: '週次報告未提出'
  };
  var STATE_CLASS = { '順調': 'ok', '要観察': 'watch', '要対応': 'action' };
  var STATE_ORDER = { '要対応': 0, '要観察': 1, '順調': 2 };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function jstDate(iso) {
    if (!iso) return null;
    return new Date(iso).toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric' });
  }
  function jstDateTime(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  // SQLiteの "YYYY-MM-DD HH:MM:SS"（UTC）をDateが解釈できるISO形式へ
  function sqlTime(s) {
    return s ? s.replace(' ', 'T') + 'Z' : s;
  }
  function api(path) {
    return fetch(path).then(function (r) {
      if (!r.ok) throw new Error('API error ' + r.status);
      return r.json();
    });
  }
  function setTab(which) {
    tabS.className = which === 's' ? 'active' : '';
    tabAct.className = which === 'act' ? 'active' : '';
    tabA.className = which === 'a' ? 'active' : '';
    actionMode = which === 'act';
  }
  function setActionBadge(n) {
    actionBadge.style.display = n > 0 ? '' : 'none';
    actionBadge.textContent = n;
  }
  var toastTimer = null;
  function toast(msg, isErr) {
    var el = document.getElementById('toast');
    el.textContent = msg;
    el.className = 'show' + (isErr ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = ''; }, isErr ? 4000 : 2000);
  }
  function setBadge(n) {
    badge.style.display = n > 0 ? '' : 'none';
    badge.textContent = n;
  }

  // ---------- 生徒一覧 ----------
  function showStudents() {
    setTab('s');
    content.innerHTML = '<div class="loading">読み込み中…</div>';
    api('/api/overview').then(function (data) {
      overview = data;
      var total = 0, act = 0;
      data.students.forEach(function (s) {
        total += s.open_alerts || 0;
        if (s.state === '要対応') act++;
      });
      setBadge(total);
      setActionBadge(act);
      renderStudents();
    }).catch(showError);
  }

  function renderStudents() {
    var items = overview.students.slice();
    // 要対応 → 要観察 → 順調、同じ状態の中では日報の経過が長い順
    items.sort(function (a, b) {
      var d = (STATE_ORDER[a.state] || 0) - (STATE_ORDER[b.state] || 0);
      if (d !== 0) return d;
      return (b.report_gap_days == null ? -1 : b.report_gap_days) - (a.report_gap_days == null ? -1 : a.report_gap_days);
    });

    var counts = { '要対応': 0, '要観察': 0, '順調': 0, alerts: 0 };
    items.forEach(function (s) {
      counts[s.state] = (counts[s.state] || 0) + 1;
      counts.alerts += s.open_alerts || 0;
    });

    var teachers = [];
    items.forEach(function (s) {
      if (s.teacher_name && teachers.indexOf(s.teacher_name) < 0) teachers.push(s.teacher_name);
    });
    teachers.sort();

    var html = '<div class="cards">'
      + card('action', counts['要対応'], '要対応', filters.state === '要対応')
      + card('watch', counts['要観察'], '要観察', filters.state === '要観察')
      + card('ok', counts['順調'], '順調', filters.state === '順調')
      + '<button class="card alerts' + (filters.onlyAlerts ? ' selected' : '') + '" data-card="alerts"><div class="num">' + counts.alerts + '</div><div class="lbl">未対応アラート（件）</div></button>'
      + '</div>';

    html += '<div class="filters">';
    html += sel('business', [['', '事業: すべて'], ['shiratani', '白谷塾'], ['localmedi', 'ローカルメディ']]);
    var tOpts = [['', '講師: すべて']];
    teachers.forEach(function (t) { tOpts.push([t, t]); });
    html += sel('teacher', tOpts);
    html += '<input type="search" id="f-q" placeholder="名前で検索" value="' + esc(filters.q) + '">';
    html += '<span class="count" id="shown-count"></span>';
    html += '<span class="reload" id="reload">最新に更新</span>';
    html += '</div>';

    html += '<div class="tablewrap"><table><thead><tr><th>状態</th><th>名前</th><th>事業</th><th>在籍</th><th>担当講師</th><th>最終日報</th><th>経過</th><th>未対応</th><th>指導後共有</th></tr></thead><tbody>';
    var shown = 0;
    items.forEach(function (s) {
      if (filters.business && s.business !== filters.business) return;
      if (filters.teacher && s.teacher_name !== filters.teacher) return;
      if (filters.state && s.state !== filters.state) return;
      if (filters.onlyAlerts && !(s.open_alerts > 0)) return;
      if (filters.q && String(s.name).indexOf(filters.q) < 0) return;
      shown++;
      var share = s.lesson_share_ok === true ? 'あり' : s.lesson_share_ok === false ? '<span class="state watch">なし</span>' : '<span class="muted">-</span>';
      var over = s.report_gap_days != null && s.report_gap_days >= (s.threshold || 3);
      html += '<tr class="clickable" data-id="' + s.id + '">'
        + '<td><span class="state ' + STATE_CLASS[s.state] + '">' + s.state + '</span></td>'
        + '<td>' + esc(s.name) + (s.unmapped ? ' <span class="muted">(グループ未紐付け)</span>' : '') + '</td>'
        + '<td>' + (BIZ[s.business] || s.business) + '</td>'
        + '<td>' + (STATUS[s.status] || s.status) + '</td>'
        + '<td>' + esc(s.teacher_name || '-') + '</td>'
        + '<td>' + (s.last_report_at ? jstDate(s.last_report_at) : '<span class="muted">記録なし</span>') + '</td>'
        + '<td' + (over ? ' class="gap-over"' : '') + '>' + (s.report_gap_days == null ? '-' : s.report_gap_days + '日') + '</td>'
        + '<td>' + (s.open_alerts > 0 ? '<span class="state action">' + s.open_alerts + '件</span>' : '-') + '</td>'
        + '<td>' + share + '</td>'
        + '</tr>';
    });
    html += '</tbody></table></div>';
    if (shown === 0) html += '<p class="muted">該当する生徒がいません。フィルタを解除するにはカードや選択を元に戻してください。</p>';
    content.innerHTML = html;
    document.getElementById('shown-count').textContent = shown + '名 / 全' + items.length + '名';

    content.querySelectorAll('.card').forEach(function (c) {
      c.onclick = function () {
        var key = c.getAttribute('data-card');
        if (key === 'alerts') {
          filters.onlyAlerts = !filters.onlyAlerts;
        } else {
          filters.state = (filters.state === key) ? '' : key;
        }
        renderStudents();
      };
    });
    ['business', 'teacher'].forEach(function (k) {
      var el = document.getElementById('f-' + k);
      el.value = filters[k];
      el.onchange = function () { filters[k] = el.value; renderStudents(); };
    });
    var q = document.getElementById('f-q');
    q.oninput = function () {
      filters.q = q.value.trim();
      renderStudents();
      var nq = document.getElementById('f-q');
      nq.focus();
      nq.setSelectionRange(nq.value.length, nq.value.length);
    };
    document.getElementById('reload').onclick = showStudents;
    content.querySelectorAll('tr.clickable').forEach(function (tr) {
      tr.onclick = function () { showDetail(tr.getAttribute('data-id')); };
    });
  }

  function card(key, num, label, selected) {
    return '<button class="card ' + key + (selected ? ' selected' : '') + '" data-card="' + label + '"><div class="num">' + num + '</div><div class="lbl">' + label + '（名）</div></button>';
  }

  function sel(key, opts) {
    var h = '<select id="f-' + key + '">';
    opts.forEach(function (o) { h += '<option value="' + esc(o[0]) + '">' + esc(o[1]) + '</option>'; });
    return h + '</select>';
  }

  // ---------- 要対応タブ（1人ずつめくって確認） ----------
  function showAction() {
    setTab('act');
    if (location.hash) history.replaceState(null, '', location.pathname);
    content.innerHTML = '<div class="loading">読み込み中…</div>';
    api('/api/overview').then(function (data) {
      overview = data;
      actionList = data.students.filter(function (s) { return s.state === '要対応'; });
      // 日報の経過が長い順に並べる
      actionList.sort(function (a, b) {
        return (b.report_gap_days == null ? 999 : b.report_gap_days) - (a.report_gap_days == null ? 999 : a.report_gap_days);
      });
      setActionBadge(actionList.length);
      if (actionList.length === 0) {
        content.innerHTML = '<h2>要対応の生徒</h2><p class="muted">現在、要対応の生徒はいません。</p>';
        return;
      }
      loadAction(0);
    }).catch(showError);
  }

  function loadAction(i) {
    actionIdx = Math.max(0, Math.min(i, actionList.length - 1));
    content.innerHTML = '<div class="loading">読み込み中…</div>';
    api('/api/student?id=' + actionList[actionIdx].id).then(function (d) {
      renderDetail(d, true);
    }).catch(showError);
  }

  // ←→キーでもめくれるようにする（要対応タブのときだけ反応）
  document.addEventListener('keydown', function (e) {
    if (!actionMode || actionList.length === 0) return;
    if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    if (e.key === 'ArrowLeft' && actionIdx > 0) loadAction(actionIdx - 1);
    if (e.key === 'ArrowRight' && actionIdx < actionList.length - 1) loadAction(actionIdx + 1);
  });

  // ---------- 生徒詳細 ----------
  function showDetail(id) {
    setTab('s');
    if (location.hash !== '#s' + id) location.hash = 's' + id;
    content.innerHTML = '<div class="loading">読み込み中…</div>';
    api('/api/student?id=' + id).then(function (d) { renderDetail(d, false); }).catch(showError);
  }

  function renderDetail(d, inAction) {
    var s = d.student;
    var html;
    if (inAction) {
      html = '<div class="pager">'
        + '<button id="pg-prev"' + (actionIdx === 0 ? ' disabled' : '') + '>← 前へ</button>'
        + '<span class="pos">' + (actionIdx + 1) + ' / ' + actionList.length + '人目</span>'
        + '<button id="pg-next"' + (actionIdx === actionList.length - 1 ? ' disabled' : '') + '>次へ →</button>'
        + '<span class="keyhint">キーボードの ← → でもめくれます</span>'
        + '</div>';
    } else {
      html = '<span class="backlink" id="back">← 生徒一覧へ戻る</span>';
    }
    html += '<h2>' + esc(s.name) + 'さん</h2>';
    html += '<div class="box">'
      + (BIZ[s.business] || s.business) + ' / ' + (STATUS[s.status] || s.status)
      + ' / 担当: ' + esc(s.teacher_name || '未設定')
      + ' / 最終日報: ' + (d.last_report_at ? jstDateTime(d.last_report_at) : '記録なし')
      + '（停止判定は' + s.threshold + '日）</div>';

    html += '<div class="detail-grid"><div>';

    html += '<h2>日報カレンダー（直近12週）</h2>' + renderCalendar(d.report_days);
    html += '<div class="legend"><span class="sw" style="background:#458BC3"></span> 生徒側の投稿あり　<span class="sw" style="background:#e5e7eb"></span> なし　<span class="sw" style="outline:2px solid #DF8D33"></span> 今日</div>';

    html += '<h2>個別指導（リンク投稿の履歴）</h2>';
    if (d.lessons.length === 0) {
      html += '<p class="muted">直近のZoom / Google Meetリンクの投稿がありません。</p>';
    } else {
      html += '<ul class="msgs">';
      d.lessons.forEach(function (m) {
        html += '<li>' + jstDateTime(m.sent_at) + '　' + esc(m.display_name || '') + '</li>';
      });
      html += '</ul>';
    }
    if (d.lesson.lesson_share_ok === false) {
      html += '<div class="box" style="border-left-color:#DF8D33">' + jstDate(d.lesson.last_lesson_link_at) + 'の指導後、グループへの共有投稿が見当たりません。</div>';
    }

    html += '<h2>アラート履歴</h2>';
    if (d.alerts.length === 0) {
      html += '<p class="muted">アラートはありません。</p>';
    } else {
      html += '<p class="hint">チェックすると自動で保存されます（保存ボタンは不要です）。</p>';
      html += '<div class="tablewrap"><table><thead><tr><th>日時</th><th>種別</th><th>対応</th></tr></thead><tbody>';
      d.alerts.forEach(function (a) {
        html += '<tr' + (a.resolved ? ' class="resolved"' : '') + '><td>' + jstDateTime(sqlTime(a.created_at)) + '</td><td>' + (KIND[a.kind] || a.kind) + '</td>'
          + '<td><label class="resolve"><input type="checkbox" data-alert="' + a.id + '"' + (a.resolved ? ' checked' : '') + '> 対応済み</label></td></tr>';
      });
      html += '</tbody></table></div>';
    }

    html += '</div><div>';

    html += '<h2>直近の会話（40件）</h2><ul class="msgs">';
    d.messages.slice().reverse().forEach(function (m) {
      var body = m.message_type === 'text' ? esc(m.text) : '[' + m.message_type + ']';
      html += '<li><div class="meta">' + jstDateTime(m.sent_at) + '　' + esc(m.display_name || '') + '</div>' + body.replace(/\\n/g, '<br>') + '</li>';
    });
    html += '</ul>';

    html += '</div></div>';
    content.innerHTML = html;
    if (inAction) {
      var prev = document.getElementById('pg-prev');
      var next = document.getElementById('pg-next');
      if (prev) prev.onclick = function () { loadAction(actionIdx - 1); };
      if (next) next.onclick = function () { loadAction(actionIdx + 1); };
    } else {
      document.getElementById('back').onclick = function () {
        if (location.hash) history.replaceState(null, '', location.pathname);
        showStudents();
      };
    }
    bindResolve();
  }

  function renderCalendar(reportDays) {
    var set = {};
    reportDays.forEach(function (r) { set[r.day] = r.count; });
    var today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
    var days = [];
    var t = new Date(today + 'T00:00:00');
    for (var i = 83; i >= 0; i--) {
      var dd = new Date(t.getTime() - i * 86400000);
      days.push(dd.toLocaleDateString('sv-SE'));
    }
    // 先頭を月曜に揃える
    var firstDow = (new Date(days[0] + 'T00:00:00').getDay() + 6) % 7;
    var html = '<div class="cal">';
    ['月', '火', '水', '木', '金', '土', '日'].forEach(function (w) { html += '<div class="head">' + w + '</div>'; });
    for (var p = 0; p < firstDow; p++) html += '<div></div>';
    days.forEach(function (day) {
      var cls = 'day' + (set[day] ? ' on' : '') + (day === today ? ' today' : '');
      html += '<div class="' + cls + '" title="' + day + (set[day] ? '（' + set[day] + '件）' : '') + '"></div>';
    });
    return html + '</div>';
  }

  // ---------- アラート一覧 ----------
  function showAlerts() {
    setTab('a');
    content.innerHTML = '<div class="loading">読み込み中…</div>';
    api('/api/alerts').then(function (rows) {
      var open = rows.filter(function (a) { return !a.resolved; }).length;
      setBadge(open);
      var html = '<h2>アラート一覧</h2>';
      html += '<p class="hint">チェックすると自動で保存されます（保存ボタンは不要です）。</p>';
      html += '<div class="filters"><label class="chk"><input type="checkbox" id="show-resolved"' + (showResolved ? ' checked' : '') + '> 対応済みも表示する</label>'
        + '<span class="count">未対応 ' + open + '件</span></div>';
      var list = showResolved ? rows : rows.filter(function (a) { return !a.resolved; });
      if (list.length === 0) {
        html += '<p class="muted">' + (showResolved ? 'アラートはありません。' : '未対応のアラートはありません。') + '</p>';
      } else {
        html += '<div class="tablewrap"><table><thead><tr><th>日時</th><th>生徒</th><th>種別</th><th>内容</th><th>対応</th></tr></thead><tbody>';
        list.forEach(function (a) {
          html += '<tr' + (a.resolved ? ' class="resolved"' : '') + '><td style="white-space:nowrap">' + jstDateTime(sqlTime(a.created_at)) + '</td>'
            + '<td style="white-space:nowrap">' + esc(a.student_name) + '</td>'
            + '<td style="white-space:nowrap">' + (KIND[a.kind] || a.kind) + '</td>'
            + '<td style="font-size:12px;color:#4b5563">' + esc((a.detail || '').slice(0, 120)) + '</td>'
            + '<td><label class="resolve"><input type="checkbox" data-alert="' + a.id + '"' + (a.resolved ? ' checked' : '') + '> 対応済み</label></td></tr>';
        });
        html += '</tbody></table></div>';
      }
      content.innerHTML = html;
      var sr = document.getElementById('show-resolved');
      sr.onchange = function () { showResolved = sr.checked; showAlerts(); };
      bindResolve();
    }).catch(showError);
  }

  // 対応済みチェックの自動保存。成功でトースト、失敗ならチェックを戻す
  function bindResolve() {
    content.querySelectorAll('input[data-alert]').forEach(function (cb) {
      cb.onchange = function () {
        var checked = cb.checked;
        cb.disabled = true;
        fetch('/api/alerts/resolve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: Number(cb.getAttribute('data-alert')), resolved: checked })
        }).then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          var tr = cb.closest('tr');
          if (tr) tr.className = checked ? 'resolved' : '';
          toast(checked ? '対応済みとして保存しました' : '未対応に戻しました');
        }).catch(function () {
          cb.checked = !checked;
          toast('保存に失敗しました。通信環境を確認して、もう一度チェックしてください', true);
        }).then(function () {
          cb.disabled = false;
        });
      };
    });
  }

  function showError(e) {
    content.innerHTML = '<p class="muted">読み込みに失敗しました: ' + esc(e.message) + '</p>';
  }

  tabS.onclick = function () {
    if (location.hash) history.replaceState(null, '', location.pathname);
    showStudents();
  };
  tabAct.onclick = showAction;
  tabA.onclick = showAlerts;
  api('/api/me').then(function (me) {
    document.getElementById('user').textContent =
      me.name + (me.role === 'teacher' ? '（担当生徒のみ表示）' : '（全生徒表示）');
  });
  var hashMatch = location.hash.match(/^#s(\\d+)$/);
  if (hashMatch) showDetail(hashMatch[1]); else showStudents();
})();
</script>
</body>
</html>`;
