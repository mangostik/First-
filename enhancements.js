function viewAudit(){return `<div class="card"><h2>Журнал действий</h2><div class="table-wrap"><table><thead><tr><th>Дата</th><th>Автор</th><th>Действие</th><th>Объект</th><th>Изменение</th></tr></thead><tbody>${DB.audit.map(a=>`<tr><td>${esc(a.created_at)}</td><td>${esc(getUser(a.actor_id)?.name||a.actor_id||'Магазин / миграция')}</td><td>${esc(a.action)}</td><td>${esc(a.entity_type)} ${esc(a.entity_id)}</td><td><details><summary>До / после</summary><pre>${esc(JSON.stringify({before:a.before_json,after:a.after_json},null,2))}</pre></details></td></tr>`).join('')}</tbody></table></div></div>`;}
function bindExtraActions(){
 const docTypes={'receiving':'receivings','processing':'processing','adjust':'stockAdjustments'};
 for(const [attr,kind] of Object.entries(docTypes)){
   document.querySelectorAll(`[data-del-${attr}]`).forEach(original=>{
     const row=DB[kind].find(r=>r.id===original.getAttribute('data-del-'+attr));if(!row)return;
     const button=original.cloneNode(true);original.replaceWith(button);
     const label=document.createElement('span');label.textContent={draft:'Черновик',posted:'Проведён',cancelled:'Отменён'}[row.status]||row.status;button.before(label);
     if(row.status==='draft' && getUser(session.userId).role!=='worker'){
       const post=document.createElement('button');post.className='btn-primary btn-sm';post.textContent='Провести';
       post.onclick=()=>{if(confirm('Провести документ? Он изменит остатки и станет неизменяемым.'))directCommand(kind,row,'post');};button.before(post);
     }
     const role=getUser(session.userId).role;
     if(row.status==='draft'&&['owner','partner'].includes(role)){
       button.disabled=false;button.title='Удалить ошибочную запись';button.setAttribute('aria-label','Удалить ошибочную запись');
       button.onclick=()=>{if(confirm('Удалить ошибочную запись из списка? История действия сохранится.'))archiveDocument(kind,row);};
     }else if(row.status==='draft'){
       button.disabled=false;button.title='Отменить черновик';button.setAttribute('aria-label','Отменить черновик');
       button.onclick=()=>{if(confirm('Отменить черновик?'))directCommand(kind,row,'cancel');};
     }else if(row.status==='cancelled'&&['owner','partner'].includes(role)){
       button.disabled=false;button.title='Удалить ошибочную запись';button.setAttribute('aria-label','Удалить ошибочную запись');
       button.onclick=()=>{if(confirm('Удалить отменённую запись из списка? История действия сохранится.'))archiveDocument(kind,row);};
     }else if(row.status==='posted'&&['owner','partner'].includes(role)){
       button.disabled=false;button.title='Отменить проведение';button.setAttribute('aria-label','Отменить проведение');
       button.onclick=()=>{
         const reason=prompt('Причина отмены проведения (не менее 3 символов)');
         if(reason===null)return;
         if(reason.trim().length<3){showToast('Укажите причину отмены');return;}
         if(confirm('Отменить проведение? Система создаст обратные складские движения и сохранит историю.'))reverseDocument(kind,row,reason.trim());
       };
     }else{button.disabled=true;button.title=row.status==='posted'?'Отмена доступна владельцу и партнёру':'Документ уже отменён';}
   });
 }
 document.querySelectorAll('[data-del-order]').forEach(original=>{
   const row=DB.orders.find(o=>o.id===original.dataset.delOrder);if(!row)return;
   const button=original.cloneNode(true);original.replaceWith(button);
   const role=getUser(session.userId).role;
   if(['owner','partner'].includes(role)&&['draft','cancelled'].includes(row.status)){
     button.disabled=false;button.title='Удалить ошибочную запись';button.setAttribute('aria-label','Удалить ошибочную запись');
     button.onclick=()=>{if(confirm('Удалить ошибочный заказ из списка? История действия сохранится.'))archiveDocument('orders',row);};
   }else if(['owner','partner','manager'].includes(role)&&['draft','confirmed','reserved'].includes(row.status)){
     button.disabled=false;button.title='Отменить заказ';button.setAttribute('aria-label','Отменить заказ');
     button.onclick=()=>{if(confirm('Отменить заказ и освободить резерв?'))directCommand('orders',row,'cancel');};
   }else{
     button.disabled=true;button.title=isPosted(row)?'Сначала оформите возврат или отмену проведения':'Заказ уже завершён';
   }
 });
  document.querySelectorAll('[data-history]').forEach(b=>b.onclick=()=>{
    const p=getProduct(b.dataset.history),lots=DB.lots.filter(l=>l.product_id===p.id),moves=DB.movements.filter(m=>m.product_id===p.id).sort((a,b)=>a.created_at.localeCompare(b.created_at)),role=getUser(session.userId).role;
    const action=['owner','partner'].includes(role)?'<button class="btn-primary" id="adjustFromHistory">Корректировать остаток</button>':'';
    openModal(`<h2>${esc(p.name)} — движения</h2><p>Текущий остаток: <strong>${Number(getStock(p.id).qty).toLocaleString('ru-RU',{maximumFractionDigits:3})} ${esc(p.baseUnit)}</strong></p>${action}<h3>Партии</h3><div class="table-wrap"><table><tr><th>Партия</th><th>Годен до</th><th>Статус</th><th>Доступно</th></tr>${lots.map(l=>`<tr><td>${esc(l.lot_number)}</td><td>${esc(l.expiry_date||'Не задан')}</td><td>${esc(l.status)}</td><td>${Number(l.available)}</td></tr>`).join('')}</table></div><h3>История</h3><div class="table-wrap"><table><tr><th>Дата</th><th>Документ</th><th>Количество</th><th>Себестоимость</th><th>Автор</th></tr>${moves.map(m=>`<tr><td>${esc(m.created_at)}</td><td>${esc(m.source_type)} ${esc(m.source_id)}</td><td>${Number(m.quantity)}</td><td>${fmtMoney(m.unit_cost)}</td><td>${esc(getUser(m.created_by)?.name||m.created_by||'Миграция')}</td></tr>`).join('')}</table></div>`);
    document.getElementById('adjustFromHistory')?.addEventListener('click',()=>{openModal(adjustFormHtml(p.id));bindAdjustFormSubmit();});
 });
 for(const type of ['payment','return'])document.querySelectorAll(`[data-${type}]`).forEach(b=>{
   const row=DB.orders.find(o=>o.id===b.dataset[type]);b.disabled=!isPosted(row)||!['owner','partner'].includes(getUser(session.userId).role);
   b.onclick=()=>{
     openModal(`<h2>${type==='payment'?'Оплата / возврат денег':'Возврат товара'}</h2><form id="moneyForm">${type==='payment'?'<label>Сумма, ₾ (минус — возврат денег)</label><input name="amount" type="number" step="0.01" required>':`<label>Строка заказа</label><select name="line">${row.items.map((it,i)=>`<option value="${i}">${esc(getProduct(it.productId)?.name)} — ${it.qty} ${esc(it.unit)}</option>`).join('')}</select><label>Количество</label><input name="quantity" type="number" min="0.001" step="0.001" required><p>Возврат поступает в карантин. Возврат денег оформляется отдельной оплатой с отрицательной суммой.</p>`}<label>Основание</label><input name="reason" minlength="3" required><button class="btn-primary">Сохранить документ</button></form>`);
     document.getElementById('moneyForm').onsubmit=async e=>{e.preventDefault();if(!confirm('Создать финансовый документ? Он сохранится в истории.'))return;const p=Object.fromEntries(new FormData(e.target));await directCommand(type==='payment'?'payments':'returns',row,type,p);};
   };
 });
 document.querySelectorAll('[data-status-select]').forEach(b=>{const o=DB.orders.find(r=>r.id===b.dataset.statusSelect);b.disabled=!['owner','partner','manager'].includes(getUser(session.userId).role);const next={draft:['draft','confirmed','cancelled'],confirmed:['confirmed','reserved','cancelled'],reserved:['reserved','posted','cancelled'],posted:['posted','completed'],completed:['completed'],cancelled:['cancelled']}[o.status];for(const option of b.options)option.disabled=!next.includes(option.value);});
 document.querySelectorAll('[data-edit-order]').forEach(b=>{const o=DB.orders.find(r=>r.id===b.dataset.editOrder);b.disabled=!['owner','partner','manager'].includes(getUser(session.userId).role)||o.status!=='draft';});
 document.querySelectorAll('[data-edit-receiving]').forEach(b=>{b.disabled=DB.receivings.find(r=>r.id===b.dataset.editReceiving)?.status!=='draft';});
 document.querySelectorAll('button').forEach(b=>{if(!b.getAttribute('aria-label'))b.setAttribute('aria-label',b.title||({'✏️':'Редактировать','🗑':'Отменить или архивировать','×':'Закрыть','☰':'Открыть меню','⚖️':'Корректировка'}[b.textContent.trim()]||b.textContent.trim()));});
 document.querySelectorAll('[data-nav]').forEach(n=>{n.tabIndex=0;n.setAttribute('role','button');n.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();n.click();}};});
}
function tableTools(){
 document.querySelectorAll('#content .table-wrap').forEach((wrap,idx)=>{
   const table=wrap.querySelector('table'),body=table?.tBodies[0];if(!body)return;
    const rows=[...body.rows],tools=document.createElement('div'),noPagination=wrap.hasAttribute('data-no-pagination'),pageSize=noPagination?Math.max(1,rows.length):25;tools.className='table-tools';
   tools.innerHTML='<label>Поиск <input type="search" aria-label="Поиск по таблице"></label><button class="btn-secondary">CSV</button><button class="btn-secondary">XLSX</button>';
   wrap.before(tools);const pager=document.createElement('div');pager.className='table-pager';pager.innerHTML='<button class="btn-secondary" aria-label="Предыдущая страница">←</button><span></span><button class="btn-secondary" aria-label="Следующая страница">→</button>';wrap.after(pager);
    let page=0,filtered=rows;const show=()=>{rows.forEach(r=>r.hidden=true);filtered.slice(page*pageSize,page*pageSize+pageSize).forEach(r=>r.hidden=false);pager.hidden=noPagination;pager.children[1].textContent=`${page+1} / ${Math.max(1,Math.ceil(filtered.length/pageSize))} · ${filtered.length} записей`;pager.firstChild.disabled=page===0;pager.lastChild.disabled=(page+1)*pageSize>=filtered.length;};
   tools.querySelector('input').oninput=e=>{filtered=rows.filter(r=>r.textContent.toLowerCase().includes(e.target.value.toLowerCase()));page=0;show();};
   pager.firstChild.onclick=()=>{page--;show();};pager.lastChild.onclick=()=>{page++;show();};show();
   const exportRows=()=>[...[table.tHead?.rows[0]].filter(Boolean),...filtered].map(r=>[...r.cells].map(c=>{const t=c.innerText.trim();return /^[=+@\-\t\r]/.test(t)?"'"+t:t;}));
   tools.querySelectorAll('button')[0].onclick=()=>{const csv='\ufeff'+exportRows().map(r=>r.map(v=>'"'+v.replaceAll('"','""')+'"').join(';')).join('\r\n');const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));a.download='fishcrm.csv';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);};
   tools.querySelectorAll('button')[1].onclick=()=>{const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet(exportRows()),'FishCRM');XLSX.writeFile(book,'fishcrm.xlsx');};
 });
}
const originalRender=render;
render=function(){originalRender();if(session.userId){bindExtraActions();tableTools();}};
const oldOpenModal=openModal;
openModal=function(html){oldOpenModal(html);const box=document.querySelector('.modal-box');box?.setAttribute('role','dialog');box?.setAttribute('aria-modal','true');box?.querySelector('input,select,button')?.focus();document.querySelectorAll('.modal-box label').forEach((l,i)=>{const input=l.parentElement?.classList.contains('field')?l.parentElement.querySelector('input,select'):(l.nextElementSibling?.matches('input,select')?l.nextElementSibling:null);if(input){input.id ||= 'field-'+i;l.htmlFor=input.id;}});};
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeModal();});

viewDashboard=function(){
 const {from,to}=dashboardRange,orders=DB.orders.filter(o=>isPosted(o)&&o.date>=from&&o.date<=to);
 const returns=DB.returns.filter(r=>r.created_at.slice(0,10)>=from&&r.created_at.slice(0,10)<=to);
 const revenue=orders.reduce((s,o)=>s+orderTotal(o),0)-returns.reduce((s,r)=>s+Number(r.net_amount),0);
 const cogs=orders.reduce((s,o)=>s+o.items.reduce((a,it)=>a+Number(it.qty)*Number(it.cost_price),0),0)-returns.reduce((s,r)=>s+Number(r.cost_amount),0);
 const payments=DB.payments.filter(p=>p.created_at.slice(0,10)>=from&&p.created_at.slice(0,10)<=to).reduce((s,p)=>s+Number(p.amount),0);
 const wages=DB.timeEntries.filter(t=>t.date>=from&&t.date<=to).reduce((s,t)=>s+Number(t.earnings||0),0);
 const delivery=orders.reduce((s,o)=>s+Number(o.deliveryCost||0),0),receivables=DB.orders.filter(isPosted).reduce((s,o)=>s+debt(o),0);
 const attention=[];
 for(const p of DB.products.filter(p=>p.active)){const q=getStock(p.id).qty;if(q<0)attention.push(`Отрицательный остаток: ${p.name} (${q} ${p.baseUnit})`);else if(q<Number(p.lowStock||1))attention.push(`Низкий запас: ${p.name} (${q} ${p.baseUnit})`);}
 for(const l of DB.lots){if(l.expiry_date&&l.expiry_date<todayStr()&&getStock(l.product_id).qty>0)attention.push(`Просрочена партия ${l.lot_number}: ${l.expiry_date}`);}
 for(const t of DB.timeEntries)if(!t.checkOut&&t.date<todayStr())attention.push(`Незакрытая смена: ${getUser(t.workerId)?.name||t.workerId}, ${t.date}`);
 for(const o of DB.orders.filter(o=>isPosted(o)&&debt(o)>0))attention.push(`Неоплаченный заказ ${o.id.slice(0,8)}: ${fmtMoney(debt(o))}`);
 for(const p of DB.processing.filter(p=>p.status==='draft')){const input=getProduct(p.inputProductId),mass=Number(p.inputQty||0)*(input?.baseUnit==='g'?.001:1);const out=[1,2,3,4,5].reduce((s,i)=>s+Number(p['output'+i+'Qty']||0)*(getProduct(p['output'+i+'ProductId'])?.baseUnit==='g'?.001:1),0);if(Math.abs(mass-out-Number(p.wasteQty||0))>.005)attention.push(`Отклонение выхода в черновике ${p.id.slice(0,8)}`);}
 return `<div class="stat-grid">${[['Выручка без НДС',revenue],['Себестоимость продаж',cogs],['Поступления денег',payments],['Дебиторская задолженность (все даты)',receivables],['Прибыль после зарплаты и доставки',revenue-cogs-wages-delivery]].map(([label,value])=>`<div class="stat-card"><div class="stat-label">${label}</div><div class="stat-value">${fmtMoney(value)}</div></div>`).join('')}</div><div class="card attention"><h2>Требует внимания</h2>${attention.length?`<ul>${attention.map(t=>`<li>${esc(t)}</li>`).join('')}</ul>`:'<p>Исключений не обнаружено</p>'}</div><div class="card"><h2>Период показателей</h2><div class="row"><div class="field"><label for="dashFrom">С даты</label><input type="date" id="dashFrom" value="${from}"></div><div class="field"><label for="dashTo">По дату</label><input type="date" id="dashTo" value="${to}"></div><button class="btn-primary" id="dashApply">Показать</button><button class="btn-secondary" id="dashToday">Сегодня</button><button class="btn-secondary" id="dashWeek">7 дней</button></div><p>Выручка и себестоимость: только проведённые и завершённые заказы, за вычетом возвратов периода. Оплата — по дате движения денег. Доставка, взимаемая с покупателя, показывается в заказе отдельно.</p></div>`;
};
// Workers use a compact mobile flow. The full journal stays in the owner view.
const legacyWorkerRender=renderWorker;
renderWorker=function(user){
 if(session.view!=='processingWorker'){legacyWorkerRender(user);return;}
 const mine=DB.processing.filter(row=>row.workerId===user.id&&row.date===todayStr()).slice().reverse();
 const history=mine.length?mine.map(row=>{
   const input=getProduct(row.inputProductId);
   const outputs=[1,2,3,4,5].map(i=>({product:getProduct(row[`output${i}ProductId`]),qty:Number(row[`output${i}Qty`]||0)})).filter(item=>item.product&&item.qty>0);
   return `<article class="worker-processing-history">
     <div><strong>Этап ${Number(row.processingStage||1)}</strong><span>${input?esc(input.name):'—'} · ${Number(row.inputQty||0)} ${esc(input?.unit||'кг')}</span></div>
     <div class="worker-processing-history-outs">${outputs.map(item=>`${esc(item.product.name)} — <b>${item.qty} ${esc(item.product.unit)}</b>`).join('<br>')||'Выход не указан'}</div>
     ${row.status==='draft'?`<button class="btn-secondary btn-sm" data-worker-processing-delete="${row.id}">Удалить черновик</button>`:''}
   </article>`;
 }).join(''):'<div class="empty-state worker-empty">Сегодня записей пока нет.</div>';
 document.getElementById('app').innerHTML=safeHTML(`<div id="workerScreen">
   <div class="worker-header"><div><h1>Переработка</h1><p>Выберите, что делаете сейчас</p></div><button id="workerBack" class="btn-secondary">Назад</button></div>
   <div class="worker-stage-grid">
     <button class="worker-stage-card" data-worker-processing-stage="1"><span>1</span><strong>Разделка сырья</strong><small>Тушка → филе, стейки, фарш, икра</small></button>
     <button class="worker-stage-card" data-worker-processing-stage="2"><span>2</span><strong>Готовый продукт</strong><small>Филе → слабосолёное филе, джерки, котлеты</small></button>
   </div>
   <section class="worker-processing-today"><h2>Записи сегодня</h2>${history}</section>
 </div>`);
 document.getElementById('workerBack').onclick=()=>{session.view='workerMenu';render();};
 document.querySelectorAll('[data-worker-processing-stage]').forEach(button=>button.onclick=()=>openWorkerProcessingForm(user,Number(button.dataset.workerProcessingStage)));
 document.querySelectorAll('[data-worker-processing-delete]').forEach(button=>button.onclick=async()=>{
   if(!confirm('Удалить этот черновик переработки?'))return;
   DB.processing=DB.processing.filter(row=>row.id!==button.dataset.workerProcessingDelete);
   if(await saveData(DB)){showToast('Черновик удалён');render();}
 });
};
const extraBindings=bindExtraActions;
bindExtraActions=function(){extraBindings();
 const bar=document.getElementById('topbar');if(bar){const b=document.createElement('button');b.className='btn-secondary';b.textContent='Обновить данные';b.onclick=async()=>{b.disabled=true;try{DB=await fetchAllData();render();}catch(e){showToast(e.message);b.disabled=false;}};bar.append(b);}
};
function viewRecipes(){return `<div class="card"><h2>Версии рецептур</h2><button id="newRecipe" class="btn-primary">Новая версия</button><div class="table-wrap"><table><thead><tr><th>Товар</th><th>Версия</th><th>Сырьё на единицу выхода</th><th>Действие</th></tr></thead><tbody>${DB.recipes.map(r=>`<tr><td>${esc(getProduct(r.outputProductId)?.name)}</td><td>${esc(r.recipeVersion)}</td><td>${r.lines.map(l=>`${esc(getProduct(l.productId)?.name)}: ${l.quantityPerOutput} ${esc(l.unit)}`).join('<br>')}</td><td><button class="btn-primary" data-recipe-batch="${r.id}">Выпуск</button></td></tr>`).join('')}</tbody></table></div></div>`;}
function bindRecipes(){
 const options=DB.products.filter(p=>p.active&&['kg','g'].includes(p.baseUnit)).map(p=>`<option value="${p.id}">${esc(p.name)} (${p.baseUnit})</option>`).join('');
 document.getElementById('newRecipe').onclick=()=>{
   openModal(`<h2>Новая версия рецептуры</h2><form id="recipeForm"><label>Товар на выходе</label><select name="outputProductId">${options}</select><label>Версия (например 1.0)</label><input name="recipeVersion" required><div id="recipeLines"></div><button id="addRecipeLine" class="btn-secondary" type="button">Добавить сырьё</button><p>Количество в базовых единицах сырья на одну базовую единицу выпуска. Для 10 кг входа → 8 кг выхода коэффициент 1,25.</p><button class="btn-primary">Сохранить версию</button></form>`);
   const add=()=>{const line=document.createElement('div');line.className='row recipe-line';line.innerHTML=safeHTML(`<select>${options}</select><input type="number" min="0.000001" step="0.000001" placeholder="Кол-во на единицу" required aria-label="Количество сырья на единицу выхода"><button type="button" aria-label="Удалить строку">×</button>`);line.querySelector('button').onclick=()=>line.remove();document.getElementById('recipeLines').append(line);};add();document.getElementById('addRecipeLine').onclick=add;
   document.getElementById('recipeForm').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.target),lines=[...document.querySelectorAll('.recipe-line')].map(l=>{const p=getProduct(l.querySelector('select').value);return{productId:p.id,unit:p.baseUnit,quantityPerOutput:Number(l.querySelector('input').value)};});DB.recipes.push({id:uid(),outputProductId:f.get('outputProductId'),recipeVersion:f.get('recipeVersion'),lines});if(await saveData(DB)){closeModal();render();}};
 };
 document.querySelectorAll('[data-recipe-batch]').forEach(b=>b.onclick=()=>{
   const r=DB.recipes.find(r=>r.id===b.dataset.recipeBatch),p=getProduct(r.outputProductId);
   openModal(`<h2>Выпуск ${esc(p.name)} · ${esc(r.recipeVersion)}</h2><form id="recipeBatchForm"><label>Дата</label><input name="date" type="date" value="${todayStr()}" required><label>План, ${esc(p.baseUnit)}</label><input name="plannedOutput" type="number" min="0.001" step="0.001" required><label>Фактический выход, ${esc(p.baseUnit)}</label><input name="actualOutput" type="number" min="0.001" step="0.001" required><label>Отходы, кг</label><input name="wasteQty" type="number" min="0" step="0.001" required><label>Номер партии</label><input name="lotNumber" required><label>Годен до</label><input name="expiryDate" type="date"><button class="btn-primary">Сохранить черновик</button></form>`);
    document.getElementById('recipeBatchForm').onsubmit=async e=>{e.preventDefault();const f=Object.fromEntries(new FormData(e.target)),stage=productionRole(p)==='stage2_final'?2:1;DB.processing.push({...f,id:uid(),processingStage:stage,recipeId:r.id,output1ProductId:p.id,output1Qty:Number(f.actualOutput),status:'draft'});if(await saveData(DB)){closeModal();session.view='processing';render();}};
 });
}
const orderFilters={from:'',to:'',company:'',client:'',channel:'',status:''};
function matchesOrder(o){const f=orderFilters;return(!f.from||o.date>=f.from)&&(!f.to||o.date<=f.to)&&(!f.company||o.companyId===f.company)&&(!f.client||o.counterpartyId===f.client)&&(!f.channel||(o.channel||'crm')===f.channel)&&(!f.status||o.status===f.status);}
function historicalOrderStatus(o){return({done:'completed',cancel:'cancelled',new:'draft'})[o.legacyStatus]||o.legacyStatus||'archived';}
function historicalOrderTotal(o){return orderTotal({...o,items:Array.isArray(o.items)?o.items:[]})+Number(o.deliveryCost||o.deliveryFee||0);}
function matchesHistoricalOrder(o){const f=orderFilters,status=historicalOrderStatus(o);return(!f.from||o.date>=f.from)&&(!f.to||o.date<=f.to)&&(!f.company||o.companyId===f.company)&&(!f.client||o.counterpartyId===f.client)&&(!f.channel||(o.channel||'crm')===f.channel)&&(!f.status||status===f.status);}
function archivedOrderView(){
 const rows=(DB.orderHistory||[]).filter(matchesHistoricalOrder).sort((a,b)=>String(b.date||'').localeCompare(String(a.date||'')));
 const labels={completed:'Выполнен',cancelled:'Отменён',draft:'Не обработан',archived:'Архив'};
 return `<div class="card"><div class="card-header"><div><h2>Архив старых заказов</h2><p style="color:var(--text-muted);font-size:13px;margin:4px 0 0;">Только для просмотра. Архив не меняет склад, деньги, долги и уведомления.</p></div><span class="badge">${rows.length} из ${(DB.orderHistory||[]).length}</span></div>${rows.length===0?'<div class="empty-state">Архивных заказов по выбранным фильтрам нет.</div>':`<div class="table-wrap"><table><thead><tr><th>Дата</th><th>№ с сайта</th><th>Контрагент</th><th>Компания</th><th>Состав</th><th>Итого</th><th>Оплата</th><th>Статус</th></tr></thead><tbody>${rows.map(o=>{const cp=getCounterparty(o.counterpartyId),comp=getCompany(o.companyId),items=(Array.isArray(o.items)?o.items:[]).map(it=>{const p=getProduct(it.productId);return `${p?esc(p.name):'Товар из архива'} × ${Number(it.qty||0)} ${p?esc(p.unit):''}`;}).join(', ');return `<tr><td>${o.date?fmtDate(o.date):'—'}</td><td>${esc(o.externalOrderNumber)||'—'}</td><td>${cp?esc(cp.name):'—'}</td><td>${comp?esc(comp.name):'—'}</td><td>${items||'—'}</td><td><b>${fmtMoney(historicalOrderTotal(o))}</b></td><td>${o.paid?'Оплачен':'Нет отметки об оплате'}${o.paymentType?`<br>${esc(o.paymentType)}`:''}</td><td><span class="badge">${labels[historicalOrderStatus(o)]||esc(o.legacyStatus)||'Архив'}</span></td></tr>`;}).join('')}</tbody></table></div>`}</div>`;
}
const filteredOrderView=viewOrders;
viewOrders=function(){const option=(id,name,key)=>`<option value="${esc(id)}" ${orderFilters[key]===id?'selected':''}>${esc(name)}</option>`;return `<div class="card"><h2>Фильтры заказов</h2><div class="row"><div class="field"><label>С даты</label><input data-order-filter="from" type="date" value="${orderFilters.from}"></div><div class="field"><label>По дату</label><input data-order-filter="to" type="date" value="${orderFilters.to}"></div><div class="field"><label>Компания</label><select data-order-filter="company"><option value="">Все компании</option>${DB.companies.map(c=>option(c.id,c.name,'company')).join('')}</select></div><div class="field"><label>Клиент</label><select data-order-filter="client"><option value="">Все клиенты</option>${DB.counterparties.map(c=>option(c.id,c.name,'client')).join('')}</select></div><div class="field"><label>Канал</label><select data-order-filter="channel"><option value="">Все каналы</option>${[['crm','CRM'],['shop','Магазин']].map(([id,label])=>option(id,label,'channel')).join('')}</select></div><div class="field"><label>Статус</label><select data-order-filter="status"><option value="">Все статусы</option>${[['draft','Черновик / не обработан'],['confirmed','Подтверждён'],['reserved','В резерве'],['posted','Проведён'],['completed','Завершён'],['cancelled','Отменён']].map(([id,label])=>option(id,label,'status')).join('')}</select></div></div></div>`+filteredOrderView()+archivedOrderView();};
const moreBindings=bindExtraActions;
bindExtraActions=function(){moreBindings();document.querySelectorAll('[data-order-filter]').forEach(el=>el.onchange=()=>{orderFilters[el.dataset.orderFilter]=el.value;render();});};
const inventoryBindings=bindExtraActions;
bindExtraActions=function(){inventoryBindings();
 document.querySelectorAll('[data-goto],[data-processing-tile],#backBtn').forEach(b=>{b.setAttribute('role','button');b.tabIndex=0;b.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();b.click();}};});
 if(session.view==='warehouse'){
   const header=document.querySelector('#content .card-header');
   if(header){
     const print=document.createElement('button');print.className='btn-secondary';print.textContent='Этикетка партии';print.onclick=()=>{
       openModal(`<h2>Печать этикетки</h2><label for="printLot">Партия</label><select id="printLot">${DB.lots.map(l=>`<option value="${l.id}">${esc(getProduct(l.product_id)?.name)} · ${esc(l.lot_number)}</option>`).join('')}</select><button class="btn-primary" id="openLabel">Открыть этикетку</button>`);
       document.getElementById('openLabel').onclick=()=>{const l=DB.lots.find(l=>l.id===document.getElementById('printLot').value);if(!l){showToast('Нет партии для печати');return;}const p=getProduct(l.product_id);window.open('label.html#'+encodeURIComponent(JSON.stringify({productId:p.id,lotId:l.id,name:p.name,sku:p.sku,lot:l.lot_number,expiry:l.expiry_date})),'_blank','noopener');};
     };header.append(print);
     if(['owner','partner'].includes(getUser(session.userId).role)){
       const inventory=document.createElement('button');inventory.className='btn-secondary';inventory.textContent='Инвентаризация';inventory.onclick=()=>{
          openModal(`<h2>Инвентаризация</h2><form id="inventoryForm"><label for="countProduct">Товар (базовая единица)</label><select id="countProduct" name="productId">${DB.products.filter(p=>p.active).map(p=>`<option value="${p.id}">${esc(p.name)} (${p.baseUnit})</option>`).join('')}</select><label for="countQuantity">Фактически посчитано</label><input id="countQuantity" name="countedQuantity" type="number" min="0" step="0.001" required><label for="countReason">Основание и ответственный</label><input id="countReason" name="note" minlength="3" required><p>Система сравнит подсчёт с текущим остатком и сразу запишет разницу отдельным движением.</p><button class="btn-primary">Сохранить и изменить остаток</button></form>`);
          document.getElementById('inventoryForm').onsubmit=async e=>{e.preventDefault();const row={id:uid(),date:todayStr(),...Object.fromEntries(new FormData(e.target)),status:'draft'};e.target.querySelector('button[type="submit"]').disabled=true;await saveAndPostStockAdjustment(row);};
       };header.append(inventory);
     }
   }
 }
 for(const b of document.querySelectorAll('[data-payment]')){const o=DB.orders.find(o=>o.id===b.dataset.payment);b.disabled=!['owner','partner'].includes(getUser(session.userId).role)||!['confirmed','reserved','posted','completed','cancelled'].includes(o.status);}
};
