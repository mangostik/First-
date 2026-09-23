const PRODUCTION_ROLE_LABELS = Object.freeze({
  stage1_input: 'Вход этапа 1 (принятое сырьё)',
  intermediate: 'Полуфабрикат: выход этапа 1 → вход этапа 2',
  stage1_final: 'Готовый выход этапа 1',
  stage2_final: 'Готовый выход этапа 2'
});

const PRODUCTION_SPECIES_LABELS = Object.freeze({
  forel: 'Форель',
  semga: 'Сёмга / лосось',
  dorado: 'Дорадо',
  sibas: 'Сибас',
  krevetka: 'Креветка',
  grebeshok: 'Гребешок'
});

const PRODUCTION_SPECIES_PRESETS = Object.freeze({
  forel: 'Форель',
  semga: 'Сёмга / лосось',
  'forel,semga': 'Форель или сёмга / лосось',
  dorado: 'Дорадо',
  sibas: 'Сибас',
  'dorado,sibas': 'Дорадо или сибас',
  krevetka: 'Креветка',
  grebeshok: 'Гребешок',
  'forel,krevetka': 'Форель с креветкой'
});

function productSpecies(product) {
  if (!product) return [];
  if (Array.isArray(product.productionSpecies) && product.productionSpecies.length) {
    return [...new Set(product.productionSpecies.map(String).filter(Boolean))].sort();
  }
  const name = String(product.name || '').toLocaleLowerCase('ru');
  const species = new Set();
  if (name.includes('форел')) species.add('forel');
  if (name.includes('сёмг') || name.includes('семг') || name.includes('лосос')) species.add('semga');
  if (name.includes('дорад')) species.add('dorado');
  if (name.includes('сибас')) species.add('sibas');
  if (name.includes('кревет')) species.add('krevetka');
  if (name.includes('гребеш')) species.add('grebeshok');
  if (!species.size && (name.includes('икра красная') || name.includes('гравлакс') || name === 'fish burger' || name === 'fish dog' || name.includes('стейк на гриле'))) {
    species.add('forel'); species.add('semga');
  }
  if (!species.size) {
    const aliases = {forel:['forel'],semga:['semga'],dorado:['dorado'],sibas:['sibas'],sibas_dorado:['dorado','sibas'],seafood:[]};
    (aliases[product.species] || []).forEach(value => species.add(value));
  }
  return [...species].sort();
}

function productionSpeciesLabel(product) {
  const values = productSpecies(product);
  return values.map(value => PRODUCTION_SPECIES_LABELS[value] || value).join(' / ') || 'Не задан';
}

function processingSpeciesCompatible(input, output) {
  const inputSpecies = productSpecies(input);
  const outputSpecies = productSpecies(output);
  return inputSpecies.length > 0 && outputSpecies.length > 0 && inputSpecies.some(value => outputSpecies.includes(value));
}

function productionRole(product) {
  if (!product) return '';
  if (PRODUCTION_ROLE_LABELS[product.productionRole]) return product.productionRole;
  if (product.isTerminal) return 'stage2_final';
  if (product.type === 'raw') return product.receivable === false ? 'intermediate' : 'stage1_input';
  return ['salted', 'marinated', 'caviar', 'ready', 'snacks', 'kotlety'].includes(product.category)
    ? 'stage2_final' : 'stage1_final';
}

function productionRoleLabel(product) {
  return PRODUCTION_ROLE_LABELS[productionRole(product)] || 'Роль не задана';
}

function canReceiveProduct(product) {
  return !!product?.active && product.receivable === true;
}

function canUseAsProcessingInput(product, stage) {
  const role = productionRole(product);
  return !!product?.active && ((Number(stage) === 1 && role === 'stage1_input') ||
    (Number(stage) === 2 && role === 'intermediate'));
}

function canUseAsProcessingOutput(product, stage) {
  const role = productionRole(product);
  return !!product?.active && ((Number(stage) === 1 && ['intermediate', 'stage1_final'].includes(role)) ||
    (Number(stage) === 2 && role === 'stage2_final'));
}

function validateProcessingChain(record, products) {
  const stage = Number(record.processingStage);
  if (![1, 2].includes(stage)) return 'Выберите этап переработки';
  const byId = new Map(products.map(product => [product.id, product]));
  const input = byId.get(record.inputProductId);
  if (!canUseAsProcessingInput(input, stage)) {
    return stage === 1
      ? 'На вход этапа 1 можно выбрать только принятое сырьё'
      : 'На вход этапа 2 можно выбрать только полуфабрикат, полученный на этапе 1';
  }
  const outputs = [];
  for (let i = 1; i <= 5; i += 1) {
    const id = record[`output${i}ProductId`];
    const qty = Number(record[`output${i}Qty`] || 0);
    if (!id && qty > 0) return `Выберите товар для выхода ${i}`;
    if (id && qty <= 0) return `Укажите количество для выхода ${i}`;
    if (!id) continue;
    const product = byId.get(id);
    if (!canUseAsProcessingOutput(product, stage)) {
      return `Товар «${product?.name || 'неизвестный'}» нельзя получить на этапе ${stage}`;
    }
    if (!processingSpeciesCompatible(input, product)) {
      return `Из «${input?.name || 'неизвестного сырья'}» нельзя получить «${product?.name || 'неизвестный товар'}»: вид рыбы не совпадает`;
    }
    if (id === record.inputProductId) return 'Один товар не может быть одновременно входом и выходом';
    if (outputs.includes(id)) return 'Один выходной товар нельзя указывать дважды';
    outputs.push(id);
  }
  if (!outputs.length) return 'Добавьте хотя бы один выход переработки';
  return '';
}
