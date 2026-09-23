const tg = window.Telegram?.WebApp;
if (tg) { tg.ready(); tg.expand(); }

const sb=makeClient();

const CATEGORY_LABELS = { fresh: 'Свежая рыба', salted: 'Слабосолёная', marinated: 'Маринованное', ready: 'Готовая продукция', caviar: 'Икра', kotlety: 'Котлеты', snacks: 'Снеки', delicacies: 'Деликатесы', legacy: 'Другое' };
const SPECIES_LABELS = { forel: 'Форель', semga: 'Сёмга', dorado: 'Дорадо', sibas: 'Сибас', sibas_dorado: 'Сибас/Дорадо', seafood: 'Морепродукты' };
const CATEGORY_ORDER = ['fresh','salted','marinated','ready','caviar','kotlety','snacks','delicacies'];

let products = [];let deliverySlots=[];let searchQuery="";let pendingPublicOrder=null;
let cart = []; // {key, product, qty, selections, unitPrice}
let currentCategory = 'fresh';
let currentSpecies = null;
let detailProduct = null;
let detailSelections = {};
let detailQty = 1;
let detailGalleryIdx = 0;

function fmtMoney(n) { return n.toFixed(2) + ' ₾'; }

async function loadProducts() {
  let data;try{data=await rpc('shop_catalog');deliverySlots=await rpc('shop_delivery');}catch(e){document.getElementById('grid').textContent=e.message;return;}
  products = (data || []).map(p => ({
    ...p,
    options: p.options || [],
    images: ((p.gallery_images && p.gallery_images.length) ? p.gallery_images : (p.image_url ? [p.image_url] : [])).map(safeImage).filter(Boolean)
  }));
  if(!products.some(p=>p.category===currentCategory))currentCategory=products[0]?.category||'fresh';
  renderTabs();
  renderGrid();
}

function renderTabs() {
  const tabsEl = document.getElementById('tabs');
  const productCategories = [...new Set(products.map(product => product.category || 'legacy'))];
  const orderedCategories = [...CATEGORY_ORDER.filter(category => productCategories.includes(category)),
    ...productCategories.filter(category => !CATEGORY_ORDER.includes(category)).sort((a,b)=>a.localeCompare(b,'ru'))];
  tabsEl.innerHTML = safeHTML(orderedCategories.map(c =>
    `<div class="tab ${c===currentCategory?'active':''}" data-cat="${c}">${CATEGORY_LABELS[c]||c}</div>`
  ).join(''));
  tabsEl.querySelectorAll('.tab').forEach(el => el.addEventListener('click', () => {
    currentCategory = el.dataset.cat;
    currentSpecies = null;
    renderTabs(); renderSubtabs(); renderGrid();
  }));
  renderSubtabs();
}

function renderSubtabs() {
  const subEl = document.getElementById('subtabs');
  if (currentCategory !== 'fresh') { subEl.style.display = 'none'; subEl.innerHTML=safeHTML(''); return; }
  const species = [...new Set(products.filter(p => p.category==='fresh').map(p=>p.species).filter(Boolean))];
  if (!species.length) { subEl.style.display='none'; return; }
  subEl.style.display = 'flex';
  subEl.innerHTML = safeHTML(`<div class="subtab ${!currentSpecies?'active':''}" data-sp="">Все</div>` + species.map(s =>
    `<div class="subtab ${currentSpecies===s?'active':''}" data-sp="${s}">${SPECIES_LABELS[s]||s}</div>`
  ).join(''));
  subEl.querySelectorAll('.subtab').forEach(el => el.addEventListener('click', () => {
    currentSpecies = el.dataset.sp || null;
    renderSubtabs(); renderGrid();
  }));
}

function priceRangeLabel(p) {
  if (!p.options.length) return fmtMoney(Number(p.sell_price));
  // compute min possible total: base + cheapest choice per group (choices include a 0-modifier default typically)
  let min = Number(p.sell_price);
  p.options.forEach(g => {
    const mods = g.choices.map(c => Number(c.modifier)||0);
    min += Math.min(...mods, 0);
  });
  return `от ${fmtMoney(min)}`;
}

function renderGrid() {
  const gridEl = document.getElementById('grid');
  let items = products.filter(p => (searchQuery||p.category===currentCategory) && p.name.toLowerCase().includes(searchQuery));
  if (currentCategory === 'fresh' && currentSpecies) items = items.filter(p => p.species === currentSpecies);
  if (!items.length) { gridEl.innerHTML = safeHTML('<div class="empty">Нет товаров в этом разделе.</div>'); return; }
  gridEl.innerHTML = safeHTML(items.map(p => `
    <div class="pcard" data-id="${p.id}">
      <div class="img" style="${esc(imageStyle(p.images[0]))}">
        ${p.images[0] ? '' : (p.emoji||'🐟')}
        ${p.images.length > 1 ? `<span class="photocount">📷 ${p.images.length}</span>` : ''}
      </div>
      <div class="body">
        <div class="name">${p.emoji||''} ${esc(p.name)}</div>
        <div class="unit">${esc(p.unit)} · ${Number(p.available)>0?'В наличии':'Нет в наличии'}</div>
        <div class="price">${priceRangeLabel(p)}</div>
        <button class="selectbtn">Выбрать</button>
      </div>
    </div>`).join(''));
  gridEl.querySelectorAll('.pcard').forEach(cardEl => {
    cardEl.addEventListener('click', () => {const p=products.find(p=>p.id===cardEl.dataset.id);if(Number(p.available)>0)openDetail(p);});
  });
}

function computeDetailPrice() {
  let total = Number(detailProduct.sell_price);
  detailProduct.options.forEach(g => {
    const chosenText = detailSelections[g.name];
    const choice = g.choices.find(c => c.text === chosenText);
    if (choice) total += Number(choice.modifier)||0;
  });
  return total;
}

function renderGallery() {
  const el = document.getElementById('gallery');
  const imgs = detailProduct.images.length ? detailProduct.images : [null];
  el.innerHTML = safeHTML(imgs.map((src,i) => src ? `<img class="${i===detailGalleryIdx?'active':''}" src="${esc(safeImage(src))}" alt="Фото товара">` : `<div style="display:flex;align-items:center;justify-content:center;height:100%;font-size:60px;">${detailProduct.emoji||'🐟'}</div>`).join('')
    + (imgs.length > 1 ? `
      <div class="nav prev" id="galPrev">‹</div>
      <div class="nav next" id="galNext">›</div>
      <div class="dots">${imgs.map((_,i)=>`<span class="${i===detailGalleryIdx?'active':''}"></span>`).join('')}</div>
    ` : ''));
  if (imgs.length > 1) {
    document.getElementById('galPrev').addEventListener('click', () => { detailGalleryIdx = (detailGalleryIdx-1+imgs.length)%imgs.length; renderGallery(); });
    document.getElementById('galNext').addEventListener('click', () => { detailGalleryIdx = (detailGalleryIdx+1)%imgs.length; renderGallery(); });
  }
}

function renderOptGroups() {
  const el = document.getElementById('optGroups');
  el.innerHTML = safeHTML(detailProduct.options.map(g => `
    <div class="opt-group" data-group="${esc(g.name)}">
      <div class="oglabel">${esc(g.name)}</div>
      <div class="opt-choices">
        ${g.choices.map(c => `<div class="opt-choice ${detailSelections[esc(g.name)]===c.text?'active':''}" data-text="${c.text}">${c.text}${c.modifier?` (${c.modifier>0?'+':''}${c.modifier}₾)`:''}</div>`).join('')}
      </div>
    </div>`).join(''));
  el.querySelectorAll('.opt-group').forEach(groupEl => {
    const gname = groupEl.dataset.group;
    groupEl.querySelectorAll('.opt-choice').forEach(choiceEl => {
      choiceEl.addEventListener('click', () => {
        detailSelections[gname] = choiceEl.dataset.text;
        renderOptGroups();
        document.getElementById('detailPrice').textContent = fmtMoney(computeDetailPrice());
      });
    });
  });
}

function openDetail(product) {
  detailProduct = product;
  detailGalleryIdx = 0;
  detailQty = 1;
  detailSelections = {};
  product.options.forEach(g => { detailSelections[g.name] = g.choices[0]?.text; });
  document.getElementById('detailName').textContent = `${product.emoji||''} ${esc(product.name)}`;
  document.getElementById('detailUnit').textContent = product.unit;
  document.getElementById('detailPrice').textContent = fmtMoney(computeDetailPrice());
  document.getElementById('detailQty').textContent = detailQty;
  renderGallery();
  renderOptGroups();
  document.getElementById('detailOverlay').classList.add('open');
}

document.getElementById('closeDetail').addEventListener('click', () => document.getElementById('detailOverlay').classList.remove('open'));
document.getElementById('detailDec').addEventListener('click', () => { detailQty = Math.max(1, detailQty-1); document.getElementById('detailQty').textContent = detailQty; });
document.getElementById('detailInc').addEventListener('click', () => { detailQty += 1; document.getElementById('detailQty').textContent = detailQty; });

document.getElementById('addFromDetail').addEventListener('click', () => {
  const unitPrice = computeDetailPrice();
  const selText = detailProduct.options.map(g => detailSelections[g.name]).filter(Boolean).join(', ');
  const key = detailProduct.id + '::' + selText;
  const existing = cart.find(c => c.key === key);
  if (existing) existing.qty += detailQty;
  else cart.push({ key, product: detailProduct, qty: detailQty, selText, selections:{...detailSelections}, unitPrice });
  updateCartBar();
  document.getElementById('detailOverlay').classList.remove('open');
  if (tg?.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
});

function cartCount() { return cart.reduce((s,c)=>s+c.qty,0); }
function cartTotal() { return cart.reduce((s,c)=>s+c.qty*c.unitPrice,0); }

function updateCartBar() {
  const bar = document.getElementById('cartbar');
  const count = cartCount();
  if (count > 0) {
    bar.style.display = 'flex';
    document.getElementById('cartbarText').textContent = `Корзина: ${count}`;
    document.getElementById('cartbarTotal').textContent = fmtMoney(cartTotal());
  } else {
    bar.style.display = 'none';
  }
}

function renderCartModal() {
  const el = document.getElementById('cartItems');
  if (!cart.length) { el.innerHTML = safeHTML('<div class="empty">Корзина пуста</div>'); document.getElementById('cartTotal').textContent = fmtMoney(0); return; }
  el.innerHTML = safeHTML(cart.map((c,idx) => `
    <div class="cart-row" data-idx="${idx}">
      <div class="ci"><div class="cn">${c.product.emoji||''} ${esc(c.product.name)}</div><div class="cu">${esc(c.selText) ? esc(c.selText)+' · ' : ''}${c.product.unit} × ${c.qty} = ${fmtMoney(c.qty*c.unitPrice)}</div></div>
      <div class="stepper">
        <button class="cdec">−</button><span>${c.qty}</span><button class="cinc">+</button>
      </div>
    </div>`).join(''));
  el.querySelectorAll('.cart-row').forEach(row => {
    const idx = Number(row.dataset.idx);
    row.querySelector('.cdec').addEventListener('click', () => { cart[idx].qty -= 1; if (cart[idx].qty<=0) cart.splice(idx,1); renderCartModal(); updateCartBar(); });
    row.querySelector('.cinc').addEventListener('click', () => { cart[idx].qty += 1; renderCartModal(); updateCartBar(); });
  });
  document.getElementById('cartTotal').textContent = fmtMoney(cartTotal());
}

document.getElementById('cartbar').addEventListener('click', () => { renderCartModal(); document.getElementById('cartOverlay').classList.add('open'); });
document.getElementById('closeCart').addEventListener('click', () => document.getElementById('cartOverlay').classList.remove('open'));
document.getElementById('checkoutBtn').addEventListener('click', () => {
  if (cartCount() === 0) return;
  document.getElementById('cartOverlay').classList.remove('open');
  const tgUser = tg?.initDataUnsafe?.user;
  if (tgUser) {
    document.getElementById('cName').value = [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ');
  }
  document.getElementById('deliverySlot').innerHTML=safeHTML(deliverySlots.map(s=>`<option value="${s.id}">${esc(s.zone)}${s.delivery_date?' · '+esc(s.delivery_date):''} · ${esc(s.label)} · ${fmtMoney(Number(s.fee))}, бесплатно от ${fmtMoney(Number(s.free_from||0))}</option>`).join(''));
  document.getElementById('checkoutOverlay').classList.add('open');
  updateCheckoutTotal();
});
document.getElementById('closeCheckout').addEventListener('click', () => document.getElementById('checkoutOverlay').classList.remove('open'));

function normPhone(s) { return (s||'').replace(/\D/g,''); }

document.getElementById('submitOrderBtn').addEventListener('click',async()=>{
 const btn=document.getElementById('submitOrderBtn');
 const payload={name:document.getElementById('cName').value.trim(),phone:document.getElementById('cPhone').value.trim(),address:document.getElementById('cAddress').value.trim(),
 slotId:document.getElementById('deliverySlot').value,privacyConsent:document.getElementById('privacyConsent').checked,marketingConsent:document.getElementById('marketingConsent').checked,
 items:cart.map(c=>({productId:c.product.id,qty:c.qty,selections:c.selections||{}}))};
 if(!payload.name||!payload.phone||!payload.address||!payload.slotId||!payload.privacyConsent||!payload.items.length){alert('Заполните контакты, выберите доставку и подтвердите обработку данных');return;}
 const fingerprint=JSON.stringify(payload);
 if(pendingPublicOrder?.fingerprint!==fingerprint)pendingPublicOrder={fingerprint,id:crypto.randomUUID()};
 btn.disabled=true;btn.textContent='Оформляем…';
 try{
   const result=await rpc('create_public_order',{request_id:pendingPublicOrder.id,payload});
   if(!result?.created)throw new Error('Сервер не подтвердил создание заказа');
   cart=[];pendingPublicOrder=null;updateCartBar();document.getElementById('checkoutOverlay').classList.remove('open');
   document.getElementById('successOverlay').classList.add('open');
   document.getElementById('orderReceipt').textContent='Заказ '+result.id+' создан. Уведомление менеджеру поставлено в очередь.';
 }catch(e){alert(e.message+' При обрыве связи повторите отправку без изменения заказа.');}
 finally{btn.disabled=false;btn.textContent='Подтвердить заказ';}
});
document.getElementById('successCloseBtn').addEventListener('click', () => {
  document.getElementById('successOverlay').classList.remove('open');
  if (tg) tg.close();
});

document.getElementById('shopSearch').addEventListener('input',e=>{searchQuery=e.target.value.trim().toLowerCase();renderGrid();});
loadProducts();

function deliveryFee(slot){return slot&&cartTotal()<Number(slot.free_from||0)?Number(slot.fee||0):0;}
function updateCheckoutTotal(){const slot=deliverySlots.find(s=>s.id===document.getElementById('deliverySlot').value);document.getElementById('checkoutTotal').textContent='Итого с доставкой: '+fmtMoney(cartTotal()+deliveryFee(slot));}
document.getElementById('deliverySlot').addEventListener('change',updateCheckoutTotal);
for(const id of ['closeDetail','closeCart','closeCheckout']){const b=document.getElementById(id);b.setAttribute('role','button');b.setAttribute('aria-label','Закрыть');b.tabIndex=0;b.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();b.click();}};}
const cartButton=document.getElementById('cartbar');cartButton.setAttribute('role','button');cartButton.tabIndex=0;cartButton.setAttribute('aria-label','Открыть корзину');cartButton.onkeydown=e=>{if(e.key==='Enter'){cartButton.click();}};

function imageStyle(url){const u=safeImage(url);return u?'background-image:url("'+u.replaceAll('"','%22').replaceAll('\\','%5C')+'")':'';}
