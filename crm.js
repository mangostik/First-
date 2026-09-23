/* ================= DATA LAYER ================= */
const STORAGE_KEY = 'fishCRM_v4';

function uid() { return crypto.randomUUID(); }
function todayStr() { const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function nowTimeStr() { const d = new Date(); return d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0'); }
function fmtDate(s) { const [y,m,d] = s.split('-'); return `${d}.${m}.${y}`; }
function fmtMoney(n) { return Number(n || 0).toLocaleString('ru-RU', {maximumFractionDigits: 2}) + ' ₾'; }
function fmtKg(n) { return Number(n || 0).toLocaleString('ru-RU', {maximumFractionDigits: 2}) + ' кг'; }

const TERMINAL_PRODUCT_NAMES = [
  'Джерки из лосося', 'FISH DOG', 'FISH Burger', 'Стейк лосося', 'Стейки форели охлаждённые',
  'Котлеты RedFish, 100% премиальное мясо', 'Рубленые котлеты из сибаса',
  'Слабосолёная сёмга, нарезка', 'Слабосолёная форель, нарезка', 'Слабосолёная нарезка (ГРАВЛАКС)',
  'Слабосолёное филе (ГРАВЛАКС)', 'Слабосолёное филе сёмги на шкурке', 'Слабосолёное филе форели на шкурке'
];

const sb=makeClient();
let DB=emptyData();
let session = { userId: null, view: 'dashboard', workerSub: null };

function getUser(id) { return DB.users.find(u => u.id === id); }
function getProduct(id) { return DB.products.find(p => p.id === id); }
function getCounterparty(id) { return DB.counterparties.find(c => c.id === id); }
function getCompany(id) { return DB.companies.find(c => c.id === id); }
function isReceivable(p) { return canReceiveProduct(p); }
function isTerminalProduct(p) { return !!p.isTerminal; }

/* ================= TOAST ================= */
function showToast(msg) {
  const root = document.getElementById('toastRoot');
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => el.remove(), 2400);
}

/* ================= SEARCHABLE SELECT ================= */
function searchableSelectHtml(id, fieldName, selectedLabel, placeholder, selectedId) {
  return `
    <div class="searchable-select" data-searchable-select="${esc(id)}">
      <input type="search" class="searchable-select-input" id="${esc(id)}_input"
        value="${esc(selectedLabel || '')}" placeholder="${esc(placeholder || 'Начните вводить…')}"
        autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false"
        aria-controls="${esc(id)}_list">
      <input type="hidden" id="${esc(id)}" name="${esc(fieldName)}" value="${esc(selectedId || '')}" required>
      <div class="searchable-select-list" id="${esc(id)}_list" role="listbox" hidden></div>
    </div>`;
}

function initSearchableSelect(id, options, onSelect, addNewLabel, onAddNew) {
  const input = document.getElementById(id + '_input');
  const hidden = document.getElementById(id);
  const list = document.getElementById(id + '_list');
  if (!input || !hidden || !list) return;
  let visible = [];
  let activeIndex = -1;

  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    activeIndex = -1;
  };
  const choose = option => {
    hidden.value = option.id;
    input.value = option.label;
    close();
    onSelect?.(option);
  };
  const activate = index => {
    const rows = [...list.querySelectorAll('[data-option-index]')];
    if (!rows.length) return;
    activeIndex = (index + rows.length) % rows.length;
    rows.forEach((row, rowIndex) => row.classList.toggle('active', rowIndex === activeIndex));
    input.setAttribute('aria-activedescendant', rows[activeIndex].id);
    rows[activeIndex].scrollIntoView({block: 'nearest'});
  };
  const render = query => {
    const normalized = String(query || '').trim().toLocaleLowerCase('ru');
    visible = options.filter(option => !normalized ||
      option.label.toLocaleLowerCase('ru').includes(normalized) ||
      String(option.sub || '').toLocaleLowerCase('ru').includes(normalized)).slice(0, 30);
    list.innerHTML = safeHTML(visible.map((option, index) => `
      <button type="button" class="searchable-select-option" role="option"
        id="${esc(id)}_option_${index}" data-option-index="${index}">
        <span>${esc(option.label)}</span>${option.sub ? `<small>${esc(option.sub)}</small>` : ''}
      </button>`).join('') +
      (!visible.length ? '<div class="searchable-select-empty">Ничего не найдено</div>' : '') +
      (addNewLabel ? `<button type="button" class="searchable-select-option add-new" data-add-new>+ ${esc(addNewLabel)}</button>` : ''));
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    activeIndex = -1;
    list.querySelectorAll('[data-option-index]').forEach(button => {
      button.addEventListener('mousedown', event => event.preventDefault());
      button.addEventListener('click', () => choose(visible[Number(button.dataset.optionIndex)]));
    });
    const addButton = list.querySelector('[data-add-new]');
    addButton?.addEventListener('mousedown', event => event.preventDefault());
    addButton?.addEventListener('click', () => { close(); onAddNew?.(input.value.trim()); });
  };

  input.addEventListener('focus', () => render(''));
  input.addEventListener('input', () => { hidden.value = ''; render(input.value); });
  input.addEventListener('blur', () => setTimeout(close, 150));
  input.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (list.hidden) render(input.value);
      activate(activeIndex + (event.key === 'ArrowDown' ? 1 : -1));
    } else if (event.key === 'Enter' && activeIndex >= 0) {
      event.preventDefault();
      choose(visible[activeIndex]);
    } else if (event.key === 'Escape') close();
  });
}

/* ================= MODAL ================= */
function openModal(html) {
  document.getElementById('modalRoot').innerHTML = safeHTML(`
    <div class="modal-overlay" id="modalOverlay">
      <div class="modal-box">
        <button class="modal-close" id="modalCloseBtn">&times;</button>
        ${html}
      </div>
    </div>`);
  document.getElementById('modalCloseBtn').onclick = closeModal;
  document.getElementById('modalOverlay').addEventListener('mousedown', e => { if (e.target.id === 'modalOverlay') closeModal(); });
}
function closeModal() { document.getElementById('modalRoot').innerHTML = safeHTML(''); }

/* ================= AUTH ================= */
let authLinkRequiresPassword=['invite','recovery'].includes(window.FISHCRM_AUTH_LINK_TYPE);
let authSetupRendered=false;
function clearAuthLink(){
 if(typeof history!=='undefined'&&typeof location!=='undefined')history.replaceState(null,'',location.pathname);
 window.FISHCRM_AUTH_LINK_TYPE='';
}
function renderPasswordSetup(user){
 authSetupRendered=true;
 document.getElementById('app').style.display='none';
 const screen=document.getElementById('loginScreen');screen.style.display='flex';
 screen.innerHTML=safeHTML(`<div class="login-box"><div class="title">🐟 FishCRM</div><div class="subtitle">Установите пароль для входа</div>
 <form id="passwordSetupForm"><div class="field"><label for="newPassInput">Новый пароль</label><input id="newPassInput" type="password" minlength="8" autocomplete="new-password" required></div>
 <div class="field"><label for="newPassRepeat">Повторите пароль</label><input id="newPassRepeat" type="password" minlength="8" autocomplete="new-password" required></div>
 <button class="btn-primary" type="submit">Сохранить пароль</button><p id="passwordSetupError" role="alert"></p></form></div>`);
 document.getElementById('passwordSetupForm').addEventListener('submit',async e=>{
   e.preventDefault();const button=e.target.querySelector('button');button.disabled=true;
   const password=document.getElementById('newPassInput').value;
   const repeat=document.getElementById('newPassRepeat').value;
   const errorBox=document.getElementById('passwordSetupError');
   try{
     if(password.length<8)throw new Error('Пароль должен содержать не менее 8 символов.');
     if(password!==repeat)throw new Error('Пароли не совпадают.');
     const {error}=await sb.auth.updateUser({password});
     if(error)throw error;
     authLinkRequiresPassword=false;clearAuthLink();
     await doLogin(user.id);
   }catch(err){errorBox.textContent=err.message||'Не удалось сохранить пароль.';}
   finally{button.disabled=false;}
 });
}
function renderLogin() {
 document.getElementById('app').style.display='none';
 const screen=document.getElementById('loginScreen');screen.style.display='flex';
 screen.innerHTML=safeHTML(`<div class="login-box"><div class="title">🐟 FishCRM</div><div class="subtitle">Учёт производства рыбопереработки</div>
 <form id="loginForm"><div class="field"><label for="loginInput">Email</label><input id="loginInput" type="email" autocomplete="username" required></div>
 <div class="field"><label for="passInput">Пароль</label><input id="passInput" type="password" autocomplete="current-password" required></div>
 <button class="btn-primary" type="submit">Войти</button><p id="loginError" role="alert"></p></form></div>`);
 if(!sb)document.getElementById('loginError').textContent='Подключение не настроено. Заполните config.js для тестового проекта.';
 document.getElementById('loginForm').addEventListener('submit',async e=>{
   e.preventDefault();const button=e.target.querySelector('button');button.disabled=true;
   try{
     if(!sb)throw new Error('Подключение не настроено');
     const {data,error}=await sb.auth.signInWithPassword({email:document.getElementById('loginInput').value.trim(),password:document.getElementById('passInput').value});
     if(error)throw new Error('Не удалось войти. Проверьте email и пароль.');
     await doLogin(data.user.id);
   }catch(err){document.getElementById('loginError').textContent=err.message;}
   finally{button.disabled=false;}
 });
}
async function doLogin(userId){
 DB=await loadData();const user=getUser(userId);
 if(!user){await sb.auth.signOut();throw new Error('Для аккаунта не назначен активный профиль. Обратитесь к владельцу.');}
 session.userId=userId;session.view=VIEW_ROLES[user.role][0];
 document.getElementById('loginScreen').style.display='none';document.getElementById('app').style.display='flex';render();
}
async function doLogout(){
 const {error}=await sb.auth.signOut();if(error){showToast(error.message);return;}
 DB=emptyData();snapshot=emptyData();session={userId:null,view:'dashboard',workerSub:null};closeModal();renderLogin();
}
/* ================= ROUTER / RENDER ================= */
function render() {
  const user = getUser(session.userId);
  if (!user) { renderLogin(); return; }
  if(!canView(session.view))session.view=VIEW_ROLES[user.role][0];
  if (user.role !== 'worker') renderAdmin(user);
  else renderWorker(user);
}

/* ================= ADMIN LAYOUT ================= */
const ADMIN_NAV = [
  { key: 'dashboard', label: 'Дашборд', icon: '📊' },
  { key: 'receiving', label: 'Приёмка', icon: '📥' },
  { key: 'processing', label: 'Переработка / выход', icon: '🔪' },
  { key: 'warehouse', label: 'Склад', icon: '📦' },
  { key: 'workers', label: 'Работники и время', icon: '👷' },
  { key: 'counterparties', label: 'Контрагенты', icon: '🤝' },
  { key: 'orders', label: 'Заказы', icon: '🧾' },
  { key: 'productReport', label: 'Отчёт по товарам', icon: '📈' },
  { key: 'marketing', label: 'Маркетинг', icon: '📣' },
  { key: 'products', label: 'Товары и цены', icon: '🏷️' },{key:'audit',label:'Журнал действий',icon:'📋'},{key:'recipes',label:'Рецептуры',icon:'📖'}
];

function renderAdmin(user) {
  const app = document.getElementById('app');
  app.innerHTML = safeHTML(`
    <div class="sidebar-overlay" id="sidebarOverlay"></div>
    <div id="sidebar">
      <div class="logo">🐟 FishCRM</div>
      ${ADMIN_NAV.filter(n=>canView(n.key)).map(n => `
        <div class="nav-item ${session.view === n.key ? 'active' : ''}" data-nav="${n.key}">
          <span>${n.icon}</span><span>${n.label}</span>
        </div>
      `).join('')}
      <div class="nav-spacer"></div>
      <div class="user-box">
        <div class="name">${esc(user.name)}</div>
        <div class="role">${esc(user.role)}</div>
        <button class="btn-secondary btn-sm" style="width:100%;" id="logoutBtn">Выйти</button>
      </div>
    </div>
    <div id="main">
      <div id="topbar">
        <div style="display:flex; align-items:center; gap:10px;">
          <button id="hamburgerBtn">☰</button>
          <h1>${ADMIN_NAV.find(n => n.key === session.view)?.label || ''}</h1>
        </div>
        <div style="color:var(--text-muted); font-size:13px;">${fmtDate(todayStr())}</div>
      </div>
      <div id="content"></div>
    </div>
  `);
  app.querySelectorAll('[data-nav]').forEach(el => {
    el.addEventListener('click', () => {
      session.view = el.dataset.nav;
      document.getElementById('sidebar').classList.remove('mobile-open');
      document.getElementById('sidebarOverlay').classList.remove('active');
      render();
    });
  });
  document.getElementById('logoutBtn').addEventListener('click', doLogout);
  document.getElementById('hamburgerBtn').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('mobile-open');
    document.getElementById('sidebarOverlay').classList.toggle('active');
  });
  document.getElementById('sidebarOverlay').addEventListener('click', () => {
    document.getElementById('sidebar').classList.remove('mobile-open');
    document.getElementById('sidebarOverlay').classList.remove('active');
  });

  const content = document.getElementById('content');
  switch (session.view) {
    case 'dashboard': content.innerHTML = safeHTML(viewDashboard()); bindDashboardEvents(); break;
    case 'receiving': content.innerHTML = safeHTML(viewReceiving()); bindReceivingEvents(); break;
    case 'processing': content.innerHTML = safeHTML(viewProcessing()); bindProcessingEvents(); break;
    case 'warehouse': content.innerHTML = safeHTML(viewWarehouse()); bindWarehouseEvents(); break;
    case 'workers': content.innerHTML = safeHTML(viewWorkers()); bindWorkersEvents(); break;
    case 'counterparties': content.innerHTML = safeHTML(viewCounterparties()); bindCounterpartiesEvents(); break;
    case 'orders': content.innerHTML = safeHTML(viewOrders()); bindOrdersEvents(); break;
    case 'productReport': content.innerHTML = safeHTML(viewProductReport()); bindProductReportEvents(); break;
    case 'marketing': content.innerHTML = safeHTML(viewMarketing()); bindMarketingEvents(); break;
    case 'recipes': content.innerHTML=safeHTML(viewRecipes());bindRecipes();break;
    case 'audit': content.innerHTML=safeHTML(viewAudit());break;
    case 'products': content.innerHTML = safeHTML(viewProducts()); bindProductsEvents(); break;
  }
}

/* ============ DASHBOARD ============ */
let dashboardRange = { from: todayStr(), to: todayStr() };
function viewDashboard() {
  const today = todayStr();
  const todayReceivings = DB.receivings.filter(r => r.date === today);
  const todayVolume = todayReceivings.reduce((s, r) => s + Number(r.volumeKg), 0);
  const todayReceivingCost = todayReceivings.reduce((s, r) => s + Number(r.volumeKg) * Number(r.purchasePrice), 0);
  const todayProcessing = DB.processing.filter(p => p.date === today);
  const todayOut1 = todayProcessing.reduce((s, p) => s + Number(p.output1Qty || 0), 0);
  const todayOut2 = todayProcessing.reduce((s, p) => s + Number(p.output2Qty || 0), 0);
  const thisMonth = today.slice(0, 7);
  const monthOrders = DB.orders.filter(o => isPosted(o) && o.date.slice(0, 7) === thisMonth);
  const monthRevenue = monthOrders.reduce((s, o) => s + orderTotal(o), 0);
  const activeWorkers = DB.users.filter(u => u.role === 'worker').length;

  // Финансы за выбранный период (по умолчанию — сегодня), можно выбрать любой день или диапазон
  const { from, to } = dashboardRange;
  const periodOrders = DB.orders.filter(o => isPosted(o) && o.date >= from && o.date <= to);
  const periodRevenue = periodOrders.reduce((s, o) => s + orderTotal(o), 0);
  const periodCOGS = periodOrders.reduce((s, o) => s + o.items.reduce((s2, it) => {
    const p = getProduct(it.productId);
    return s2 + Number(it.qty) * Number(it.cost_price || 0);
  }, 0), 0);
  const periodPayroll = DB.timeEntries.filter(t => t.date >= from && t.date <= to && t.earnings != null).reduce((s, t) => s + Number(t.earnings), 0);
  const periodDelivery = periodOrders.reduce((s, o) => s + Number(o.deliveryCost || 0), 0);
  const periodNetProfit = periodRevenue - periodCOGS - periodPayroll - periodDelivery;
  const periodVAT = periodOrders.reduce((s, o) => s + orderVAT(o), 0);
  const monthVAT = monthOrders.reduce((s, o) => s + orderVAT(o), 0);
  const unpaidOrders = DB.orders.filter(o => !o.paid && isPosted(o));
  const unpaidTotal = unpaidOrders.reduce((s, o) => s + orderGrandTotal(o), 0);
  const isSingleDay = from === to;
  const periodLabel = isSingleDay ? (from === today ? 'сегодня' : fmtDate(from)) : `${fmtDate(from)} — ${fmtDate(to)}`;

  const recentReceivings = [...DB.receivings].sort((a,b) => b.date.localeCompare(a.date)).slice(0, 6);

  return `
    <div class="card" style="border-left: 4px solid ${periodNetProfit >= 0 ? 'var(--success)' : 'var(--danger)'};">
      <div class="card-header"><h2>Финансы: ${periodLabel}</h2></div>
      <div class="row" style="align-items:flex-end;">
        <div class="field"><label>С даты</label><input type="date" id="dashFrom" value="${from}"></div>
        <div class="field"><label>По дату</label><input type="date" id="dashTo" value="${to}"></div>
        <div class="field"><button class="btn-primary" id="dashApply">Показать</button></div>
        <div class="field"><button class="btn-secondary" id="dashToday">Сегодня</button></div>
        <div class="field"><button class="btn-secondary" id="dashWeek">Последние 7 дней</button></div>
      </div>
      <div class="stat-grid">
        <div class="stat-card"><div class="stat-label">Выручка</div><div class="stat-value">${fmtMoney(periodRevenue)}</div><div class="stat-sub">${periodOrders.length} заказов</div></div>
        <div class="stat-card" style="border-left-color: var(--danger);"><div class="stat-label">Себестоимость проданного</div><div class="stat-value">${fmtMoney(periodCOGS)}</div></div>
        <div class="stat-card" style="border-left-color: #de6f8e;"><div class="stat-label">Зарплата за смены</div><div class="stat-value">${fmtMoney(periodPayroll)}</div></div>
        <div class="stat-card" style="border-left-color: var(--danger);"><div class="stat-label">Доставка</div><div class="stat-value">${fmtMoney(periodDelivery)}</div></div>
        <div class="stat-card" style="border-left-color: ${periodNetProfit >= 0 ? 'var(--success)' : 'var(--danger)'};"><div class="stat-label">Чистая прибыль</div><div class="stat-value" style="color:${periodNetProfit >= 0 ? 'var(--success)' : 'var(--danger)'};">${fmtMoney(periodNetProfit)}</div></div>
      </div>
      <p style="color:var(--text-muted); font-size:12px; margin: 8px 0 0;">Прибыль = выручка − себестоимость проданных товаров (по зафиксированной себестоимости) − начисленная зарплата за период − доставка. Закупка сырья на затраты не влияет напрямую — она входит в себестоимость только когда товар продан.</p>
      <div class="stat-grid" style="margin-top:10px;">
        <div class="stat-card"><div class="stat-label">НДС начислено за период</div><div class="stat-value">${fmtMoney(periodVAT)}</div></div>
        <div class="stat-card"><div class="stat-label">НДС начислено за месяц</div><div class="stat-value">${fmtMoney(monthVAT)}</div></div>
      </div>
    </div>
    <div class="stat-grid">
      <div class="stat-card"><div class="stat-label">Приёмка сегодня</div><div class="stat-value">${fmtKg(todayVolume)}</div><div class="stat-sub">${todayReceivings.length} партий, ${fmtMoney(todayReceivingCost)}</div></div>
      <div class="stat-card" style="border-left-color: var(--accent);"><div class="stat-label">Переработка: выход 1 сегодня</div><div class="stat-value">${fmtKg(todayOut1)}</div></div>
      <div class="stat-card" style="border-left-color: #7a5cd1;"><div class="stat-label">Переработка: выход 2 сегодня</div><div class="stat-value">${fmtKg(todayOut2)}</div></div>
      <div class="stat-card" style="border-left-color: var(--success);"><div class="stat-label">Выручка за месяц</div><div class="stat-value">${fmtMoney(monthRevenue)}</div><div class="stat-sub">${monthOrders.length} заказов</div></div>
      <div class="stat-card" style="border-left-color: ${unpaidOrders.length ? 'var(--danger)' : 'var(--success)'};"><div class="stat-label">Неоплаченных заказов</div><div class="stat-value">${unpaidOrders.length}</div><div class="stat-sub">${fmtMoney(unpaidTotal)}</div></div>
      <div class="stat-card" style="border-left-color: #de6f8e;"><div class="stat-label">Работники</div><div class="stat-value">${activeWorkers}</div></div>
    </div>
    <div class="card">
      <div class="card-header"><h2>Последние приёмки</h2></div>
      ${recentReceivings.length === 0 ? '<div class="empty-state">Пока нет данных о приёмке рыбы</div>' : `
      <div class="table-wrap"><table>
        <thead><tr><th>Дата</th><th>Товар</th><th>Объём</th><th>Работник</th><th>Закуп. цена</th></tr></thead>
        <tbody>
          ${recentReceivings.map(r => {
            const p = getProduct(r.productId); const w = getUser(r.workerId);
            return `<tr><td>${fmtDate(r.date)}</td><td>${p ? p.emoji + ' ' + esc(p.name) : '—'}</td><td>${fmtKg(r.volumeKg)}</td><td>${w ? esc(w.name) : '—'}</td><td>${fmtMoney(r.purchasePrice)}/кг</td></tr>`;
          }).join('')}
        </tbody>
      </table></div>`}
    </div>
  `;
}
function bindDashboardEvents() {
  document.getElementById('dashApply')?.addEventListener('click', () => {
    const from = document.getElementById('dashFrom').value;
    const to = document.getElementById('dashTo').value;
    if (from && to) { dashboardRange = { from, to: to < from ? from : to }; render(); }
  });
  document.getElementById('dashToday')?.addEventListener('click', () => {
    dashboardRange = { from: todayStr(), to: todayStr() }; render();
  });
  document.getElementById('dashWeek')?.addEventListener('click', () => {
    const to = todayStr();
    const fromDate = new Date(); fromDate.setDate(fromDate.getDate() - 6);
    const from = fromDate.toISOString().slice(0, 10);
    dashboardRange = { from, to }; render();
  });
}

/* ============ RECEIVING (Приёмка) ============ */
function viewReceiving() {
  const rows = [...DB.receivings].sort((a,b) => b.date.localeCompare(a.date));
  return `
    <div class="card">
      <div class="card-header">
        <h2>Журнал приёмки сырья</h2>
        <button class="btn-primary" id="addReceivingBtn">+ Новая приёмка</button>
      </div>
      ${rows.length === 0 ? '<div class="empty-state">Записей пока нет. Добавьте первую приёмку.</div>' : `
      <div class="table-wrap"><table>
        <thead><tr><th>Дата</th><th>Товар</th><th>Объём</th><th>Цена / баз. ед.</th><th>Сумма</th><th>Работник</th><th>Примечание</th><th></th></tr></thead>
        <tbody>
          ${rows.map(r => {
            const p = getProduct(r.productId); const w = getUser(r.workerId);
            return `<tr>
              <td>${fmtDate(r.date)}</td>
              <td>${p ? p.emoji + ' ' + esc(p.name) : '—'}</td>
              <td>${fmtKg(r.volumeKg)}</td>
              <td>${fmtMoney(r.purchasePrice)}</td>
              <td>${fmtMoney(r.volumeKg * r.purchasePrice)}</td>
              <td>${w ? esc(w.name) : '—'}</td>
              <td>${esc(r.note) || ''}</td>
              <td><button class="icon-btn" data-edit-receiving="${r.id}">✏️</button><button class="icon-btn" data-del-receiving="${r.id}">🗑</button></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table></div>`}
    </div>
  `;
}

function receivingFormHtml(editId) {
  const editing = editId ? DB.receivings.find(r => r.id === editId) : null;
  const receivableProducts = DB.products.filter(isReceivable);
  const initialProduct = editing ? getProduct(editing.productId) : receivableProducts[0];
  const automaticPrice = editing ? Number(editing.purchasePrice) : Number(initialProduct?.purchasePrice || 0);
  return `
    <h2>${editing ? 'Редактировать приёмку' : 'Новая приёмка сырья'}</h2>
    <form id="receivingForm"><p>Количество и закупочная цена — за базовую единицу (kg/g/pcs/pack), не за упаковку.</p>
 <div class="row"><div class="field"><label>Номер партии</label><input name="lotNumber" value="${editing?.lotNumber||''}" required></div>
 <div class="field"><label>Годен до</label><input name="expiryDate" type="date" value="${editing?.expiryDate||''}"></div></div>
      <div class="row">
        <div class="field"><label>Дата</label><input type="date" name="date" value="${editing ? editing.date : todayStr()}" required></div>
        <div class="field"><label>Товар (сырьё)</label>
          <select name="productId" required>
            ${receivableProducts.map(p => `<option value="${p.id}" ${editing && editing.productId === p.id ? 'selected' : ''}>${p.emoji} ${esc(p.name)} — ${esc(p.unit)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="row">
        <div class="field"><label>Количество (баз. ед.)</label><input type="number" step="0.005" min="0" name="volumeKg" value="${editing ? editing.volumeKg : ''}" required></div>
        <div class="field"><label>Закупочная цена за базовую единицу (₾)</label><input type="number" step="0.01" min="0.01" name="purchasePrice" value="${automaticPrice}" required><small>Подставляется из карточки товара. При необходимости цену этой партии можно изменить.</small></div>
      </div>
      <div class="field"><label>Работник, принявший партию</label>
        <select name="workerId">
          <option value="">— не указан —</option>
          ${DB.users.map(u => `<option value="${u.id}" ${editing && editing.workerId === u.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label>Примечание / партия</label><input type="text" name="note" value="${editing ? (esc(editing.note)||'') : ''}" placeholder="Например, № накладной"></div>
      <div class="modal-actions">
        <button type="button" class="btn-secondary" id="cancelModalBtn">Отмена</button>
        <button type="submit" class="btn-primary">${editing ? 'Сохранить' : 'Добавить'}</button>
      </div>
    </form>
  `;
}

function bindReceivingEvents() {
  document.getElementById('addReceivingBtn')?.addEventListener('click', () => {
    openModal(receivingFormHtml(null));
    bindReceivingFormSubmit(null);
  });
  document.querySelectorAll('[data-edit-receiving]').forEach(el => {
    el.addEventListener('click', () => {
      openModal(receivingFormHtml(el.dataset.editReceiving));
      bindReceivingFormSubmit(el.dataset.editReceiving);
    });
  });
  document.querySelectorAll('[data-del-receiving]').forEach(el => {
    el.addEventListener('click', async () => {
      if (confirm('Отменить черновик приёмки? Проведённые документы сохраняются в истории.')) {
        const id = el.dataset.delReceiving;
        DB.receivings = DB.receivings.filter(r => r.id !== id);
        if (!await saveData(DB)) return; render();
      }
    });
  });
}
function bindReceivingFormSubmit(editId, onDone) {
  document.getElementById('cancelModalBtn').addEventListener('click', closeModal);
  const form=document.getElementById('receivingForm');
  const syncPurchasePrice=()=>{form.elements.purchasePrice.value=Number(getProduct(form.elements.productId.value)?.purchasePrice||0);};
  form.elements.productId.addEventListener('change',syncPurchasePrice);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const vol = parseFloat(f.get('volumeKg'));
    if (!confirmBigQty(vol)) return;
    const record = {
      ...(editId?DB.receivings.find(r=>r.id===editId):{}),id: editId || uid(),
      date: f.get('date'),
      productId: f.get('productId'),
      volumeKg: vol,
      purchasePrice: parseFloat(f.get('purchasePrice')),lotNumber:f.get('lotNumber'),expiryDate:f.get('expiryDate'),
      workerId: f.get('workerId') || null,
      note: f.get('note') || '',status:'draft'
    };
    if (editId) {
      DB.receivings = DB.receivings.map(r => r.id === editId ? record : r);
    } else {
      DB.receivings.push(record);
    }
    if (!await saveData(DB)) return;
    closeModal();
    if (onDone) onDone(record); else render();
  });
}

/* ============ PROCESSING / YIELD (Переработка) ============ */
function viewProcessing() {
  const rows = [...DB.processing].sort((a,b) => b.date.localeCompare(a.date));
  return `
    <div class="card">
      <div class="card-header">
        <h2>Журнал двухэтапной переработки</h2>
        <button class="btn-primary" id="addProcessingBtn">+ Новый этап переработки</button>
      </div>
      <p><strong>Рабочий цикл:</strong> 1) отдельным документом проведите тушку в филе; 2) новым документом проведите филе в маринованное или слабосолёное филе. Для каждого этапа укажите фактический выход и отходы/усушку — сумма должна совпасть с входным весом.</p>
      ${rows.length === 0 ? '<div class="empty-state">Записей о переработке пока нет.</div>' : `
      <div class="table-wrap"><table>
        <thead><tr><th>Дата</th><th>Этап</th><th>Вход</th><th>Выходы</th><th>Отходы/усушка</th><th>Выход, %</th><th></th></tr></thead>
        <tbody>
          ${rows.map(pr => {
            const inputP = getProduct(pr.inputProductId);
            const input = Number(pr.inputQty) || 0;
            const outputs = [1,2,3,4,5].map(i => ({p:getProduct(pr[`output${i}ProductId`]),qty:Number(pr[`output${i}Qty`]||0)})).filter(row=>row.p&&row.qty>0);
            const outputTotal = outputs.reduce((sum,row)=>sum+row.qty,0);
            const waste = Number(pr.wasteQty) || 0;
            const outputPct = input ? (outputTotal / input * 100) : 0;
            const wastePct = input ? (waste / input * 100) : 0;
            return `<tr>
              <td>${fmtDate(pr.date)}</td>
              <td><b>${Number(pr.processingStage||1)}</b><br><small>${Number(pr.processingStage||1)===1?'сырьё → полуфабрикаты/готовое':'полуфабрикат → готовое'}</small></td>
              <td>${inputP ? inputP.emoji + ' ' + esc(inputP.name) : '—'}${input ? '<br><b>' + input + ' ' + (inputP ? inputP.unit : '') + '</b>' : ''}</td>
              <td>${outputs.length?outputs.map(row=>`${row.p.emoji} ${esc(row.p.name)} — <b>${row.qty} ${esc(row.p.unit)}</b>`).join('<br>'):'—'}</td>
              <td>${waste ? fmtKg(waste) : '—'}</td>
              <td style="min-width:140px;">
                <div class="yield-bar">
                  <div style="width:${outputPct}%; background:#0e7c86;" title="Выход ${outputPct.toFixed(1)}%">${outputPct>12?outputPct.toFixed(0)+'%':''}</div>
                  <div style="width:${wastePct}%; background:#c7ced3;" title="Отходы ${wastePct.toFixed(1)}%"></div>
                </div>
              </td>
              <td><button class="icon-btn" data-del-processing="${pr.id}">🗑</button></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table></div>`}
    </div>
  `;
}

function processingFormHtml() {
  const inputOpts = processingProductOptions(1, 'input');
  const outputRows = [1,2,3,4,5].map(i=>`<div class="row">
    <div class="field"><label>Выход ${i} — товар</label><select name="output${i}ProductId" data-processing-output><option value="">— сначала выберите вход —</option></select></div>
    <div class="field"><label>Выход ${i} — количество</label><input type="number" step="0.005" min="0" name="output${i}Qty" value="0"></div>
  </div>`).join('');
  return `
    <h2>Новая запись переработки</h2>
    <p style="color:var(--text-muted); font-size:13px; margin-top:-8px;">
      Вход обязателен. Все количества указываются в базовой единице товара, отходы — в кг.<br>
      Этап 1 принимает только принятое сырьё и даёт полуфабрикаты или готовые товары.<br>
      Этап 2 принимает только полуфабрикаты этапа 1 и даёт готовые товары. Можно указать до пяти выходов.
    </p>
    <form id="processingForm">
      <div class="row">
        <div class="field"><label>Дата</label><input type="date" name="date" value="${todayStr()}" required></div>
        <div class="field"><label>Этап</label><select name="processingStage" id="processingStage"><option value="1">1 — разделка сырья</option><option value="2">2 — изготовление готового продукта</option></select></div>
        <div class="field"><label>Работник</label>
          <select name="workerId">
            <option value="">— не указан —</option>
            ${DB.users.map(u => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="row">
        <div class="field"><label>Вход (обязательно)</label><select required name="inputProductId" id="pInputProduct"><option value="">— выберите —</option>${inputOpts}</select></div>
        <div class="field"><label>Количество на входе</label><input type="number" step="0.005" min="0" name="inputQty" id="pInput" value="0"><small class="field-hint" data-processing-available>Сначала выберите входной товар.</small></div>
      </div>
      ${outputRows}
      <div class="field"><label>Отходы / усушка (кг) — можно оставить пусто</label><input type="number" step="0.005" min="0" name="wasteQty" id="pWaste" placeholder="авто, если применимо"></div>
      <div class="field"><label>Примечание</label><input type="text" name="note" placeholder="напр. «отправлено в засолку», партия №"></div>
      <div class="modal-actions">
        <button type="button" class="btn-secondary" id="cancelModalBtn">Отмена</button>
        <button type="submit" class="btn-primary">Сохранить и изменить остаток</button>
      </div>
    </form>
  `;
}

function processingProductOptions(stage, direction, inputProductId = null) {
  const allowed = direction === 'input' ? canUseAsProcessingInput : canUseAsProcessingOutput;
  const inputProduct = inputProductId ? getProduct(inputProductId) : null;
  return DB.products.filter(product => allowed(product, stage) && (direction === 'input' || (inputProduct && processingSpeciesCompatible(inputProduct, product))))
    .sort((a,b)=>a.name.localeCompare(b.name,'ru'))
    .map(product => {
      const available = direction === 'input' ? ` · доступно ${formatProcessingQty(availableProcessingQty(product.id))} ${processingUnit(product)}` : '';
      return `<option value="${product.id}">${product.emoji} ${esc(product.name)} (${esc(product.unit)})${available}</option>`;
    }).join('');
}

function processingUnit(product) {
  return ({kg:'кг',g:'г',pcs:'шт.',pack:'уп.'})[product?.baseUnit] || product?.unit || 'кг';
}

function formatProcessingQty(value) {
  return Number(value||0).toLocaleString('ru-RU',{minimumFractionDigits:0,maximumFractionDigits:3});
}

function availableProcessingQty(productId) {
  const row=(DB.processingAvailability||[]).find(item=>(item.productId||item.product_id)===productId);
  if(row)return Math.max(0,Number(row.available||0));
  return (DB.lots||[])
    .filter(lot=>lot.product_id===productId&&lot.status==='available'&&(!lot.expiry_date||lot.expiry_date>=todayStr()))
    .reduce((sum,lot)=>sum+Math.max(0,Number(lot.available||0)),0);
}

function updateProcessingAvailability(form) {
  const productId=form.elements.inputProductId.value;
  const quantityInput=form.elements.inputQty;
  const hint=form.querySelector('[data-processing-available]');
  if(!productId){
    quantityInput.removeAttribute('max');
    if(hint)hint.textContent='Сначала выберите входной товар.';
    return null;
  }
  const product=getProduct(productId),available=availableProcessingQty(productId);
  quantityInput.max=String(available);
  if(hint)hint.textContent=`Доступно для переработки: ${formatProcessingQty(available)} ${processingUnit(product)}`;
  return {available,unit:processingUnit(product)};
}

function processingAvailabilityError(form,inputQty) {
  const info=updateProcessingAvailability(form);
  return info&&Number(inputQty)>info.available+0.000001
    ? `Максимально доступно: ${formatProcessingQty(info.available)} ${info.unit}. Уменьшите вес входа.`
    : '';
}

function updateProcessingStageOptions(form) {
  const stage = Number(form.elements.processingStage.value);
  const input = form.elements.inputProductId;
  input.innerHTML = safeHTML(`<option value="">— выберите —</option>${processingProductOptions(stage,'input')}`);
  updateProcessingOutputOptions(form);
  updateProcessingAvailability(form);
}

function updateProcessingOutputOptions(form) {
  const stage = Number(form.elements.processingStage.value);
  const inputProductId = form.elements.inputProductId.value;
  form.querySelectorAll('[data-processing-output]').forEach(select => {
    const selected = select.value;
    const placeholder = inputProductId ? '— нет —' : '— сначала выберите вход —';
    select.innerHTML = safeHTML(`<option value="">${placeholder}</option>${processingProductOptions(stage,'output',inputProductId)}`);
    if ([...select.options].some(option => option.value === selected)) select.value = selected;
  });
}

function bindProcessingEvents() {
  document.getElementById('addProcessingBtn')?.addEventListener('click', () => {
    openModal(processingFormHtml());
    document.getElementById('cancelModalBtn').addEventListener('click', closeModal);
    document.getElementById('processingStage').addEventListener('change', e => updateProcessingStageOptions(e.target.form));
    document.getElementById('pInputProduct').addEventListener('change', e => {updateProcessingOutputOptions(e.target.form);updateProcessingAvailability(e.target.form);});
    document.getElementById('processingForm').addEventListener('submit', async e => {
      e.preventDefault();
      const f = new FormData(e.target);
      const input = parseFloat(f.get('inputQty')) || 0;
      const availabilityError=processingAvailabilityError(e.target,input);
      if(availabilityError){alert(availabilityError);e.target.elements.inputQty.focus();return;}
      const outputs=[1,2,3,4,5].map(i=>({id:f.get(`output${i}ProductId`)||null,qty:parseFloat(f.get(`output${i}Qty`))||0}));
      const inputP = getProduct(f.get('inputProductId'));
      const outputProducts=outputs.map(row=>getProduct(row.id)).filter(Boolean);
      const sameUnit=inputP?.baseUnit==='kg' && outputProducts.every(p=>p.baseUnit==='kg');
      let waste = f.get('wasteQty') ? parseFloat(f.get('wasteQty')) : (sameUnit ? Math.max(0, input - outputs.reduce((s,row)=>s+row.qty,0)) : 0);
      const record={
        id: uid(), date: f.get('date'),
        processingStage:Number(f.get('processingStage')),
        inputProductId: f.get('inputProductId') || null, inputQty: input,
        wasteQty: waste,
        workerId: f.get('workerId') || null,
        note: f.get('note') || '',status:'draft'
      };
      outputs.forEach((row,index)=>{record[`output${index+1}ProductId`]=row.id;record[`output${index+1}Qty`]=row.qty;});
      const chainError=validateProcessingChain(record,DB.products);
      if(chainError){alert(chainError);return;}
      const outputSummary=outputs.filter(row=>row.id&&row.qty>0).map(row=>`${getProduct(row.id)?.name}: ${row.qty} кг`).join('\n');
      if(!confirm(`Проверьте запись:\n\nВзяли: ${inputP?.name||'—'} — ${input} кг\nПолучилось:\n${outputSummary}\nОтходы/усушка: ${waste.toFixed(3)} кг\n\nСохранить документ?`))return;
      DB.processing.push(record);
      if (!await saveData(DB)) return; closeModal(); render();
    });
  });
  document.querySelectorAll('[data-del-processing]').forEach(el => {
    el.addEventListener('click', async () => {
      if (confirm('Отменить черновик? История сохранится.')) {
        const id = el.dataset.delProcessing;
        DB.processing = DB.processing.filter(p => p.id !== id); if (!await saveData(DB)) return; render();
      }
    });
  });
}

/* ============ WAREHOUSE (Склад / остатки) ============ */
function getStock(productId){
 const moves=DB.movements.filter(m=>m.product_id===productId);
 const inQty=moves.filter(m=>m.quantity>0).reduce((s,m)=>s+Number(m.quantity),0);
 const outQty=-moves.filter(m=>m.quantity<0).reduce((s,m)=>s+Number(m.quantity),0);
 return {qty:inQty-outQty,inQty,outQty,manual:0};
}
function viewWarehouse() {
  const rows = DB.products.map(p => ({ p, stock: getStock(p.id) }))
    .sort((a,b) => Number(b.stock.qty > 0) - Number(a.stock.qty > 0) || a.p.name.localeCompare(b.p.name, 'ru'));
  const totalCost=DB.movements.reduce((s,m)=>s+Number(m.quantity)*Number(m.unit_cost),0);
  const totalPotential = rows.reduce((s, r) => s + (stockSaleValue(r.p, Math.max(0, r.stock.qty)) || 0), 0);

  const renderRows = (list) => list.map(({p, stock}) => {
    const costValue = DB.movements.filter(m=>m.product_id===p.id).reduce((s,m)=>s+Number(m.quantity)*Number(m.unit_cost),0);
    const potentialValue = p.sellPrice ? stockSaleValue(p, stock.qty) : null;
    const negative = stock.qty < 0;
    return `<tr>
      <td>${p.emoji} <b>${esc(p.name)}</b><br><small style="color:var(--text-muted);">Фасовка: ${esc(p.unit)}</small></td>
      <td>${p.baseUnit}</td>
      <td style="${negative ? 'color:var(--danger); font-weight:700;' : 'font-weight:700;'}">${stock.qty.toLocaleString('ru-RU', {maximumFractionDigits: 2})}${negative ? ' ⚠️' : ''}</td>
      <td>${fmtMoney(costValue)}</td>
      <td>${potentialValue !== null ? fmtMoney(potentialValue) : '—'}</td>
      <td><button class="btn-secondary btn-sm" data-history="${p.id}">Движения</button><button class="icon-btn" data-adjust="${p.id}" title="Корректировка">⚖️</button></td>
    </tr>`;
  }).join('');

  return `
    <div class="stat-grid">
      <div class="stat-card"><div class="stat-label">Себестоимость остатков</div><div class="stat-value">${fmtMoney(totalCost)}</div></div>
      <div class="stat-card" style="border-left-color: var(--success);"><div class="stat-label">Потенциальная стоимость (по цене продажи)</div><div class="stat-value">${fmtMoney(totalPotential)}</div></div>
    </div>

    <div class="card">
      <div class="card-header">
        <h2>Остатки товаров</h2>
        <button class="btn-secondary" id="addAdjustBtn">⚖️ Корректировка склада</button>
      </div>
      <div class="table-wrap" data-no-pagination><table>
        <thead><tr><th>Товар</th><th>Ед.</th><th>Остаток</th><th>Себестоимость</th><th>Потенц. стоимость</th><th></th></tr></thead>
        <tbody>${renderRows(rows)}</tbody>
      </table></div>
    </div>

    <div class="card">
      <div class="card-header"><h2>Журнал корректировок склада</h2></div>
      ${DB.stockAdjustments.length === 0 ? '<div class="empty-state">Корректировок пока не было. Фактический остаток внесите через инвентаризацию. Выпуск продукции оформляйте в разделе переработки.</div>' : `
      <div class="table-wrap"><table>
        <thead><tr><th>Дата</th><th>Товар</th><th>Кол-во</th><th>Причина</th><th></th></tr></thead>
        <tbody>
          ${[...DB.stockAdjustments].sort((a,b)=>b.date.localeCompare(a.date)).map(a => {
            const p = getProduct(a.productId);
            return `<tr>
              <td>${fmtDate(a.date)}</td>
              <td>${p ? p.emoji + ' ' + esc(p.name) : '—'}</td>
              <td style="${a.qty < 0 ? 'color:var(--danger);' : 'color:var(--success);'} font-weight:700;">${a.qty > 0 ? '+' : ''}${a.qty ?? ('подсчёт: '+a.countedQuantity)} ${p ? p.unit : ''}</td>
              <td>${esc(a.note) || ''}</td>
              <td><button class="icon-btn" data-del-adjust="${a.id}">🗑</button></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table></div>`}
    </div>
  `;
}

function adjustFormHtml(preselectId) {
  return `
    <h2>Корректировка склада</h2>
    <p style="color:var(--text-muted); font-size:13px; margin-top:-8px;">
      Положительное число — приход (например, расфасовали партию слабосола или гребешков).<br>
      Отрицательное число — расход/списание (порча, усушка, недостача).
    </p>
    <form id="adjustForm">
      <div class="field"><label>Товар</label>
        <select name="productId" required>
          ${DB.products.map(p => `<option value="${p.id}" ${preselectId === p.id ? 'selected' : ''}>${p.emoji} ${esc(p.name)} (${p.unit})</option>`).join('')}
        </select>
      </div>
      <div class="row">
        <div class="field"><label>Дата</label><input type="date" name="date" value="${todayStr()}" required></div>
        <div class="field"><label>Количество (+ приход / − расход)</label><input type="number" step="0.005" name="qty" placeholder="напр. 5 или -2" required></div>
      </div>
      <div class="field"><label>Причина / примечание</label><input type="text" required minlength="3" name="note" placeholder="Например: расфасовка партии, списание брака"></div>
      <div class="modal-actions">
        <button type="button" class="btn-secondary" id="cancelModalBtn">Отмена</button>
        <button type="submit" class="btn-primary">Сохранить</button>
      </div>
    </form>
  `;
}

function bindWarehouseEvents() {
  document.getElementById('addAdjustBtn')?.addEventListener('click', () => {
    openModal(adjustFormHtml(null));
    bindAdjustFormSubmit();
  });
  document.querySelectorAll('[data-adjust]').forEach(el => {
    el.addEventListener('click', () => {
      openModal(adjustFormHtml(el.dataset.adjust));
      bindAdjustFormSubmit();
    });
  });
  document.querySelectorAll('[data-del-adjust]').forEach(el => {
    el.addEventListener('click', async () => {
      if (confirm('Отменить черновик корректировки?')) { DB.stockAdjustments = DB.stockAdjustments.filter(a => a.id !== el.dataset.delAdjust); if (!await saveData(DB)) return; render(); }
    });
  });
}
function bindAdjustFormSubmit() {
  document.getElementById('cancelModalBtn').addEventListener('click', closeModal);
  document.getElementById('adjustForm').addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const row={ id: uid(), productId: f.get('productId'), date: f.get('date'), qty: parseFloat(f.get('qty')), note: f.get('note') || '',status:'draft' };
    e.target.querySelector('button[type="submit"]').disabled=true;
    await saveAndPostStockAdjustment(row);
  });
}

/* ============ WORKERS & TIME ============ */
function viewWorkers() {
  const workers = DB.users.filter(u => true);
  const today = todayStr();
  return `
    <div class="card">
      <div class="card-header">
        <h2>Сотрудники</h2>
        <p>Новые аккаунты создаются в Supabase Auth; здесь редактируются профили.</p>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Имя</th><th>Должность</th><th>Роль</th><th>Логин</th><th>Статус сегодня</th><th></th></tr></thead>
        <tbody>
          ${workers.map(w => {
            const wEntries = DB.timeEntries.filter(t => t.workerId === w.id && t.date === today);
            const openE = wEntries.find(t => t.checkIn && !t.checkOut);
            const closedCount = wEntries.filter(t => t.checkOut).length;
            const totalH = wEntries.filter(t=>t.checkOut).reduce((s,t)=>s+(calcHours(t.checkIn,t.checkOut)||0),0);
            let status = '<span style="color:var(--text-muted);">не отмечен</span>';
            if (openE) status = `<span class="badge badge-progress">на смене с ${openE.checkIn}</span>`;
            else if (closedCount) status = `<span class="badge badge-done">${closedCount} смен(ы), ${totalH.toFixed(1)} ч</span>`;
            return `<tr>
              <td><b>${esc(w.name)}</b></td>
              <td>${esc(w.position) || ''}</td>
              <td>${({owner:'Владелец',partner:'Партнёр',manager:'Менеджер',worker:'Работник'})[w.role] || esc(w.role)}</td>
              <td>${w.login}</td>
              <td>${status}</td>
              <td><button class="icon-btn" data-edit-worker="${w.id}">✏️</button>${!['owner','partner'].includes(w.role) ? `<button class="icon-btn" data-del-worker="${w.id}">🗑</button>` : ''}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table></div>
    </div>
    <div class="card">
      <div class="card-header">
        <h2>Учёт рабочего времени</h2>
        <button class="btn-secondary" id="addTimeBtn">+ Добавить запись вручную</button>
      </div>
      ${DB.timeEntries.length === 0 ? '<div class="empty-state">Нет отметок времени.</div>' : `
      <div class="table-wrap"><table>
        <thead><tr><th>Дата</th><th>Работник</th><th>Приход</th><th>Уход</th><th>Часов</th><th>Начислено</th><th></th></tr></thead>
        <tbody>
          ${[...DB.timeEntries].sort((a,b)=>b.date.localeCompare(a.date)).map(t => {
            const w = getUser(t.workerId);
            const hours = calcHours(t.checkIn, t.checkOut);
            return `<tr>
              <td>${fmtDate(t.date)}</td><td>${w ? esc(w.name) : '—'}</td><td>${t.checkIn || '—'}</td><td>${t.checkOut || '—'}</td>
              <td>${hours !== null ? hours.toFixed(1) + ' ч' : '—'}</td>
              <td>${t.earnings != null ? fmtMoney(t.earnings) : '—'}</td>
              <td>${!t.checkOut?`<button class="btn-secondary btn-sm" data-close-time="${t.id}">Закрыть</button>`:''}<button class="btn-secondary btn-sm" data-edit-time="${t.id}">Изменить</button><button class="btn-secondary btn-sm" data-del-time="${t.id}">Удалить</button></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table></div>`}
    </div>
  `;
}

function calcHours(checkIn, checkOut) {
  if (!checkIn || !checkOut) return null;
  const [h1,m1] = checkIn.split(':').map(Number);
  const [h2,m2] = checkOut.split(':').map(Number);
  let mins = (h2*60+m2) - (h1*60+m1);
  if (mins < 0) mins += 24*60;
  return mins / 60;
}

/* Расчёт зарплаты за смену: базовая ставка до overtimeAfterHours часов, дальше — повышенная */
/* Защита от явной опечатки: крупные производственные партии до 200 кг считаются нормальными. */
function confirmBigQty(qty) {
  if (qty > 200) {
    return confirm(`Вы ввели ${qty} кг — это много для одной записи. Проверьте, не лишний ли ноль в числе. Сохранить как есть?`);
  }
  return true;
}

function computeEarnings(worker, hours) {
  if (!worker || !hours) return 0;
  const rate = Number(worker.hourlyRate || 0);
  const otRate = Number(worker.overtimeRate || rate);
  const threshold = Number(worker.overtimeAfterHours || 8);
  if (hours <= threshold) return hours * rate;
  return threshold * rate + (hours - threshold) * otRate;
}

function workerFormHtml(editId) {
  const editing = editId ? getUser(editId) : null;
  return `
    <h2>${editing ? 'Редактировать сотрудника' : 'Новый сотрудник'}</h2>
    <form id="workerForm">
      <div class="field"><label>Имя</label><input type="text" name="displayName" value="${editing ? esc(editing.name) : ''}" required></div>
      <div class="row">
        
        
      </div>
      <div class="row">
        <div class="field"><label>Должность</label><input type="text" name="position" value="${editing ? (esc(editing.position)||'') : 'Обработчик рыбы'}"></div>
        <div class="field"><label>Роль</label>
          <select name="role">${[['owner','Владелец'],['partner','Партнёр'],['manager','Менеджер'],['worker','Работник']].map(([v,l])=>`<option value="${v}" ${editing?.role===v?'selected':''}>${l}</option>`).join('')}</select>
        </div>
      </div>
      <div class="row">
        <div class="field"><label>Ставка, ₾/час</label><input type="number" step="0.01" min="0" name="hourlyRate" value="${editing ? (editing.hourlyRate||0) : 9}"></div>
        <div class="field"><label>Ставка сверхурочно, ₾/час</label><input type="number" step="0.01" min="0" name="overtimeRate" value="${editing ? (editing.overtimeRate||0) : 11}"></div>
        <div class="field"><label>Сверхурочные после, ч</label><input type="number" step="0.5" min="0" name="overtimeAfterHours" value="${editing ? (editing.overtimeAfterHours||8) : 5}"></div>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn-secondary" id="cancelModalBtn">Отмена</button>
        <button type="submit" class="btn-primary">${editing ? 'Сохранить' : 'Добавить'}</button>
      </div>
    </form>
  `;
}

function timeFormHtml() {
  return `
    <h2>Добавить запись времени</h2>
    <form id="timeForm">
      <div class="field"><label>Работник</label>
        <select name="workerId" required>${DB.users.map(u => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}</select>
      </div>
      <div class="field"><label>Дата</label><input type="date" name="date" value="${todayStr()}" required></div>
      <div class="row">
        <div class="field"><label>Приход</label><input type="time" name="checkIn" required></div>
        <div class="field"><label>Уход</label><input type="time" name="checkOut"></div>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn-secondary" id="cancelModalBtn">Отмена</button>
        <button type="submit" class="btn-primary">Сохранить</button>
      </div>
    </form>
  `;
}

function bindWorkersEvents() {
  document.getElementById('addWorkerBtn')?.addEventListener('click', () => {
    openModal(workerFormHtml(null));
    document.getElementById('cancelModalBtn').addEventListener('click', closeModal);
    document.getElementById('workerForm').addEventListener('submit', async e => {
      e.preventDefault();
      const f = new FormData(e.target);
      DB.users.push({ id: uid(), name: f.get('displayName'),  position: f.get('position'), role: f.get('role'), hourlyRate: parseFloat(f.get('hourlyRate'))||0, overtimeRate: parseFloat(f.get('overtimeRate'))||0, overtimeAfterHours: parseFloat(f.get('overtimeAfterHours'))||8 });
      if (!await saveData(DB)) return; closeModal(); render();
    });
  });
  document.querySelectorAll('[data-edit-worker]').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.editWorker;
      openModal(workerFormHtml(id));
      document.getElementById('cancelModalBtn').addEventListener('click', closeModal);
      document.getElementById('workerForm').addEventListener('submit', async e => {
        e.preventDefault();
        const f = new FormData(e.target);
        DB.users = DB.users.map(u => u.id === id ? { ...u, name: f.get('displayName'),  position: f.get('position'), role: f.get('role'), hourlyRate: parseFloat(f.get('hourlyRate'))||0, overtimeRate: parseFloat(f.get('overtimeRate'))||0, overtimeAfterHours: parseFloat(f.get('overtimeAfterHours'))||8 } : u);
        if (!await saveData(DB)) return; closeModal(); render();
      });
    });
  });
  document.querySelectorAll('[data-del-worker]').forEach(el => {
    el.addEventListener('click', async () => {
      if (confirm('Удалить сотрудника?')) { DB.users = DB.users.filter(u => u.id !== el.dataset.delWorker); if (!await saveData(DB)) return; render(); }
    });
  });
  document.getElementById('addTimeBtn')?.addEventListener('click', () => {
    openModal(timeFormHtml());
    document.getElementById('cancelModalBtn').addEventListener('click', closeModal);
    document.getElementById('timeForm').addEventListener('submit', async e => {
      e.preventDefault();
      const f = new FormData(e.target);
      const checkOut = f.get('checkOut') || null;
      const worker = getUser(f.get('workerId'));
      const hours = checkOut ? calcHours(f.get('checkIn'), checkOut) : null;
      DB.timeEntries.push({ id: uid(), workerId: f.get('workerId'), date: f.get('date'), checkIn: f.get('checkIn'), checkOut, earnings: hours !== null ? computeEarnings(worker, hours) : null });
      if (!await saveData(DB)) return; closeModal(); render();
    });
  });
  document.querySelectorAll('[data-del-time]').forEach(el => {
    el.addEventListener('click', async () => {
      const row=DB.timeEntries.find(t=>t.id===el.dataset.delTime);if(!row)return;
      if(confirm('Удалить ошибочную смену из журнала? История действия сохранится.'))await manageShift(row,'archive',{reason:'Ошибочная смена удалена владельцем'});
    });
  });
  const openManageForm=(row,closeOnly)=>{
    openModal(editTimeFormHtml(row,closeOnly));
    document.getElementById('cancelModalBtn').onclick=closeModal;
    document.getElementById('manageTimeForm').onsubmit=async e=>{
      e.preventDefault();const payload=Object.fromEntries(new FormData(e.target));
      e.target.querySelector('button[type="submit"]').disabled=true;
      await manageShift(row,closeOnly?'close':'correct',payload);
    };
  };
  document.querySelectorAll('[data-close-time]').forEach(el=>el.onclick=()=>{const row=DB.timeEntries.find(t=>t.id===el.dataset.closeTime);if(row)openManageForm(row,true);});
  document.querySelectorAll('[data-edit-time]').forEach(el=>el.onclick=()=>{const row=DB.timeEntries.find(t=>t.id===el.dataset.editTime);if(row)openManageForm(row,false);});
}

/* ============ COUNTERPARTIES ============ */
const SOURCE_LABELS = { site: 'Сайт', instagram: 'Instagram', facebook: 'Facebook', call: 'Звонок', google: 'Google Карты', other: 'Другое' };
const CONTACT_METHOD_LABELS = { phone: '📞 Телефон', telegram: '✈️ Telegram', whatsapp: '💬 WhatsApp' };
function viewCounterparties() {
  return `
    <div class="card">
      <div class="card-header">
        <h2>Контрагенты</h2>
        <button class="btn-primary" id="addCpBtn">+ Новый контрагент</button>
      </div>
      ${DB.counterparties.length === 0 ? '<div class="empty-state">Список контрагентов пуст.</div>' : `
      <div class="table-wrap"><table>
        <thead><tr><th>Название</th><th>Тип</th><th>Контакт / источник</th><th>Телефон</th><th>Email</th><th>Telegram/WA</th><th>Способ связи</th><th>Маркетинг</th><th>ИНН</th><th>Адрес</th><th></th></tr></thead>
        <tbody>
          ${DB.counterparties.map(c => {
            return `
            <tr style="cursor:pointer;" data-view-cp="${c.id}">
              <td><b>${esc(c.name)}</b></td>
              <td>${c.type === 'private' ? 'Частный клиент' : 'Ресторан/бизнес'}</td>
              <td>${c.type === 'private' ? (SOURCE_LABELS[c.source] || '—') : (esc(c.contact)||'—')}</td>
              <td>${esc(c.phone) ? (c.contactMethod === 'whatsapp' ? `<a href="https://wa.me/${c.phone.replace(/\D/g,'')}" target="_blank" style="color:#25D366; text-decoration:none;">💬 ${esc(c.phone)}</a>` : `<a href="tel:${c.phone.replace(/\s/g,'')}" style="text-decoration:none; color:inherit;">${esc(c.phone)}</a>`) : ''}</td>
              <td>${esc(c.email)||'—'}</td>
              <td>${esc(c.telegram) ? `<a href="https://t.me/${c.telegram.replace('@','')}" target="_blank" style="color:#229ED9;">✈️ ${esc(c.telegram)}</a>` : ''}${c.whatsapp ? ` <a href="https://wa.me/${c.whatsapp.replace(/\D/g,'')}" target="_blank" style="color:#25D366;">💬 ${c.whatsapp}</a>` : ''}${!esc(c.telegram) && !c.whatsapp ? '—' : ''}</td>
              <td>${CONTACT_METHOD_LABELS[c.contactMethod] || '📞 Телефон'}</td>
              <td>${c.marketingConsent===true ? '<span class="badge badge-done">Разрешён</span>' : '<span class="badge">Нет согласия</span>'}</td>
              <td>${esc(c.inn)||''}</td><td>${esc(c.address)||''}</td>
              <td><button class="icon-btn" data-edit-cp="${c.id}" onclick="event.stopPropagation()">✏️</button><button class="icon-btn" data-del-cp="${c.id}" onclick="event.stopPropagation()">🗑</button></td>
            </tr>
          `;}).join('')}
        </tbody>
      </table></div>`}
    </div>
  `;
}
function viewClientCard(cpId) {
  const c = getCounterparty(cpId);
  if (!c) return;
  const orders = [...DB.orders, ...(DB.orderHistory || [])].filter(o => o.counterpartyId === cpId).sort((a,b) => String(b.date||'').localeCompare(String(a.date||'')));
  const activeOrders = DB.orders.filter(o => o.counterpartyId === cpId && isPosted(o));
  const totalSpent = activeOrders.reduce((s,o) => s + orderGrandTotal(o)-returnedValue(o), 0);
  const productStats = {};
  activeOrders.forEach(o => o.items.forEach(it => {
    const p = getProduct(it.productId);
    const key = it.productId;
    if (!productStats[key]) productStats[key] = { name: p ? p.emoji+' '+p.name : '?', qty: 0, unit: p?p.unit:'' };
    productStats[key].qty += Number(it.qty);
  }));
  const topProducts = Object.values(productStats).sort((a,b) => b.qty - a.qty);
  openModal(`
    <h2>${esc(c.name)}</h2>
    <p style="color:var(--text-muted); font-size:13px;">
      ${esc(c.phone) ? '📞 ' + esc(c.phone) + ' &nbsp; ' : ''}${esc(c.email) ? '✉️ ' + esc(c.email) + ' &nbsp; ' : ''}${esc(c.telegram) ? `<a href="https://t.me/${c.telegram.replace('@','')}" target="_blank" style="color:#229ED9;">✈️ ${esc(c.telegram)}</a> &nbsp; ` : ''}${c.whatsapp ? `<a href="https://wa.me/${c.whatsapp.replace(/\D/g,'')}" target="_blank" style="color:#25D366;">💬 ${c.whatsapp}</a>` : ''}
    </p>
    <div class="stat-grid">
      <div class="stat-card"><div class="stat-label">Всего потрачено</div><div class="stat-value">${fmtMoney(totalSpent)}</div></div>
      <div class="stat-card"><div class="stat-label">Заказов</div><div class="stat-value">${activeOrders.length}</div></div>
    </div>
    <h3 style="margin-bottom:6px;">Что чаще всего берёт</h3>
    ${topProducts.length === 0 ? '<div class="empty-state">Пока нет заказов.</div>' : `
    <div class="table-wrap"><table>
      <thead><tr><th>Товар</th><th>Всего куплено</th></tr></thead>
      <tbody>${topProducts.map(p => `<tr><td>${esc(p.name)}</td><td>${p.qty} ${p.unit}</td></tr>`).join('')}</tbody>
    </table></div>`}
    <h3 style="margin: 14px 0 6px;">История заказов</h3>
    ${orders.length === 0 ? '<div class="empty-state">Заказов нет.</div>' : `
    <div class="table-wrap"><table>
      <thead><tr><th>Дата</th><th>№ сайта</th><th>Состав</th><th>Сумма</th><th>Статус</th></tr></thead>
      <tbody>${orders.map(o => {
        const itemsStr = o.items.map(it => { const p = getProduct(it.productId); return `${p?esc(p.name):'?'} ×${it.qty}`; }).join(', ');
        const sourceStatus = o.legacyHistorical ? o.legacyStatus : o.status;
        const statusLabel = { new:'Новый (архив)', progress:'В работе', done:'Выполнен (архив)', cancel:'Отменён (архив)', draft:'Черновик', confirmed:'Подтверждён', reserved:'В резерве', posted:'Проведён', completed:'Выполнен', cancelled:'Отменён' }[sourceStatus] || sourceStatus;
        const total = o.legacyHistorical ? historicalOrderTotal(o) : orderGrandTotal(o);
        return `<tr><td>${o.date ? fmtDate(o.date) : '—'}</td><td>${esc(o.externalOrderNumber)||'—'}</td><td>${itemsStr}</td><td>${fmtMoney(total)}</td><td>${esc(statusLabel)}</td></tr>`;
      }).join('')}</tbody>
    </table></div>`}
    <div class="modal-actions"><button type="button" class="btn-secondary" id="cancelModalBtn">Закрыть</button></div>
  `);
  document.getElementById('cancelModalBtn').addEventListener('click', closeModal);
}
function cpFormHtml(editId) {
  const editing = editId ? getCounterparty(editId) : null;
  const type = editing ? (editing.type || 'restaurant') : 'restaurant';
  return `
    <h2>${editing ? 'Редактировать контрагента' : 'Новый контрагент'}</h2>
    <form id="cpForm">
      <div class="field"><label>Название / имя</label><input type="text" name="displayName" value="${editing ? esc(editing.name) : ''}" required></div>
      <div class="field"><label>Email</label><input type="email" name="email" value="${editing ? (esc(editing.email)||'') : ''}"></div>
      <div class="row">
        <div class="field"><label>Telegram (@ник или номер)</label><input type="text" name="telegram" value="${editing ? (esc(editing.telegram)||'') : ''}" placeholder="@username"></div>
        <div class="field"><label>WhatsApp (номер)</label><input type="text" name="whatsapp" value="${editing ? (editing.whatsapp||'') : ''}" placeholder="+995..."></div>
      </div>
      <div class="field"><label>Предпочитаемый способ связи</label>
        <select name="contactMethod">
          <option value="phone" ${!editing || editing.contactMethod==='phone' ? 'selected':''}>📞 Телефон</option>
          <option value="telegram" ${editing && editing.contactMethod==='telegram' ? 'selected':''}>✈️ Telegram</option>
          <option value="whatsapp" ${editing && editing.contactMethod==='whatsapp' ? 'selected':''}>💬 WhatsApp</option>
        </select>
      </div>
      <label style="display:flex; align-items:flex-start; gap:8px; margin:10px 0 14px;">
        <input type="checkbox" name="marketingConsent" ${editing && editing.marketingConsent===true ? 'checked' : ''} style="width:auto; margin-top:3px;">
        <span><b>Согласие на маркетинговые сообщения</b><br><small style="color:var(--text-muted);">Добавляет клиента в списки рассылки по Email, Telegram и WhatsApp.</small></span>
      </label>
      <div class="field"><label>Тип контрагента</label>
        <select name="type" id="cpTypeSelect">
          <option value="restaurant" ${type==='restaurant'?'selected':''}>Ресторан / бизнес</option>
          <option value="private" ${type==='private'?'selected':''}>Частный клиент</option>
        </select>
      </div>
      <div id="cpRestaurantFields" style="${type==='private'?'display:none;':''}">
        <div class="row">
          <div class="field"><label>Контактное лицо</label><input type="text" name="contact" value="${editing ? (esc(editing.contact)||'') : ''}"></div>
          <div class="field"><label>Телефон</label><input type="text" name="phone" value="${editing ? (esc(editing.phone)||'') : ''}"></div>
        </div>
        <div class="row">
          <div class="field"><label>ИНН</label><input type="text" name="inn" value="${editing ? (esc(editing.inn)||'') : ''}"></div>
          <div class="field"><label>Адрес</label><input type="text" name="address" value="${editing ? (esc(editing.address)||'') : ''}"></div>
        </div>
        <div class="field"><label>Работаем через компанию (по умолчанию для заказов)</label>
          <select name="preferredCompanyId">
            <option value="">— не задано —</option>
            ${DB.companies.map(c => `<option value="${c.id}" ${editing && editing.preferredCompanyId===c.id?'selected':''}>${esc(c.name)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div id="cpPrivateFields" style="${type==='private'?'':'display:none;'}">
        <div class="row">
          <div class="field"><label>Телефон</label><input type="text" name="phone_private" value="${editing ? (esc(editing.phone)||'') : ''}"></div>
          <div class="field"><label>Откуда клиент</label>
            <select name="source">
              ${Object.entries(SOURCE_LABELS).map(([k,v]) => `<option value="${k}" ${editing && editing.source===k?'selected':''}>${v}</option>`).join('')}
            </select>
          </div>
        </div>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn-secondary" id="cancelModalBtn">Отмена</button>
        <button type="submit" class="btn-primary">${editing ? 'Сохранить' : 'Добавить'}</button>
      </div>
    </form>
  `;
}
function bindCpFormCommon(onSubmit) {
  document.getElementById('cancelModalBtn').addEventListener('click', closeModal);
  document.getElementById('cpTypeSelect').addEventListener('change', (e) => {
    const isPrivate = e.target.value === 'private';
    document.getElementById('cpRestaurantFields').style.display = isPrivate ? 'none' : '';
    document.getElementById('cpPrivateFields').style.display = isPrivate ? '' : 'none';
  });
  document.getElementById('cpForm').addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const type = f.get('type');
    const common = { email: f.get('email') || '', telegram: f.get('telegram') || '', whatsapp: f.get('whatsapp') || '', contactMethod: f.get('contactMethod') || 'phone', marketingConsent: f.get('marketingConsent') === 'on' };
    const data = type === 'private'
      ? { name: f.get('displayName'), type, phone: f.get('phone_private'), source: f.get('source'), contact: '', inn: '', address: '', preferredCompanyId: null, ...common }
      : { name: f.get('displayName'), type, contact: f.get('contact'), phone: f.get('phone'), inn: f.get('inn'), address: f.get('address'), preferredCompanyId: f.get('preferredCompanyId') || null, ...common };
    await onSubmit(data);
  });
}
function bindCounterpartiesEvents() {
  document.getElementById('addCpBtn')?.addEventListener('click', () => {
    openModal(cpFormHtml(null));
    bindCpFormCommon(async (data) => {
      DB.counterparties.push({ id: uid(), ...data });
      if (!await saveData(DB)) return; closeModal(); render();
    });
  });
  document.querySelectorAll('[data-edit-cp]').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.editCp;
      openModal(cpFormHtml(id));
      bindCpFormCommon(async (data) => {
        DB.counterparties = DB.counterparties.map(c => c.id === id ? { ...c, ...data } : c);
        if (!await saveData(DB)) return; closeModal(); render();
      });
    });
  });
  document.querySelectorAll('[data-del-cp]').forEach(el => {
    el.addEventListener('click', async () => {
      if (confirm('Удалить контрагента?')) { DB.counterparties = DB.counterparties.filter(c => c.id !== el.dataset.delCp); if (!await saveData(DB)) return; render(); }
    });
  });
  document.querySelectorAll('[data-view-cp]').forEach(el => {
    el.addEventListener('click', () => viewClientCard(el.dataset.viewCp));
  });
}

/* ============ ORDERS ============ */
function orderTotal(order) {
  return order.items.reduce((s, it) => s + Number(it.qty) * Number(it.price), 0);
}
function orderVAT(order) {
  return orderTotal(order) * (Number(order.vatRate || 0) / 100);
}
function orderGrandTotal(order) {
  return orderTotal(order) + orderVAT(order) + Number(order.deliveryFee||0);
}

/* ============ PRODUCT REPORT ============ */
let productReportRange = { from: '', to: '' };
function viewProductReport() {
  const { from, to } = productReportRange;
  const orders = DB.orders.filter(o => isPosted(o) && (!from || o.date >= from) && (!to || o.date <= to));
  const stats = {};
  orders.forEach(o => {
    o.items.forEach(it => {
      const p = getProduct(it.productId);
      const key = it.productId;
      if (!stats[key]) stats[key] = { name: p ? p.emoji + ' ' + p.name : '(товар удалён)', unit: p ? p.unit : '', qty: 0, revenue: 0, orders: 0 };
      stats[key].qty += Number(it.qty);
      stats[key].revenue += Number(it.qty) * Number(it.price);
      stats[key].orders += 1;
    });
  });
  const rows = Object.values(stats).sort((a,b) => b.revenue - a.revenue);
  const totalRevenue = rows.reduce((s,r) => s + r.revenue, 0);
  return `
    <div class="card">
      <div class="card-header"><h2>Отчёт по товарам</h2></div>
      <div class="row">
        <div class="field"><label>С даты</label><input type="date" id="reportFrom" value="${from}"></div>
        <div class="field"><label>По дату</label><input type="date" id="reportTo" value="${to}"></div>
        <div class="field" style="display:flex; align-items:flex-end;"><button class="btn-primary" id="applyReportRange">Показать</button></div>
        <div class="field" style="display:flex; align-items:flex-end;"><button class="btn-secondary" id="clearReportRange">Сбросить (всё время)</button></div>
      </div>
      <p style="color:var(--text-muted); font-size:13px;">${from || to ? `Период: ${from ? fmtDate(from) : '...'} — ${to ? fmtDate(to) : '...'}` : 'За всё время'}. Отменённые заказы не учитываются.</p>
      ${rows.length === 0 ? '<div class="empty-state">Нет данных за этот период.</div>' : `
      <div class="table-wrap"><table>
        <thead><tr><th>Товар</th><th>Продано (кол-во)</th><th>Позиций в заказах</th><th>Выручка</th><th>Доля</th></tr></thead>
        <tbody>
          ${rows.map(r => `<tr>
            <td>${esc(r.name)}</td>
            <td>${r.qty} ${r.unit}</td>
            <td>${r.orders}</td>
            <td>${fmtMoney(r.revenue)}</td>
            <td>${totalRevenue ? (r.revenue/totalRevenue*100).toFixed(1) : 0}%</td>
          </tr>`).join('')}
        </tbody>
        <tfoot><tr><td colspan="3"><b>Итого</b></td><td><b>${fmtMoney(totalRevenue)}</b></td><td></td></tr></tfoot>
      </table></div>`}
    </div>
  `;
}
function bindProductReportEvents() {
  document.getElementById('applyReportRange')?.addEventListener('click', () => {
    productReportRange.from = document.getElementById('reportFrom').value;
    productReportRange.to = document.getElementById('reportTo').value;
    render();
  });
  document.getElementById('clearReportRange')?.addEventListener('click', () => {
    productReportRange = { from: '', to: '' };
    render();
  });
}

/* ============ MARKETING ============ */
function viewMarketing() {
  const contacts = DB.counterparties.filter(c => c.email || c.telegram || c.whatsapp);
  const withEmail = DB.counterparties.filter(c => c.marketingConsent===true && c.email);
  const withTelegram = DB.counterparties.filter(c => c.marketingConsent===true && c.telegram);
  const withWhatsapp = DB.counterparties.filter(c => c.marketingConsent===true && c.whatsapp);
  return `
    <div class="card">
      <div class="card-header"><h2>📣 Маркетинг</h2></div>
      <p style="color:var(--text-muted); font-size:13px;">
        Здесь показаны только клиенты с явным согласием на рекламные предложения. CRM не отправляет письма/сообщения сама — она готовит список адресов и текст, а отправляешь ты через свою почту, Telegram или WhatsApp (у меня нет доступа к этим сервисам напрямую).
      </p>
      <div class="stat-grid">
        <div class="stat-card"><div class="stat-label">Есть email</div><div class="stat-value">${withEmail.length}</div></div>
        <div class="stat-card" style="border-left-color:#229ED9;"><div class="stat-label">Есть Telegram</div><div class="stat-value">${withTelegram.length}</div></div>
        <div class="stat-card" style="border-left-color:#25D366;"><div class="stat-label">Есть WhatsApp</div><div class="stat-value">${withWhatsapp.length}</div></div>
      </div>
      <h3>Контакты клиентов</h3>
      <p style="color:var(--text-muted); font-size:13px;">Контакты видны всегда. В рассылки ниже попадают только клиенты с отмеченным согласием.</p>
      ${contacts.length === 0 ? '<div class="empty-state">У контрагентов пока не заполнены Email, Telegram или WhatsApp.</div>' : `<div class="table-wrap"><table>
        <thead><tr><th>Клиент</th><th>Email</th><th>Telegram</th><th>WhatsApp</th><th>Рассылка</th></tr></thead>
        <tbody>${contacts.map(c => `<tr><td>${esc(c.name)}</td><td>${esc(c.email)||'—'}</td><td>${esc(c.telegram)||'—'}</td><td>${esc(c.whatsapp)||'—'}</td><td>${c.marketingConsent===true?'Разрешена':'Нет согласия'}</td></tr>`).join('')}</tbody>
      </table></div>`}
    </div>

    <div class="card">
      <h3 style="margin-top:0;">✉️ Рассылка по email</h3>
      <div class="field"><label>Тема письма</label><input type="text" id="mkEmailSubject" placeholder="Например: Скидка 15% на слабосол в эти выходные"></div>
      <div class="field"><label>Текст письма</label><textarea id="mkEmailBody" rows="4" style="width:100%; padding:8px; border:1px solid var(--border); border-radius:6px;" placeholder="Текст предложения..."></textarea></div>
      <label style="font-size:13px; display:flex; align-items:center; gap:6px; margin:8px 0;"><input type="checkbox" id="mkEmailSelectAll" checked> Выбрать всех с email (${withEmail.length})</label>
      <div class="table-wrap" style="max-height:220px; overflow-y:auto;"><table>
        <thead><tr><th></th><th>Имя</th><th>Email</th></tr></thead>
        <tbody>${withEmail.map(c => `<tr><td><input type="checkbox" class="mk-email-cb" value="${esc(c.email)}" checked></td><td>${esc(c.name)}</td><td>${esc(c.email)}</td></tr>`).join('')}</tbody>
      </table></div>
      <div class="modal-actions" style="justify-content:flex-start; margin-top:10px;">
        <button class="btn-secondary" id="mkCopyEmails">Скопировать адреса</button>
        <button class="btn-primary" id="mkOpenMail">Открыть в почте (BCC)</button>
      </div>
    </div>

    <div class="card">
      <h3 style="margin-top:0;">✈️ Клиенты с Telegram (${withTelegram.length})</h3>
      <p style="color:var(--text-muted); font-size:13px;">Массовая рассылка в Telegram требует своего бота — CRM пока даёт только список для ручной отправки.</p>
      <div class="table-wrap" style="max-height:220px; overflow-y:auto;"><table>
        <thead><tr><th>Имя</th><th>Telegram</th></tr></thead>
        <tbody>${withTelegram.map(c => `<tr><td>${esc(c.name)}</td><td>${esc(c.telegram)}</td></tr>`).join('')}</tbody>
      </table></div>
      <button class="btn-secondary" id="mkCopyTelegram" style="margin-top:8px;">Скопировать список</button>
    </div>

    <div class="card">
      <h3 style="margin-top:0;">💬 Клиенты с WhatsApp (${withWhatsapp.length})</h3>
      <div class="table-wrap" style="max-height:220px; overflow-y:auto;"><table>
        <thead><tr><th>Имя</th><th>WhatsApp</th></tr></thead>
        <tbody>${withWhatsapp.map(c => `<tr><td>${esc(c.name)}</td><td>${c.whatsapp}</td></tr>`).join('')}</tbody>
      </table></div>
      <button class="btn-secondary" id="mkCopyWhatsapp" style="margin-top:8px;">Скопировать список</button>
    </div>
  `;
}
function bindMarketingEvents() {
  document.getElementById('mkEmailSelectAll')?.addEventListener('change', (e) => {
    document.querySelectorAll('.mk-email-cb').forEach(cb => cb.checked = e.target.checked);
  });
  document.getElementById('mkCopyEmails')?.addEventListener('click', () => {
    const emails = [...document.querySelectorAll('.mk-email-cb:checked')].map(cb => cb.value);
    navigator.clipboard.writeText(emails.join(', '));
    showToast(`Скопировано адресов: ${emails.length} ✓`);
  });
  document.getElementById('mkOpenMail')?.addEventListener('click', () => {
    const emails = [...document.querySelectorAll('.mk-email-cb:checked')].map(cb => cb.value);
    const subject = encodeURIComponent(document.getElementById('mkEmailSubject').value || '');
    const body = encodeURIComponent(document.getElementById('mkEmailBody').value || '');
    if (emails.length === 0) { alert('Выберите хотя бы один email'); return; }
    window.location.href = `mailto:?bcc=${emails.join(',')}&subject=${subject}&body=${body}`;
  });
  document.getElementById('mkCopyTelegram')?.addEventListener('click', () => {
    const list = DB.counterparties.filter(c => c.marketingConsent===true && c.telegram).map(c => `${esc(c.name)}: ${esc(c.telegram)}`).join('\n');
    navigator.clipboard.writeText(list);
    showToast('Список скопирован ✓');
  });
  document.getElementById('mkCopyWhatsapp')?.addEventListener('click', () => {
    const list = DB.counterparties.filter(c => c.marketingConsent===true && c.whatsapp).map(c => `${esc(c.name)}: ${c.whatsapp}`).join('\n');
    navigator.clipboard.writeText(list);
    showToast('Список скопирован ✓');
  });
}

function viewOrders() {
  const rows = [...DB.orders].filter(matchesOrder).sort((a,b) => b.date.localeCompare(a.date));
  const badgeClass = { new: 'badge-new', progress: 'badge-progress', done: 'badge-done', cancel: 'badge-cancel' };
  const statusLabel = { new: 'Новый', progress: 'В работе', done: 'Выполнен', cancel: 'Отменён' };
  const paymentLabel = { prepay: 'Предоплата', postpay: 'Постоплата' };
  const orderStatusLabels = { draft: 'Черновик', confirmed: 'Подтверждён', reserved: 'В резерве', posted: 'Проведён', completed: 'Выполнен', cancelled: 'Отменён' };
  const allowedOrderStatuses = {
    draft: ['draft', 'confirmed', 'cancelled'],
    confirmed: ['confirmed', 'reserved', 'cancelled'],
    reserved: ['reserved', 'posted', 'cancelled'],
    posted: ['posted', 'completed'],
    completed: ['completed'],
    cancelled: ['cancelled']
  };
  return `
    <div class="card">
      <div class="card-header">
        <h2>Заказы контрагентов</h2>
        <button class="btn-primary" id="addOrderBtn">+ Новый заказ</button>
      </div>
      ${rows.length === 0 ? '<div class="empty-state">Заказов пока нет.</div>' : `
      <div class="table-wrap"><table>
        <thead><tr><th>Дата</th><th>№ с сайта</th><th>Контрагент</th><th>Компания</th><th>Состав</th><th>Сумма без НДС</th><th>НДС</th><th>Доставка</th><th>Итого</th><th>Оплата</th><th>Статус</th><th></th></tr></thead>
        <tbody>
          ${rows.map(o => {
            const cp = getCounterparty(o.counterpartyId);
            const comp = getCompany(o.companyId);
            const itemsStr = o.items.map(it => { const p = getProduct(it.productId); return `${p ? esc(p.name) : '?'} × ${it.qty} ${p ? p.unit : ''}`; }).join(', ');
            return `<tr>
              <td>${fmtDate(o.date)}</td>
              <td>${o.externalOrderNumber ? `<span class="badge" style="background:#e8f4f6; color:#0e7c86;">🌐 ${o.externalOrderNumber}</span>` : '—'}</td>
              <td>${cp ? esc(cp.name) : '—'}${cp && esc(cp.telegram) ? `<br><a href="https://t.me/${cp.telegram.replace('@','')}" target="_blank" style="color:#229ED9; font-size:12px; text-decoration:none;">✈️ ${esc(cp.telegram)}</a>` : ''}${cp && cp.whatsapp ? `<br><a href="https://wa.me/${cp.whatsapp.replace(/\D/g,'')}" target="_blank" style="color:#25D366; font-size:12px; text-decoration:none;">💬 ${cp.whatsapp}</a>` : ''}</td>
              <td>${comp ? esc(comp.name) : '—'}</td>
              <td>${itemsStr}</td>
              <td>${fmtMoney(orderTotal(o))}</td>
              <td>${o.vatRate ? fmtMoney(orderVAT(o)) + ` (${o.vatRate}%)` : '—'}</td>
              <td>${o.deliveryCost ? fmtMoney(o.deliveryCost) : '—'}</td>
              <td><b>${fmtMoney(orderGrandTotal(o))}</b></td>
              <td>
                <div>${paymentLabel[o.paymentType] || '—'}</div>
                <div>Оплачено: ${fmtMoney(receivedPayment(o))}<br>Долг: ${fmtMoney(debt(o))}</div><button data-payment="${o.id}" class="btn-secondary btn-sm">Оплата</button><button data-return="${o.id}" class="btn-secondary btn-sm">Возврат</button>
              </td>
              <td>
                <select class="order-status-select" aria-label="Статус заказа" data-status-select="${o.id}">
                  ${(allowedOrderStatuses[o.status] || [o.status]).map(status => `<option value="${status}" ${o.status===status?'selected':''}>${orderStatusLabels[status] || status}</option>`).join('')}
                </select>
              </td>
              <td>${!['completed','cancelled'].includes(o.status)?`<button class="btn-primary btn-sm" data-fulfill-order="${o.id}">Исполнен</button>`:''}<button class="icon-btn" data-edit-order="${o.id}">✏️</button><button class="icon-btn" data-del-order="${o.id}">🗑</button></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table></div>`}
    </div>
  `;
}

let orderItemCount = 0;
function orderFormHtml(editId) {
  const editing = editId ? DB.orders.find(o => o.id === editId) : null;
  const selectedCounterparty = editing ? getCounterparty(editing.counterpartyId) : null;
  orderItemCount = editing ? editing.items.length : 1;
  return `
    <h2>${editing ? 'Редактировать заказ' : 'Новый заказ'}</h2>
    <form id="orderForm">
      <div class="row">
        <div class="field"><label>Дата</label><input type="date" name="date" value="${editing ? editing.date : todayStr()}" required></div>
        <div class="field"><label>Контрагент</label>
          ${searchableSelectHtml('orderCpSelect', 'counterpartyId', selectedCounterparty?.name, 'Имя или телефон…', selectedCounterparty?.id)}
        </div>
      </div>
      <div id="newCpInline" class="inline-create" hidden>
        <strong>Новый клиент</strong>
        <div class="row">
          <div class="field"><label for="newCpName">Имя</label><input id="newCpName" type="text"></div>
          <div class="field"><label for="newCpPhone">Телефон</label><input id="newCpPhone" type="tel"></div>
          <div class="field"><label for="newCpType">Тип</label><select id="newCpType"><option value="private">Частное лицо</option><option value="restaurant">Ресторан / компания</option></select></div>
        </div>
        <button type="button" class="btn-secondary btn-sm" id="newCpSaveBtn">Сохранить клиента</button>
      </div>
      <div class="row">
        <div class="field"><label>Компания (на кого оформляется)</label>
          <select name="companyId" id="orderCompanySelect">
            ${DB.companies.map(c => `<option value="${c.id}" data-vatrate="${c.vatRate||0}" ${editing ? (editing.companyId===c.id?'selected':'') : ''}>${esc(c.name)}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label>Ставка НДС, % (0 — без НДС)</label><input type="number" step="0.1" min="0" name="vatRate" id="orderVatRate" value="${editing ? (editing.vatRate||0) : (DB.companies[0] ? DB.companies[0].vatRate||0 : 0)}"></div>
      </div>
      <div class="row">
        <div class="field"><label>Тип оплаты</label>
          <select name="paymentType">
            <option value="prepay" ${editing && editing.paymentType==='prepay'?'selected':''}>Предоплата</option>
            <option value="postpay" ${!editing || editing.paymentType==='postpay'?'selected':''}>Постоплата</option>
          </select>
        </div>
        
        <div class="field"><label>Стоимость доставки, ₾ (расход, уменьшает прибыль)</label><input type="number" step="0.01" min="0" name="deliveryCost" value="${editing ? (editing.deliveryCost||0) : 0}"></div>
      </div>
      <label>Товары в заказе</label>
      <div id="orderItemsWrap">${editing ? editing.items.map((it, i) => orderItemRowHtml(i, it)).join('') : orderItemRowHtml(0)}</div>
      <button type="button" class="btn-secondary btn-sm" id="addOrderItemBtn" style="margin-top:6px;">+ Добавить товар</button>
      <div class="field" style="margin-top:14px;"><label>Статус</label>
        <input type="hidden" name="status" value="draft">
        <div class="field-hint"><b>Черновик.</b> После сохранения измените статус в таблице заказов: Подтверждён → В резерве → Проведён → Выполнен.</div>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn-secondary" id="cancelModalBtn">Отмена</button>
        <button type="submit" class="btn-primary">${editing ? 'Сохранить изменения' : 'Сохранить заказ'}</button>
      </div>
    </form>
  `;
}
function orderItemRowHtml(idx, preset) {
  const selectedProduct = preset ? getProduct(preset.productId) : null;
  return `
    <div class="pill-input-row" data-order-item="${idx}" style="margin-bottom:8px;">
      <div style="flex:2; min-width:220px;">${searchableSelectHtml('item_product_' + idx, 'item_product_' + idx,
        selectedProduct ? `${selectedProduct.name} (${selectedProduct.unit})` : '',
        'Название товара…', selectedProduct?.id)}</div>
      <input type="number" step="0.01" min="0" aria-label="Количество товара" name="item_qty_${idx}" placeholder="Кол-во" style="flex:1;" value="${preset ? preset.qty : ''}">
      <input type="number" step="0.01" min="0" aria-label="Цена товара" name="item_price_${idx}" placeholder="Цена/ед." style="flex:1;" value="${preset ? preset.price : ''}">
    </div>
  `;
}
function bindOrderFormCommon(onSubmit, isNew) {
  document.getElementById('cancelModalBtn').addEventListener('click', closeModal);
  const selectCounterparty = option => {
    const counterparty = getCounterparty(option.id);
    const preferredId = counterparty?.preferredCompanyId;
    if (!preferredId) return;
    const companySelect = document.getElementById('orderCompanySelect');
    companySelect.value = preferredId;
    const companyOption = companySelect.selectedOptions[0];
    document.getElementById('orderVatRate').value = companyOption?.dataset.vatrate || 0;
  };
  const counterpartyOptions = DB.counterparties.map(counterparty => ({
    id: counterparty.id,
    label: counterparty.name,
    sub: counterparty.phone || counterparty.telegram || counterparty.email || ''
  })).sort((a, b) => a.label.localeCompare(b.label, 'ru'));
  initSearchableSelect('orderCpSelect', counterpartyOptions, selectCounterparty, 'Добавить нового клиента', typedName => {
    const panel = document.getElementById('newCpInline');
    panel.hidden = false;
    document.getElementById('newCpName').value = typedName;
    document.getElementById('newCpName').focus();
  });
  document.getElementById('newCpSaveBtn').addEventListener('click', async event => {
    const name = document.getElementById('newCpName').value.trim();
    if (!name) { showToast('Укажите имя клиента'); return; }
    const button = event.currentTarget;
    const id = uid();
    button.disabled = true;
    DB.counterparties.push({
      id,
      name,
      phone: document.getElementById('newCpPhone').value.trim(),
      type: document.getElementById('newCpType').value,
      status: 'draft'
    });
    try {
      if (!await saveData(DB)) return;
      const saved = getCounterparty(id);
      document.getElementById('orderCpSelect').value = id;
      document.getElementById('orderCpSelect_input').value = saved?.name || name;
      document.getElementById('newCpInline').hidden = true;
      selectCounterparty({id});
      showToast('Клиент сохранён');
    } finally { button.disabled = false; }
  });
  const initProductSearch = idx => {
    const row = document.querySelector(`[data-order-item="${idx}"]`);
    const priceInput = row?.querySelector(`[name="item_price_${idx}"]`);
    const productOptions = DB.products.filter(product => product.active && product.type === 'finished')
      .map(product => ({id: product.id, label: `${product.name} (${product.unit})`, sub: fmtMoney(product.sellPrice)}))
      .sort((a, b) => a.label.localeCompare(b.label, 'ru'));
    initSearchableSelect('item_product_' + idx, productOptions, option => {
      if (priceInput && !priceInput.value) priceInput.value = getProduct(option.id)?.sellPrice || 0;
    });
  };
  document.querySelectorAll('[data-order-item]').forEach(row => initProductSearch(row.dataset.orderItem));
  document.getElementById('addOrderItemBtn').addEventListener('click', () => {
    document.getElementById('orderItemsWrap').insertAdjacentHTML('beforeend', safeHTML(orderItemRowHtml(orderItemCount)));
    initProductSearch(orderItemCount);
    orderItemCount++;
  });
  document.getElementById('orderCompanySelect')?.addEventListener('change', (e) => {
    const opt = e.target.selectedOptions[0];
    document.getElementById('orderVatRate').value = opt.dataset.vatrate || 0;
  });
  if (isNew && DB.counterparties.length === 1) {
    const only = DB.counterparties[0];
    document.getElementById('orderCpSelect').value = only.id;
    document.getElementById('orderCpSelect_input').value = only.name;
    selectCounterparty({id: only.id});
  }
  document.getElementById('orderForm').addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    if (!f.get('counterpartyId')) { showToast('Выберите контрагента из списка'); return; }
    const items = [];
    document.querySelectorAll('[data-order-item]').forEach(row => {
      const idx = row.dataset.orderItem;
      const productId = f.get(`item_product_${idx}`);
      const qty = parseFloat(f.get(`item_qty_${idx}`));
      const price = parseFloat(f.get(`item_price_${idx}`));
      if (productId && qty > 0 && price >= 0) items.push({ productId, qty, price });
    });
    if (items.length === 0) { alert('Добавьте хотя бы один товар с количеством'); return; }
    await onSubmit({
      date: f.get('date'), counterpartyId: f.get('counterpartyId'), items, status: f.get('status'),
      companyId: f.get('companyId') || null, vatRate: parseFloat(f.get('vatRate')) || 0,
      paymentType: f.get('paymentType'), paid: f.get('paid') === '1',
      deliveryCost: parseFloat(f.get('deliveryCost')) || 0
    });
  });
}
function bindOrdersEvents() {
  document.getElementById('addOrderBtn')?.addEventListener('click', () => {
    openModal(orderFormHtml(null));
    bindOrderFormCommon(async (data) => {
      DB.orders.push({ id: uid(), ...data });
      if (!await saveData(DB)) return; closeModal(); render();
    }, true);
  });
  document.querySelectorAll('[data-edit-order]').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.editOrder;
      openModal(orderFormHtml(id));
      bindOrderFormCommon(async (data) => {
        DB.orders = DB.orders.map(o => o.id === id ? { ...o, ...data } : o);
        if (!await saveData(DB)) return; closeModal(); render();
      }, false);
    });
  });
  document.querySelectorAll('[data-del-order]').forEach(el => {
    el.addEventListener('click', async () => {
      if (confirm('Отменить заказ и освободить резерв? Проведённый заказ требует возврата.')) {
        const id = el.dataset.delOrder;
        DB.orders = DB.orders.filter(o => o.id !== id); if (!await saveData(DB)) return; render();
      }
    });
  });
  document.querySelectorAll('[data-status-select]').forEach(el => {
    el.addEventListener('change', async () => {
      const id = el.dataset.statusSelect;
      if(['posted','cancelled'].includes(el.value)&&!confirm(el.value==='posted'?'Провести заказ и списать зарезервированный товар?':'Отменить заказ и освободить резерв?')){render();return;}
      DB.orders = DB.orders.map(o => o.id === id ? { ...o, status: el.value } : o);
      if (!await saveData(DB)) return; showToast('Статус обновлён ✓'); render();
    });
  });
  document.querySelectorAll('[data-paid-toggle]').forEach(el => {
    el.addEventListener('change', async () => {
      const id = el.dataset.paidToggle;
      DB.orders = DB.orders.map(o => o.id === id ? { ...o, paid: el.checked } : o);
      if (!await saveData(DB)) return; showToast(el.checked ? 'Отмечено как оплачено ✓' : 'Отмечено как неоплачено'); render();
    });
  });
}

/* ============ PRODUCTS & PRICES ============ */
function viewProducts() {
  const groups = Object.keys(PRODUCTION_ROLE_LABELS).map(role=>({role,list:DB.products.filter(p=>p.active&&productionRole(p)===role)}));
  const renderTable = (list) => `
      <div class="table-wrap"><table>
        <thead><tr><th>Товар</th><th>Вид сырья</th><th>Категория</th><th>Продажа</th><th>Приёмка</th><th>Ед.</th><th>Закупочная цена</th><th>Цена продажи</th><th></th></tr></thead>
        <tbody>
          ${list.map(p => `
            <tr>
              <td>${p.emoji} <b>${esc(p.name)}</b></td>
              <td>${esc(productionSpeciesLabel(p))}</td>
              <td>${categoryLabel(p.category)}</td>
              <td>${p.type==='finished'?'да':'нет'}</td>
              <td>${canReceiveProduct(p)?'да':'нет'}</td>
              <td>${p.unit}</td>
              <td>${fmtMoney(p.purchasePrice)}</td>
              <td>${p.sellPrice ? fmtMoney(p.sellPrice) : '—'}</td>
              <td><button class="icon-btn" data-edit-product="${p.id}">✏️</button><button class="icon-btn" data-del-product="${p.id}">🗑</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table></div>`;
  return `
    ${groups.map((group,index)=>`<div class="card"><div class="card-header"><h2>${esc(PRODUCTION_ROLE_LABELS[group.role])}</h2>${index===0?'<button class="btn-primary" id="addProductBtn">+ Новый товар</button>':''}</div>${group.list.length?renderTable(group.list):'<div class="empty-state">Нет товаров в этой роли.</div>'}</div>`).join('')}
  `;
}
function categoryLabel(c) {
  return {
    raw: 'Сырьё (для переработки)',
    fresh: 'Свежие охлаждённые',
    salted: 'Слабосолёные',
    marinated: 'Маринованные',
    caviar: 'Икра',
    ready: 'Готовая еда / замороженные'
  }[c] || c;
}
function productFormHtml(editId) {
  const editing = editId ? getProduct(editId) : null;
  return `
    <h2>${editing ? 'Редактировать товар' : 'Новый товар'}</h2>
    <form id="productForm"><div class="row">
 <div class="field"><label>Артикул</label><input name="sku" value="${esc(editing?.sku)||''}" required></div>
 <div class="field"><label>Базовая единица</label><select name="baseUnit">${['kg','g','pcs','pack'].map(u=>`<option value="${u}" ${editing?.baseUnit===u?'selected':''}>${u}</option>`).join('')}</select></div>
 <div class="field"><label>Базовых единиц в продаваемой упаковке</label><input name="packageFactor" type="number" min="0.000001" step="0.000001" value="${editing?.packageFactor||1}" required></div></div>
      <div class="row">
        <div class="field"><label>Название</label><input type="text" name="displayName" value="${editing ? esc(editing.name) : ''}" required></div>
        <div class="field"><label>Эмодзи-иконка</label><input type="text" name="emoji" value="${editing ? editing.emoji : '🐟'}" maxlength="2"></div>
      </div>
      <div class="row">
        <div class="field"><label>Роль в переработке</label><select name="productionRole">
          ${Object.entries(PRODUCTION_ROLE_LABELS).map(([value,label])=>`<option value="${value}" ${productionRole(editing)===value?'selected':''}>${esc(label)}</option>`).join('')}
        </select></div>
        <div class="field"><label>Вид сырья</label><select name="productionSpecies" required>
          <option value="">— выберите —</option>
          ${Object.entries(PRODUCTION_SPECIES_PRESETS).map(([value,label])=>`<option value="${value}" ${productSpecies(editing).join(',')===value?'selected':''}>${esc(label)}</option>`).join('')}
        </select><small>Выход переработки разрешён только для совместимого вида.</small></div>
        <div class="field"><label><input type="checkbox" name="receivable" ${editing?.receivable===true?'checked':''}> Можно принимать от поставщика</label><small>В приёмке будут видны только товары с этим разрешением.</small></div>
      </div>
      <div class="row">
        <div class="field"><label>Тип товара</label>
          <select name="type">
            <option value="raw" ${editing && editing.type==='raw' ? 'selected':''}>Сырьё (для приёмки/переработки)</option>
            <option value="finished" ${editing && editing.type==='finished' ? 'selected':''}>Готовый товар (для продажи)</option>
          </select>
        </div>
        <div class="field"><label>Единица / упаковка</label><input type="text" name="unit" value="${editing ? editing.unit : 'кг'}" placeholder="кг, 500 г, шт, 14 шт..."></div>
      </div>
      <div class="field"><label>Категория</label>
        <select name="category">
          <option value="raw" ${editing && editing.category==='raw' ? 'selected':''}>Сырьё (для переработки)</option>
          <option value="fresh" ${editing && editing.category==='fresh' ? 'selected':''}>Свежие охлаждённые</option>
          <option value="salted" ${editing && editing.category==='salted' ? 'selected':''}>Слабосолёные</option>
          <option value="marinated" ${editing && editing.category==='marinated' ? 'selected':''}>Маринованные</option>
          <option value="caviar" ${editing && editing.category==='caviar' ? 'selected':''}>Икра</option>
          <option value="ready" ${editing && editing.category==='ready' ? 'selected':''}>Готовая еда / замороженные</option>
        </select>
      </div>
      <div class="row">
        <div class="field"><label>Закупочная цена за единицу (₾)</label><input type="number" step="0.01" min="0" name="purchasePrice" value="${editing ? editing.purchasePrice : ''}"></div>
        <div class="field"><label>Цена продажи за единицу (₾)</label><input type="number" step="0.01" min="0" name="sellPrice" value="${editing ? editing.sellPrice : ''}"></div>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn-secondary" id="cancelModalBtn">Отмена</button>
        <button type="submit" class="btn-primary">${editing ? 'Сохранить' : 'Добавить'}</button>
      </div>
    </form>
  `;
}
function bindProductsEvents() {
  document.getElementById('addProductBtn')?.addEventListener('click', () => {
    openModal(productFormHtml(null));
    document.getElementById('cancelModalBtn').addEventListener('click', closeModal);
    document.getElementById('productForm').addEventListener('submit', async e => {
      e.preventDefault();
      const f = new FormData(e.target);
      const role=f.get('productionRole');
      DB.products.push({ id: uid(), name: f.get('displayName'), sku:f.get('sku'),baseUnit:f.get('baseUnit'),packageFactor:Number(f.get('packageFactor')), emoji: f.get('emoji') || '🐟', category: f.get('category'), type: f.get('type') || 'finished', unit: f.get('unit') || 'кг', purchasePrice: parseFloat(f.get('purchasePrice'))||0, sellPrice: parseFloat(f.get('sellPrice'))||0, productionRole:role, productionSpecies:String(f.get('productionSpecies')||'').split(',').filter(Boolean), receivable:f.get('receivable')==='on', isTerminal:['stage1_final','stage2_final'].includes(role) });
      if (!await saveData(DB)) return; closeModal(); render();
    });
  });
  document.querySelectorAll('[data-edit-product]').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.editProduct;
      openModal(productFormHtml(id));
      document.getElementById('cancelModalBtn').addEventListener('click', closeModal);
      document.getElementById('productForm').addEventListener('submit', async e => {
        e.preventDefault();
        const f = new FormData(e.target);
        const role=f.get('productionRole');
        DB.products = DB.products.map(p => p.id === id ? { ...p, name: f.get('displayName'), sku:f.get('sku'),baseUnit:f.get('baseUnit'),packageFactor:Number(f.get('packageFactor')), emoji: f.get('emoji')||'🐟', category: f.get('category'), type: f.get('type') || p.type, unit: f.get('unit') || p.unit, purchasePrice: parseFloat(f.get('purchasePrice'))||0, sellPrice: parseFloat(f.get('sellPrice'))||0, productionRole:role, productionSpecies:String(f.get('productionSpecies')||'').split(',').filter(Boolean), receivable:f.get('receivable')==='on', isTerminal:['stage1_final','stage2_final'].includes(role) } : p);
        if (!await saveData(DB)) return; closeModal(); render();
      });
    });
  });
  document.querySelectorAll('[data-del-product]').forEach(el => {
    el.addEventListener('click', async () => {
      if (confirm('Архивировать товар? История сохранится.')) { DB.products = DB.products.filter(p => p.id !== el.dataset.delProduct); if (!await saveData(DB)) return; render(); }
    });
  });
}

/* ================= WORKER CABINET ================= */
function renderWorker(user) {
  const app = document.getElementById('app');
  app.innerHTML = safeHTML(`<div id="workerScreen"></div>`);
  const screen = document.getElementById('workerScreen');

  if (session.view === 'workerMenu') {
    screen.innerHTML = safeHTML(`
      <div class="worker-header">
        <div><h1 style="margin:0;">Привет, ${user.name.split(' ')[0]}! 👋</h1><div style="color:var(--text-muted); font-size:13px;">${fmtDate(todayStr())} · ${esc(user.position)||''}</div></div>
        <button class="btn-secondary" id="logoutBtn">Выйти</button>
      </div>
      <div class="tile-grid">
        <div class="tile" data-goto="receiving"><div class="tile-emoji">📥</div><div class="tile-label">Приёмка</div></div>
        <div class="tile" data-processing-tile><div class="tile-emoji">🔪</div><div class="tile-label">Переработка</div></div>
        <div class="tile" data-goto="clock"><div class="tile-emoji">⏱️</div><div class="tile-label">Учёт времени</div></div>
        <div class="tile" data-goto="myReceivings"><div class="tile-emoji">📋</div><div class="tile-label">Мои записи за сегодня</div></div>
        <div class="tile" data-goto="myWallet"><div class="tile-emoji">💰</div><div class="tile-label">Мой заработок</div></div>
      </div>
    `);
    document.getElementById('logoutBtn').addEventListener('click', doLogout);
    screen.querySelectorAll('[data-goto]').forEach(el => {
      el.addEventListener('click', () => { session.view = el.dataset.goto; render(); });
    });
    screen.querySelector('[data-processing-tile]')?.addEventListener('click', () => {
      session.view = 'processingWorker'; render();
    });
  }
  else if (session.view === 'processingWorker') {
    const findByName = (name) => DB.products.find(p => p.name === name);
    const OUTPUT_CONFIG = {
      'Форель (Турция, целая тушка)': [
        { key: 'filet', label: 'Филе', name: 'Филе турецкой форели' },
        { key: 'steak', label: 'Стейки', name: 'Стейки форели охлаждённые' },
        { key: 'farsh', label: 'Фарш', name: 'Фарш форели (полуфабрикат)' }
      ],
      'Сёмга / лосось норвежский (потрошёная)': [
        { key: 'filet', label: 'Филе', name: 'Филе норвежской сёмги' },
        { key: 'steak', label: 'Стейк', name: 'Стейк лосося' },
        { key: 'farsh', label: 'Фарш', name: 'Фарш сёмги (полуфабрикат)' }
      ],
      'Дорадо (целая)': [{ key: 'filet', label: 'Филе', name: 'Филе дорадо' }],
      'Дорадо (потрошёная)': [{ key: 'filet', label: 'Филе', name: 'Филе дорадо' }],
      'Сибас (целая)': [{ key: 'filet', label: 'Филе', name: 'Филе сибаса' }],
      'Сибас (потрошёная)': [{ key: 'filet', label: 'Филе', name: 'Филе сибаса' }]
    };
    const SALTING_MAP = {
      'Филе турецкой форели': 'Слабосолёное филе форели (навес, кг)',
      'Филе норвежской сёмги': 'Слабосолёное филе сёмги (навес, кг)'
    };

    const rawCards = Object.keys(OUTPUT_CONFIG).map(rawName => {
      const rawP = findByName(rawName);
      if (!rawP) return null;
      const receivedTotal = DB.receivings.filter(r => r.productId === rawP.id).reduce((s,r)=>s+Number(r.volumeKg),0);
      if (receivedTotal <= 0.001) return null;
      return `<div class="card">
        <div style="font-weight:700; font-size:16px;">${rawP.emoji} ${esc(rawP.name)}</div>
        <button class="btn-primary btn-sm" data-species-menu="${rawP.id}">Что переработали?</button>
      </div>`;
    }).filter(Boolean).join('');

    const filetCards = Object.keys(SALTING_MAP).map(filetName => {
      const filetP = findByName(filetName);
      const bulkP = findByName(SALTING_MAP[filetName]);
      if (!filetP || !bulkP) return null;
      const stock = getStock(filetP.id).qty;
      const sentToSalting = DB.processing.filter(pr => pr.inputProductId === filetP.id && pr.note === 'в засолку').reduce((s,pr)=>s+Number(pr.inputQty||0),0);
      const retrieved = DB.processing.filter(pr => pr.output1ProductId === bulkP.id && pr.note === 'из засолки').reduce((s,pr)=>s+Number(pr.output1Qty||0),0);
      const inTransit = Math.max(0, sentToSalting - retrieved);
      if (stock <= 0.001 && inTransit <= 0.001) return null;
      return `<div class="card">
        <div style="font-weight:700; font-size:16px;">${filetP.emoji} ${esc(filetP.name)}</div>
        ${stock > 0.001 ? `<div style="color:var(--text-muted); margin:4px 0 6px;">Свежее на складе: <b>${fmtKg(stock)}</b></div>
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          <button class="btn-accent btn-sm" data-salt-send="${filetP.id}">🧂 Отправить в засолку</button>
          <button class="btn-secondary btn-sm" data-dispatch="${filetP.id}" data-pname="${esc(filetP.name)}">📦 Отправлено клиенту / на склад</button>
        </div>` : ''}
        ${inTransit > 0.001 ? `<div style="color:var(--accent); margin:10px 0 6px; font-weight:700;">🧂 В засолке сейчас: ${fmtKg(inTransit)}</div>
        <button class="btn-secondary btn-sm" data-salt-retrieve="${filetP.id}" data-bulk="${bulkP.id}" data-max="${inTransit}">✅ Забрать из засолки</button>` : ''}
      </div>`;
    }).filter(Boolean).join('');

    const myToday = DB.processing.filter(pr => pr.workerId === user.id && pr.date === todayStr()).sort((a,b)=>0);
    const historyHtml = myToday.length ? `
      <div class="card">
        <div style="font-weight:700; margin-bottom:8px;">История ваших записей сегодня</div>
        <div class="table-wrap"><table>
          <thead><tr><th>Вход</th><th>Выходы</th><th>Примечание</th><th></th></tr></thead>
          <tbody>
            ${myToday.map(pr => {
              const inP = getProduct(pr.inputProductId);
              const outs = [[pr.output1ProductId, pr.output1Qty],[pr.output2ProductId, pr.output2Qty],[pr.output3ProductId, pr.output3Qty]]
                .filter(([pid, q]) => pid && q)
                .map(([pid, q]) => { const p = getProduct(pid); return `${p ? esc(p.name) : '?'}: ${q} ${p?p.unit:''}`; }).join('<br>');
              return `<tr>
                <td>${inP ? esc(inP.name) + ': ' + pr.inputQty + ' ' + inP.unit : '—'}</td>
                <td>${outs || '—'}</td>
                <td>${esc(pr.note) || ''}</td>
                <td><button class="icon-btn" data-del-my-processing="${pr.id}">🗑</button></td>
              </tr>`;
            }).join('')}
          </tbody>
        </table></div>
      </div>` : '';

    screen.innerHTML = safeHTML(`
      <div class="back-link" id="backBtn">← Назад в меню</div>
      <h1 style="margin-top:0;">Переработка сегодня</h1>
      ${rawCards || '<div class="empty-state">Пока нет непереработанного сырья.</div>'}
      ${filetCards}
      ${historyHtml}
      <div style="text-align:center; margin-top:10px;">
        <a href="#" id="detailedProcessingLink" style="color:var(--text-muted); font-size:13px;">Подробная запись (другой товар)</a>
      </div>
    `);
    document.getElementById('backBtn').addEventListener('click', () => { session.view = 'workerMenu'; render(); });
    document.getElementById('detailedProcessingLink').addEventListener('click', (e) => { e.preventDefault(); openWorkerProcessingForm(user); });

    screen.querySelectorAll('[data-del-my-processing]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (confirm('Удалить эту запись?')) {
          DB.processing = DB.processing.filter(pr => pr.id !== btn.dataset.delMyProcessing);
          if (!await saveData(DB)) return; showToast('Запись удалена ✓'); render();
        }
      });
    });

    screen.querySelectorAll('[data-species-menu]').forEach(btn => {
      btn.addEventListener('click', () => {
        const rawId = btn.dataset.speciesMenu;
        const rawP = getProduct(rawId);
        const outs = OUTPUT_CONFIG[rawP.name] || [];
        const todayTotals = outs.map(o => {
          const destP = findByName(o.name);
          const total = destP ? DB.processing.filter(pr=>pr.date===todayStr()).reduce((s,pr)=>{
            let q = 0;
            if (pr.output1ProductId===destP.id) q+=Number(pr.output1Qty||0);
            if (pr.output2ProductId===destP.id) q+=Number(pr.output2Qty||0);
            if (pr.output3ProductId===destP.id) q+=Number(pr.output3Qty||0);
            return s+q;
          },0) : 0;
          return { o, destP, total };
        });
        openModal(`
          <h2>${rawP.emoji} ${esc(rawP.name)} — что получилось?</h2>
          <div style="display:flex; flex-direction:column; gap:10px; margin-top:10px;">
            ${todayTotals.map(t => `
              <button class="btn-secondary" data-out-cat="${t.destP ? t.destP.id : ''}" data-label="${t.o.label}" style="text-align:left; padding:14px; font-size:16px;">
                + ${t.o.label} <span style="float:right; color:var(--text-muted); font-size:13px;">сегодня: ${fmtKg(t.total)}</span>
              </button>
            `).join('')}
          </div>
          <div class="modal-actions"><button type="button" class="btn-secondary" id="cancelModalBtn">Отмена</button></div>
        `);
        document.getElementById('cancelModalBtn').addEventListener('click', closeModal);
        document.getElementById('modalRoot').querySelectorAll('[data-out-cat]').forEach(catBtn => {
          catBtn.addEventListener('click', () => {
            const destId = catBtn.dataset.outCat;
            const label = catBtn.dataset.label;
            openModal(`
              <h2>+ ${label}</h2>
              <form id="outQtyForm">
                <div class="field"><label>Сколько получилось, кг?</label><input type="number" step="0.005" min="0" name="qty" required autofocus></div>
                <div class="modal-actions">
                  <button type="button" class="btn-secondary" id="cancelModalBtn">Отмена</button>
                  <button type="submit" class="btn-primary">Добавить</button>
                </div>
              </form>
            `);
            document.getElementById('cancelModalBtn').addEventListener('click', closeModal);
            document.getElementById('outQtyForm').addEventListener('submit', async e => {
              e.preventDefault();
              const qty = parseFloat(new FormData(e.target).get('qty')) || 0;
              if (qty <= 0) { closeModal(); return; }
              if (!confirmBigQty(qty)) return;
              DB.processing.push({
                id: uid(), date: todayStr(),
                inputProductId: null, inputQty: 0,
                output1ProductId: destId, output1Qty: qty,
                output2ProductId: null, output2Qty: 0,
                output3ProductId: null, output3Qty: 0,
                wasteQty: 0, workerId: user.id, note: label
              });
              if (!await saveData(DB)) return; closeModal(); showToast(`+${qty} кг: ${label} ✓`); render();
            });
          });
        });
      });
    });

    screen.querySelectorAll('[data-dispatch]').forEach(btn => {
      btn.addEventListener('click', () => {
        const productId = btn.dataset.dispatch;
        const pName = btn.dataset.pname;
        const stock = getStock(productId).qty;
        openModal(`
          <h2>📦 Отправлено клиенту / на склад</h2>
          <form id="dispatchForm">
            <div class="field"><label>${pName} — сколько кг, кг (доступно ${fmtKg(stock)})</label><input type="number" step="0.005" min="0" max="${stock}" name="qty" required autofocus></div>
            <div class="modal-actions">
              <button type="button" class="btn-secondary" id="cancelModalBtn">Отмена</button>
              <button type="submit" class="btn-primary">Сохранить</button>
            </div>
          </form>
        `);
        document.getElementById('cancelModalBtn').addEventListener('click', closeModal);
        document.getElementById('dispatchForm').addEventListener('submit', async e => {
          e.preventDefault();
          const qty = parseFloat(new FormData(e.target).get('qty')) || 0;
          if (qty <= 0) { closeModal(); return; }
          if (!confirmBigQty(qty)) return;
          DB.processing.push({
            id: uid(), date: todayStr(),
            inputProductId: productId, inputQty: qty,
            output1ProductId: null, output1Qty: 0, output2ProductId: null, output2Qty: 0, output3ProductId: null, output3Qty: 0,
            wasteQty: 0, workerId: user.id, note: 'отправлено клиенту/на склад'
          });
          if (!await saveData(DB)) return; closeModal(); showToast(`Отправлено: ${qty} кг ✓`); render();
        });
      });
    });

    screen.querySelectorAll('[data-salt-send]').forEach(btn => {
      btn.addEventListener('click', () => {
        const filetId = btn.dataset.saltSend;
        const filetP = getProduct(filetId);
        const stock = getStock(filetId).qty;
        openModal(`
          <h2>🧂 Отправить в засолку</h2>
          <form id="saltSendForm">
            <div class="field"><label>Сколько кг филе отправляем, кг (доступно ${fmtKg(stock)})</label><input type="number" step="0.005" min="0" max="${stock}" name="qty" required autofocus></div>
            <div class="modal-actions">
              <button type="button" class="btn-secondary" id="cancelModalBtn">Отмена</button>
              <button type="submit" class="btn-primary">Отправить</button>
            </div>
          </form>
        `);
        document.getElementById('cancelModalBtn').addEventListener('click', closeModal);
        document.getElementById('saltSendForm').addEventListener('submit', async e => {
          e.preventDefault();
          const qty = parseFloat(new FormData(e.target).get('qty')) || 0;
          if (qty <= 0) { closeModal(); return; }
          if (!confirmBigQty(qty)) return;
          DB.processing.push({
            id: uid(), date: todayStr(),
            inputProductId: filetId, inputQty: qty,
            output1ProductId: null, output1Qty: 0, output2ProductId: null, output2Qty: 0, output3ProductId: null, output3Qty: 0,
            wasteQty: 0, workerId: user.id, note: 'в засолку'
          });
          if (!await saveData(DB)) return; closeModal(); showToast(`Отправлено в засолку: ${qty} кг ✓`); render();
        });
      });
    });

    screen.querySelectorAll('[data-salt-retrieve]').forEach(btn => {
      btn.addEventListener('click', () => {
        const bulkId = btn.dataset.bulk;
        const maxQty = parseFloat(btn.dataset.max) || 0;
        openModal(`
          <h2>✅ Забрать из засолки</h2>
          <p style="color:var(--text-muted); font-size:13px; margin-top:-8px;">В засолке было ${fmtKg(maxQty)} — вес после засолки обычно немного меньше (усушка). Укажите итоговый вес, который получился.</p>
          <form id="saltRetrieveForm">
            <div class="field"><label>Итоговый вес, кг</label><input type="number" step="0.005" min="0" name="qty" required autofocus></div>
            <div class="modal-actions">
              <button type="button" class="btn-secondary" id="cancelModalBtn">Отмена</button>
              <button type="submit" class="btn-primary">Сохранить</button>
            </div>
          </form>
        `);
        document.getElementById('cancelModalBtn').addEventListener('click', closeModal);
        document.getElementById('saltRetrieveForm').addEventListener('submit', async e => {
          e.preventDefault();
          const qty = parseFloat(new FormData(e.target).get('qty')) || 0;
          if (qty <= 0) { closeModal(); return; }
          if (!confirmBigQty(qty)) return;
          DB.processing.push({
            id: uid(), date: todayStr(),
            inputProductId: null, inputQty: 0,
            output1ProductId: bulkId, output1Qty: qty, output2ProductId: null, output2Qty: 0, output3ProductId: null, output3Qty: 0,
            wasteQty: 0, workerId: user.id, note: 'из засолки'
          });
          if (!await saveData(DB)) return; closeModal(); showToast(`Получено из засолки: ${qty} кг ✓`); render();
        });
      });
    });
  }
  else if (session.view === 'receiving') {
    screen.innerHTML = safeHTML(`
      <div class="back-link" id="backBtn">← Назад в меню</div>
      <h1 style="margin-top:0;">Что вы приняли?</h1>
      <div class="product-grid">
        ${[...DB.products].filter(isReceivable).sort((a,b)=>(a.sortOrder||100)-(b.sortOrder||100)).map(p => `
          <div class="product-tile" data-product="${p.id}">
            <div class="p-emoji">${p.emoji}</div>
            <div class="p-name">${esc(p.name)}<br><small>${esc(p.unit)}</small></div>
          </div>
        `).join('')}
      </div>
    `);
    document.getElementById('backBtn').addEventListener('click', () => { session.view = 'workerMenu'; render(); });
    screen.querySelectorAll('[data-product]').forEach(el => {
      el.addEventListener('click', () => openWorkerReceivingForm(el.dataset.product, user));
    });
  }
  else if (session.view === 'myWallet') {
    const mine = DB.timeEntries.filter(t => t.workerId === user.id && t.earnings != null);
    const thisMonth = todayStr().slice(0,7);
    const monthTotal = mine.filter(t => t.date.slice(0,7) === thisMonth).reduce((s,t)=>s+Number(t.earnings),0);
    const monthHours = mine.filter(t => t.date.slice(0,7) === thisMonth).reduce((s,t)=>s+(calcHours(t.checkIn,t.checkOut)||0),0);
    const allTimeTotal = mine.reduce((s,t)=>s+Number(t.earnings),0);
    const byDate = {};
    mine.forEach(t => { byDate[t.date] = (byDate[t.date]||0) + Number(t.earnings); });
    const days = Object.keys(byDate).sort((a,b)=>b.localeCompare(a)).slice(0,14);
    screen.innerHTML = safeHTML(`
      <div class="back-link" id="backBtn">← Назад в меню</div>
      <h1 style="margin-top:0;">💰 Мой заработок</h1>
      <div class="stat-grid">
        <div class="stat-card"><div class="stat-label">За этот месяц</div><div class="stat-value">${fmtMoney(monthTotal)}</div><div class="stat-sub">${monthHours.toFixed(1)} ч</div></div>
        <div class="stat-card" style="border-left-color: var(--success);"><div class="stat-label">Всего заработано</div><div class="stat-value">${fmtMoney(allTimeTotal)}</div></div>
      </div>
      <div class="card">
        <div style="font-weight:700; margin-bottom:8px;">По дням</div>
        ${days.length === 0 ? '<div class="empty-state">Пока нет закрытых смен.</div>' : `
        <div class="table-wrap"><table>
          <thead><tr><th>Дата</th><th>Заработано</th></tr></thead>
          <tbody>${days.map(d => `<tr><td>${fmtDate(d)}</td><td>${fmtMoney(byDate[d])}</td></tr>`).join('')}</tbody>
        </table></div>`}
      </div>
    `);
    document.getElementById('backBtn').addEventListener('click', () => { session.view = 'workerMenu'; render(); });
  }
  else if (session.view === 'myReceivings') {
    const mine = DB.receivings.filter(r => r.workerId === user.id && r.date === todayStr());
    const myShifts = DB.timeEntries.filter(t => t.workerId === user.id && t.date === todayStr());
    const totalHours = myShifts.filter(t=>t.checkOut).reduce((s,t)=>s+(calcHours(t.checkIn,t.checkOut)||0),0);
    const totalEarnings = myShifts.reduce((s,t)=>s+Number(t.earnings||0),0);
    screen.innerHTML = safeHTML(`
      <div class="back-link" id="backBtn">← Назад в меню</div>
      <h1 style="margin-top:0;">Мои записи за сегодня</h1>
      ${myShifts.length ? `<div class="card"><b>Смены:</b> ${myShifts.map(t=>`${t.checkIn}${t.checkOut?'–'+t.checkOut:' (идёт)'}`).join(', ')}<br><span style="color:var(--success); font-weight:700; font-size:18px;">Итого: ${totalHours.toFixed(1)} ч, начислено ${fmtMoney(totalEarnings)}</span></div>` : ''}
      <div class="card">
        ${mine.length === 0 ? '<div class="empty-state">Сегодня вы ещё не отмечали приёмку рыбы.</div>' : `
        <div class="table-wrap"><table>
          <thead><tr><th>Товар</th><th>Объём</th><th>Цена/кг</th><th>Сумма</th></tr></thead>
          <tbody>
            ${mine.map(r => { const p = getProduct(r.productId); return `<tr><td>${p?p.emoji+' '+esc(p.name):'—'}</td><td>${fmtKg(r.volumeKg)}</td><td>${fmtMoney(r.purchasePrice)}</td><td>${fmtMoney(r.volumeKg*r.purchasePrice)}</td></tr>`; }).join('')}
          </tbody>
        </table></div>`}
      </div>
    `);
    document.getElementById('backBtn').addEventListener('click', () => { session.view = 'workerMenu'; render(); });
  }
  else if (session.view === 'clock') {
    const today = todayStr();
    const todayEntries = DB.timeEntries.filter(t => t.workerId === user.id && t.date === today).sort((a,b) => (a.checkIn||'').localeCompare(b.checkIn||''));
    const openEntry = DB.timeEntries.filter(t => t.workerId === user.id && t.checkIn && !t.checkOut).sort((a,b) => `${b.date} ${b.checkIn}`.localeCompare(`${a.date} ${a.checkIn}`))[0];
    const closedEntries = todayEntries.filter(t => t.checkOut);
    const totalHours = closedEntries.reduce((s, t) => s + (calcHours(t.checkIn, t.checkOut) || 0), 0);
    const totalEarnings = closedEntries.reduce((s, t) => s + Number(t.earnings || 0), 0);
    let statusText = openEntry ? `На смене с ${openEntry.date===today?'сегодня':fmtDate(openEntry.date)} ${openEntry.checkIn}` : (todayEntries.length ? 'Смена сейчас закрыта — можно открыть новую' : 'Вы ещё не отметили приход сегодня');

    screen.innerHTML = safeHTML(`
      <div class="back-link" id="backBtn">← Назад в меню</div>
      <div class="card clock-box">
        <div class="clock-time" id="clockNow">${nowTimeStr()}</div>
        <div class="clock-status">${statusText}</div>
        ${!openEntry ? `<button class="btn-primary" id="checkInBtn">Отметить приход</button>` : ''}
        ${openEntry ? `<button class="btn-accent" id="checkOutBtn">Отметить уход</button>` : ''}
      </div>
      ${todayEntries.length > 0 ? `
      <div class="card">
        <b>Смены сегодня:</b>
        <div class="table-wrap"><table>
          <thead><tr><th>Приход</th><th>Уход</th><th>Часов</th><th>Начислено</th></tr></thead>
          <tbody>
            ${todayEntries.map(t => `<tr><td>${t.checkIn}</td><td>${t.checkOut || 'идёт'}</td><td>${t.checkOut ? calcHours(t.checkIn, t.checkOut).toFixed(1) : '—'}</td><td>${t.earnings != null ? fmtMoney(t.earnings) : '—'}</td></tr>`).join('')}
          </tbody>
        </table></div>
        <div style="margin-top:10px; font-weight:700;">Итого за день: ${totalHours.toFixed(1)} ч, начислено ${fmtMoney(totalEarnings)}</div>
      </div>` : ''}
    `);
    document.getElementById('backBtn').addEventListener('click', () => { session.view = 'workerMenu'; render(); });
    document.getElementById('checkInBtn')?.addEventListener('click', async () => {
      DB.timeEntries.push({ id: uid(), workerId: user.id, date: today, checkIn: nowTimeStr(), checkOut: null, earnings: null });
      if (!await saveData(DB)) return; showToast('Приход отмечен ✓'); render();
    });
    document.getElementById('checkOutBtn')?.addEventListener('click', async () => {
      const checkOutTime = nowTimeStr();
      const currentEntry = DB.timeEntries.find(t => t.id === openEntry?.id);
      if(!currentEntry){showToast('Открытая смена не найдена. Обновите данные.');return;}
      const result=await closeWorkerShift(currentEntry,today,checkOutTime);
      if(!result)return;
      const hours=Number(result.hours||0),earnings=Number(result.earnings||0);
      openModal(`
        <h2>Смена завершена ✓</h2>
        <p style="font-size:16px; margin:12px 0;">Вы отработали в эту смену <b>${hours.toFixed(1)} ч</b> (${currentEntry.checkIn} — ${checkOutTime}).</p>
        <p style="font-size:22px; font-weight:800; color:var(--success); margin:12px 0;">Начислено за смену: ${fmtMoney(earnings)}</p>
        <div class="modal-actions"><button type="button" class="btn-primary" id="cancelModalBtn">Ок</button></div>
      `);
      document.getElementById('cancelModalBtn').addEventListener('click', () => { closeModal(); render(); });
    });
  }
}

function openWorkerProcessingForm(user, initialStage = 1) {
  const stage = Number(initialStage) === 2 ? 2 : 1;
  const stageLabel = stage === 1 ? 'Разделка сырья' : 'Готовый продукт';
  const inputOpts = `<option value="">— выберите сырьё —</option>${processingProductOptions(stage,'input')}`;
  const outputRows=[1,2,3,4,5].map(i=>`<div class="worker-processing-output" data-worker-output-row="${i}" ${i>1?'hidden':''}>
    <div class="row">
      <div class="field"><label>Что получилось${i>1?' '+i:''}</label><select name="output${i}ProductId" data-processing-output ${i===1?'required':'disabled'}><option value="">— сначала выберите сырьё —</option></select></div>
      <div class="field"><label>Вес, кг</label><input type="number" inputmode="decimal" step="0.005" min="0.005" name="output${i}Qty" placeholder="0,000" ${i===1?'required':'disabled'}></div>
    </div>
    ${i>1?'<button type="button" class="btn-secondary btn-sm" data-remove-worker-output>Убрать этот выход</button>':''}
  </div>`).join('');
  openModal(`
    <h2>Этап ${stage}: ${stageLabel}</h2>
    <p class="field-hint">${stage===1?'Выберите принятую рыбу, затем укажите полученные продукты.':'Выберите полуфабрикат первого этапа, затем готовый продукт.'}</p>
    <form id="workerProcessingForm" class="worker-processing-form">
      <input type="hidden" name="processingStage" value="${stage}">
      <div class="field"><label>1. Что взяли</label><select required name="inputProductId" id="workerProcessingInput">${inputOpts}</select></div>
      <div class="field"><label>2. Вес сырья, кг</label><input type="number" inputmode="decimal" step="0.005" min="0.005" name="inputQty" placeholder="0,000" required><small class="field-hint" data-processing-available>Сначала выберите входной товар.</small></div>
      <h3>3. Что получилось</h3>
      ${outputRows}
      <button type="button" class="btn-secondary" id="addWorkerOutput">+ Добавить ещё один продукт</button>
      <div class="worker-processing-summary" id="workerProcessingSummary">Заполните вес сырья и первый выход.</div>
      <div class="form-error" id="workerProcessingError" role="alert"></div>
      <details><summary>Добавить примечание</summary><div class="field"><label>Примечание</label><input type="text" name="note" placeholder="Например: партия для засолки"></div></details>
      <div class="modal-actions">
        <button type="button" class="btn-secondary" id="cancelModalBtn">Отмена</button>
        <button type="submit" class="btn-primary">Проверить и сохранить</button>
      </div>
    </form>
  `);
  document.querySelector('.modal-box')?.classList.add('worker-processing-modal');
  const form = document.getElementById('workerProcessingForm');
  const errorBox = document.getElementById('workerProcessingError');
  const showFormError = message => { errorBox.textContent=message; errorBox.scrollIntoView({block:'nearest'}); };
  const visibleOutputRows = () => [...form.querySelectorAll('[data-worker-output-row]')].filter(row => !row.hidden);
  const updateSummary = () => {
    const inputQty = Number(form.elements.inputQty.value || 0);
    const outputQty = visibleOutputRows().reduce((sum,row)=>sum+Number(row.querySelector('input').value||0),0);
    const waste = inputQty > 0 ? inputQty - outputQty : 0;
    const summary = document.getElementById('workerProcessingSummary');
    summary.classList.toggle('invalid', waste < -0.000001);
    summary.textContent = inputQty > 0
      ? `Сырьё: ${inputQty.toFixed(3)} кг · выход: ${outputQty.toFixed(3)} кг · отходы/усушка: ${Math.max(0,waste).toFixed(3)} кг${waste<0?' — выход больше входа':''}`
      : 'Заполните вес сырья и первый выход.';
  };
  document.getElementById('cancelModalBtn').addEventListener('click', closeModal);
  document.getElementById('workerProcessingInput').addEventListener('change',e=>{updateProcessingOutputOptions(e.target.form);updateProcessingAvailability(e.target.form);updateSummary();});
  form.addEventListener('input',()=>{errorBox.textContent='';updateSummary();});
  document.getElementById('addWorkerOutput').addEventListener('click',()=>{
    const next=[...form.querySelectorAll('[data-worker-output-row]')].find(row=>row.hidden);
    if(!next)return;
    next.hidden=false;
    next.querySelectorAll('select,input').forEach(control=>control.disabled=false);
    updateProcessingOutputOptions(form);
    if(![...form.querySelectorAll('[data-worker-output-row]')].some(row=>row.hidden))document.getElementById('addWorkerOutput').hidden=true;
    next.querySelector('select').focus();
  });
  document.querySelectorAll('[data-fulfill-order]').forEach(el=>{
    el.addEventListener('click',async()=>{
      const row=DB.orders.find(o=>o.id===el.dataset.fulfillOrder);if(!row)return;
      if(!confirm('Исполнить заказ? Товар будет списан со склада, а заказ станет выполненным.'))return;
      el.disabled=true;await fulfillOrder(row);
    });
  });
  form.querySelectorAll('[data-remove-worker-output]').forEach(button=>button.addEventListener('click',()=>{
    const row=button.closest('[data-worker-output-row]');
    row.querySelectorAll('select,input').forEach(control=>{control.value='';control.disabled=true;});
    row.hidden=true;
    document.getElementById('addWorkerOutput').hidden=false;
    updateSummary();
  }));
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const input = parseFloat(f.get('inputQty')) || 0;
    const availabilityError=processingAvailabilityError(e.target,input);
    if(availabilityError){showFormError(availabilityError);e.target.elements.inputQty.focus();return;}
    const outputs=[1,2,3,4,5].map(i=>({id:f.get(`output${i}ProductId`)||null,qty:parseFloat(f.get(`output${i}Qty`))||0}));
    const inputP = getProduct(f.get('inputProductId'));
    const outputProducts=outputs.map(row=>getProduct(row.id)).filter(Boolean);
    const sameUnit=inputP?.baseUnit==='kg' && outputProducts.every(p=>p.baseUnit==='kg');
    const waste = sameUnit ? Math.max(0, input - outputs.reduce((s,row)=>s+row.qty,0)) : 0;
    const record={
      id: uid(), date: todayStr(),
      processingStage:Number(f.get('processingStage')),
      inputProductId: f.get('inputProductId') || null, inputQty: input,
      wasteQty: waste,
      workerId: user.id,
      note: f.get('note') || '',status:'draft'
    };
    outputs.forEach((row,index)=>{record[`output${index+1}ProductId`]=row.id;record[`output${index+1}Qty`]=row.qty;});
    const chainError=validateProcessingChain(record,DB.products);
    if(chainError){showFormError(chainError);return;}
    const outputSummary=outputs.filter(row=>row.id&&row.qty>0).map(row=>`${getProduct(row.id)?.name}: ${row.qty} кг`).join('\n');
    if(!confirm(`Проверьте запись:\n\nВзяли: ${inputP?.name||'—'} — ${input} кг\nПолучилось:\n${outputSummary}\nОтходы/усушка: ${waste.toFixed(3)} кг\n\nСохранить документ?`))return;
    DB.processing.push(record);
    if (!await saveData(DB)) return; closeModal(); showToast('Переработка записана ✓'); render();
  });
  updateProcessingOutputOptions(form);
  updateProcessingAvailability(form);
  updateSummary();
}

function editTimeFormHtml(row,closeOnly=false) {
  const worker=getUser(row.workerId),checkoutDate=row.checkOutDate||row.date;
  return `<h2>${closeOnly?'Закрыть смену':'Изменить смену'}</h2>
    <form id="manageTimeForm">
      <p><strong>${esc(worker?.name||'Работник')}</strong></p>
      <div class="row"><div class="field"><label>Дата прихода</label><input type="date" name="date" value="${esc(row.date)}" ${closeOnly?'readonly':''} required></div><div class="field"><label>Время прихода</label><input type="time" name="checkIn" value="${esc(row.checkIn||'')}" ${closeOnly?'readonly':''} required></div></div>
      <div class="row"><div class="field"><label>Дата ухода</label><input type="date" name="checkOutDate" value="${esc(closeOnly?todayStr():checkoutDate)}" required></div><div class="field"><label>Время ухода</label><input type="time" name="checkOut" value="${esc(closeOnly?nowTimeStr():(row.checkOut||''))}" required></div></div>
      <div class="modal-actions"><button type="button" class="btn-secondary" id="cancelModalBtn">Отмена</button><button type="submit" class="btn-primary">${closeOnly?'Закрыть смену':'Сохранить изменения'}</button></div>
    </form>`;
}

function openWorkerReceivingForm(productId, user) {
  const p = getProduct(productId);
  openModal(`
    <h2>${p.emoji} ${esc(p.name)} — ${esc(p.unit)}</h2>
    <p class="field-hint">Закупочная цена подставится автоматически: <strong>${fmtMoney(p.purchasePrice)}</strong> за ${esc(p.baseUnit||'кг')}.</p>
    <form id="workerReceivingForm">
      <div class="field"><label>Количество (баз. ед.)</label><input type="number" step="0.005" min="0" name="volumeKg" required autofocus></div>
      <div class="field"><label>Примечание (необязательно)</label><input type="text" name="note" placeholder="Например, номер накладной"></div>
      <div class="modal-actions">
        <button type="button" class="btn-secondary" id="cancelModalBtn">Отмена</button>
        <button type="submit" class="btn-primary">Сохранить приёмку</button>
      </div>
    </form>
  `);
  document.getElementById('cancelModalBtn').addEventListener('click', closeModal);
  document.getElementById('workerReceivingForm').addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const vol = parseFloat(f.get('volumeKg'));
    if (!confirmBigQty(vol)) return;
    DB.receivings.push({
      id: uid(), date: todayStr(), productId,
      volumeKg: vol,
      purchasePrice: Number(p.purchasePrice || 0),
      workerId: user.id, note: f.get('note') || '',status:'draft'
    });
    if (!await saveData(DB)) return;
    closeModal();
    showToast(`Приёмка «${esc(p.name)}» сохранена ✓`);
    session.view = 'workerMenu';
    render();
  });
}

/* ================= INIT ================= */
(async function initApp(){
 localStorage.removeItem('fishCRM_v4');
 renderLogin();
 if(!sb)return;
 sb.auth.onAuthStateChange((event,nextSession)=>{
   if(event==='SIGNED_OUT'){DB=emptyData();snapshot=emptyData();session.userId=null;closeModal();renderLogin();return;}
   if(event==='PASSWORD_RECOVERY')authLinkRequiresPassword=true;
   if(authLinkRequiresPassword&&nextSession?.user&&!authSetupRendered)renderPasswordSetup(nextSession.user);
 });
 const {data,error}=await sb.auth.getSession();
 if(error){showToast(error.message);return;}
 if(data.session){
   if(authLinkRequiresPassword){renderPasswordSetup(data.session.user);return;}
   try{await doLogin(data.session.user.id);}catch(e){renderLogin();document.getElementById('loginError').textContent=e.message;}
 }
})();
