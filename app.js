import { backend } from './supabase.js';

(function () {
  'use strict';

  var startupStatus = document.getElementById('startupStatus');
  var startupTimer = setTimeout(function () {
    if (!ready) startupStatus.textContent = 'Kết nối chậm. Kiểm tra mạng, cấu hình Supabase và SQL đã cài đặt.';
  }, 20000);
  window.addEventListener('error', function (event) {
    clearTimeout(startupTimer);
    startupStatus.hidden = false;
    startupStatus.textContent = 'Lỗi giao diện: ' + (event.message || 'Không xác định') + '. Hãy gửi lại thông báo này.';
  });

  var S = {
    kpis: [],
    subTasks: [],
    checkItems: [],
    urgentTasks: [],
    dailyNotes: [],
    leaves: [],
    resourceLinks: [],
    salaryRules: [],
    salaryBonuses: [],
    payrolls: [],
    payrollItems: []
  };
  var P = month(),
    D = date(),
    Q = '',
    ctx = '',
    view = 'dashboard',
    ready = false;
  var queue = Promise.resolve(),
    pending = 0,
    modalVersion = 0,
    chatting = false,
    searchTimer;
  var expanded = new Map(),
    drafts = new Map(),
    index = {};
  function e(id) {
    return document.getElementById(id);
  }
  function date() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function month() {
    return date().slice(0, 7);
  }
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      }[c];
    });
  }
  function escSelector(value) {
    if (window.CSS && CSS.escape) return CSS.escape(value);
    return String(value).replace(/["\\]/g, '\\$&');
  }

  function toast(message, error) {
    var node = document.createElement('div');
    node.className = 'toast' + (error ? ' error' : '');
    node.textContent = message;
    e('toast').replaceChildren(node);
    setTimeout(function () {
      node.remove();
    }, 5000);
  }
  function api(name, args) { return backend.call(name, args || [], P); }
  function isdone(x) {
    return x && (x.status === 'Hoàn thành' || x.done === true || x.done === 1 || x.done === 'TRUE');
  }
  function p(x) {
    return Math.max(0, Math.min(100, Number(x) || 0));
  }
  function money(value) {
    return (Number(value) || 0).toLocaleString('vi-VN') + ' đ';
  }
  function b(x, done) {
    return '<div class="bar ' + (done ? 'done' : '') + '"><i style="width:' + p(x) + '%"></i></div>';
  }
  function empty(text) {
    return '<div class="empty">' + text + '</div>';
  }
  function group(list, key) {
    var result = new Map();
    list.forEach(function (item) {
      var k = typeof key === 'function' ? key(item) : item[key];
      if (!result.has(k)) result.set(k, []);
      result.get(k).push(item);
    });
    return result;
  }
  function accept(data) {
    ['kpis', 'subTasks', 'checkItems', 'urgentTasks', 'dailyNotes', 'leaves', 'resourceLinks', 'salaryRules', 'salaryBonuses', 'payrolls', 'payrollItems'].forEach(function (key) {
      if (data && data[key] == null && ['salaryRules','salaryBonuses','payrolls','payrollItems'].includes(key)) data[key] = [];
      if (!data || !Array.isArray(data[key])) throw Error('Dữ liệu trả về không hợp lệ: ' + key);
    });
    S = data;
    index.subs = group(S.subTasks, 'kpiId');
    index.checks = group(S.checkItems, 'subTaskId');
    index.links = group(S.resourceLinks, function (l) {
      return l.entityType + ':' + l.entityId;
    });
    index.payrollItems = group(S.payrollItems, 'payrollId');
    index.calendarPeriod = null;
    ready = true;
  }
  function ks() {
    return S.kpis.filter(function (k) {
      return String(k.period).slice(0, 7) === P;
    });
  }
  function ss() {
    return ks().flatMap(function (k) {
      return index.subs.get(k.id) || [];
    });
  }
  function setBusy() {
    e('sync').disabled = pending > 0;
    ['prev','next','period','logout'].forEach(function(id){e(id).disabled=pending>0;});
    document.querySelectorAll('.view').forEach(function(node){node.inert=!ready;});
    e('sync').textContent = pending ? 'Đang đồng bộ…' : '↻ Đồng bộ dữ liệu';
  }
  // Serialize reads and writes so an older response never overwrites a newer save.
  function request(name, args, after) {
    pending++;
    setBusy();
    var result = queue.then(function () {
      return api(name, args);
    }).then(function (data) {
      if (data.period !== P) return;
      accept(data);
      if (after) after();
      render();
      clearTimeout(startupTimer);
      startupStatus.hidden = true;
    });
    queue = result.catch(function () {});
    return result.catch(function (error) {
      toast(error.message, true);
      if (!ready) {
        clearTimeout(startupTimer);
        startupStatus.hidden = false;
        startupStatus.textContent = 'Không tải được dữ liệu: ' + error.message;
      }
      render();
      throw error;
    }).finally(function () {
      pending--;
      setBusy();
    });
  }
  function refresh() {
    return request('getSystemData', [], function () {
      toast('Đã đồng bộ dữ liệu');
    }).catch(function () {});
  }
  function save(name, args, after) {
    var formNode = e('form'),
      version = modalVersion;
    if (formNode && formNode.dataset.busy) return Promise.resolve(false);
    if (formNode) {
      formNode.dataset.busy = '1';
      formNode.querySelectorAll('button,input,textarea,select').forEach(function (n) {
        n.disabled = true;
      });
    }
    return request(name, args, function () {
      if (after) after();
      if (version === modalVersion) close();
      toast('Đã lưu thay đổi');
    }).then(function () {
      return true;
    }).catch(function () {
      return false;
    }).finally(function () {
      if (formNode && formNode.isConnected) {
        delete formNode.dataset.busy;
        formNode.querySelectorAll('button,input,textarea,select').forEach(function (n) {
          n.disabled = false;
        });
      }
    });
  }
  function render() {
    e('period').value = P;
    if (!ready) return;
    ({
      dashboard: dash,
      kpi: tree,
      calendar: cal,
      report: report,
      urgent: urgent,
      salary: salary
    })[view]();
  }
  function focusWorkItem(item) {
    if (!item || !item.kpiId) return;
    expanded.set(item.kpiId, true);
    nav('kpi');
    requestAnimationFrame(function () {
      var selector = item.checkId ? '[data-check-row="' + escSelector(item.checkId) + '"]' : '[data-sub-row="' + escSelector(item.subId) + '"]';
      var node = document.querySelector(selector);
      if (!node) return;
      node.scrollIntoView({ behavior: 'smooth', block: 'center' });
      node.classList.add('focus-flash');
      setTimeout(function () {
        node.classList.remove('focus-flash');
      }, 1600);
    });
  }
  function nav(v) {
    view = v;
    document.querySelectorAll('.view').forEach(function (n) {
      n.classList.toggle('active', n.id === v);
    });
    document.querySelectorAll('.nav').forEach(function (n) {
      n.classList.toggle('active', n.dataset.v === v);
    });
    var labels = {
      dashboard: ['Tổng quan KPI', 'Bức tranh công việc trong tháng'],
      kpi: ['KPI công việc', 'Lập kế hoạch và theo dõi tiến độ'],
      calendar: ['Lịch & nghỉ phép', 'Công việc, deadline và lịch cá nhân'],
      report: ['Báo cáo', 'Tổng hợp kết quả theo kỳ'],
      urgent: ['Việc gấp', 'Theo dõi yêu cầu phát sinh'],
      salary: ['Lương tháng', 'Tổng hợp lương, KPI thưởng và thống kê năm']
    };
    e('title').textContent = labels[v][0];
    e('sub').textContent = labels[v][1];
    render();
  }
  function controls(type, id) {
    return '<span class="row controls">' + ['edit', 'link', 'delete'].map(function (action) {
      return '<button type="button" class="mini ' + (action === 'delete' ? 'red' : '') + '" data-action="' + action + '" data-type="' + type + '" data-id="' + esc(id) + '">' + {
        edit: 'Sửa',
        link: '🔗 Link',
        delete: 'Xóa'
      }[action] + '</button>';
    }).join('') + '</span>';
  }
  function links(type, id, primary) {
    var items = index.links.get(type + ':' + id) || [];
    function anchor(url, label) {
      return /^https?:\/\/[^\s]+$/i.test(url) ? '<a target="_blank" rel="noopener noreferrer" href="' + esc(url) + '">' + esc(label) + '</a>' : '';
    }
    return '<div class="small links">' + (primary ? anchor(primary, 'Tài liệu chính') : '') + items.map(function (l) {
      return '<span>' + anchor(l.url, l.label) + ' <button class="mini red" data-unlink="' + esc(l.id) + '" type="button" aria-label="Xóa link">×</button></span>';
    }).join(' ') + '</div>';
  }
  function tree() {
    var scroll = e('tree').scrollTop;
    var K = ks().filter(function (k) {
      var subs = index.subs.get(k.id) || [];
      return !Q || [k.title].concat(subs.flatMap(function (s) {
        return [s.title].concat((index.checks.get(s.id) || []).map(function (c) {
          return c.title;
        }));
      })).join(' ').toLocaleLowerCase('vi').includes(Q);
    });
    e('count').textContent = K.length + ' KPI trong ' + P;
    e('tree').innerHTML = K.length ? K.map(function (k, i) {
      var subs = index.subs.get(k.id) || [];
      return '<details class="kpi" data-kpi="' + esc(k.id) + '" ' + ((expanded.has(k.id) ? expanded.get(k.id) : i === 0) ? 'open' : '') + '><summary><div class="khead"><b>' + esc(k.title) + '</b>' + b(k.progress, true) + (k.salaryEnabled ? '<small>' + money(k.salaryAmount) + '</small>' : '') + controls('KPI', k.id) + '<button type="button" class="mini" data-sub="' + esc(k.id) + '">+ Sub-task</button></div></summary>' + links('KPI', k.id, k.driveLink) + subs.map(function (s) {
        var checks = index.checks.get(s.id) || [];
        return '<details class="sub" data-sub-row="' + esc(s.id) + '"><summary class="sub-summary"><b class="grow">' + esc(s.title) + '</b><small>' + esc(s.dueDate || 'Chưa có hạn') + '</small>' + b(s.progress, isdone(s)) + '</summary><div class="sub-details"><div class="row sub-actions"><button class="mini" data-ask="' + esc(s.id) + '">Hỏi Gemini</button>' + controls('SUBTASK', s.id) + '<button class="mini" data-ca="' + esc(s.id) + '">+ Việc</button></div>' + links('SUBTASK', s.id, s.driveLink) + '<div class="checks">' + (checks.length ? checks.map(function (c) {
          return '<div class="check" data-check-row="' + esc(c.id) + '"><label class="grow"><input type="checkbox" data-check="' + esc(c.id) + '" ' + (isdone(c) ? 'checked' : '') + '> ' + esc(c.title) + '</label><small>' + esc(c.dueDate) + '</small>' + controls('CHECK', c.id) + '</div>' + links('CHECK', c.id);
        }).join('') : empty('Chưa có đầu việc.')) + '</div></div></details>';
      }).join('') + '</details>';
    }).join('') : empty('Chưa có KPI phù hợp.');
    e('tree').scrollTop = scroll;
  }
  function calendarEvents(day) {
    if (index.calendarPeriod !== P) {
      index.events = new Map();
      function put(date, item) {
        if (!index.events.has(date)) index.events.set(date, []);
        index.events.get(date).push(item);
      }
      ss().forEach(function (s) {
        var kpi = S.kpis.find(function (k) {
          return k.id === s.kpiId;
        });
        put(s.dueDate, {
          title: s.title,
          parentTitle: kpi ? kpi.title : '',
          kpiId: s.kpiId,
          subId: s.id
        });
        (index.checks.get(s.id) || []).forEach(function (c) {
          put(c.dueDate, {
            title: c.title,
            parentTitle: s.title,
            kpiTitle: kpi ? kpi.title : '',
            kpiId: s.kpiId,
            subId: s.id,
            checkId: c.id,
            check: c
          });
        });
      });
      S.urgentTasks.forEach(function (t) {
        put(t.dueDate, {
          title: 'Việc gấp: ' + t.title,
          urgentId: t.id
        });
      });
      index.calendarPeriod = P;
    }
    return (index.events.get(day) || []).concat(S.leaves.filter(function (l) {
      return l.startDate <= day && l.endDate >= day;
    }).map(function (l) {
      return {
        title: l.type,
        leave: l
      };
    }));
  }
  function cal() {
    var parts = P.split('-'),
      year = +parts[0],
      m = +parts[1] - 1,
      last = new Date(year, m + 1, 0).getDate(),
      offset = (new Date(year, m, 1).getDay() + 6) % 7;
    var h = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'].map(function (n) {
      return '<div class="dow">' + n + '</div>';
    }).join('');
    for (var i = 1; i <= 42; i++) {
      var day = i - offset,
        ds = day > 0 && day <= last ? P + '-' + String(day).padStart(2, '0') : '',
        events = ds ? calendarEvents(ds) : [];
      h += '<div class="day ' + (ds === D ? 'active' : '') + '" data-day="' + ds + '" title="' + esc(events.map(function (t) {
        return t.title;
      }).join('\n')) + '">' + (ds ? day : '') + events.filter(function(t){return t.leave;}).map(function(t){return '<span class="event leave">' + esc(t.title) + '</span>';}).join('') + (events.some(function(t){return !t.leave;}) ? '<span class="event">' + events.filter(function(t){return !t.leave;}).length + ' việc</span>' : '') + '</div>';
    }
    e('calTitle').textContent = 'Tháng ' + parts[1] + ' / ' + parts[0];
    e('cal').innerHTML = h;
    detail();
  }
  function detail() {
    e('dateTitle').textContent = 'Ngày ' + D.split('-').reverse().join('/');
    var items = calendarEvents(D);
    e('dateItems').innerHTML = items.length ? items.map(function (item) {
      if (item.leave) {
        return '<div class="line"><div class="grow"><b>' + esc(item.title) + '</b><span class="small">' + esc(leaveRange(item.leave)) + '</span><span class="small">' + esc(item.leave.note) + '</span></div><button class="mini red" data-dl="' + esc(item.leave.id) + '">Xóa</button></div>';
      }
      var parent = item.parentTitle || item.kpiTitle || '';
      var workMeta = parent ? '<span class="small">' + esc(parent) + '</span>' : '';
      if (item.urgentId) {
        return '<div class="line"><button type="button" class="grow calendar-jump" data-eu="' + esc(item.urgentId) + '"><b>' + esc(item.title) + '</b></button></div>';
      }
      if (!item.kpiId) {
        return '<div class="line"><div class="grow"><b>' + esc(item.title) + '</b></div></div>';
      }
      return '<div class="line">' + (item.check ? '<input type="checkbox" data-check="' + esc(item.check.id) + '" ' + (isdone(item.check) ? 'checked' : '') + '>' : '') + '<button type="button" class="grow calendar-jump" data-goto-kpi="' + esc(item.kpiId || '') + '" data-goto-sub="' + esc(item.subId || '') + '" data-goto-check="' + esc(item.checkId || '') + '"><b>' + esc(item.title) + '</b>' + workMeta + '</button></div>';
    }).join('') : empty('Không có mục nào');
    var note = S.dailyNotes.find(function (n) {
      return n.date === D;
    });
    e('note').value = drafts.has(D) ? drafts.get(D) : note ? note.content : '';
  }
  function close() {
    modalVersion++;
    e('modal').replaceChildren();
  }
  function field(name, label, value, type, opts) {
    return {
      name: name,
      label: label,
      v: value,
      type: type || 'text',
      opts: opts
    };
  }
  function form(title, fields, submit) {
    if (!ready) return toast('Đang tải dữ liệu. Vui lòng chờ.', true);
    modalVersion++;
    e('modal').innerHTML = '<div class="modal"><form id="form" class="dialog"><h2>' + esc(title) + '</h2>' + fields.map(function (f) {
      var attrs = ' name="' + f.name + '"';
      var control = f.type === 'select' ? '<select' + attrs + '>' + f.opts.map(function (o) {
        return '<option ' + (o === f.v ? 'selected' : '') + '>' + esc(o) + '</option>';
      }).join('') + '</select>' : f.type === 'textarea' ? '<textarea' + attrs + '>' + esc(f.v) + '</textarea>' : '<input' + attrs + ' type="' + f.type + '" ' + (f.type === 'checkbox' ? f.v ? 'checked' : '' : 'value="' + esc(f.v) + '"') + (f.name === 'title' ? ' required' : '') + (f.type === 'number' ? ' min="0" max="100"' : '') + '>';
      return '<label class="field">' + esc(f.label) + control + '</label>';
    }).join('') + '<div class="actions"><button type="button" id="cancel" class="btn ghost">Hủy</button><button class="btn primary">Lưu</button></div></form></div>';
    e('cancel').onclick = close;
    e('form').onsubmit = function (event) {
      event.preventDefault();
      if (event.target.dataset.busy) return;
      var values = {};
      fields.forEach(function (f) {
        var input = event.target.elements.namedItem(f.name);
        values[f.name] = f.type === 'checkbox' ? input.checked : input.value;
      });
      submit(values);
    };
    var first = e('form').querySelector('input,textarea,select');
    if (first) first.focus();
  }
  var config = {
    KPI: ['kpis', 'Kpi'],
    SUBTASK: ['subTasks', 'SubTask'],
    CHECK: ['checkItems', 'CheckItem'],
    URGENT: ['urgentTasks', 'UrgentTask'],
    SALARY_RULE: ['salaryRules', 'SalaryRule'],
    SALARY_BONUS: ['salaryBonuses', 'SalaryBonus'],
    PAYROLL: ['payrolls', 'Payroll']
  };
  function edit(type, id) {
    var item = S[config[type][0]].find(function (x) {
      return x.id === id;
    });
    if (!item) return;
    var fields = [field('title', 'Tên', item.title, type === 'URGENT' ? 'textarea' : 'text')];
    if (type === 'SALARY_RULE') fields.push(field('type', 'Loại dòng lương', item.type || 'keyword', 'select', ['base','keyword','tax']), field('keyword', 'Từ khóa tính số lượng', item.keyword || ''), field('amount', 'Số tiền', item.amount || 0, 'number'), field('active', 'Đang áp dụng', item.active !== false, 'checkbox'));
    else if (type === 'SALARY_BONUS') fields.push(field('period', 'Tháng', item.period || P, 'month'), field('amount', 'Số tiền', item.amount || 0, 'number'), field('done', 'Tính vào lương', !!item.done, 'checkbox'), field('note', 'Ghi chú', item.note || '', 'textarea'));
    else if (type === 'KPI') fields.push(field('period', 'Kỳ', item.period, 'month'), field('salaryEnabled', 'Tính thêm tiền khi KPI hoàn thành', !!item.salaryEnabled, 'checkbox'), field('salaryAmount', 'Số tiền KPI riêng', item.salaryAmount || 0, 'number'), field('note', 'Ghi chú', item.note, 'textarea'));else fields.push(field('dueDate', 'Hạn', item.dueDate, 'date'));
    if (type === 'CHECK') fields.push(field('note', 'Ghi chú', item.note, 'textarea'), field('done', 'Đã hoàn thành', isdone(item), 'checkbox'));else {
      var derived = type === 'KPI' ? (index.subs.get(id) || []).length : type === 'SUBTASK' ? (index.checks.get(id) || []).length : 0;
      if (type !== 'URGENT' && !derived) fields.push(field('progress', 'Tiến độ (%) — trạng thái tự tính', item.progress, 'number'));
      if (type === 'URGENT') fields.push(field('kpiGroup', 'Nhóm', item.kpiGroup), field('status', 'Trạng thái', item.status, 'select', ['Chưa làm', 'Đang làm', 'Hoàn thành']));
      fields.push(field('driveLink', 'Link tài liệu chính', item.driveLink, 'url'));
    }
    form('Chỉnh sửa' + (derived ? ' — tiến độ tính từ các mục con' : ''), fields, function (values) {
      save('apiUpdate' + config[type][1], [id, values]);
    });
  }
  function addK() {
    form('Tạo KPI mới', [field('title', 'Tên KPI', ''), field('period', 'Kỳ', P, 'month'), field('salaryEnabled', 'Tính thêm tiền khi KPI hoàn thành', false, 'checkbox'), field('salaryAmount', 'Số tiền KPI riêng', 0, 'number')], function (d) {
      save('apiAddKpi', [{
        title: d.title,
        period: d.period,
        salaryEnabled: !!d.salaryEnabled,
        salaryAmount: Number(d.salaryAmount) || 0
      }]);
    });
  }
  function addU() {
    form('Thêm việc gấp', [field('title', 'Tên công việc', ''), field('dueDate', 'Hạn', D, 'date'), field('kpiGroup', 'Nhóm', '')], function (d) {
      save('apiAddUrgentTask', [d]);
    });
  }
  function addL() {
    form('Thêm lịch cá nhân', [field('startDate', 'Từ ngày', D, 'date'), field('endDate', 'Đến ngày', D, 'date'), field('startTime', 'Từ giờ (bỏ trống nếu cả ngày)', '', 'time'), field('endTime', 'Đến giờ', '', 'time'), field('type', 'Loại lịch', 'Nghỉ phép', 'select', ['Nghỉ phép', 'Đi công tác', 'Đào tạo', 'Việc cá nhân']), field('note', 'Ghi chú', '', 'textarea')], function (d) {
      if (!d.startDate || !d.endDate || d.endDate < d.startDate || !!d.startTime !== !!d.endTime || (d.startDate === d.endDate && d.startTime && d.endTime <= d.startTime)) return toast('Kiểm tra khoảng ngày và giờ kết thúc sau giờ bắt đầu.', true);
      d.startTime = d.startTime || null; d.endTime = d.endTime || null;
      save('apiAddLeave', [d]);
    });
  }
  function addSalaryRule() {
    form('Thêm dòng lương', [field('title', 'Tên dòng lương', ''), field('type', 'Loại', 'keyword', 'select', ['base','keyword','tax']), field('keyword', 'Từ khóa tính số lượng', ''), field('amount', 'Số tiền', 0, 'number')], function(d){
      save('apiAddSalaryRule', [{ title: d.title, type: d.type, keyword: d.keyword, amount: Number(d.amount) || 0, active: true }]);
    });
  }
  function addSalaryBonus() {
    form('Thêm KPI thưởng riêng', [field('title', 'Tên KPI thưởng', ''), field('period', 'Tháng', P, 'month'), field('amount', 'Số tiền', 0, 'number'), field('done', 'Tính vào lương', false, 'checkbox'), field('note', 'Ghi chú', '', 'textarea')], function(d){
      save('apiAddSalaryBonus', [{ title: d.title, period: d.period, amount: Number(d.amount) || 0, done: !!d.done, note: d.note }]);
    });
  }
  function baseSalaryRule() {
    return (S.salaryRules || []).find(function(r){return r.active !== false && r.type === 'base';}) || { title: 'Lương cơ bản', amount: 10000000 };
  }
  function payrollDraft(id) {
    var payroll = (S.payrolls || []).find(function(p){return p.id === id;});
    var existing = new Map((payroll ? index.payrollItems.get(payroll.id) || [] : []).map(function(item){
      return [item.sourceType + ':' + (item.sourceId || item.title), item];
    }));
    var base = baseSalaryRule();
    var rows = [{
      key: 'base:base',
      sourceType: 'base',
      sourceId: '',
      title: base.title || 'Lương cơ bản',
      amount: Number(base.amount) || 0,
      checked: !payroll || existing.has('base:' + (base.title || 'Lương cơ bản'))
    }];
    completedSubTasks().forEach(function(sub){
      var key = 'subTask:' + sub.id;
      var old = existing.get(key);
      rows.push({
        key: key,
        sourceType: 'subTask',
        sourceId: sub.id,
        title: sub.title,
        amount: old ? Number(old.amount) || 0 : suggestedPay(sub),
        checked: !!old,
        meta: sub.kpiTitle
      });
    });
    if (payroll) (index.payrollItems.get(payroll.id) || []).forEach(function(item){
      var key = item.sourceType + ':' + (item.sourceId || item.title);
      if (!rows.some(function(row){return row.key === key;})) rows.push({
        key: key,
        sourceType: item.sourceType,
        sourceId: item.sourceId || '',
        title: item.title,
        amount: Number(item.amount) || 0,
        checked: true
      });
    });
    return { payroll: payroll, rows: rows };
  }
  function openPayroll(id) {
    if (!ready) return toast('Đang tải dữ liệu. Vui lòng chờ.', true);
    var draft = payrollDraft(id);
    modalVersion++;
    e('modal').innerHTML = '<div class="modal"><form id="form" class="dialog payroll-dialog"><h2>' + (draft.payroll ? 'Chỉnh sửa bảng lương' : 'Thêm bảng lương') + '</h2><label class="field">Tên bảng lương<input name="title" required value="' + esc(draft.payroll ? draft.payroll.title : 'Bảng lương ' + P) + '"></label><label class="field">Tháng<input name="period" type="month" value="' + esc(draft.payroll ? draft.payroll.period : P) + '"></label><label class="field">Ghi chú<textarea name="note">' + esc(draft.payroll ? draft.payroll.note : '') + '</textarea></label><div class="payroll-picker">' + draft.rows.map(function(row, i){
      return '<label class="payroll-pick-row"><input type="checkbox" name="row' + i + '" ' + (row.checked ? 'checked' : '') + '><span><b>' + esc(row.title) + '</b>' + (row.meta ? '<small>' + esc(row.meta) + '</small>' : '') + '</span><input name="amount' + i + '" type="number" min="0" value="' + esc(row.amount) + '"></label>';
    }).join('') + '</div><div class="actions"><button type="button" id="cancel" class="btn ghost">Hủy</button><button class="btn primary">' + (draft.payroll ? 'Lưu bảng lương' : 'Tạo bảng lương') + '</button></div></form></div>';
    e('cancel').onclick = close;
    e('form').onsubmit = function(event){
      event.preventDefault();
      var formNode = event.target;
      var rows = draft.rows.map(function(row, i){
        return {
          sourceType: row.sourceType,
          sourceId: row.sourceId,
          title: row.title,
          amount: Number(formNode.elements.namedItem('amount' + i).value) || 0,
          selected: formNode.elements.namedItem('row' + i).checked
        };
      }).filter(function(row){return row.selected;});
      if (!rows.length) return toast('Chọn ít nhất một dòng lương.', true);
      save('apiSavePayroll', [{ id: id || null, title: formNode.elements.namedItem('title').value, period: formNode.elements.namedItem('period').value, note: formNode.elements.namedItem('note').value, items: rows }]);
    };
  }
  function exportPayroll(id) {
    var payroll = (S.payrolls || []).find(function(p){return p.id === id;});
    if (!payroll) return;
    var rows = index.payrollItems.get(id) || [];
    var csv = [['Bảng lương', payroll.title], ['Tháng', payroll.period], ['Ghi chú', payroll.note || ''], [], ['Khoản lương','Số tiền']]
      .concat(rows.map(function(row){return [row.title, row.amount];}))
      .concat([['Tổng', payrollTotal(payroll)]])
      .map(function(row){return row.map(function(cell){return '"' + String(cell == null ? '' : cell).replace(/"/g,'""') + '"';}).join(',');}).join('\n');
    downloadText('\ufeff' + csv, 'Bang-luong-' + payroll.period + '.csv');
  }
  function leaveRange(l) {
    return l.startDate + (l.startTime ? ' ' + l.startTime.slice(0,5) : '') + ' → ' + l.endDate + (l.endTime ? ' ' + l.endTime.slice(0,5) : ' · Cả ngày');
  }
  var exportTables = [
    ['flow_kpis', 'KPI'],
    ['flow_sub_tasks', 'Sub-task'],
    ['flow_check_items', 'Đầu việc nhỏ'],
    ['flow_urgent_tasks', 'Việc gấp'],
    ['flow_daily_notes', 'Ghi chú ngày'],
    ['flow_leaves', 'Lịch nghỉ/công tác'],
    ['flow_resource_links', 'Link tài liệu'],
    ['flow_salary_rules', 'Cấu hình lương'],
    ['flow_salary_bonuses', 'KPI thưởng lương'],
    ['flow_payrolls', 'Bảng lương'],
    ['flow_payroll_items', 'Dòng bảng lương']
  ];
  e('deleteData').onclick = function () {
    if (pending) return toast('Chờ đồng bộ xong trước khi xóa.', true);
    form('Chọn phạm vi xóa', [field('scope', 'Xóa theo', 'Ngày', 'select', ['Ngày','Tháng'])], function(choice){
      var monthly = choice.scope === 'Tháng';
      form('Xóa dữ liệu theo ' + choice.scope.toLowerCase(), [field('value', monthly ? 'Tháng cần xóa' : 'Ngày cần xóa', monthly ? P : D, monthly ? 'month' : 'date'), field('password', 'Mật khẩu đăng nhập Supabase', '', 'password')], function(values){
        if (!values.value || !values.password) return toast('Nhập kỳ và mật khẩu xác nhận.', true);
        if (!confirm('Xóa dữ liệu ' + values.value + '? Công việc được chọn theo hạn; KPI theo tháng (chỉ khi xóa tháng). Các mục con và link cũng bị xóa. Lịch cá nhân chỉ bị xóa nếu nằm trọn trong kỳ. Không thể hoàn tác.')) return;
        values.scope = monthly ? 'month' : 'day';
        save('apiDeleteData', [values], function(){drafts.clear();});
      });
      e('form').querySelector('.actions button:last-child').textContent = 'Xác nhận xóa';
      e('form').querySelector('[name="password"]').autocomplete = 'current-password';
    });
  };
  e('exportData').onclick = function () {
    var fields = [field('scope', 'Phạm vi', 'all', 'select', ['all','month','year'])].concat(exportTables.map(function(t){
      return field(t[0], t[1], true, 'checkbox');
    }));
    form('Export data tùy chỉnh', fields, async function (values) {
      var button = e('form').querySelector('.actions button:last-child');
      button.disabled = true;
      try {
        await queue;
        var selected = exportTables.filter(function(t){return values[t[0]];}).map(function(t){return t[0];});
        if (!selected.length) return toast('Chọn ít nhất một nhóm dữ liệu để xuất.', true);
        var opts = { scope: values.scope, period: P, year: P.slice(0,4), tables: selected };
        var data = filterExportData(await api('apiExportData', [opts]), opts);
        var sql = buildExportSQL(data);
        downloadText(sql, 'Flow-KPI-' + values.scope + '-' + date() + '.sql');
        close();
        toast(values.scope === 'all' ? 'Đã xuất dữ liệu đã chọn.' : 'Đã xuất theo phạm vi đang chọn.');
      } catch(error) { toast(error.message, true); }
      finally { if (button.isConnected) button.disabled = false; }
    });
    e('form').querySelector('.actions button:last-child').textContent = 'Tải file SQL';
  };
  function downloadText(text, filename) {
    var url = URL.createObjectURL(new Blob([text], {type:'text/plain;charset=utf-8'}));
    var a = document.createElement('a'); a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function(){URL.revokeObjectURL(url);},1000);
  }
  function filterExportData(data, opts) {
    var result = {};
    exportTables.forEach(function(t){ result[t[0]] = opts.tables.includes(t[0]) ? (data[t[0]] || []) : []; });
    function inScope(row, column) {
      if (opts.scope === 'all') return true;
      var value = String(row[column] || row.createdAt || '');
      return opts.scope === 'year' ? value.slice(0,4) === opts.year : value.slice(0,7) === opts.period;
    }
    if (opts.scope !== 'all') result.flow_kpis = result.flow_kpis.filter(function(r){return opts.scope === 'year' ? String(r.period).slice(0,4) === opts.year : r.period === opts.period;});
    result.flow_sub_tasks = result.flow_sub_tasks.filter(function(r){return inScope(r, 'dueDate');});
    result.flow_check_items = result.flow_check_items.filter(function(r){return inScope(r, 'dueDate');});
    result.flow_urgent_tasks = result.flow_urgent_tasks.filter(function(r){return inScope(r, 'dueDate');});
    result.flow_daily_notes = result.flow_daily_notes.filter(function(r){return inScope(r, 'date');});
    result.flow_leaves = result.flow_leaves.filter(function(r){return opts.scope === 'all' || (opts.scope === 'year' ? String(r.startDate).slice(0,4) === opts.year || String(r.endDate).slice(0,4) === opts.year : String(r.startDate).slice(0,7) <= opts.period && String(r.endDate).slice(0,7) >= opts.period);});
    result.flow_salary_bonuses = result.flow_salary_bonuses.filter(function(r){return opts.scope === 'all' || (opts.scope === 'year' ? String(r.period).slice(0,4) === opts.year : r.period === opts.period);});
    result.flow_payrolls = result.flow_payrolls.filter(function(r){return opts.scope === 'all' || (opts.scope === 'year' ? String(r.period).slice(0,4) === opts.year : r.period === opts.period);});
    var payrollIds = new Set(result.flow_payrolls.map(function(r){return r.id;}));
    result.flow_payroll_items = result.flow_payroll_items.filter(function(r){return opts.scope === 'all' || payrollIds.has(r.payrollId);});
    return result;
  }
  function buildExportSQL(data) {
    // Encode as a SQL string; no data can terminate the surrounding DO block.
    var payload = JSON.stringify(data).replace(/'/g,"''").replace(/\$/g,'\\u0024');
    return `-- Flow KPI: toàn bộ dữ liệu của tài khoản, mọi tháng.
-- 1. Chạy schema.sql phiên bản mới trong database Supabase đích.
-- 2. Tạo tài khoản đích trong Authentication, thay UUID bên dưới.
-- 3. Chạy toàn bộ file này trong SQL Editor. Lỗi bất kỳ sẽ rollback.
-- Không bao gồm mật khẩu, tài khoản Auth hoặc Gemini key.
begin;
set local standard_conforming_strings = on;
do $flow_import$
declare
  target_user uuid := '00000000-0000-0000-0000-000000000000';
  payload jsonb := '${payload}'::jsonb;
  tbl text; row_data jsonb; cols text; vals text;
begin
  if not exists(select 1 from auth.users where id=target_user) then
    raise exception 'Thay target_user bằng UUID tài khoản đích trước khi nhập.';
  end if;
  foreach tbl in array array['flow_kpis','flow_sub_tasks','flow_check_items','flow_urgent_tasks','flow_daily_notes','flow_leaves','flow_resource_links','flow_salary_rules','flow_salary_bonuses','flow_payrolls','flow_payroll_items'] loop
    for row_data in select value from jsonb_array_elements(payload->tbl) loop
      row_data := (row_data - 'entityType' - 'entityId') || jsonb_build_object('user_id',target_user);
      select string_agg(format('%I',key),',' order by key), string_agg(format('r.%I',key),',' order by key) into cols,vals from jsonb_each(row_data);
      execute format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I,$1) r',tbl,cols,vals,tbl) using row_data;
    end loop;
  end loop;
  insert into public.flow_revisions(user_id,revision) values(target_user,1)
    on conflict(user_id) do update set revision=public.flow_revisions.revision+1;
end $flow_import$;
commit;
`;
  }
  function gstatus() {
    return api('apiGeminiStatus').then(function (x) {
      e('gstatus').textContent = x.configured ? '● Sẵn sàng · ' + x.model : '● Chưa gắn API key';
    }).catch(function (error) {
      e('gstatus').textContent = error.message;
    });
  }
  function ask(text) {
    text = String(text || '').trim();
    if (!text || chatting) return;
    chatting = true;
    e('chatSend').disabled = true;
    var messages = e('msgs'),
      waiting = document.createElement('div');
    messages.insertAdjacentHTML('beforeend', '<div class="bubble me">' + esc(text) + '</div>');
    waiting.className = 'bubble';
    waiting.textContent = 'Gemini đang suy nghĩ…';
    messages.appendChild(waiting);
    messages.scrollTop = messages.scrollHeight;
    api('apiAskGemini', [text, ctx]).then(function (x) {
      waiting.textContent = x.answer;
    }).catch(function (error) {
      waiting.textContent = 'Lỗi: ' + error.message;
    }).finally(function () {
      chatting = false;
      e('chatSend').disabled = false;
      messages.scrollTop = messages.scrollHeight;
    });
  }
  document.addEventListener('click', function (event) {
    var target = event.target.closest('button,[data-day]');
    if (!target) return;
    var d = target.dataset;
    if (d.v) return nav(d.v);
    if (d.gotoKpi) return focusWorkItem({
      kpiId: d.gotoKpi,
      subId: d.gotoSub,
      checkId: d.gotoCheck
    });
    if (target.closest('summary')) event.preventDefault();
    if (d.action) {
      var id = d.id,
        type = d.type;
      if (d.action === 'edit') return edit(type, id);
      if (d.action === 'delete') {
        if (confirm('Xóa mục này và các mục con liên quan?')) save('apiDelete' + config[type][1], [id]);
        return;
      }
      if (d.action === 'link') return form('Gắn tài liệu', [field('label', 'Tên hiển thị', 'Tài liệu'), field('url', 'Đường dẫn', '', 'url')], function (values) {
        save('apiAddResourceLink', [{
          entityType: type,
          entityId: id,
          label: values.label,
          url: values.url
        }]);
      });
    }
    if (d.unlink) {
      if (confirm('Xóa link tài liệu?')) save('apiDeleteResourceLink', [d.unlink]);
      return;
    }
    if (d.sub || d.ca) return form(d.sub ? 'Thêm sub-task' : 'Thêm đầu việc', [field('title', 'Tên công việc', ''), field('dueDate', 'Hạn', D, 'date')], function (values) {
      save(d.sub ? 'apiAddSubTask' : 'apiAddCheckItem', [d.sub || d.ca, values.title, values.dueDate]);
    });
    if (d.ask) {
      var sub = S.subTasks.find(function (s) {
        return s.id === d.ask;
      });
      ctx = 'Sub-task: ' + (sub ? sub.title : '') + '\nHạn: ' + (sub ? sub.dueDate : '');
      var drawer = e('chatDrawer');
      if (drawer) drawer.hidden = false;
      return ask('Hãy đề xuất 4–6 đầu mục nhỏ để hoàn thành sub-task này.');
    }
    if (d.eu) return edit('URGENT', d.eu);
    if (d.cu) return save('apiUpdateUrgentTask', [d.cu, { status: 'Hoàn thành' }]);
    if (d.ep) return openPayroll(d.ep);
    if (d.xp) return exportPayroll(d.xp);
    if (d.dp) {
      if (confirm('Xóa bảng lương này?')) save('apiDeletePayroll', [d.dp]);
      return;
    }
    if (d.du || d.dl) {
      if (confirm('Xóa mục này?')) save(d.du ? 'apiDeleteUrgentTask' : 'apiDeleteLeave', [d.du || d.dl]);
      return;
    }
    if (d.day) {
      D = d.day;
      cal();
    }
  });
  e('tree').addEventListener('toggle', function (event) {
    if (event.target.dataset.kpi) expanded.set(event.target.dataset.kpi, event.target.open);
  }, true);
  document.addEventListener('change', function (event) {
    var target = event.target;
    if (target.dataset.check) {
      target.disabled = true;
      save('apiToggleCheckItem', [target.dataset.check, target.checked]);
    }
    if (target.id === 'period') {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(target.value)) {
        target.value = P;
        return;
      }
      P = target.value;
      D = P + '-01';
      ready=false;refresh();
    }
  });
  function move(n) {
    var a = P.split('-'),
      d = new Date(+a[0], +a[1] - 1 + n, 1);
    P = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    D = P + '-01';
    ready=false;refresh();
  }
  e('sync').onclick = refresh;
  e('prev').onclick = function () {
    move(-1);
  };
  e('next').onclick = function () {
    move(1);
  };
  e('kpiTop').onclick = e('kpiAdd').onclick = addK;
  e('urgentTop').onclick = e('urgentAdd').onclick = addU;
  e('leaveTop').onclick = e('leaveAdd').onclick = addL;
  e('salaryRuleAdd').onclick = addSalaryRule;
  e('payrollAdd').onclick = function(){ openPayroll(); };
  e('search').oninput = function (event) {
    Q = event.target.value.trim().toLocaleLowerCase('vi');
    clearTimeout(searchTimer);
    searchTimer = setTimeout(tree, 160);
  };
  e('note').oninput = function () {
    drafts.set(D, e('note').value);
  };
  e('noteSave').onclick = function () {
    var day = D,
      text = e('note').value;
    e('noteSave').disabled = true;
    save('apiSaveDailyNote', [day, text], function () {
      if (drafts.get(day) === text) drafts.delete(day);
    }).finally(function () {
      e('noteSave').disabled = false;
    });
  };
  window.addEventListener('beforeunload', function (event) {
    if (drafts.size || pending) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
  e('apiKey').onclick = function () {
    form('Kết nối Gemini', [field('key', 'API key', '', 'password'), field('model', 'Model', 'gemini-2.5-flash')], function (values) {
      var node = e('form'),
        version = modalVersion;
      node.dataset.busy = '1';
      node.querySelector('button[type="button"]').disabled = true;
      api('apiSaveGeminiSettings', [values.key, values.model]).then(function () {
        if (version === modalVersion) close();
        gstatus();
        toast('Đã lưu API key');
      }).catch(function (error) {
        toast(error.message, true);
      }).finally(function () {
        delete node.dataset.busy;
        if (node.isConnected) node.querySelector('button[type="button"]').disabled = false;
      });
    });
  };
  e('chatSend').onclick = function () {
    if (chatting) return;
    var text = e('chatText').value;
    e('chatText').value = '';
    ask(text);
  };
  document.querySelectorAll('.chip').forEach(function (node) {
    node.onclick = function () {
      ask(node.dataset.p);
    };
  });
  function toggleDrawer(open) {
    var drawer = e('chatDrawer');
    if (!drawer) return;
    drawer.hidden = typeof open === 'boolean' ? !open : !drawer.hidden;
    if (!drawer.hidden) {
      var msgs = e('msgs');
      if (msgs) msgs.scrollTop = msgs.scrollHeight;
      var text = e('chatText');
      if (text) setTimeout(function () { text.focus(); }, 120);
    }
  }
  var closeBtn = e('chatCloseBtn'), backdrop = e('chatBackdrop');
  if (closeBtn) closeBtn.onclick = function () { toggleDrawer(false); };
  if (backdrop) backdrop.onclick = function () { toggleDrawer(false); };
  var toggleAiDesk = e('toggleAiDesktop');
  if (toggleAiDesk) toggleAiDesk.onclick = function () { toggleDrawer(); };
  var mobileAi = e('mobileAiBtn');
  if (mobileAi) mobileAi.onclick = function () { toggleDrawer(); };
  var mobileSync = e('mobileSyncBtn');
  if (mobileSync) mobileSync.onclick = function () { e('sync').click(); };
  var mobileLogout = e('mobileLogoutBtn');
  if (mobileLogout) mobileLogout.onclick = function () { e('logout').click(); };
  window.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
      var drawer = e('chatDrawer');
      if (drawer && !drawer.hidden) toggleDrawer(false);
    }
  });
  e('csv').onclick = function () {
    var rows = [['Kỳ', 'Sub-task', 'Hạn', 'Tiến độ', 'Trạng thái']];
    ss().forEach(function (x) {
      rows.push([P, x.title, x.dueDate, p(x.progress), x.status]);
    });
    var csv = rows.map(function (row) {
      return row.map(function (value) {
        var s = String(value == null ? '' : value);
        if (/^[=+@\-\t\r]/.test(s)) s = "'" + s;
        return '"' + s.replace(/"/g, '""') + '"';
      }).join(',');
    }).join('\r\n');
    var url = URL.createObjectURL(new Blob(['\uFEFF' + csv], {
        type: 'text/csv;charset=utf-8'
      })),
      a = document.createElement('a');
    a.href = url;
    a.download = 'Bao-cao-' + P + '.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 1000);
  };
  clearTimeout(startupTimer);
  var signedUser=null, pollTimer;
  async function sessionChanged(session) {
    var user=session&&session.user.id;
    if(user===signedUser)return;
    signedUser=user;clearInterval(pollTimer);
    drafts.clear();expanded.clear();ctx='';close();ready=false;
    S={kpis:[],subTasks:[],checkItems:[],urgentTasks:[],dailyNotes:[],leaves:[],resourceLinks:[],salaryRules:[],salaryBonuses:[],payrolls:[],payrollItems:[]};
    ['metrics','today','late','leaves','progress','health','tree','cal','dateItems','doneList','pendingList','urgentGrid','salaryMetrics','payrollList','salaryYear','salaryRules','salaryDoneTasks'].forEach(function(id){e(id).replaceChildren();});
    e('note').value='';e('search').value='';Q='';
    e('msgs').innerHTML='<div class="bubble">Chọn sub-task hoặc nhập câu hỏi cho Gemini.</div>';
    document.querySelectorAll('.view').forEach(function(node){node.classList.remove('active');});
    e(view).classList.add('active');
    e('authPanel').hidden=!!user;e('application').hidden=!user;startupStatus.hidden=!user;
    if(!user)return;
    startupStatus.textContent='Đang tải dữ liệu tháng '+P+'…';
    await refresh();gstatus();
    pollTimer=setInterval(checkUpdates,20000);
  }
  async function checkUpdates(){
    if(!signedUser||pending||document.hidden||!navigator.onLine)return;
    try{if(await backend.changed())await refresh();}catch(error){e('sync').textContent='Mất kết nối — bấm thử lại';}
  }
  document.addEventListener('visibilitychange',function(){if(!document.hidden)checkUpdates();});
  window.addEventListener('online',checkUpdates);
  e('loginForm').onsubmit=async function(event){event.preventDefault();e('loginButton').disabled=true;e('authMessage').textContent='Đang đăng nhập…';try{await backend.signIn(e('email').value,e('password').value);e('password').value='';e('authMessage').textContent='';}catch(error){e('authMessage').textContent=error.message;}finally{e('loginButton').disabled=false;}};
  var demoBtn = e('demoButton');
  if (demoBtn) {
    demoBtn.onclick = async function () {
      e('authMessage').textContent = 'Đang khởi tạo dữ liệu mẫu…';
      try {
        await backend.signIn('demo@flowkpi.local', 'demo');
        e('authMessage').textContent = '';
      } catch (error) {
        e('authMessage').textContent = error.message;
      }
    };
  }
  e('logout').onclick=async function(){if(drafts.size&&!confirm('Có ghi chú chưa lưu. Đăng xuất và bỏ bản nháp?'))return;try{await backend.signOut();}catch(error){toast(error.message,true);}};
  backend.initialize(sessionChanged).then(function(){startupStatus.hidden=true;}).catch(function(error){startupStatus.hidden=true;e('authMessage').textContent=error.message;e('loginButton').disabled=true;});
  function dash() {
    var K = ks(),
      T = ss(),
      C = T.flatMap(function(t){return index.checks.get(t.id)||[];}),
      late = T.filter(function (t) {
        return t.dueDate && t.dueDate < date() && !isdone(t);
      });
    e('metrics').innerHTML = '<div class="metric blue"><label>Tổng KPI</label><b>' + K.length + '</b><small>' + P + '</small></div><div class="metric green"><label>Hoàn thành</label><b>' + C.filter(isdone).length + '/' + C.length + '</b><small>Checklist đã xong</small></div><div class="metric amber"><label>Đang làm</label><b>' + T.filter(function (x) {
      return !isdone(x);
    }).length + '</b><small>Sub-task cần xử lý</small></div><div class="metric purple"><label>Việc gấp</label><b>' + S.urgentTasks.filter(function (x) {
      return !isdone(x);
    }).length + '</b><small>Yêu cầu đang mở</small></div>';
    function lines(a) {
      return a.length ? a.slice(0, 6).map(function (x) {
        return '<div class="line"><div class="grow"><b>' + esc(x.title || x.type) + '</b><span class="small">' + esc(x.dueDate || leaveRange(x)) + '</span></div></div>';
      }).join('') : empty('Không có dữ liệu');
    }
    ;
    e('today').innerHTML = lines(C.filter(function (x) {
      return x.dueDate === date() && !isdone(x);
    }));
    e('late').innerHTML = lines(late);
    e('leaves').innerHTML = lines(S.leaves.filter(function (x) {
      return x.endDate >= date();
    }));
    e('progress').innerHTML = K.length ? K.map(function (x) {
      return '<div class="pro"><span>' + esc(x.title) + '</span>' + b(x.progress, true) + '<b>' + p(x.progress) + '%</b></div>';
    }).join('') : empty('Chưa có KPI');
    var d = T.length || 1;
    e('health').innerHTML = '<div class="pro"><span>Hoàn thành</span>' + b(Math.round(T.filter(isdone).length * 100 / d), true) + '</div><div class="pro"><span>Đang xử lý</span>' + b(Math.round(T.filter(function (x) {
      return !isdone(x);
    }).length * 100 / d)) + '</div><div class="pro"><span>Quá hạn</span>' + b(Math.round(late.length * 100 / d)) + '</div>';
  }
  function report() {
    var T = ss(),
      a = T.filter(isdone),
      pending = T.filter(function (x) {
        return !isdone(x);
      });
    e('summary').textContent = P + ' · ' + a.length + '/' + T.length + ' sub-task hoàn thành';
    function it(x) {
      return '<div class="ritem"><b>' + esc(x.title) + '</b><span class="small">Hạn ' + esc(x.dueDate) + '</span>' + b(x.progress, isdone(x)) + '</div>';
    }
    e('doneList').innerHTML = a.length ? a.map(it).join('') : empty('Chưa có việc hoàn thành.');
    e('pendingList').innerHTML = pending.length ? pending.map(it).join('') : empty('Không còn việc cần xử lý.');
  }
  function completedSubTasks() {
    return ss().filter(isdone).map(function(s){
      var kpi = S.kpis.find(function(k){return k.id === s.kpiId;});
      return Object.assign({ kpiTitle: kpi ? kpi.title : '' }, s);
    });
  }
  function suggestedPay(sub) {
    var text = (sub.title + ' ' + sub.kpiTitle).toLocaleLowerCase('vi');
    var rules = (S.salaryRules || []).filter(function(r){return r.active !== false && r.type === 'keyword';});
    var found = rules.find(function(r){
      return String(r.keyword || r.title || '').trim() && text.includes(String(r.keyword || r.title).toLocaleLowerCase('vi'));
    });
    return found ? Number(found.amount) || 0 : 0;
  }
  function payrollTotal(payroll) {
    return (index.payrollItems.get(payroll.id) || []).reduce(function(sum, item){return sum + (Number(item.amount) || 0);}, 0);
  }
  function leaveDays(type) {
    return (S.leaves || []).filter(function(l){return l.type === type;}).reduce(function(sum,l){
      return sum + Math.max(1, Math.round(((new Date(l.endDate)) - (new Date(l.startDate))) / 86400000) + 1);
    }, 0);
  }
  function payrollItemLine(item) {
    return '<div class="salary-line"><span>' + esc(item.title) + '</span><strong>' + money(item.amount) + '</strong></div>';
  }
  function salary() {
    var payrolls = S.payrolls || [],
      doneSubs = completedSubTasks(),
      monthTotal = payrolls.reduce(function(sum, p){return sum + payrollTotal(p);}, 0),
      trips = leaveDays('Đi công tác'),
      leaves = leaveDays('Nghỉ phép');
    e('salarySummary').textContent = P + ' · ' + payrolls.length + ' bảng lương · ' + money(monthTotal);
    e('salaryMetrics').innerHTML = '<div class="metric green"><label>Đã tạo bảng lương</label><b>' + money(monthTotal) + '</b><small>' + P + '</small></div><div class="metric blue"><label>Sub-task xong</label><b>' + doneSubs.length + '</b><small>sẵn sàng chọn vào lương</small></div><div class="metric amber"><label>Công tác</label><b>' + trips + '</b><small>ngày</small></div><div class="metric purple"><label>Nghỉ phép</label><b>' + leaves + '</b><small>ngày</small></div>';
    e('payrollList').innerHTML = payrolls.length ? payrolls.map(function(p){
      var items = index.payrollItems.get(p.id) || [];
      return '<div class="ritem payroll-card"><b>' + esc(p.title) + '</b><span class="small">' + esc(p.period) + (p.note ? ' · ' + esc(p.note) : '') + '</span><strong>' + money(payrollTotal(p)) + '</strong><div class="payroll-items">' + (items.length ? items.map(payrollItemLine).join('') : '<span class="small">Chưa có dòng lương.</span>') + '</div><div class="row"><button class="mini" data-ep="' + esc(p.id) + '">Chỉnh sửa</button><button class="mini" data-xp="' + esc(p.id) + '">Xuất bảng lương</button><button class="mini red" data-dp="' + esc(p.id) + '">Xóa</button></div></div>';
    }).join('') : empty('Chưa tạo bảng lương tháng này.');
    e('salaryRules').innerHTML = (S.salaryRules || []).length ? S.salaryRules.map(function(r){
      return '<div class="ritem"><b>' + esc(r.title) + '</b><span class="small">' + esc(r.type || 'keyword') + (r.keyword ? ' · ' + esc(r.keyword) : '') + '</span><strong>' + money(r.amount) + '</strong><div class="row"><button class="mini" data-action="edit" data-type="SALARY_RULE" data-id="' + esc(r.id) + '">Sửa</button><button class="mini red" data-action="delete" data-type="SALARY_RULE" data-id="' + esc(r.id) + '">Xóa</button></div></div>';
    }).join('') : empty('Chưa có cấu hình lương.');
    e('salaryDoneTasks').innerHTML = doneSubs.length ? doneSubs.map(function(s){
      return '<div class="ritem"><b>' + esc(s.title) + '</b><span class="small">' + esc(s.kpiTitle) + ' · gợi ý ' + money(suggestedPay(s)) + '</span></div>';
    }).join('') : empty('Chưa có sub-task hoàn thành trong tháng.');
    e('salaryYear').innerHTML = empty('Đang tính tổng kết năm...');
    api('apiSalaryYear', [P.slice(0,4)]).then(function(y){
      e('salaryYear').innerHTML = '<div class="ritem"><b>' + esc(P.slice(0,4)) + '</b><span class="small">Sub-task: ' + (y.doneSubTasks || 0) + ' · Công tác: ' + (y.tripDays || 0) + ' ngày · Nghỉ: ' + (y.leaveDays || 0) + ' ngày</span><strong>' + money(y.totalSalary || monthTotal) + '</strong></div>';
    }).catch(function(){
      e('salaryYear').innerHTML = '<div class="ritem"><b>' + esc(P.slice(0,4)) + '</b><span class="small">Cần chạy schema.sql mới để tổng kết đủ cả năm trên Supabase.</span><strong>' + money(monthTotal) + '</strong></div>';
    });
  }
  function urgent() {
    e('urgentGrid').innerHTML = S.urgentTasks.length ? S.urgentTasks.map(function (x) {
      return '<div class="urgent"><div class="urgent-detail"><h3>' + esc(x.title) + '</h3><p>Hạn: ' + esc(x.dueDate || 'Chưa đặt') + '</p><p>' + esc(x.kpiGroup || 'Đột xuất') + ' · ' + esc(x.status) + '</p></div><div class="urgent-actions"><button class="mini" data-eu="' + esc(x.id) + '">Chỉnh sửa</button><button class="mini ok" data-cu="' + esc(x.id) + '">Hoàn thành</button><button class="mini red" data-du="' + esc(x.id) + '">Xóa</button></div></div>';
    }).join('') : empty('Chưa có việc gấp.');
  }
})();

