function validateLabel(d){
 const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
 if(!d||!uuid.test(d.productId)||!uuid.test(d.lotId)||typeof d.name!=='string'||!d.name.trim()||d.name.length>200||typeof d.sku!=='string'||d.sku.length>100||typeof d.lot!=='string'||d.lot.length>200)throw new Error('Некорректные данные этикетки');
 return d;
}
try{
 const d=validateLabel(JSON.parse(decodeURIComponent(location.hash.slice(1))));
 document.getElementById('name').textContent=d.name;
 document.getElementById('sku').textContent='Артикул: '+d.sku;
 document.getElementById('lot').textContent='Партия: '+d.lot;
 document.getElementById('expiry').textContent='Годен до: '+(d.expiry||'не указан');
 const qr=qrcode(0,'M');qr.addData(JSON.stringify({productId:d.productId,lotId:d.lotId,sku:d.sku}));qr.make();
 const img=document.createElement('img');img.src=qr.createDataURL(4,8);img.alt='QR-код товара и партии';document.getElementById('qr').append(img);
}catch(e){document.getElementById('error').textContent=e.message;document.getElementById('print').disabled=true;}
document.getElementById('print').onclick=()=>window.print();
