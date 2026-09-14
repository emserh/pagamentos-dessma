/* ==== painel_dessma.html — lógica de leitura, cálculo e renderização ==== */

const SHEET_NAME = 'ProcessosDESSMA';
const SHEET_NAME_PG = 'PG';
const HEADER_ROW_INDEX = 1;
const DATA_START_INDEX = 2;

// Posições de coluna (0-based) dentro da linha, confirmadas contra o layout real do RGT-0023
const IDX = {
  empresa:0, contrato:1, competencia:2, fiscal:3, statusLib:4, data:5, processo:6,
  setorOrigem:7, setorAtual:8, remanejamento:9, dataRemanej:10, obs:11, diasAberturaRaw:12,
  valor:13, situacao:14, unidades:15, chegada1:16, chegadaRemanej:17, saidaGcont:18, analista:19,
  diasAberturaSaidaGcont:20, divide:21,
  dataRet1:22, setorRet1:23, dataSaidaRet1:24, analistaRet1:25, diasSanar1:26,
  dataRet2:27, setorRet2:28, dataSaidaRet2:29, analistaRet2:30, diasSanar2:31,
  dataRet3:32, setorRet3:33, dataSaidaRet3:34, analistaRet3:35, diasSanar3:36,
  financeiro:37, qddiasFinanceiro:38, diasFinanceiroRaw:39
};

let charts = {}; // instâncias Chart.js ativas
let currentSort = 'dias';
let lastCritList = [];
let allRecords = []; // dataset completo (sem filtro), carregado da planilha
let msAno, msSetor, msStatus; // instâncias do componente de filtro multiselect

const MONTHS_PT = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
function monthLabel(key){ // key = 'YYYY-MM'
  const [y,m] = key.split('-');
  return MONTHS_PT[parseInt(m,10)-1] + '/' + y.slice(2);
}
function parseCompetencia(raw){
  if (typeof raw !== 'string') return null;
  const m = raw.trim().match(/^(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const mm = parseInt(m[1],10);
  if (mm < 1 || mm > 12) return null;
  return m[2] + '-' + m[1];
}

const PALETTE = {
  teal: '#12a594', tealSoft: 'rgba(18,165,148,.18)',
  petroleo: '#156082', petroleo2: '#3c7194',
  red: '#c94a3f', redSoft: 'rgba(201,74,63,.75)',
  amber: '#d68a1f', amberSoft: 'rgba(214,138,31,.75)',
  grid: '#e9edf0', text: '#647184'
};

// Rota interna da Vercel (Serverless Function) — não expõe a URL do Google Sheets
// A variável de ambiente GOOGLE_SHEETS_URL é lida apenas no servidor.
const GOOGLE_SHEETS_URL = '/api/sheets';

// Limpa qualquer resquício anterior de URL salva no navegador
try { localStorage.removeItem('DESSMA_GSHEETS_URL'); } catch(e){}

document.getElementById('fileInput').addEventListener('change', handleFile);

const btnRefresh = document.getElementById('btnRefresh');
if (btnRefresh){
  btnRefresh.addEventListener('click', () => carregarGoogleSheets(true));
}

/* ---------- Abas ---------- */
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.querySelector('.tab-panel[data-panel="' + btn.dataset.tab + '"]').classList.add('active');
  });
});

// Busca o nome real da aba ignorando maiúsculas/minúsculas e espaços nas pontas —
// evita falhar por causa de "PG " ou "pg" em vez de "PG".
function findSheetName(wb, target){
  const norm = s => s.trim().toLowerCase();
  return wb.SheetNames.find(n => norm(n) === norm(target)) || null;
}

// Processa e exibe os dados (usado tanto pelo Google Sheets quanto pelo upload de arquivo local)
function processData(aoaD, aoaP, sourceLabel, sheetNamesFound = []){
  const recD = extractDESSMA(aoaD).map(r => computeRow(r.row, r.fonte));

  let recP = [];
  const temPG = Array.isArray(aoaP) && aoaP.length > 0;
  if (temPG){
    recP = extractPG(aoaP).map(r => computeRow(r.row, r.fonte));
  }

  const records = [...recD, ...recP];
  if (records.length === 0){
    throw new Error('Nenhum processo válido foi encontrado nos dados carregados.');
  }

  allRecords = records;
  setupFilters(allRecords);
  applyFilters();

  document.getElementById('fileStatus').innerHTML =
    '<strong>' + sourceLabel + '</strong> · ' + recD.length + ' na carteira ativa' +
    (temPG ? ' + ' + recP.length + ' na aba PG' : ' · aba PG não encontrada');
  document.getElementById('headerUpdated').textContent = 'Atualizado: ' + new Date().toLocaleString('pt-BR');
  document.getElementById('emptyState').style.display = 'none';
  document.getElementById('dashboard').classList.add('visible');
  document.getElementById('tabBar').style.display = 'flex';

  const banner = document.getElementById('pgWarning');
  if (temPG){
    banner.classList.remove('show');
  } else {
    banner.classList.add('show');
    banner.innerHTML = '⚠️ Não foi encontrada a aba <strong>"' + SHEET_NAME_PG + '"</strong>' +
      (sheetNamesFound && sheetNamesFound.length ? ' (encontradas: ' + sheetNamesFound.map(n=>'"'+n+'"').join(', ') + ')' : '') +
      '. Sem ela, o painel só enxerga a carteira ativa — <strong>histórico de pagamentos, % pago e tempo de pagamento ficam zerados/indisponíveis.</strong> Confirme se sua planilha possui a aba PG.';
  }
}

// Carregamento via /api/sheets (Serverless Function da Vercel)
// A URL do Google Sheets fica segura em process.env.GOOGLE_SHEETS_URL no servidor.
async function carregarGoogleSheets(isManual = false){
  const url = (GOOGLE_SHEETS_URL || '').trim();
  const statusEl = document.getElementById('fileStatus');
  const refreshBtn = document.getElementById('btnRefresh');

  if (!url){
    statusEl.textContent = 'Nenhuma planilha configurada. Carregue um arquivo .xlsx manualmente.';
    return false;
  }

  if (refreshBtn){
    refreshBtn.disabled = true;
    refreshBtn.innerHTML = '<span class="loading-spinner"></span> Atualizando…';
  }
  statusEl.innerHTML = '<span class="loading-spinner"></span> Conectando ao Google Sheets…';

  const MAX_RETRIES = 2;
  let lastError = null;

  try {
    for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++){
      try {
        if (attempt > 1){
          statusEl.innerHTML = '<span class="loading-spinner"></span> Reconectando… (tentativa ' + attempt + '/' + (MAX_RETRIES + 1) + ')';
          await new Promise(r => setTimeout(r, 1200));
        }

        // O timestamp evita que o browser sirva uma resposta antiga em cache
        const fetchUrl = url + '?_ts=' + Date.now();
        const res = await fetch(fetchUrl, { method: 'GET', cache: 'no-store' });

        if (!res.ok){
          const errBody = await res.json().catch(() => ({}));
          throw new Error(errBody.error || ('Servidor retornou status ' + res.status));
        }

        const data = await res.json();

        if (data && data.error){
          throw new Error(data.error);
        }

        let aoaD = null;
        let aoaP = null;
        let sheetsFound = [];

        if (data && typeof data === 'object'){
          sheetsFound = Object.keys(data);
          const normKey = (target) => sheetsFound.find(k => k.trim().toLowerCase() === target.trim().toLowerCase());
          const keyD = normKey(SHEET_NAME);
          const keyP = normKey(SHEET_NAME_PG);
          if (keyD && Array.isArray(data[keyD])) aoaD = data[keyD];
          if (keyP && Array.isArray(data[keyP])) aoaP = data[keyP];
        }

        if (!aoaD || !Array.isArray(aoaD) || aoaD.length === 0){
          throw new Error('Aba "' + SHEET_NAME + '" não encontrada. Abas recebidas: ' + (sheetsFound.join(', ') || 'nenhuma'));
        }

        // Salva cache local de emergência
        try {
          localStorage.setItem('DESSMA_CACHE_DATA', JSON.stringify({
            aoaD, aoaP, sheetsFound, time: new Date().toISOString()
          }));
        } catch(e){}

        processData(aoaD, aoaP, 'Google Sheets (ao vivo)', sheetsFound);
        return true;

      } catch(err){
        lastError = err;
        console.warn('Tentativa ' + attempt + ' falhou:', err);
      }
    }

    // Todas as tentativas falharam — tenta exibir cache local
    console.error('Erro ao buscar dados após retentativas:', lastError);
    const cacheRaw = localStorage.getItem('DESSMA_CACHE_DATA');
    if (cacheRaw){
      try {
        const cache = JSON.parse(cacheRaw);
        processData(cache.aoaD, cache.aoaP, 'Google Sheets (em cache)', cache.sheetsFound);
        const dataHora = cache.time ? new Date(cache.time).toLocaleTimeString('pt-BR', {hour:'2-digit', minute:'2-digit'}) : '';
        statusEl.innerHTML = '<span style="color:#d68a1f">⚠️ Instabilidade (' + lastError.message + '). Exibindo dados recentes (' + dataHora + '). <a href="#" id="linkRetryCache" style="color:var(--teal);text-decoration:underline;margin-left:4px;">Tentar reconectar</a></span>';
        document.getElementById('linkRetryCache')?.addEventListener('click', (e) => { e.preventDefault(); carregarGoogleSheets(true); });
        return false;
      } catch(e){}
    }

    statusEl.innerHTML = '<span style="color:#ff8b80">⚠️ Erro ao carregar dados: ' + lastError.message + '. <a href="#" id="linkRetryError" style="color:var(--teal);text-decoration:underline;margin-left:4px;">Tentar novamente</a></span>';
    document.getElementById('linkRetryError')?.addEventListener('click', (e) => { e.preventDefault(); carregarGoogleSheets(true); });
    return false;

  } finally {
    if (refreshBtn){
      refreshBtn.disabled = false;
      refreshBtn.innerHTML = '🔄 Atualizar dados';
    }
  }
}

// Carregamento via arquivo manual (.xlsx)
function handleFile(ev){
  const file = ev.target.files[0];
  if (!file) return;
  document.getElementById('fileStatus').innerHTML =
    '<span class="loading-spinner"></span> Lendo <strong>' + file.name + '</strong>…';
  const reader = new FileReader();
  reader.onload = (e) => {
    try{
      const wb = XLSX.read(e.target.result, {type:'array', cellDates:true});
      const realSheetName = findSheetName(wb, SHEET_NAME);
      if (!realSheetName){
        alert('A planilha selecionada não contém a aba "' + SHEET_NAME + '". Verifique o arquivo.');
        document.getElementById('fileStatus').textContent = 'Falha ao ler: aba "' + SHEET_NAME + '" não encontrada.';
        return;
      }
      const wsD = wb.Sheets[realSheetName];
      const aoaD = XLSX.utils.sheet_to_json(wsD, {header:1, defval:null, raw:true});

      let aoaP = null;
      const realSheetNamePG = findSheetName(wb, SHEET_NAME_PG);
      if (realSheetNamePG){
        const wsP = wb.Sheets[realSheetNamePG];
        aoaP = XLSX.utils.sheet_to_json(wsP, {header:1, defval:null, raw:true});
      }

      processData(aoaD, aoaP, file.name, wb.SheetNames);
    }catch(err){
      console.error(err);
      alert('Não foi possível ler o arquivo: ' + err.message);
      document.getElementById('fileStatus').textContent = 'Falha ao processar o arquivo.';
    }
  };
  reader.readAsArrayBuffer(file);
}

/* ---------- Extração ---------- */
// Datas aceitam objetos Date, texto DD/MM/AAAA, texto ISO (JSON) ou serial numérico
function parseFlexDate(v){
  if (!v) return null;
  if (v instanceof Date && !isNaN(v.getTime())) return v;
  if (typeof v === 'number' && !isNaN(v)){
    // Serial de data do Excel/Sheets (dias decorridos desde 30/12/1899)
    if (v > 20000 && v < 60000){
      const dt = new Date(Math.round((v - 25569) * 86400 * 1000));
      if (!isNaN(dt.getTime())) return dt;
    }
  }
  if (typeof v === 'string'){
    const s = v.trim();
    if (!s) return null;
    const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m){
      const dt = new Date(parseInt(m[3],10), parseInt(m[2],10)-1, parseInt(m[1],10));
      if (!isNaN(dt.getTime())) return dt;
    }
    // Formato ISO ("2024-05-12T03:00:00.000Z") gerado pelo Google Apps Script em JSON
    const dtIso = new Date(s);
    if (!isNaN(dtIso.getTime())) return dtIso;
  }
  return null;
}
// Valor às vezes vem como texto formatado "R$   260,00" em vez de número.
function parseFlexValor(v){
  if (typeof v === 'number' && !isNaN(v)) return v;
  if (typeof v === 'string'){
    const cleaned = v.replace(/R\$/gi,'').replace(/\s/g,'').replace(/\./g,'').replace(',', '.');
    const n = parseFloat(cleaned);
    if (!isNaN(n)) return n;
  }
  return null;
}

function isValidRow(row){
  if (!row) return false;
  const emp = row[IDX.empresa];
  return typeof emp === 'string' && emp.trim() !== '' &&
         parseFlexDate(row[IDX.data]) !== null &&
         parseFlexValor(row[IDX.valor]) !== null;
}

function extractDESSMA(aoa){
  const out = [];
  let invalidStreak = 0;
  for (let r = DATA_START_INDEX; r < aoa.length; r++){
    const row = aoa[r];
    if (isValidRow(row)){
      out.push({row, fonte:'DESSMA'});
      invalidStreak = 0;
    } else {
      invalidStreak++;
      // depois que a base real termina, a planilha traz um resumo quinzenal/mensal
      // nas mesmas colunas — paramos ao encontrar linhas inválidas consecutivas
      if (out.length > 0 && invalidStreak >= 3) break;
    }
  }
  return out;
}

function extractPG(aoa){
  // A aba PG não tem resumo/pivô grudado no final, mas tem linhas divisórias
  // (ex.: "ARQUIVADOS") no meio da lista — por isso lemos a aba inteira em vez
  // de parar nas primeiras linhas inválidas consecutivas.
  const out = [];
  for (let r = DATA_START_INDEX; r < aoa.length; r++){
    const row = aoa[r];
    if (isValidRow(row)) out.push({row, fonte:'PG'});
  }
  return out;
}

/* ---------- Cálculo ---------- */
function stripTime(d){ return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }

function networkDays(start, end){
  if (!start || !end) return null;
  let d1 = stripTime(start), d2 = stripTime(end);
  if (d1 > d2) return 0;
  let count = 0, cur = new Date(d1);
  while (cur <= d2){
    const day = cur.getDay();
    if (day !== 0 && day !== 6) count++;
    cur.setDate(cur.getDate()+1);
  }
  return count;
}
function calendarDays(d1, d2){ return Math.round((stripTime(d2) - stripTime(d1)) / 86400000); }

function computeRow(row, fonte){
  const TODAY = new Date();
  const data = parseFlexDate(row[IDX.data]);
  const valor = parseFlexValor(row[IDX.valor]);
  // Situação (ProcessosDESSMA) e Data Pagamento (PG) ocupam a MESMA coluna (O).
  // Quando essa célula é uma data, o processo está pago; quando é texto
  // ("Não pago", ou um setor de bloqueio na PG), ainda está pendente.
  const paymentDate = parseFlexDate(row[IDX.situacao]);
  const pago = paymentDate !== null;
  const financeiro = parseFlexDate(row[IDX.financeiro]);
  const dataRet2 = parseFlexDate(row[IDX.dataRet2]);
  const dataRet3 = parseFlexDate(row[IDX.dataRet3]);
  const remanej = row[IDX.remanejamento];

  const diasAbertura = (networkDays(data, TODAY) || 0) - 1;
  const diasAteFinanceiro = financeiro ? calendarDays(data, financeiro) : null;
  const diasNoFinanceiro = financeiro ? calendarDays(financeiro, pago ? paymentDate : TODAY) : null;
  const diasParaPagamento = pago ? calendarDays(data, paymentDate) : null;
  const retrabalho = !!(dataRet2 || dataRet3);
  const remanejado = !!(remanej && String(remanej).trim() !== '' && String(remanej).trim() !== '-');

  return {
    fonte, empresa: row[IDX.empresa], contrato: row[IDX.contrato], processo: row[IDX.processo],
    setorAtual: row[IDX.setorAtual] || '(sem setor)', setorOrigem: row[IDX.setorOrigem] || '(sem setor)',
    statusLib: (row[IDX.statusLib] || '').toString().trim().toUpperCase(),
    valor, data, pago, paymentDate,
    diasAbertura: Math.max(diasAbertura, 0), diasAteFinanceiro, diasNoFinanceiro, diasParaPagamento,
    retrabalho, remanejado, competenciaKey: parseCompetencia(row[IDX.competencia])
  };
}

/* ---------- Agregações ---------- */
const sum = (arr, f) => arr.reduce((a,r)=> a + f(r), 0);
const avg = (arr) => arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : null;
const median = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a,b)=>a-b);
  const m = Math.floor(s.length/2);
  return s.length % 2 ? s[m] : (s[m-1]+s[m])/2;
};
const fmtBRL = (n) => 'R$ ' + n.toLocaleString('pt-BR', {minimumFractionDigits:2, maximumFractionDigits:2});
const fmtBRLcompact = (n) => {
  if (n >= 1e6) return 'R$ ' + (n/1e6).toLocaleString('pt-BR',{maximumFractionDigits:1}) + ' mi';
  if (n >= 1e3) return 'R$ ' + (n/1e3).toLocaleString('pt-BR',{maximumFractionDigits:0}) + ' mil';
  return fmtBRL(n);
};
const fmtDias = (n) => (n===null || n===undefined || isNaN(n)) ? '—' : Math.round(n).toLocaleString('pt-BR') + ' d';
const fmtPct = (n) => n.toLocaleString('pt-BR',{maximumFractionDigits:1}) + '%';

/* ---------- Filtros ---------- */
function createMultiSelect(containerId, placeholder){
  const root = document.getElementById(containerId);
  root.innerHTML =
    '<button type="button" class="ms-btn">' + placeholder + '</button>' +
    '<div class="ms-panel">' +
      '<div class="ms-actions"><button type="button" data-act="all">Selecionar todos</button><button type="button" data-act="none">Limpar</button></div>' +
      '<div class="ms-list"></div>' +
    '</div>';
  const btn = root.querySelector('.ms-btn');
  const panel = root.querySelector('.ms-panel');
  const list = root.querySelector('.ms-list');
  let options = []; // [{value,label}]
  let selected = new Set(); // vazio = "todos" (sem filtro)
  let onChangeCb = () => {};

  function renderList(){
    list.innerHTML = options.map(o =>
      '<label class="ms-opt"><input type="checkbox" value="' + encodeURIComponent(o.value) + '" ' +
      (selected.has(o.value) ? 'checked' : '') + '><span>' + o.label + '</span></label>'
    ).join('');
    list.querySelectorAll('input[type=checkbox]').forEach(cb => {
      cb.addEventListener('change', () => {
        const val = decodeURIComponent(cb.value);
        if (cb.checked) selected.add(val); else selected.delete(val);
        updateBtn();
        onChangeCb();
      });
    });
  }
  function updateBtn(){
    if (selected.size === 0){
      btn.textContent = placeholder;
      btn.classList.remove('has-selection');
    } else {
      btn.textContent = selected.size === 1 ? [...selected][0] : selected.size + ' selecionados';
      btn.classList.add('has-selection');
    }
  }
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.ms-panel.open').forEach(p => { if (p!==panel) p.classList.remove('open'); });
    panel.classList.toggle('open');
  });
  panel.addEventListener('click', (e) => e.stopPropagation());
  root.querySelector('[data-act="all"]').addEventListener('click', () => {
    options.forEach(o => selected.add(o.value)); renderList(); updateBtn(); onChangeCb();
  });
  root.querySelector('[data-act="none"]').addEventListener('click', () => {
    selected.clear(); renderList(); updateBtn(); onChangeCb();
  });

  return {
    setOptions(opts){ options = opts; selected = new Set([...selected].filter(v => opts.some(o=>o.value===v))); renderList(); updateBtn(); },
    getSelected(){ return selected; },
    clear(){ selected.clear(); renderList(); updateBtn(); },
    onChange(cb){ onChangeCb = cb; }
  };
}
document.addEventListener('click', () => {
  document.querySelectorAll('.ms-panel.open').forEach(p => p.classList.remove('open'));
});

function setupFilters(records){
  const anos = [...new Set(records.map(r=>r.competenciaKey).filter(Boolean).map(k=>k.split('-')[0]))].sort().reverse();
  const setores = [...new Set(records.map(r=>r.setorOrigem).filter(Boolean))].sort();
  const statusPresentes = [...new Set(records.map(r=>r.statusLib).filter(Boolean))];
  const statusLabels = { LIB:'Sem remanejamento (LIB)', REM:'Com remanejamento (REM)' };

  if (!msAno){
    msAno = createMultiSelect('msAno', 'Todos os anos');
    msSetor = createMultiSelect('msSetor', 'Todas as gerências');
    msStatus = createMultiSelect('msStatus', 'Todos os status');
    msAno.onChange(applyFilters);
    msSetor.onChange(applyFilters);
    msStatus.onChange(applyFilters);
    document.getElementById('btnClearFilters').addEventListener('click', () => {
      msAno.clear(); msSetor.clear(); msStatus.clear(); applyFilters();
    });
  }
  msAno.setOptions(anos.map(a => ({value:a, label:a})));
  msSetor.setOptions(setores.map(s => ({value:s, label:s})));
  msStatus.setOptions(statusPresentes.map(s => ({value:s, label: statusLabels[s] || s})));
}

function applyFilters(){
  const anos = msAno.getSelected();
  const setores = msSetor.getSelected();
  const status = msStatus.getSelected();

  const filtered = allRecords.filter(r => {
    if (anos.size && !(r.competenciaKey && anos.has(r.competenciaKey.split('-')[0]))) return false;
    if (setores.size && !setores.has(r.setorOrigem)) return false;
    if (status.size && !status.has(r.statusLib)) return false;
    return true;
  });

  const totalAtivos = anos.size + setores.size + status.size;
  document.getElementById('filterCount').textContent =
    totalAtivos ? filtered.length.toLocaleString('pt-BR') + ' de ' + allRecords.length.toLocaleString('pt-BR') + ' processos com os filtros aplicados' : '';

  renderAll(filtered);
}

/* ---------- Render principal ---------- */
function renderAll(records){
  if (records.length === 0){
    renderEmptyDashboard();
    return;
  }
  const pendentes = records.filter(r => !r.pago);
  const pagos = records.filter(r => r.pago);

  renderTopCards(records, pendentes, pagos);
  renderPerfCards(records, pendentes, pagos);
  renderRiskCards(records, pendentes);

  renderEvolChart(records);
  renderAgingChart(pendentes);
  renderSetorChart(pendentes);
  renderEmpresasChart(pendentes);
  renderCompetenciaChart(records);

  lastCritList = pendentes;
  renderCriticalTable();

  document.getElementById('footerMeta').textContent =
    'Painel calculado a partir das abas ' + SHEET_NAME + ' e ' + SHEET_NAME_PG + ' · ' + records.length + ' processos no recorte atual (de ' + allRecords.length + ' no total) · cálculo executado localmente no navegador';
}

function renderEmptyDashboard(){
  const topLabels = ['Processos em carteira', 'Processos pendentes', 'Valor pendente', '% de processos pagos'];
  const perfLabels = ['Tempo médio de pagamento', 'Tempo mediano de pagamento', 'Tempo médio até o Financeiro', 'Tempo médio no Financeiro'];
  const riskLabels = ['Processos &gt;180 dias', 'Valor &gt;180 dias', '% com retrabalho', '% com remanejamento'];

  document.getElementById('kpiTop').innerHTML = topLabels.map(l => kpiCardEmpty(l)).join('');
  document.getElementById('kpiPerf').innerHTML = perfLabels.map(l => kpiCardEmpty(l)).join('');
  document.getElementById('kpiRisk').innerHTML = riskLabels.map(l => kpiCardEmpty(l, 'risk')).join('');

  hideCanvas('chartEvol','evol');
  hideCanvas('chartAging','aging');
  hideCanvas('chartSetor','setor');
  hideCanvas('chartEmpresas','empresas');
  hideCanvas('chartCompetencia','competencia');
  document.getElementById('compTotals').innerHTML = '';

  lastCritList = [];
  document.getElementById('critBody').innerHTML = '';
  document.getElementById('critFoot').textContent = 'Nenhum processo corresponde aos filtros selecionados — ajuste ou limpe os filtros acima.';
  document.getElementById('critSearchCount').textContent = '';

  document.getElementById('footerMeta').textContent =
    'Painel calculado a partir das abas ' + SHEET_NAME + ' e ' + SHEET_NAME_PG + ' · 0 processos no recorte atual (de ' + allRecords.length + ' no total) · cálculo executado localmente no navegador';
}

function kpiCard(label, value, sub, riskClass){
  return '<div class="kpi ' + (riskClass||'') + '">' +
    '<p class="label">' + label + '</p>' +
    '<p class="value">' + value + '</p>' +
    (sub ? '<p class="sub">' + sub + '</p>' : '') +
  '</div>';
}

function kpiCardEmpty(label, riskClass){
  return '<div class="kpi ' + (riskClass||'') + '">' +
    '<p class="label">' + label + '</p>' +
    '<p class="value empty">Sem dados</p>' +
    '<p class="sub">Nenhum processo com os filtros aplicados</p>' +
  '</div>';
}

function renderTopCards(records, pendentes, pagos){
  const valorPendente = sum(pendentes, r=>r.valor);
  const pctPagos = records.length ? (pagos.length/records.length*100) : 0;
  const bloqueadosPG = pendentes.filter(r=>r.fonte==='PG').length;
  const html = [
    kpiCard('Processos em carteira', records.length.toLocaleString('pt-BR'), 'Carteira ativa (ProcessosDESSMA) + histórico (PG)'),
    kpiCard('Processos pendentes', pendentes.length.toLocaleString('pt-BR'),
      bloqueadosPG ? (pendentes.length - bloqueadosPG) + ' na carteira ativa + ' + bloqueadosPG + ' parados/bloqueados na PG' : ''),
    kpiCard('Valor pendente', fmtBRLcompact(valorPendente), fmtBRL(valorPendente)),
    kpiCard('% de processos pagos', fmtPct(pctPagos), pagos.length + ' de ' + records.length + ' processos')
  ].join('');
  document.getElementById('kpiTop').innerHTML = html;
}

function renderPerfCards(records, pendentes, pagos){
  const temposPagamento = pagos.map(r=>r.diasParaPagamento).filter(v=>v!=null);
  const comFinanceiro = records.filter(r=>r.diasAteFinanceiro!=null);
  const noFinanceiro = records.filter(r=>r.diasNoFinanceiro!=null);

  const html = [
    kpiCard('Tempo médio de pagamento', temposPagamento.length ? fmtDias(avg(temposPagamento)) : '—',
      temposPagamento.length ? 'Da abertura até a data de pagamento' : 'Ainda sem processos marcados como pagos'),
    kpiCard('Tempo mediano de pagamento', temposPagamento.length ? fmtDias(median(temposPagamento)) : '—',
      temposPagamento.length ? 'Menos sensível a casos extremos' : 'Ainda sem processos marcados como pagos'),
    kpiCard('Tempo médio até o Financeiro', comFinanceiro.length ? fmtDias(avg(comFinanceiro.map(r=>r.diasAteFinanceiro))) : '—',
      'Base: ' + comFinanceiro.length + ' processos que já chegaram na GFIN'),
    kpiCard('Tempo médio no Financeiro', noFinanceiro.length ? fmtDias(avg(noFinanceiro.map(r=>r.diasNoFinanceiro))) : '—',
      'Contando até hoje para quem ainda não foi pago')
  ].join('');
  document.getElementById('kpiPerf').innerHTML = html;
}

function renderRiskCards(records, pendentes){
  const gt180 = pendentes.filter(r=>r.diasAbertura>180);
  const valorGt180 = sum(gt180, r=>r.valor);
  const pctRetrabalho = records.length ? (records.filter(r=>r.retrabalho).length/records.length*100) : 0;
  const pctRemanej = records.length ? (records.filter(r=>r.remanejado).length/records.length*100) : 0;

  const html = [
    kpiCard('Processos &gt;180 dias', gt180.length.toLocaleString('pt-BR'), 'Do total de ' + pendentes.length + ' pendentes', 'risk'),
    kpiCard('Valor &gt;180 dias', fmtBRLcompact(valorGt180), fmtBRL(valorGt180), 'risk'),
    kpiCard('% com retrabalho', fmtPct(pctRetrabalho), 'Processos que voltaram mais de uma vez', 'risk'),
    kpiCard('% com remanejamento', fmtPct(pctRemanej), 'Processos que precisaram de remanejamento orçamentário', 'risk')
  ].join('');
  document.getElementById('kpiRisk').innerHTML = html;
}

/* ---------- Gráficos ---------- */
function destroyChart(key){ if (charts[key]) { charts[key].destroy(); delete charts[key]; } }
function showCanvas(canvasId){
  document.getElementById(canvasId).classList.remove('hide');
  document.getElementById(canvasId + 'Empty').classList.remove('show');
}
function hideCanvas(canvasId, key){
  destroyChart(key);
  document.getElementById(canvasId).classList.add('hide');
  document.getElementById(canvasId + 'Empty').classList.add('show');
}

function baseGridOptions(extra){
  return Object.assign({
    responsive:true, maintainAspectRatio:false,
    plugins:{ legend:{ position:'bottom', labels:{ boxWidth:10, font:{size:11}, color: PALETTE.text } } },
    scales:{
      x:{ grid:{ display:false }, ticks:{ color: PALETTE.text, font:{size:10.5} } },
      y:{ grid:{ color: PALETTE.grid }, ticks:{ color: PALETTE.text, font:{size:10.5} } }
    }
  }, extra||{});
}

function renderEvolChart(records){
  destroyChart('evol');
  if (records.length === 0){ hideCanvas('chartEvol','evol'); return; }
  showCanvas('chartEvol');
  const byMonth = {};
  records.forEach(r=>{
    const k = r.data.getFullYear() + '-' + String(r.data.getMonth()+1).padStart(2,'0');
    byMonth[k] = byMonth[k] || {recebidos:0, pagos:0};
    byMonth[k].recebidos++;
  });
  records.filter(r=>r.pago).forEach(r=>{
    const k = r.paymentDate.getFullYear() + '-' + String(r.paymentDate.getMonth()+1).padStart(2,'0');
    byMonth[k] = byMonth[k] || {recebidos:0, pagos:0};
    byMonth[k].pagos++;
  });
  let months = Object.keys(byMonth).sort();
  if (months.length > 15) months = months.slice(months.length - 15);
  const labels = months.map(m=>monthLabel(m));

  const ctx = document.getElementById('chartEvol').getContext('2d');
  charts.evol = new Chart(ctx, {
    type:'bar',
    data:{ labels,
      datasets:[
        { label:'Recebidos', data: months.map(m=>byMonth[m].recebidos), backgroundColor: PALETTE.tealSoft, borderColor: PALETTE.teal, borderWidth:1.5, borderRadius:4 },
        { label:'Pagos', type:'line', data: months.map(m=>byMonth[m].pagos), borderColor: PALETTE.petroleo, backgroundColor: PALETTE.petroleo, tension:.3, pointRadius:3 }
      ]
    },
    options: baseGridOptions()
  });
}

function renderAgingChart(pendentes){
  destroyChart('aging');
  if (pendentes.length === 0){ hideCanvas('chartAging','aging'); return; }
  showCanvas('chartAging');
  const buckets = [
    {label:'0–30', lo:0, hi:30}, {label:'31–60', lo:31, hi:60}, {label:'61–90', lo:61, hi:90},
    {label:'91–180', lo:91, hi:180}, {label:'181–365', lo:181, hi:365}, {label:'>365', lo:366, hi:Infinity}
  ];
  const qtd = [], val = [];
  buckets.forEach(b=>{
    const inb = pendentes.filter(r=>r.diasAbertura>=b.lo && r.diasAbertura<=b.hi);
    qtd.push(inb.length);
    val.push(sum(inb, r=>r.valor));
  });

  const ctx = document.getElementById('chartAging').getContext('2d');
  charts.aging = new Chart(ctx, {
    type:'bar',
    data:{ labels: buckets.map(b=>b.label),
      datasets:[
        { label:'Quantidade', data: qtd, backgroundColor: PALETTE.tealSoft, borderColor: PALETTE.teal, borderWidth:1.5, borderRadius:4, yAxisID:'y' },
        { label:'Valor (R$)', data: val, backgroundColor: PALETTE.amberSoft, borderColor: PALETTE.amber, borderWidth:1.5, borderRadius:4, yAxisID:'y1' }
      ]
    },
    options: baseGridOptions({
      scales:{
        x:{ grid:{display:false}, ticks:{color:PALETTE.text, font:{size:10.5}} },
        y:{ position:'left', grid:{color:PALETTE.grid}, ticks:{color:PALETTE.text, font:{size:10.5}}, title:{display:true, text:'Processos', color:PALETTE.text, font:{size:10.5}} },
        y1:{ position:'right', grid:{display:false}, ticks:{color:PALETTE.text, font:{size:10.5}, callback:(v)=>fmtBRLcompact(v)}, title:{display:true, text:'Valor', color:PALETTE.text, font:{size:10.5}} }
      }
    })
  });
}

function renderSetorChart(pendentes){
  destroyChart('setor');
  if (pendentes.length === 0){ hideCanvas('chartSetor','setor'); return; }
  showCanvas('chartSetor');
  const bySetor = {};
  pendentes.forEach(r=>{ bySetor[r.setorAtual] = (bySetor[r.setorAtual]||0) + r.valor; });
  const entries = Object.entries(bySetor).sort((a,b)=>b[1]-a[1]);

  const ctx = document.getElementById('chartSetor').getContext('2d');
  charts.setor = new Chart(ctx, {
    type:'bar',
    data:{ labels: entries.map(e=>e[0]),
      datasets:[{ data: entries.map(e=>e[1]), backgroundColor: PALETTE.petroleo2, borderRadius:4, barThickness:16 }]
    },
    options: baseGridOptions({
      indexAxis:'y',
      plugins:{ legend:{ display:false } },
      scales:{
        x:{ grid:{color:PALETTE.grid}, ticks:{ color: PALETTE.text, font:{size:10.5}, callback:(v)=>fmtBRLcompact(v) } },
        y:{ grid:{display:false}, ticks:{ color: PALETTE.text, font:{size:11} } }
      }
    })
  });
}

function renderEmpresasChart(pendentes){
  destroyChart('empresas');
  if (pendentes.length === 0){ hideCanvas('chartEmpresas','empresas'); return; }
  showCanvas('chartEmpresas');
  const byEmp = {};
  pendentes.forEach(r=>{ byEmp[r.empresa] = (byEmp[r.empresa]||0) + r.valor; });
  const top10 = Object.entries(byEmp).sort((a,b)=>b[1]-a[1]).slice(0,10).reverse();

  const ctx = document.getElementById('chartEmpresas').getContext('2d');
  charts.empresas = new Chart(ctx, {
    type:'bar',
    data:{ labels: top10.map(e=>e[0]),
      datasets:[{ data: top10.map(e=>e[1]), backgroundColor: PALETTE.teal, borderRadius:4, barThickness:14 }]
    },
    options: baseGridOptions({
      indexAxis:'y',
      plugins:{ legend:{ display:false } },
      scales:{
        x:{ grid:{color:PALETTE.grid}, ticks:{ color: PALETTE.text, font:{size:10.5}, callback:(v)=>fmtBRLcompact(v) } },
        y:{ grid:{display:false}, ticks:{ color: PALETTE.text, font:{size:11} } }
      }
    })
  });
}

function renderCompetenciaChart(records){
  destroyChart('competencia');
  if (records.length === 0){ hideCanvas('chartCompetencia','competencia'); document.getElementById('compTotals').innerHTML=''; return; }
  showCanvas('chartCompetencia');
  const byComp = {};
  let semCompetencia = 0;
  records.forEach(r=>{
    if (!r.competenciaKey){ semCompetencia++; return; }
    byComp[r.competenciaKey] = byComp[r.competenciaKey] || {faturado:0, pago:0};
    byComp[r.competenciaKey].faturado += r.valor;
    if (r.pago) byComp[r.competenciaKey].pago += r.valor;
  });
  let keys = Object.keys(byComp).sort();
  if (keys.length === 0){ hideCanvas('chartCompetencia','competencia'); document.getElementById('compTotals').innerHTML=''; return; }
  if (keys.length > 18) keys = keys.slice(keys.length - 18);
  const labels = keys.map(k=>monthLabel(k));
  const faturadoData = keys.map(k=>byComp[k].faturado);
  const pagoData = keys.map(k=>byComp[k].pago);

  const ctx = document.getElementById('chartCompetencia').getContext('2d');
  charts.competencia = new Chart(ctx, {
    type:'bar',
    data:{ labels,
      datasets:[
        { label:'Faturado', data: faturadoData, backgroundColor: PALETTE.tealSoft, borderColor: PALETTE.teal, borderWidth:1.5, borderRadius:4 },
        { label:'Pago', data: pagoData, backgroundColor: PALETTE.petroleo2, borderColor: PALETTE.petroleo, borderWidth:1.5, borderRadius:4 }
      ]
    },
    options: baseGridOptions({
      scales:{
        x:{ grid:{ display:false }, ticks:{ color: PALETTE.text, font:{size:10.5} } },
        y:{ grid:{ color: PALETTE.grid }, ticks:{ color: PALETTE.text, font:{size:10.5}, callback:(v)=>fmtBRLcompact(v) } }
      },
      plugins:{
        legend:{ position:'bottom', labels:{ boxWidth:10, font:{size:11}, color: PALETTE.text } },
        tooltip:{ callbacks:{ label:(c)=> c.dataset.label + ': ' + fmtBRL(c.raw) } }
      }
    })
  });

  const totalFaturado = sum(records, r=>r.valor);
  const totalPago = sum(records.filter(r=>r.pago), r=>r.valor);
  const pct = totalFaturado ? (totalPago/totalFaturado*100) : 0;
  const notaSemComp = semCompetencia ? (' · ' + semCompetencia + ' processo(s) sem competência identificável, não incluídos') : '';
  document.getElementById('compTotals').innerHTML =
    '<div class="item">Total faturado<strong>' + fmtBRLcompact(totalFaturado) + '</strong></div>' +
    '<div class="item">Total pago<strong>' + fmtBRLcompact(totalPago) + '</strong></div>' +
    '<div class="item">% faturado já pago<strong>' + fmtPct(pct) + '</strong></div>' +
    '<div class="item" style="align-self:flex-end;">' + labels.length + ' competências exibidas' + notaSemComp + '</div>';
}

/* ---------- Tabela de críticos ---------- */
let critSearchTerm = '';
function severityBadge(dias){
  if (dias > 365) return '<span class="badge b-red">' + fmtDias(dias) + '</span>';
  if (dias > 180) return '<span class="badge b-amber">' + fmtDias(dias) + '</span>';
  return '<span class="badge b-gray">' + fmtDias(dias) + '</span>';
}

function renderCriticalTable(){
  let base = lastCritList;
  if (critSearchTerm){
    const term = critSearchTerm.toLowerCase();
    base = base.filter(r =>
      String(r.empresa).toLowerCase().includes(term) ||
      String(r.contrato).toLowerCase().includes(term) ||
      String(r.processo).toLowerCase().includes(term)
    );
  }
  const sorted = [...base].sort((a,b)=>
    currentSort === 'dias' ? b.diasAbertura - a.diasAbertura : b.valor - a.valor
  );
  const limit = critSearchTerm ? 100 : 40;
  const top = sorted.slice(0, limit);
  document.getElementById('critBody').innerHTML = top.map(r => (
    '<tr>' +
      '<td>' + String(r.processo) + '</td>' +
      '<td>' + r.empresa + '</td>' +
      '<td>' + r.contrato + '</td>' +
      '<td>' + fmtBRL(r.valor) + '</td>' +
      '<td>' + severityBadge(r.diasAbertura) + '</td>' +
      '<td>' + r.setorAtual + '</td>' +
    '</tr>'
  )).join('');
  document.getElementById('critFoot').textContent = top.length === 0
    ? 'Nenhum processo pendente corresponde à busca.'
    : 'Exibindo ' + top.length + ' de ' + base.length + (critSearchTerm ? ' processos encontrados' : ' processos mais críticos') +
      (critSearchTerm ? '' : ' (de ' + lastCritList.length + ' pendentes)') + ' · vermelho > 365 dias · amarelo 181–365 dias';
  document.getElementById('critSearchCount').textContent = critSearchTerm ? base.length + ' encontrados' : '';
}

document.getElementById('critSearch').addEventListener('input', (e) => {
  critSearchTerm = e.target.value.trim();
  renderCriticalTable();
});

document.getElementById('sortDias').addEventListener('click', () => {
  currentSort = 'dias';
  document.getElementById('sortDias').classList.add('active');
  document.getElementById('sortValor').classList.remove('active');
  renderCriticalTable();
});
document.getElementById('sortValor').addEventListener('click', () => {
  currentSort = 'valor';
  document.getElementById('sortValor').classList.add('active');
  document.getElementById('sortDias').classList.remove('active');
  renderCriticalTable();
});

/* ---------- Inicialização automática na abertura da página ---------- */
function initApp(){
  if (GOOGLE_SHEETS_URL){
    carregarGoogleSheets();
  } else {
    const statusEl = document.getElementById('fileStatus');
    if (statusEl){
      statusEl.textContent = 'Carregue a planilha .xlsx manualmente.';
    }
  }
}

if (document.readyState === 'loading'){
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}