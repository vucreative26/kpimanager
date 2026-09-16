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
    resourceLinks: []
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
    expandedSub = new Map(),
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
    ['kpis', 'subTasks', 'checkItems', 'urgentTasks', 'dailyNotes', 'leaves', 'resourceLinks'].forEach(function (key) {
      if (!data || !Array.isArray(data[key])) throw Error('Dữ liệu trả về không hợp lệ: ' + key);
    });
    S = data;
    index.subs = group(S.subTasks, 'kpiId');
    index.checks = group(S.checkItems, 'subTaskId');
    index.links = group(S.resourceLinks, function (l) {
      return l.entityType + ':' + l.entityId;
    });
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
      urgent: urgent
    })[view]();
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
      urgent: ['Việc gấp', 'Theo dõi yêu cầu phát sinh']
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
      return '<details class="kpi" data-kpi="' + esc(k.id) + '" ' + ((expanded.has(k.id) ? expanded.get(k.id) : i === 0) ? 'open' : '') + '><summary><div class="khead"><b>' + esc(k.title) + '</b><small>' + p(k.weight) + '% trọng số</small>' + b(k.progress, true) + controls('KPI', k.id) + '<button type="button" class="mini" data-sub="' + esc(k.id) + '">+ Sub-task</button></div></summary>' + links('KPI', k.id, k.driveLink) + (subs.length ? '<div class="subs-list">' + subs.map(function (s) {
        var checks = index.checks.get(s.id) || [];
        var doneCount = checks.filter(isdone).length;
        var isSubOpen = expandedSub.has(s.id) ? expandedSub.get(s.id) : false;
        return '<details class="sub" data-subtask="' + esc(s.id) + '" ' + (isSubOpen ? 'open' : '') + '>' +
          '<summary class="sub-summary">' +
            '<div class="sub-compact-row">' +
              '<span class="sub-caret">▸</span>' +
              '<b class="grow sub-compact-title" title="' + esc(s.title) + '">' + esc(s.title) + '</b>' +
              '<span class="badge ' + (checks.length && doneCount === checks.length ? 'ok' : 'sub-count-badge') + '">' + (checks.length ? doneCount + '/' + checks.length + ' việc' : '0 việc') + '</span>' +
              '<small class="sub-date">' + esc(s.dueDate) + '</small>' +
              '<div class="sub-mini-bar">' + b(s.progress, isdone(s)) + '</div>' +
            '</div>' +
          '</summary>' +
          '<div class="sub-detail-body">' +
            '<div class="sub-expanded-head">' +
              '<div class="sub-full-title">' + esc(s.title) + '</div>' +
              '<div class="sub-actions-row">' +
                '<button type="button" class="mini ai-pill" data-ask="' + esc(s.id) + '">✦ Hỏi Gemini</button>' +
                controls('SUBTASK', s.id) +
                '<button type="button" class="mini" data-ca="' + esc(s.id) + '">+ Việc</button>' +
              '</div>' +
            '</div>' +
            b(s.progress, isdone(s)) +
            links('SUBTASK', s.id, s.driveLink) +
            '<div class="checks">' + (checks.length ? checks.map(function (c) {
              return '<div class="check"><label class="grow"><input type="checkbox" data-check="' + esc(c.id) + '" ' + (isdone(c) ? 'checked' : '') + '> ' + esc(c.title) + '</label><small>' + esc(c.dueDate) + '</small>' + controls('CHECK', c.id) + '</div>' + links('CHECK', c.id);
            }).join('') : empty('Chưa có đầu việc.')) + '</div>' +
          '</div>' +
        '</details>';
      }).join('') + '</div>' : empty('Chưa có sub-task nào.')) + '</details>';
    }).join('') : empty('Chưa có KPI phù hợp.');
    e('tree').scrollTop = scroll;
  }
  function parseLeave(l) {
    if (!l) return { type: 'Nghỉ phép', startDate: D, endDate: D, startTime: '', endTime: '', note: '' };
    var startTime = l.startTime || '';
    var endTime = l.endTime || '';
    var note = l.note || '';
    if (!startTime && !endTime && note) {
      var m = note.match(/^\[(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})\]\s*([\s\S]*)$/);
      if (m) {
        startTime = m[1];
        endTime = m[2];
        note = m[3];
      } else {
        var m2 = note.match(/^\[(\d{1,2}:\d{2})\]\s*([\s\S]*)$/);
        if (m2) {
          startTime = m2[1];
          note = m2[2];
        }
      }
    }
    return {
      id: l.id,
      type: l.type || 'Nghỉ phép',
      startDate: l.startDate || D,
      endDate: l.endDate || l.startDate || D,
      startTime: startTime,
      endTime: endTime,
      note: note
    };
  }
  function leaveTypeClass(type) {
    if (type === 'Đi công tác') return 'leave-congtac';
    if (type === 'Đào tạo') return 'leave-daotao';
    if (type === 'Việc cá nhân') return 'leave-canhan';
    return 'leave-nghi';
  }
  function leaveTypeIcon(type) {
    if (type === 'Đi công tác') return '✈️';
    if (type === 'Đào tạo') return '📚';
    if (type === 'Việc cá nhân') return '👤';
    return '🏖️';
  }
  function calendarEvents(day) {
    if (index.calendarPeriod !== P) {
      index.events = new Map();
      function put(date, item) {
        if (!index.events.has(date)) index.events.set(date, []);
        index.events.get(date).push(item);
      }
      ss().forEach(function (s) {
        put(s.dueDate, {
          title: s.title
        });
        (index.checks.get(s.id) || []).forEach(function (c) {
          put(c.dueDate, {
            title: c.title,
            check: c
          });
        });
      });
      S.urgentTasks.forEach(function (t) {
        put(t.dueDate, {
          title: 'Việc gấp: ' + t.title
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
      var dayLeaves = events.filter(function (x) { return !!x.leave; });
      var dayTasks = events.filter(function (x) { return !x.leave; });

      var leaveHtml = dayLeaves.map(function (ev) {
        var p = parseLeave(ev.leave);
        var timeLabel = p.startTime ? (p.startTime + (p.endTime ? '-' + p.endTime : '')) : '';
        var shortText = p.type + (timeLabel ? ' ' + timeLabel : '');
        return '<span class="cal-leave-pill ' + leaveTypeClass(p.type) + '" data-el="' + esc(p.id) + '" title="' + esc(p.type + (timeLabel ? ' (' + timeLabel + ')' : '') + (p.note ? ': ' + p.note : '')) + '">' +
          leaveTypeIcon(p.type) + ' <span class="cal-leave-text">' + esc(shortText) + '</span>' +
        '</span>';
      }).join('');

      var taskHtml = dayTasks.length ? '<span class="event">' + dayTasks.length + ' việc</span>' : '';

      h += '<div class="day ' + (ds === D ? 'active' : '') + '" data-day="' + ds + '" title="' + esc(events.map(function (t) {
        return t.title;
      }).join('\n')) + '">' + (ds ? '<span class="day-num">' + day + '</span>' : '') + leaveHtml + taskHtml + '</div>';
    }
    e('calTitle').textContent = 'Tháng ' + parts[1] + ' / ' + parts[0];
    e('cal').innerHTML = h;
    detail();
  }
  function detail() {
    e('dateTitle').textContent = 'Ngày ' + D.split('-').reverse().join('/');
    var items = calendarEvents(D);
    var leaves = items.filter(function (x) { return !!x.leave; });
    var tasks = items.filter(function (x) { return !x.leave; });

    var html = '';
    if (leaves.length) {
      html += '<div class="detail-section-title">Lịch cá nhân & Công tác</div>' + leaves.map(function (item) {
        var p = parseLeave(item.leave);
        var timeStr = (p.startTime || p.endTime) ? (p.startTime || '??') + ' - ' + (p.endTime || '??') : 'Cả ngày';
        var dateStr = p.startDate + (p.endDate && p.endDate !== p.startDate ? ' → ' + p.endDate : '');
        return '<div class="leave-detail-card ' + leaveTypeClass(p.type) + '">' +
          '<div class="leave-detail-top">' +
            '<span class="cal-leave-pill ' + leaveTypeClass(p.type) + '" style="cursor:default">' + leaveTypeIcon(p.type) + ' ' + esc(p.type) + '</span>' +
            '<span class="leave-time-badge">⏰ ' + esc(timeStr) + '</span>' +
          '</div>' +
          '<div class="leave-detail-date">📅 ' + esc(dateStr) + '</div>' +
          (p.note ? '<div class="leave-detail-note">' + esc(p.note) + '</div>' : '') +
          '<div class="leave-detail-actions">' +
            '<button type="button" class="mini" data-el="' + esc(p.id) + '">Sửa</button>' +
            '<button type="button" class="mini red" data-dl="' + esc(p.id) + '">Xóa</button>' +
          '</div>' +
        '</div>';
      }).join('');
    }

    if (tasks.length) {
      if (leaves.length) html += '<div class="detail-section-title" style="margin-top:12px">Công việc & Checklist</div>';
      html += tasks.map(function (item) {
        return '<div class="line">' + (item.check ? '<input type="checkbox" data-check="' + esc(item.check.id) + '" ' + (isdone(item.check) ? 'checked' : '') + '>' : '') + '<div class="grow"><b>' + esc(item.title) + '</b></div></div>';
      }).join('');
    }

    if (!leaves.length && !tasks.length) {
      html = empty('Không có mục nào');
    }

    e('dateItems').innerHTML = html;
    var note = S.dailyNotes.find(function (n) {
      return n.date === D;
    });
    e('note').value = drafts.has(D) ? drafts.get(D) : note ? note.content : '';
  }
  function close() {
    modalVersion++;
    e('modal').replaceChildren();
  }
  function field(name, label, value, type, opts, half) {
    return {
      name: name,
      label: label,
      v: value,
      type: type || 'text',
      opts: opts,
      half: !!half
    };
  }
  function form(title, fields, submit, onDelete) {
    if (!ready) return toast('Đang tải dữ liệu. Vui lòng chờ.', true);
    modalVersion++;
    e('modal').innerHTML = '<div class="modal"><form id="form" class="dialog"><h2>' + esc(title) + '</h2><div class="dialog-fields">' + fields.map(function (f) {
      var attrs = ' name="' + f.name + '"';
      var control = f.type === 'select' ? '<select' + attrs + '>' + f.opts.map(function (o) {
        return '<option ' + (o === f.v ? 'selected' : '') + '>' + esc(o) + '</option>';
      }).join('') + '</select>' : f.type === 'textarea' ? '<textarea' + attrs + '>' + esc(f.v) + '</textarea>' : '<input' + attrs + ' type="' + f.type + '" ' + (f.type === 'checkbox' ? f.v ? 'checked' : '' : 'value="' + esc(f.v) + '"') + (f.name === 'title' ? ' required' : '') + (f.type === 'number' ? ' min="0" max="100"' : '') + '>';
      return '<label class="field ' + (f.half ? 'half' : '') + '">' + esc(f.label) + control + '</label>';
    }).join('') + '</div><div class="actions">' + (onDelete ? '<button type="button" id="formDelete" class="btn danger" style="margin-right:auto">Xóa</button>' : '') + '<button type="button" id="cancel" class="btn ghost">Hủy</button><button class="btn primary">Lưu</button></div></form></div>';
    e('cancel').onclick = close;
    if (onDelete && e('formDelete')) {
      e('formDelete').onclick = function () {
        if (confirm('Xóa mục này?')) {
          close();
          onDelete();
        }
      };
    }
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
    LEAVE: ['leaves', 'Leave']
  };
  function edit(type, id) {
    var item = S[config[type][0]].find(function (x) {
      return x.id === id;
    });
    if (!item) return;
    var fields = [field('title', 'Tên', item.title)];
    if (type === 'KPI') fields.push(field('period', 'Kỳ', item.period, 'month'), field('weight', 'Trọng số (%)', item.weight, 'number'), field('note', 'Ghi chú', item.note, 'textarea'));else fields.push(field('dueDate', 'Hạn', item.dueDate, 'date'));
    if (type === 'CHECK') fields.push(field('note', 'Ghi chú', item.note, 'textarea'), field('done', 'Đã hoàn thành', isdone(item), 'checkbox'));else {
      var derived = type === 'KPI' ? (index.subs.get(id) || []).length : type === 'SUBTASK' ? (index.checks.get(id) || []).length : 0;
      if (type !== 'URGENT' && !derived) fields.push(field('progress', 'Tiến độ (%) — trạng thái tự tính', item.progress, 'number'));
      if (type === 'URGENT') fields.push(field('kpiGroup', 'Nhóm', item.kpiGroup), field('status', 'Trạng thái', item.status, 'select', ['Chưa làm', 'Đang làm', 'Hoàn thành']));
      fields.push(field('driveLink', 'Link tài liệu chính', item.driveLink, 'url'));
    }
    form(type === 'URGENT' ? 'Chi tiết việc gấp' : 'Chỉnh sửa' + (derived ? ' — tiến độ tính từ các mục con' : ''), fields, function (values) {
      save('apiUpdate' + config[type][1], [id, values]);
    }, function () {
      save('apiDelete' + config[type][1], [id]);
    });
  }
  function editL(id) {
    var item = S.leaves.find(function (l) { return l.id === id; });
    if (!item) return;
    var p = parseLeave(item);
    form('Chỉnh sửa lịch cá nhân', [
      field('type', 'Loại lịch', p.type, 'select', ['Nghỉ phép', 'Đi công tác', 'Đào tạo', 'Việc cá nhân']),
      field('startDate', 'Từ ngày', p.startDate, 'date', null, true),
      field('endDate', 'Đến ngày', p.endDate, 'date', null, true),
      field('startTime', 'Từ giờ (tùy chọn)', p.startTime, 'time', null, true),
      field('endTime', 'Đến giờ (tùy chọn)', p.endTime, 'time', null, true),
      field('note', 'Ghi chú', p.note, 'textarea')
    ], function (values) {
      var timeTag = (values.startTime || values.endTime) ? '[' + (values.startTime || '') + (values.endTime ? ' - ' + values.endTime : '') + '] ' : '';
      var cleanNote = (values.note || '').trim().replace(/^\[\d{1,2}:\d{2}(\s*[-–—]\s*\d{1,2}:\d{2})?\]\s*/, '');
      var finalNote = (timeTag + cleanNote).trim();
      save('apiUpdateLeave', [id, {
        type: values.type,
        startDate: values.startDate,
        endDate: values.endDate,
        startTime: values.startTime || '',
        endTime: values.endTime || '',
        note: finalNote
      }]);
    }, function () {
      save('apiDeleteLeave', [id]);
    });
  }
  function addK() {
    form('Tạo KPI mới', [field('title', 'Tên KPI', ''), field('period', 'Kỳ', P, 'month'), field('weight', 'Trọng số (%)', 0, 'number')], function (d) {
      save('apiAddKpi', [d.title, d.period, d.weight]);
    });
  }
  function addU() {
    form('Thêm việc gấp', [field('title', 'Tên công việc', ''), field('dueDate', 'Hạn', D, 'date'), field('kpiGroup', 'Nhóm', '')], function (d) {
      save('apiAddUrgentTask', [d]);
    });
  }
  function addL() {
    form('Thêm lịch cá nhân', [
      field('type', 'Loại lịch', 'Nghỉ phép', 'select', ['Nghỉ phép', 'Đi công tác', 'Đào tạo', 'Việc cá nhân']),
      field('startDate', 'Từ ngày', D, 'date', null, true),
      field('endDate', 'Đến ngày', D, 'date', null, true),
      field('startTime', 'Từ giờ (tùy chọn)', '', 'time', null, true),
      field('endTime', 'Đến giờ (tùy chọn)', '', 'time', null, true),
      field('note', 'Ghi chú', '', 'textarea')
    ], function (values) {
      var timeTag = (values.startTime || values.endTime) ? '[' + (values.startTime || '') + (values.endTime ? ' - ' + values.endTime : '') + '] ' : '';
      var cleanNote = (values.note || '').trim().replace(/^\[\d{1,2}:\d{2}(\s*[-–—]\s*\d{1,2}:\d{2})?\]\s*/, '');
      var finalNote = (timeTag + cleanNote).trim();
      save('apiAddLeave', [{
        type: values.type,
        startDate: values.startDate,
        endDate: values.endDate,
        startTime: values.startTime || '',
        endTime: values.endTime || '',
        note: finalNote
      }]);
    });
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
    var target = event.target.closest('button,[data-day],[data-eu],[data-el],[data-dl]');
    if (!target) return;
    var d = target.dataset;
    if (d.v) return nav(d.v);
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
    if (d.tu) {
      var item = S.urgentTasks.find(function (t) { return t.id === d.tu; });
      if (!item) return;
      var newStatus = isdone(item) ? 'Chưa làm' : 'Hoàn thành';
      return save('apiUpdateUrgentTask', [d.tu, { status: newStatus }]);
    }
    if (d.eu) return edit('URGENT', d.eu);
    if (d.el) return editL(d.el);
    if (d.dl) {
      if (confirm('Xóa lịch này?')) save('apiDeleteLeave', [d.dl]);
      return;
    }
    if (d.du) {
      if (confirm('Xóa việc gấp này?')) save('apiDeleteUrgentTask', [d.du]);
      return;
    }
    if (d.day) {
      D = d.day;
      cal();
    }
  });
  e('tree').addEventListener('toggle', function (event) {
    if (event.target.dataset.kpi) expanded.set(event.target.dataset.kpi, event.target.open);
    if (event.target.dataset.subtask) expandedSub.set(event.target.dataset.subtask, event.target.open);
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

  function downloadFile(filename, content, mimeType) {
    var blob = new Blob([content], { type: mimeType || 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function generateSqlExport(data) {
    var sql = [];
    sql.push('-- =================================================================');
    sql.push('-- FLOW KPI - DỮ LIỆU SAO LƯU / EXPORT TOÀN BỘ');
    sql.push('-- Thời gian xuất: ' + new Date().toLocaleString('vi-VN'));
    sql.push('-- HƯỚNG DẪN IMPORT SANG SUPABASE MỚI:');
    sql.push('-- 1. Trong Supabase mới: Chạy schema.sql trong SQL Editor.');
    sql.push('-- 2. Đăng ký hoặc đăng nhập tài khoản người dùng trên website mới.');
    sql.push('-- 3. Mở SQL Editor trên Supabase mới, dán toàn bộ file này và bấm RUN.');
    sql.push('-- =================================================================\n');
    sql.push('DO $$');
    sql.push('DECLARE');
    sql.push('  uid uuid := auth.uid();');
    sql.push('BEGIN');
    sql.push('  IF uid IS NULL THEN');
    sql.push('    SELECT id INTO uid FROM auth.users ORDER BY created_at ASC LIMIT 1;');
    sql.push('  END IF;\n');
    sql.push('  IF uid IS NULL THEN');
    sql.push('    RAISE EXCEPTION \'Chưa có người dùng nào trong auth.users. Vui lòng tạo tài khoản trước!\';');
    sql.push('  END IF;\n');
    
    function q(v) {
      if (v == null || v === '') return "''";
      return "'" + String(v).replace(/'/g, "''") + "'";
    }
    function qNull(v) {
      if (v == null || v === '') return 'NULL';
      return "'" + String(v).replace(/'/g, "''") + "'";
    }

    if (data.kpis && data.kpis.length) {
      sql.push('  -- 1. KPIs (' + data.kpis.length + ' dòng)');
      data.kpis.forEach(function(k) {
        sql.push('  INSERT INTO public.flow_kpis (id, user_id, title, period, weight, progress, status, "driveLink", note) VALUES (' +
          q(k.id) + ', uid, ' + q(k.title) + ', ' + q(k.period) + ', ' + (Number(k.weight) || 0) + ', ' + (Number(k.progress) || 0) + ', ' + q(k.status || 'Chưa làm') + ', ' + q(k.driveLink || '') + ', ' + q(k.note || '') +
        ') ON CONFLICT (user_id, id) DO NOTHING;');
      });
      sql.push('');
    }

    if (data.subTasks && data.subTasks.length) {
      sql.push('  -- 2. SubTasks (' + data.subTasks.length + ' dòng)');
      data.subTasks.forEach(function(s) {
        sql.push('  INSERT INTO public.flow_sub_tasks (id, user_id, "kpiId", title, "dueDate", progress, status, "driveLink", emergency) VALUES (' +
          q(s.id) + ', uid, ' + q(s.kpiId) + ', ' + q(s.title) + ', ' + qNull(s.dueDate) + ', ' + (Number(s.progress) || 0) + ', ' + q(s.status || 'Chưa làm') + ', ' + q(s.driveLink || '') + ', ' + (s.emergency ? 'true' : 'false') +
        ') ON CONFLICT (user_id, id) DO NOTHING;');
      });
      sql.push('');
    }

    if (data.checkItems && data.checkItems.length) {
      sql.push('  -- 3. CheckItems (' + data.checkItems.length + ' dòng)');
      data.checkItems.forEach(function(c) {
        sql.push('  INSERT INTO public.flow_check_items (id, user_id, "subTaskId", title, "dueDate", note, done) VALUES (' +
          q(c.id) + ', uid, ' + q(c.subTaskId) + ', ' + q(c.title) + ', ' + qNull(c.dueDate) + ', ' + q(c.note || '') + ', ' + (c.done ? 'true' : 'false') +
        ') ON CONFLICT (user_id, id) DO NOTHING;');
      });
      sql.push('');
    }

    if (data.urgentTasks && data.urgentTasks.length) {
      sql.push('  -- 4. UrgentTasks (' + data.urgentTasks.length + ' dòng)');
      data.urgentTasks.forEach(function(u) {
        sql.push('  INSERT INTO public.flow_urgent_tasks (id, user_id, title, "dueDate", "kpiGroup", status, "driveLink") VALUES (' +
          q(u.id) + ', uid, ' + q(u.title) + ', ' + qNull(u.dueDate) + ', ' + q(u.kpiGroup || 'Đột xuất') + ', ' + q(u.status || 'Đang làm') + ', ' + q(u.driveLink || '') +
        ') ON CONFLICT (user_id, id) DO NOTHING;');
      });
      sql.push('');
    }

    if (data.dailyNotes && data.dailyNotes.length) {
      sql.push('  -- 5. DailyNotes (' + data.dailyNotes.length + ' dòng)');
      data.dailyNotes.forEach(function(n) {
        sql.push('  INSERT INTO public.flow_daily_notes (id, user_id, date, content) VALUES (' +
          q(n.id || 'not-' + n.date) + ', uid, ' + q(n.date) + ', ' + q(n.content || '') +
        ') ON CONFLICT (user_id, date) DO UPDATE SET content = EXCLUDED.content;');
      });
      sql.push('');
    }

    if (data.leaves && data.leaves.length) {
      sql.push('  -- 6. Leaves (' + data.leaves.length + ' dòng)');
      data.leaves.forEach(function(l) {
        sql.push('  INSERT INTO public.flow_leaves (id, user_id, "startDate", "endDate", type, note, "startTime", "endTime") VALUES (' +
          q(l.id) + ', uid, ' + q(l.startDate) + ', ' + q(l.endDate) + ', ' + q(l.type || 'Nghỉ phép') + ', ' + q(l.note || '') + ', ' + q(l.startTime || '') + ', ' + q(l.endTime || '') +
        ') ON CONFLICT (id) DO NOTHING;');
      });
      sql.push('');
    }

    if (data.resourceLinks && data.resourceLinks.length) {
      sql.push('  -- 7. ResourceLinks (' + data.resourceLinks.length + ' dòng)');
      data.resourceLinks.forEach(function(r) {
        sql.push('  INSERT INTO public.flow_resource_links (id, user_id, "kpiId", "subTaskId", "checkItemId", label, url) VALUES (' +
          q(r.id) + ', uid, ' + qNull(r.kpiId) + ', ' + qNull(r.subTaskId) + ', ' + qNull(r.checkItemId) + ', ' + q(r.label || 'Tài liệu') + ', ' + q(r.url) +
        ') ON CONFLICT (id) DO NOTHING;');
      });
      sql.push('');
    }

    sql.push('  RAISE NOTICE \'Khôi phục thành công toàn bộ dữ liệu Flow KPI!\';');
    sql.push('END $$;');
    return sql.join('\n');
  }

  function openDataManageModal() {
    if (!ready) return toast('Đang tải dữ liệu. Vui lòng chờ.', true);
    modalVersion++;
    e('modal').innerHTML = '<div class="modal"><div class="dialog data-dialog">' +
      '<h2>Quản lý dữ liệu & Sao lưu</h2>' +
      '<div class="data-section">' +
        '<div class="data-section-title">📤 Xuất dữ liệu sang Database mới</div>' +
        '<p class="data-desc">Tải toàn bộ dữ liệu (tất cả các tháng) để lưu trữ dự phòng hoặc chuyển sang dự án Supabase mới.</p>' +
        '<div class="export-grid">' +
          '<button type="button" id="btnExpJson" class="btn ghost">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>' +
            'Xuất file JSON' +
          '</button>' +
          '<button type="button" id="btnExpSql" class="btn primary">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>' +
            'Xuất file SQL (Supabase mới)' +
          '</button>' +
        '</div>' +
      '</div>' +
      '<hr class="data-divider">' +
      '<div class="data-section">' +
        '<div class="data-section-title danger">🗑️ Xóa dữ liệu có kiểm soát</div>' +
        '<p class="data-desc">Chọn xóa theo từng tháng hoặc từng ngày (hệ thống không cho phép xóa sạch toàn bộ 1 lần để bảo vệ dữ liệu).</p>' +
        '<div class="scope-select-box">' +
          '<div class="scope-row">' +
            '<label class="scope-option">' +
              '<input type="radio" name="delScope" value="month" checked>' +
              '<span>Xóa theo <b>Tháng</b> (KPI, sub-tasks, việc gấp, ghi chú)</span>' +
            '</label>' +
            '<input type="month" id="delScopeMonth" class="scope-target-input" value="' + esc(P) + '">' +
          '</div>' +
          '<div class="scope-row">' +
            '<label class="scope-option">' +
              '<input type="radio" name="delScope" value="day">' +
              '<span>Xóa theo <b>Ngày cụ thể</b> (công việc, ghi chú, lịch)</span>' +
            '</label>' +
            '<input type="date" id="delScopeDay" class="scope-target-input" value="' + esc(D) + '" disabled>' +
          '</div>' +
        '</div>' +
        '<div class="pwd-box">' +
          '<label class="field" style="margin:0">' +
            '<span>🔒 Nhập mật khẩu tài khoản để xác nhận xóa:</span>' +
            '<input type="password" id="delConfirmPwd" placeholder="Nhập mật khẩu đăng nhập..." autocomplete="current-password">' +
          '</label>' +
          '<span class="pwd-warning">⚠️ Dữ liệu sau khi xóa sẽ không thể khôi phục. Hãy xuất file sao lưu trước khi thực hiện!</span>' +
        '</div>' +
      '</div>' +
      '<div class="actions">' +
        '<button type="button" id="btnCancelData" class="btn ghost">Đóng</button>' +
        '<button type="button" id="btnDoDelete" class="btn danger">Xác nhận Xóa</button>' +
      '</div>' +
    '</div></div>';

    var scopeRadios = document.querySelectorAll('input[name="delScope"]');
    var monthInput = e('delScopeMonth');
    var dayInput = e('delScopeDay');
    scopeRadios.forEach(function (r) {
      r.onchange = function () {
        monthInput.disabled = r.value !== 'month';
        dayInput.disabled = r.value !== 'day';
      };
    });

    e('btnCancelData').onclick = close;

    e('btnExpJson').onclick = async function () {
      try {
        e('btnExpJson').disabled = true;
        e('btnExpJson').textContent = 'Đang tải…';
        var data = await backend.exportAllData();
        var content = JSON.stringify({
          app: 'Flow-KPI',
          exportedAt: new Date().toISOString(),
          data: data
        }, null, 2);
        downloadFile('flow-kpi-backup-' + date() + '.json', content, 'application/json');
        toast('Đã xuất file JSON thành công!');
      } catch (err) {
        toast('Lỗi xuất dữ liệu: ' + err.message, true);
      } finally {
        e('btnExpJson').disabled = false;
        e('btnExpJson').innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>Xuất file JSON';
      }
    };

    e('btnExpSql').onclick = async function () {
      try {
        e('btnExpSql').disabled = true;
        e('btnExpSql').textContent = 'Đang tạo SQL…';
        var data = await backend.exportAllData();
        var sqlContent = generateSqlExport(data);
        downloadFile('flow-kpi-import-' + date() + '.sql', sqlContent, 'application/sql');
        toast('Đã tạo file SQL thành công! Bạn có thể chạy trong SQL Editor của Supabase mới.');
      } catch (err) {
        toast('Lỗi tạo file SQL: ' + err.message, true);
      } finally {
        e('btnExpSql').disabled = false;
        e('btnExpSql').innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>Xuất file SQL (Supabase mới)';
      }
    };

    e('btnDoDelete').onclick = async function () {
      var selScope = document.querySelector('input[name="delScope"]:checked').value;
      var target = selScope === 'month' ? monthInput.value : dayInput.value;
      if (!target) return toast('Vui lòng chọn ' + (selScope === 'month' ? 'tháng' : 'ngày') + ' cần xóa.', true);

      var pwd = e('delConfirmPwd').value.trim();
      if (!pwd) return toast('Vui lòng nhập mật khẩu tài khoản để xác nhận xóa!', true);

      var labelTarget = selScope === 'month' ? 'tháng ' + target : 'ngày ' + target;
      if (!confirm('CẢNH BÁO: Bạn có CHẮC CHẮN muốn xóa toàn bộ dữ liệu của ' + labelTarget + '?\n\nThao tác này KHÔNG THỂ khôi phục!')) return;

      var btn = e('btnDoDelete');
      btn.disabled = true;
      btn.textContent = 'Đang xác thực…';

      try {
        await backend.verifyPassword(pwd);
        btn.textContent = 'Đang xóa dữ liệu…';
        await backend.deleteScope(selScope, target, P);
        close();
        await refresh();
        toast('Đã xóa thành công toàn bộ dữ liệu của ' + labelTarget + '!');
      } catch (err) {
        toast(err.message, true);
        btn.disabled = false;
        btn.textContent = 'Xác nhận Xóa';
      }
    };
  }

  var dataManageBtn = e('dataManageBtn');
  if (dataManageBtn) dataManageBtn.onclick = openDataManageModal;
  var dataManageReportBtn = e('dataManageReportBtn');
  if (dataManageReportBtn) dataManageReportBtn.onclick = openDataManageModal;
  var mobileDataBtn = e('mobileDataBtn');
  if (mobileDataBtn) mobileDataBtn.onclick = openDataManageModal;

  clearTimeout(startupTimer);
  var signedUser=null, pollTimer;
  async function sessionChanged(session) {
    var user=session&&session.user.id;
    if(user===signedUser)return;
    signedUser=user;clearInterval(pollTimer);
    drafts.clear();expanded.clear();expandedSub.clear();ctx='';close();ready=false;
    S={kpis:[],subTasks:[],checkItems:[],urgentTasks:[],dailyNotes:[],leaves:[],resourceLinks:[]};
    ['metrics','today','late','leaves','progress','health','tree','cal','dateItems','doneList','pendingList','urgentGrid'].forEach(function(id){e(id).replaceChildren();});
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
        return '<div class="line"><div class="grow"><b>' + esc(x.title || x.type) + '</b><span class="small">' + esc(x.dueDate || x.startDate + ' → ' + x.endDate) + '</span></div></div>';
      }).join('') : empty('Không có dữ liệu');
    }
    ;
    e('today').innerHTML = lines(C.filter(function (x) {
      return x.dueDate === date() && !isdone(x);
    }));
    e('late').innerHTML = lines(late);
    e('leaves').innerHTML = S.leaves.length ? S.leaves.filter(function (x) {
      return x.endDate >= date();
    }).slice(0, 6).map(function (x) {
      var p = parseLeave(x);
      var timeStr = (p.startTime || p.endTime) ? ' (' + (p.startTime || '') + (p.endTime ? '-' + p.endTime : '') + ')' : '';
      return '<div class="line"><div class="grow"><b>' + leaveTypeIcon(p.type) + ' ' + esc(p.type) + esc(timeStr) + '</b><span class="small">' + esc(p.startDate + (p.endDate !== p.startDate ? ' → ' + p.endDate : '')) + (p.note ? ' · ' + esc(p.note) : '') + '</span></div></div>';
    }).join('') : empty('Không có dữ liệu');
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
  function urgent() {
    e('urgentGrid').innerHTML = S.urgentTasks.length ? S.urgentTasks.map(function (x) {
      var done = isdone(x);
      return '<div class="urgent-tile ' + (done ? 'is-done' : '') + '" data-eu="' + esc(x.id) + '" role="button" tabindex="0">' +
        '<div class="urgent-tile-top">' +
          '<span class="urgent-group-badge">' + esc(x.kpiGroup || 'Đột xuất') + '</span>' +
          '<button type="button" class="urgent-complete-btn ' + (done ? 'done' : '') + '" data-tu="' + esc(x.id) + '" title="' + (done ? 'Đánh dấu chưa xong' : 'Đánh dấu hoàn thành') + '">' +
            (done ? '✓ Đã xong' : '○ Hoàn thành') +
          '</button>' +
        '</div>' +
        '<div class="urgent-tile-title ' + (done ? 'done-text' : '') + '" title="' + esc(x.title) + '">' + esc(x.title) + '</div>' +
        '<div class="urgent-tile-bottom">' +
          '<span class="urgent-due-text">📅 ' + esc(x.dueDate || 'Chưa đặt hạn') + '</span>' +
          '<button type="button" class="urgent-view-more" data-eu="' + esc(x.id) + '">Chi tiết ›</button>' +
        '</div>' +
      '</div>';
    }).join('') : empty('Chưa có việc gấp.');
  }
})();
