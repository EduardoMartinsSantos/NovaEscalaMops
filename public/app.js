'use strict';

// ---------- utilitários ----------

const $ = (s, el = document) => el.querySelector(s);
const main = $('#main');
const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function api(method, url, body) {
  const r = await fetch('/api' + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (r.status === 401 && url !== '/login') {
    telaLogin();
    throw new Error(d.erro || 'Sessão expirada.');
  }
  if (!r.ok) throw new Error(d.erro || 'Falha na requisição.');
  return d;
}

function toast(msg, erro = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (erro ? ' err' : '');
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), erro ? 5000 : 2800);
}

const pad = (n) => String(n).padStart(2, '0');
function mesAtual() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}
function hojeStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function somarMes(mes, delta) {
  const [a, m] = mes.split('-').map(Number);
  const d = new Date(a, m - 1 + delta, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}
function rotuloMes(mes) {
  const [a, m] = mes.split('-').map(Number);
  return new Date(a, m - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
}
const LETRAS_SEMANA = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];
const diaSemana = (data) => new Date(data + 'T12:00:00').getDay();

function duracao(inicio, fim) {
  const min = (s) => s.split(':').reduce((h, m) => h * 60 + Number(m));
  const d = (min(fim) - min(inicio) + 1440) % 1440 || 1440;
  return `${Math.floor(d / 60)}h${d % 60 ? pad(d % 60) : ''}`;
}

const PADROES = {
  '5x2': '5x2 (seg a sex)',
  '6x1': '6x1 (folga domingo)',
  '12x36': '12x36 (dia sim, dia não)',
  livre: 'Livre (manual)',
};
const ORDEM_PADRAO = Object.keys(PADROES);
const AUSENCIAS = {
  FOLGA: { sigla: 'F', nome: 'Folga', cls: 'folga' },
  FERIAS: { sigla: 'FE', nome: 'Férias', cls: 'ferias' },
  ATESTADO: { sigla: 'AT', nome: 'Atestado', cls: 'atestado' },
};

// ---------- estado ----------

function lerPreferencia(chave, padrao) {
  try {
    return localStorage.getItem(chave) || padrao;
  } catch {
    return padrao;
  }
}
function salvarPreferencia(chave, v) {
  try {
    localStorage.setItem(chave, v);
  } catch {}
}

const state = {
  usuario: null, // colaborador logado ({ id, nome, email, senhaPadrao })
  torres: [],
  turnos: [],
  mesas: [],
  colaboradores: [],
  mes: mesAtual(),
  filtro: { torre: '', turno: '', busca: '' },
  agrupar: lerPreferencia('agrupar', 'torre'), // 'torre' | 'turno'
  exibicao: lerPreferencia('exibicao', 'compacta'), // 'compacta' | 'planilha'
  // Série do pincel Sobreaviso (configurável, guardada no navegador). 1 dia = lançamento pontual.
  serieSA: lerPreferencia('serieSA', lerPreferencia('horasSA', '8')),
  filtroColab: { torre: '', turno: '', mesa: '', sa: '', busca: '' },
  selecionados: new Set(), // ids marcados na lista de colaboradores
  editando: false, // tabela de colaboradores em modo edição
  rascunho: new Map(), // id → campos alterados ainda não salvos
  ultimoSelecionado: null,
  ordemColab: { campo: '', dir: 1 }, // ordenação da tabela de colaboradores ('' = por nome)
  escala: null,
  pincel: null, // valor aplicado direto ao clicar/arrastar nas células
};

const porId = (lista, id) => lista.find((x) => x.id === id);

async function carregarBase() {
  [state.torres, state.turnos, state.mesas, state.colaboradores] = await Promise.all([
    api('GET', '/torres'),
    api('GET', '/turnos'),
    api('GET', '/mesas'),
    api('GET', '/colaboradores'),
  ]);
}

// ---------- tags ----------

function tagTorre(t, extra = '') {
  if (!t) return '';
  return `<span class="tag ${t.ativo ? '' : 'off'} ${extra}" style="--c:${esc(t.cor)}" title="${esc(t.nome)}">${esc(t.codigo)}</span>`;
}
function tagTurno(t) {
  if (!t) return '';
  return `<span class="tag ${t.ativo ? '' : 'off'}" style="--c:${esc(t.cor)}" title="${esc(t.nome)} · ${t.inicio} às ${t.fim}">${esc(t.codigo)}</span>`;
}
const tagSobreaviso = (t) => (t ? tagTorre(t, 'sa') : '');
const tagMesa = (m) => (m ? tagTorre(m, 'mesa') : '');

function tagsColaborador(c) {
  return `<div class="tags">${tagTorre(porId(state.torres, c.torre_id))}${tagTurno(porId(state.turnos, c.turno_id))}${tagMesa(
    porId(state.mesas, c.mesa_id)
  )}${tagSobreaviso(porId(state.torres, c.sobreaviso_torre_id))}</div>`;
}

// Opções de select: itens ativos + o valor atual mesmo que esteja inativo.
function opcoes(lista, atual, rotulo, vazio) {
  const itens = lista.filter((x) => x.ativo || x.id === atual);
  return (
    (vazio !== undefined ? `<option value="">${esc(vazio)}</option>` : '') +
    itens.map((x) => `<option value="${x.id}" ${x.id === atual ? 'selected' : ''}>${esc(rotulo(x))}</option>`).join('')
  );
}

// ---------- dialog ----------

const dialog = $('#dialog');
const dialogForm = $('#dialog-form');

function abrirDialog({ titulo, corpo, confirmar = 'Salvar', onSubmit, aoAbrir }) {
  dialogForm.innerHTML = `
    <header><h2>${esc(titulo)}</h2></header>
    <div class="body">${corpo}<p class="form-error"></p></div>
    <footer>
      <button type="button" data-cancel>Cancelar</button>
      <button type="submit" class="primary">${esc(confirmar)}</button>
    </footer>`;
  dialogForm.onsubmit = async (e) => {
    e.preventDefault();
    const btn = dialogForm.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      await onSubmit(dialogForm);
      dialog.close();
    } catch (err) {
      $('.form-error', dialogForm).textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  };
  $('[data-cancel]', dialogForm).onclick = () => dialog.close();
  dialog.showModal();
  aoAbrir?.(dialogForm);
  dialogForm.querySelector('input:not([type=checkbox]):not([type=color]), select')?.focus();
}

const valor = (form, nome) => form.elements[nome]?.value ?? '';
const marcado = (form, nome) => !!form.elements[nome]?.checked;

// ---------- popover ----------

const popover = $('#popover');
let popoverHandler = null;

function abrirPopover(ancora, html, onEscolha) {
  popover.innerHTML = html;
  popover.hidden = false;
  popoverHandler = onEscolha;
  const r = ancora.getBoundingClientRect();
  const p = popover.getBoundingClientRect();
  let top = r.bottom + 4;
  if (top + p.height > innerHeight - 8) top = Math.max(8, r.top - p.height - 4);
  const left = Math.min(Math.max(8, r.left), innerWidth - p.width - 8);
  popover.style.top = top + 'px';
  popover.style.left = left + 'px';
}
function fecharPopover() {
  popover.hidden = true;
  popoverHandler = null;
}
popover.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-v]');
  if (!b || !popoverHandler) return;
  const fn = popoverHandler;
  fecharPopover();
  fn(b.dataset.v);
});
document.addEventListener('mousedown', (e) => {
  if (!popover.hidden && !popover.contains(e.target) && !e.target.closest('td.cell, td.sa-cell')) fecharPopover();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  fecharPopover();
  if (state.pincel !== null) {
    state.pincel = null;
    limparPrevia();
    renderLegenda();
  }
});
addEventListener('resize', fecharPopover);

// ---------- roteamento ----------

const VIEWS = { escala: viewEscala, colaboradores: viewColaboradores, torres: viewTorres, turnos: viewTurnos, mesas: viewMesas };

function rota() {
  if (!state.usuario) return telaLogin();
  if (state.editando && location.hash !== '#colaboradores') {
    if (state.rascunho.size && !confirm('Descartar as alterações não salvas dos colaboradores?')) {
      history.replaceState(null, '', '#colaboradores');
      return;
    }
    state.editando = false;
    state.rascunho.clear();
  }
  const nome = location.hash.slice(1);
  const view = VIEWS[nome] ? nome : 'escala';
  document.querySelectorAll('nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
  fecharPopover();
  state.pincel = null;
  VIEWS[view]();
}
addEventListener('hashchange', rota);
addEventListener('beforeunload', (e) => {
  if (state.rascunho.size) e.preventDefault();
});

// =====================================================================
// ESCALA
// =====================================================================

function viewEscala() {
  const f = state.filtro;
  main.innerHTML = `
    <div class="page-head">
      <div><h1>Escala</h1><p>Clique numa célula para definir o turno, ou escolha um pincel na legenda e arraste.</p></div>
      <div class="month-nav">
        <button class="icon" id="mes-ant" title="Mês anterior">‹</button>
        <strong id="mes-label">${esc(rotuloMes(state.mes))}</strong>
        <button class="icon" id="mes-prox" title="Próximo mês">›</button>
        <button id="mes-hoje">Hoje</button>
      </div>
    </div>
    <div class="toolbar">
      <select id="f-torre"><option value="">Todas as torres</option>${state.torres
        .map((t) => `<option value="${t.id}" ${String(t.id) === f.torre ? 'selected' : ''}>${esc(t.codigo)}</option>`)
        .join('')}</select>
      <select id="f-turno"><option value="">Todos os turnos</option>${state.turnos
        .map((t) => `<option value="${t.id}" ${String(t.id) === f.turno ? 'selected' : ''}>${esc(t.codigo)}</option>`)
        .join('')}</select>
      <input id="f-busca" type="search" placeholder="Buscar colaborador…" value="${esc(f.busca)}">
      <div class="segmented" id="agrupar" role="group" aria-label="Agrupar por">
        <span>Agrupar por</span>
        <button data-g="torre" class="${state.agrupar === 'torre' ? 'active' : ''}">Torre</button>
        <button data-g="turno" class="${state.agrupar === 'turno' ? 'active' : ''}">Turno</button>
      </div>
      <div class="segmented" id="exibicao" role="group" aria-label="Exibição">
        <span>Exibição</span>
        <button data-x="compacta" class="${state.exibicao === 'compacta' ? 'active' : ''}">Compacta</button>
        <button data-x="planilha" class="${state.exibicao === 'planilha' ? 'active' : ''}">Planilha</button>
      </div>
      <span class="spacer"></span>
      <button id="btn-excel" class="primary">Exportar Excel</button>
      <a class="btn" id="btn-exportar" title="Exportar em CSV (texto simples)">CSV</a>
    </div>
    <div class="legend" id="legenda"></div>
    <div class="card grid-wrap" id="grid"><div class="empty">Carregando…</div></div>`;

  $('#mes-ant').onclick = () => trocarMes(somarMes(state.mes, -1));
  $('#mes-prox').onclick = () => trocarMes(somarMes(state.mes, 1));
  $('#mes-hoje').onclick = () => trocarMes(mesAtual());
  $('#f-torre').onchange = (e) => ((f.torre = e.target.value), renderGrade());
  $('#f-turno').onchange = (e) => ((f.turno = e.target.value), renderGrade());
  $('#f-busca').oninput = (e) => ((f.busca = e.target.value), renderGrade());
  $('#agrupar').onclick = (e) => {
    const b = e.target.closest('button[data-g]');
    if (!b || b.dataset.g === state.agrupar) return;
    state.agrupar = b.dataset.g;
    salvarPreferencia('agrupar', state.agrupar);
    $('#agrupar').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    renderGrade();
  };
  $('#exibicao').onclick = (e) => {
    const b = e.target.closest('button[data-x]');
    if (!b || b.dataset.x === state.exibicao) return;
    state.exibicao = b.dataset.x;
    salvarPreferencia('exibicao', state.exibicao);
    $('#exibicao').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    renderGrade();
  };

  renderLegenda();
  ligarEventosGrade();
  carregarEscala();
}

async function trocarMes(mes) {
  state.mes = mes;
  $('#mes-label').textContent = rotuloMes(mes);
  await carregarEscala();
}

async function carregarEscala() {
  $('#btn-exportar').href = `/api/escala/exportar?mes=${state.mes}`;
  $('#btn-excel').onclick = exportarExcel;
  try {
    state.escala = await api('GET', `/escala?mes=${state.mes}`);
    renderGrade();
  } catch (e) {
    toast(e.message, true);
  }
}

function colaboradoresVisiveis() {
  const f = state.filtro;
  const busca = f.busca.trim().toLowerCase();
  return state.colaboradores.filter(
    (c) =>
      c.ativo &&
      (!f.torre || String(c.torre_id) === f.torre) &&
      (!f.turno || String(c.turno_id) === f.turno) &&
      (!busca || c.nome.toLowerCase().includes(busca))
  );
}

function chipCelula(cel) {
  if (!cel) return '';
  if (cel.tipo === 'TURNO') {
    const t = porId(state.turnos, cel.turno_id);
    return t ? `<span class="chip" style="--c:${esc(t.cor)}">${esc(t.codigo)}</span>` : '';
  }
  const a = AUSENCIAS[cel.tipo];
  return `<span class="chip ${a.cls}">${a.sigla}</span>`;
}

// ----- Exportar Excel: mesma visualização da exibição Planilha (grupos, filtros, cores e sobreaviso) -----

// Mistura a cor com branco: pct = quanto da cor original fica (0 a 1).
function misturarComBranco(hex, pct) {
  const n = parseInt(hex.replace('#', ''), 16);
  const canal = (v) => Math.round(v * pct + 255 * (1 - pct)).toString(16).padStart(2, '0');
  return `#${canal((n >> 16) & 255)}${canal((n >> 8) & 255)}${canal(n & 255)}`;
}

// Mesmas cores da exibição Planilha (tema claro).
const XL = {
  cabecalho: { bold: true, color: '#FFFFFF', bg: '#1F3B64', wrap: true },
  grupo: { bold: true, color: '#FFFFFF', bg: '#A3A3A3' },
  trabalho: { bg: '#C6EFCE', color: '#0B5A1C' },
  folga: { bg: '#E6A5A5' },
  ferias: { bg: '#BDD7EE', color: '#1F3B64', bold: true },
  atestado: { bg: '#FFE699', color: '#7A5B00', bold: true },
  fimDeSemana: { bg: '#F3F4F8' },
  semSobreaviso: { bg: '#F4C7C7' },
  ausente: { bg: '#E5E7EB' },
  total: { bold: true, color: '#2563EB' },
};

function exportarExcel() {
  if (!state.escala) return;
  const { dias, celulas } = state.escala;
  const cel = new Map(celulas.map((c) => [`${c.colaborador_id}|${c.data}`, c]));
  const colabs = colaboradoresVisiveis();
  const fimDeSemana = (d) => [0, 6].includes(diaSemana(d));
  const INFO = 5; // Nome, Torre, Turno, Mesa, Escala
  const largura = INFO + dias.length;
  const linhas = [];
  const mesclar = [];

  const vazioDoDia = (d) => ({ v: '', e: fimDeSemana(d) ? XL.fimDeSemana : {} });
  // Linha de grupo: título mesclado na largura toda (ou só no bloco de informações, se vier `diasCel`).
  const linhaGrupo = (titulo, diasCel) => {
    mesclar.push({ linha: linhas.length, de: 0, ate: diasCel ? INFO - 1 : largura - 1 });
    const bloco = Array.from({ length: INFO - 1 }, () => ({ v: '', e: XL.grupo }));
    const resto = diasCel || Array.from({ length: dias.length }, () => ({ v: '', e: XL.grupo }));
    linhas.push({ altura: 20, celulas: [{ v: titulo.toUpperCase(), e: { ...XL.grupo, align: 'left' } }, ...bloco, ...resto] });
  };
  const infoColaborador = (c, escala) => {
    const torre = porId(state.torres, c.torre_id);
    const turno = porId(state.turnos, c.turno_id);
    const mesa = porId(state.mesas, c.mesa_id);
    return [
      { v: c.nome.toUpperCase(), e: { bold: true, align: 'left' } },
      { v: torre?.codigo || '' },
      { v: turno?.codigo || '', e: turno ? { bold: true, color: turno.cor, bg: misturarComBranco(turno.cor, 0.16) } : {} },
      { v: mesa?.codigo || '', e: mesa ? { bold: true, color: mesa.cor, bg: misturarComBranco(mesa.cor, 0.16) } : {} },
      escala || { v: (turno?.padrao || '').toUpperCase() },
    ];
  };
  const celulaDia = (x, d) => {
    if (!x) return vazioDoDia(d);
    if (x.tipo === 'TURNO') {
      const t = porId(state.turnos, x.turno_id);
      return { v: t ? `${t.inicio} A ${t.fim}` : '', e: XL.trabalho };
    }
    if (x.tipo === 'FOLGA') return { v: '', e: XL.folga };
    return { v: AUSENCIAS[x.tipo].nome.toUpperCase(), e: x.tipo === 'FERIAS' ? XL.ferias : XL.atestado };
  };

  const cabecalho = (ultima) =>
    linhas.push({
      altura: 30,
      celulas: [
        ...['NOME', 'TORRE', 'TURNO', 'MESA', ultima].map((v, i) => ({ v, e: { ...XL.cabecalho, align: i ? 'center' : 'left' } })),
        ...dias.map((d) => ({ v: `${SEMANA_ABREV[diaSemana(d)]}\n${d.slice(8)}/${d.slice(5, 7)}`, e: XL.cabecalho })),
      ],
    });
  const tituloBloco = (texto) => {
    linhas.push({ altura: 12, celulas: [] });
    linhas.push({ altura: 22, celulas: [{ v: texto, e: { bold: true, size: 13, align: 'left' } }] });
  };
  // Grupos + linha "Em serviço" (contando só os colaboradores do bloco).
  const blocoEscala = (grupos, membros) => {
    for (const { titulo, grupo } of grupos) {
      linhaGrupo(`${titulo} (${grupo.length})`);
      for (const c of grupo) {
        linhas.push({ celulas: [...infoColaborador(c), ...dias.map((d) => celulaDia(cel.get(`${c.id}|${d}`), d))] });
      }
    }
    mesclar.push({ linha: linhas.length, de: 0, ate: INFO - 1 });
    linhas.push({
      celulas: [
        { v: 'EM SERVIÇO', e: { bold: true, align: 'left' } },
        ...Array.from({ length: INFO - 1 }, () => ({ v: '' })),
        ...dias.map((d) => ({
          v: membros.filter((c) => cel.get(`${c.id}|${d}`)?.tipo === 'TURNO').length,
          e: { bold: true, ...(fimDeSemana(d) ? XL.fimDeSemana : {}) },
        })),
      ],
    });
  };

  // Escala principal (mesmo agrupamento e filtros da tela) e, abaixo, o 12x36.
  const principais = colabs.filter((c) => !eh12x36(c));
  const revezamento = colabs.filter(eh12x36);
  cabecalho('ESCALA');
  blocoEscala(gruposDaGrade(principais), principais);
  if (revezamento.length) {
    tituloBloco('12X36');
    cabecalho('ESCALA');
    blocoEscala(grupos12x36(revezamento), revezamento);
  }

  // Sobreaviso: bloco próprio abaixo da escala, com título e cabeçalho (como na tela).
  const secoes = secoesSobreaviso();
  if (secoes.length) {
    tituloBloco('SOBREAVISO');
    cabecalho('HORAS');
  }
  const ausente = (id, d) => ['FERIAS', 'ATESTADO'].includes(cel.get(`${id}|${d}`)?.tipo);
  for (const { torre: t, porPessoa, cobertos, habilitados, descobertos, totalTorre, totalDe } of secoes) {
    const titulo =
      `Sobreaviso ${t.codigo} (${habilitados.length}${totalTorre ? ` · ${fmtHoras(totalTorre)}` : ''})` +
      (descobertos ? ` — ${descobertos} dia(s) sem ninguém` : '');
    linhaGrupo(titulo, dias.map((d) => ({ v: '', e: cobertos.has(d) ? XL.grupo : XL.semSobreaviso })));
    const corSA = { bold: true, size: 9, bg: misturarComBranco(t.cor, 0.3) };
    for (const c of habilitados) {
      linhas.push({
        celulas: [
          ...infoColaborador(c, { v: fmtHoras(totalDe(c.id)), e: XL.total }),
          ...dias.map((d) => {
            const s = porPessoa.get(`${c.id}|${d}`);
            if (s) return { v: s.horas != null ? fmtHoras(s.horas) : 'SOBREAVISO', e: corSA };
            return ausente(c.id, d) ? { v: '', e: XL.ausente } : vazioDoDia(d);
          }),
        ],
      });
    }
  }

  const blob = criarXlsx({
    aba: `Escala ${state.mes}`,
    colunas: [{ largura: 38 }, { largura: 8 }, { largura: 8 }, { largura: 10 }, { largura: 9 }, ...dias.map(() => ({ largura: 13 }))],
    linhas,
    mesclar,
    congelar: { linhas: 1, colunas: INFO },
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `escala-${state.mes}.xlsx`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  toast('Excel gerado.');
}

// ----- exibição "planilha": horário por extenso, trabalho em verde e folga em vermelho -----

const SEMANA_ABREV = ['DOM', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SÁB'];

function nomePlanilha(c, { escala } = {}) {
  const torre = porId(state.torres, c.torre_id);
  const turno = porId(state.turnos, c.turno_id);
  const mesa = porId(state.mesas, c.mesa_id);
  return `<div class="pl">
    <span class="n" title="${esc(c.nome)}">${esc(c.nome)}</span>
    <span>${esc(torre?.codigo || '')}</span>
    <span>${tagTurno(turno)}</span>
    <span>${tagMesa(mesa)}</span>
    <span>${escala ?? esc((turno?.padrao || '').toUpperCase())}</span>
  </div>`;
}

function classePlanilha(cel) {
  if (!cel) return '';
  return { TURNO: 'p-trab', FOLGA: 'p-folga', FERIAS: 'p-ferias', ATESTADO: 'p-atestado' }[cel.tipo];
}

function textoPlanilha(cel) {
  if (!cel) return '';
  if (cel.tipo === 'TURNO') {
    const t = porId(state.turnos, cel.turno_id);
    return t ? `${t.inicio} A ${t.fim}` : '';
  }
  return cel.tipo === 'FOLGA' ? '' : AUSENCIAS[cel.tipo].nome.toUpperCase();
}

function tituloCelula(cel) {
  if (!cel) return '';
  if (cel.tipo === 'TURNO') {
    const t = porId(state.turnos, cel.turno_id);
    return t ? `${t.codigo} · ${t.nome}` : '';
  }
  return AUSENCIAS[cel.tipo].nome;
}

function iniciais(nome) {
  const p = nome.trim().split(/\s+/);
  return ((p[0]?.[0] || '') + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
}

// Por torre: grupos na ordem das torres, colaboradores por turno.
// Por turno: um grupo por turno, exceto os 12x36, que ficam juntos num grupo por torre (12x36 N1, 12x36 N2…).
// Grupos na ordem do padrão (5x2, 6x1, 12x36…) e do horário; colaboradores pela torre (N1, N2…) e nome.
// Nos grupos 12x36, os colaboradores vêm primeiro pelo turno (TPA, TPB…).
const eh12x36 = (c) => porId(state.turnos, c.turno_id)?.padrao === '12x36';

// Tabela 12x36: um grupo por torre (12x36 N1, 12x36 N2…), na ordem das torres; dentro, por turno (TPA, TPB…) e nome.
function grupos12x36(colabs) {
  const porCodigo = (a, b) => a.codigo.localeCompare(b.codigo, 'pt-BR', { numeric: true });
  const codigoTurno = (c) => porId(state.turnos, c.turno_id)?.codigo || '';
  return state.torres
    .map((torre) => {
      const membros = colabs
        .filter((c) => c.torre_id === torre.id)
        .sort((a, b) => codigoTurno(a).localeCompare(codigoTurno(b), 'pt-BR', { numeric: true }) || a.nome.localeCompare(b.nome));
      const turnosDoGrupo = state.turnos.filter((t) => membros.some((c) => c.turno_id === t.id)).sort(porCodigo);
      return {
        titulo: `12X36 ${torre.codigo} — ${turnosDoGrupo.map((t) => t.codigo).join(' · ')}`,
        cabecalho: `<strong>12x36</strong> ${tagTorre(torre)} ${turnosDoGrupo.map(tagTurno).join(' ')}`,
        grupo: membros,
      };
    })
    .filter((g) => g.grupo.length);
}

function gruposDaGrade(colabs) {
  if (state.agrupar === 'turno') {
    const ordemTorre = new Map(state.torres.map((t, i) => [t.id, i]));
    const porTorre = (a, b) =>
      (ordemTorre.get(a.torre_id) ?? 999) - (ordemTorre.get(b.torre_id) ?? 999) || a.nome.localeCompare(b.nome);
    const turnos = [...state.turnos].sort(
      (a, b) => ORDEM_PADRAO.indexOf(a.padrao) - ORDEM_PADRAO.indexOf(b.padrao) || a.inicio.localeCompare(b.inicio)
    );

    // Os 12x36 ficam na tabela própria (grupos12x36).
    const grupos = turnos
      .filter((t) => t.padrao !== '12x36')
      .map((t) => ({
        titulo: `${t.codigo} — ${t.nome} (${t.inicio} às ${t.fim})`,
        cabecalho: `${tagTurno(t)} ${esc(t.nome)} <span class="muted">${t.inicio} às ${t.fim}</span>`,
        grupo: colabs.filter((c) => c.turno_id === t.id).sort(porTorre),
      }));
    return grupos.filter((g) => g.grupo.length);
  }
  // Por torre: dentro de cada torre, colaboradores pela ordem dos turnos e depois nome.
  // Turnos: pelo padrão (5x2, 6x1, 12x36…); dentro dele, por horário — exceto 12x36, por código (TPA, TPB, TPC…).
  const porCodigo = (a, b) => a.codigo.localeCompare(b.codigo, 'pt-BR', { numeric: true });
  const ordemTurno = new Map(
    [...state.turnos]
      .sort(
        (a, b) =>
          ORDEM_PADRAO.indexOf(a.padrao) - ORDEM_PADRAO.indexOf(b.padrao) ||
          (a.padrao === '12x36' ? porCodigo(a, b) : a.inicio.localeCompare(b.inicio) || porCodigo(a, b))
      )
      .map((t, i) => [t.id, i])
  );
  const porTurno = (a, b) =>
    (ordemTurno.get(a.turno_id) ?? 999) - (ordemTurno.get(b.turno_id) ?? 999) || a.nome.localeCompare(b.nome, 'pt-BR');
  return state.torres
    .map((t) => ({
      titulo: `Torre ${t.codigo} — ${t.nome}`,
      cabecalho: `${tagTorre(t)} ${esc(t.nome)}`,
      grupo: colabs.filter((c) => c.torre_id === t.id).sort(porTurno),
    }))
    .filter((g) => g.grupo.length);
}

// Dados de cada seção de sobreaviso do mês (usados pela grade e pelo Excel).
// Cada colaborador habilitado tem uma linha; várias pessoas podem cobrir a mesma torre no mesmo dia.
function secoesSobreaviso() {
  const { dias, sobreaviso } = state.escala;
  return state.torres
    .filter((t) => t.permite_sobreaviso && t.ativo)
    .map((t) => {
      const lanc = sobreaviso.filter((s) => s.torre_id === t.id);
      const cobertos = new Set(lanc.map((s) => s.data));
      return {
        torre: t,
        porPessoa: new Map(lanc.map((s) => [`${s.colaborador_id}|${s.data}`, s])),
        cobertos,
        habilitados: state.colaboradores
          .filter((c) => (c.ativo && c.sobreaviso_torre_id === t.id) || lanc.some((s) => s.colaborador_id === c.id))
          .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR')),
        descobertos: dias.filter((d) => !cobertos.has(d)).length,
        totalTorre: lanc.reduce((n, s) => n + (s.horas || 0), 0),
        totalDe: (id) => lanc.filter((s) => s.colaborador_id === id).reduce((n, s) => n + (s.horas || 0), 0),
      };
    });
}

function renderGrade() {
  const wrap = $('#grid');
  if (!wrap || !state.escala) return;
  const { dias, celulas } = state.escala;
  const hoje = hojeStr();
  const cel = new Map(celulas.map((c) => [`${c.colaborador_id}|${c.data}`, c]));
  const colabs = colaboradoresVisiveis();

  const clsDia = (d) => {
    const w = diaSemana(d);
    return [w === 0 || w === 6 ? 'we' : '', d === hoje ? 'hoje' : ''].join(' ');
  };

  const planilha = state.exibicao === 'planilha';
  const cabNome = planilha
    ? '<div class="pl"><span>Nome</span><span>Torre</span><span>Turno</span><span>Mesa</span><span>Escala</span></div>'
    : 'Colaborador';
  const cabDias = dias
    .map((d) =>
      planilha
        ? `<th class="${clsDia(d)}">${SEMANA_ABREV[diaSemana(d)]}<small>${d.slice(8)}/${d.slice(5, 7)}</small></th>`
        : `<th class="${clsDia(d)}">${Number(d.slice(8))}<small>${LETRAS_SEMANA[diaSemana(d)]}</small></th>`
    )
    .join('');
  // Uma tabela de escala (cabeçalho, grupos e a linha "Em serviço" dos seus colaboradores).
  const tabelaEscala = (grupos, membros, vazio) => {
    let t = `<table class="grid ${planilha ? 'planilha' : ''}"><thead><tr><th class="name">${cabNome}</th>${cabDias}</tr></thead><tbody>`;
    if (vazio) t += `<tr><td class="name muted">${vazio}</td><td colspan="${dias.length}"></td></tr>`;
    for (const { cabecalho, grupo } of grupos) {
      t += `<tr class="group"><td class="name">${cabecalho} <span class="muted">(${grupo.length})</span></td><td colspan="${dias.length}"></td></tr>`;
      for (const c of grupo) {
        t += `<tr><td class="name">${planilha ? nomePlanilha(c) : `<div class="n" title="${esc(c.nome)}">${esc(c.nome)}</div>${tagsColaborador(c)}`}</td>`;
        for (const d of dias) {
          const x = cel.get(`${c.id}|${d}`);
          t += planilha
            ? `<td class="cell ${clsDia(d)} ${classePlanilha(x)}" data-c="${c.id}" data-d="${d}" title="${esc(tituloCelula(x))}">${textoPlanilha(x)}</td>`
            : `<td class="cell ${clsDia(d)}" data-c="${c.id}" data-d="${d}">${chipCelula(x)}</td>`;
        }
        t += '</tr>';
      }
    }
    // Quantos estão em turno por dia (entre os colaboradores desta tabela).
    t += `</tbody><tfoot><tr class="sep"><td class="name">Em serviço</td>${dias
      .map((d) => {
        const n = membros.filter((c) => cel.get(`${c.id}|${d}`)?.tipo === 'TURNO').length;
        return `<td class="${clsDia(d)}">${n || '<span class="muted">0</span>'}</td>`;
      })
      .join('')}</tr></tfoot></table>`;
    return t;
  };

  // Escala principal e, abaixo, o 12x36 em tabela própria.
  const principais = colabs.filter((c) => !eh12x36(c));
  const revezamento = colabs.filter(eh12x36);
  let html = tabelaEscala(gruposDaGrade(principais), principais, colabs.length ? '' : 'Nenhum colaborador.');
  if (revezamento.length) {
    html += `<div class="tabela-titulo">12x36</div>${tabelaEscala(grupos12x36(revezamento), revezamento)}`;
  }

  // Sobreaviso: tabela própria abaixo da escala, com o mesmo cabeçalho de dias (as colunas ficam alinhadas).
  // Cada colaborador habilitado tem uma linha, com as horas de cada dia e o total do mês.
  const secoes = secoesSobreaviso();
  if (secoes.length) {
    const cabSA = planilha
      ? '<div class="pl"><span>Nome</span><span>Torre</span><span>Turno</span><span>Mesa</span><span>Horas</span></div>'
      : 'Colaborador';
    html += `<div class="tabela-titulo">Sobreaviso</div>
      <table class="grid sa-tabela ${planilha ? 'planilha' : ''}"><thead><tr><th class="name">${cabSA}</th>${cabDias}</tr></thead><tbody>`;
  }
  const ausencia = (id, d) => ['FERIAS', 'ATESTADO'].includes(cel.get(`${id}|${d}`)?.tipo);
  for (const { torre: t, porPessoa, cobertos, habilitados, descobertos, totalTorre, totalDe } of secoes) {
    html += `<tr class="group sa-group"><td class="name">Sobreaviso ${tagSobreaviso(t)} <span class="muted">(${habilitados.length}${
      totalTorre ? ` · ${fmtHoras(totalTorre)}` : ''
    })</span>${descobertos ? ` <span class="sa-alerta">${descobertos} dia(s) sem ninguém</span>` : ''}</td>${dias
      .map((d) => `<td class="${cobertos.has(d) ? '' : 'sa-vazio'}" title="${cobertos.has(d) ? '' : 'Sem sobreaviso'}"></td>`)
      .join('')}</tr>`;
    if (!habilitados.length) {
      html += `<tr><td class="name muted">Nenhum colaborador com sobreaviso ${esc(t.codigo)}.</td><td colspan="${dias.length}"></td></tr>`;
    }
    for (const c of habilitados) {
      const total = totalDe(c.id);
      const totalTxt = `<strong class="sa-total" title="Total de horas de sobreaviso no mês">${fmtHoras(total)}</strong>`;
      html += `<tr class="sa-row"><td class="name">${
        planilha
          ? nomePlanilha(c, { escala: totalTxt })
          : `<div class="n" title="${esc(c.nome)}">${esc(c.nome)} ${totalTxt}</div>${tagsColaborador(c)}`
      }</td>${dias
        .map((d) => {
          const s = porPessoa.get(`${c.id}|${d}`);
          const aus = ausencia(c.id, d);
          const rotulo = s ? (s.horas != null ? fmtHoras(s.horas) : planilha ? 'SOBREAVISO' : 'SA') : '';
          const titulo = s ? `Sobreaviso ${t.codigo}${s.horas != null ? ` · ${fmtHoras(s.horas)}` : ''}` : aus ? 'Ausente (férias/atestado)' : '';
          const conteudo = !s ? '' : planilha ? rotulo : `<span class="chip" style="--c:${esc(t.cor)}">${rotulo}</span>`;
          return `<td class="sa-cell ${clsDia(d)} ${s ? 'sa-on' : ''} ${aus ? 'sa-aus' : ''}" style="--c:${esc(
            t.cor
          )}" data-t="${t.id}" data-c="${c.id}" data-d="${d}" title="${esc(titulo)}">${conteudo}</td>`;
        })
        .join('')}</tr>`;
    }
  }
  if (secoes.length) html += '</tbody></table>';
  wrap.innerHTML = html;
}

function renderLegenda() {
  const el = $('#legenda');
  if (!el) return;
  const item = (v, chip, rotulo, titulo = '') =>
    `<button data-pincel="${v}" class="${state.pincel === v ? 'active' : ''}" title="${esc(titulo)}">${chip}${esc(rotulo)}</button>`;
  const serie = lerSerie(state.serieSA);
  const resumoSA = serie.length === 1 ? (serie[0] === null ? 'folga' : fmtHoras(serie[0])) : `${serie.length} dias`;
  const fixas =
    state.torres
      .filter((t) => t.permite_sobreaviso && t.padrao_sobreaviso)
      .map((t) => `${t.codigo}: ${descreverSerie(t.padrao_sobreaviso)}`)
      .join('\n') || 'Nenhuma torre com série fixa (Cadastros → Torres)';
  // "Trabalho" aplica o turno cadastrado de cada colaborador; férias e atestado ficam no clique da célula.
  // "Sobreaviso" usa a série configurável (⚙): com 1 dia é pontual e pinta arrastando; com mais, prévia + clique.
  // "Série" aplica a série fixa da torre (N3/ESPEC, N2…) a partir do dia clicado, com prévia ao passar o mouse.
  el.innerHTML =
    `<span class="label">Pincel:</span>` +
    item('TRABALHO', '<span class="chip trabalho">T</span>', 'Trabalho') +
    item('FOLGA', `<span class="chip folga">${AUSENCIAS.FOLGA.sigla}</span>`, AUSENCIAS.FOLGA.nome) +
    item('', '<span class="chip">⌫</span>', 'Limpar') +
    `<span class="legend-sep"></span>` +
    item('SA', '<span class="chip sa-chip">☎</span>', 'Sobreaviso', `Série configurável: ${descreverSerie(state.serieSA)}`) +
    `<button class="serie-resumo" id="cfg-serie-sa" title="Configurar a série do pincel Sobreaviso">${esc(resumoSA)} ⚙</button>` +
    item('SERIE', '<span class="chip sa-chip">⇶</span>', 'Série fixa', fixas) +
    (state.pincel !== null ? `<span class="label" style="margin-left:8px">Pincel ativo — Esc para sair</span>` : '');
  el.onclick = (e) => {
    if (e.target.closest('#cfg-serie-sa')) return dialogSerieSA();
    const b = e.target.closest('button[data-pincel]');
    if (!b) return;
    state.pincel = state.pincel === b.dataset.pincel ? null : b.dataset.pincel;
    limparPrevia();
    renderLegenda();
  };
}

function opcoesCelula() {
  return (
    state.turnos
      .filter((t) => t.ativo)
      .map(
        (t) =>
          `<button data-v="T:${t.id}"><span class="chip" style="--c:${esc(t.cor)}">${esc(t.codigo)}</span> ${t.inicio} – ${t.fim}</button>`
      )
      .join('') +
    '<hr>' +
    Object.entries(AUSENCIAS)
      .map(([k, a]) => `<button data-v="${k}"><span class="chip ${a.cls}">${a.sigla}</span> ${a.nome}</button>`)
      .join('') +
    '<hr><button data-v="">Limpar</button>'
  );
}

// "T:<id>" | FOLGA | FERIAS | ATESTADO | "" → corpo da API
function decodificar(v, colaboradorId) {
  if (!v) return { tipo: null, turno_id: null };
  if (v === 'TRABALHO') return { tipo: 'TURNO', turno_id: porId(state.colaboradores, colaboradorId)?.turno_id ?? null };
  if (v.startsWith('T:')) return { tipo: 'TURNO', turno_id: Number(v.slice(2)) };
  return { tipo: v, turno_id: null };
}

async function aplicarCelula(colaboradorId, data, v) {
  const { tipo, turno_id } = decodificar(v, colaboradorId);
  const lista = state.escala.celulas;
  const i = lista.findIndex((c) => c.colaborador_id === colaboradorId && c.data === data);
  const anterior = i >= 0 ? lista[i] : null;
  if (anterior && anterior.tipo === tipo && anterior.turno_id === turno_id) return;
  if (!anterior && !tipo) return;

  // Atualização otimista; em caso de erro recarrega do servidor.
  if (i >= 0) lista.splice(i, 1);
  if (tipo) lista.push({ colaborador_id: colaboradorId, data, tipo, turno_id });
  renderGrade();
  try {
    await api('PUT', '/escala/celula', { colaborador_id: colaboradorId, data, tipo, turno_id });
  } catch (e) {
    toast(e.message, true);
    carregarEscala();
  }
}

const fmtHoras = (h) => `${String(h).replace('.', ',')}h`;

// Padrão "12,F,5" → [12, null, 5] (null = folga).
const lerSerie = (padrao) => (padrao ? padrao.split(',').map((t) => (t === 'F' ? null : Number(t))) : []);
const descreverSerie = (padrao) => lerSerie(padrao).map((h) => (h === null ? 'folga' : fmtHoras(h))).join(' · ');

function somarDias(data, n) {
  return new Date(Date.parse(`${data}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}

// ----- editor da série: quantidade de dias e as horas de cada dia (vazio = folga) -----
// O valor final fica no campo oculto "padrao_sobreaviso" (ex.: "12,F,5,5").

function editorSerieHtml(padrao) {
  return `<div class="serie-editor" data-serie>
    <input type="hidden" name="padrao_sobreaviso" value="${esc(padrao || '')}">
    <label class="field"><span>Série de sobreaviso — quantidade de dias</span>
      <input type="number" data-serie-dias min="0" max="62" step="1" value="${lerSerie(padrao).length}"></label>
    <div class="serie-dias" data-serie-grade></div>
    <p class="hint" data-serie-resumo></p>
  </div>`;
}

function ligarEditorSerie(raiz) {
  const box = raiz.querySelector('[data-serie]');
  if (!box) return;
  const oculto = box.querySelector('input[name=padrao_sobreaviso]');
  const qtd = box.querySelector('[data-serie-dias]');
  const grade = box.querySelector('[data-serie-grade]');
  const resumo = box.querySelector('[data-serie-resumo]');
  let valores = lerSerie(oculto.value).map((h) => (h === null ? '' : String(h).replace('.', ',')));

  const sincronizar = () => {
    let valido = true;
    valores = [...grade.querySelectorAll('input')].map((inp) => {
      const v = inp.value.trim();
      const h = Number(v.replace(',', '.'));
      const ok = !v || (h > 0 && h <= 24);
      inp.classList.toggle('invalido', !ok);
      valido &&= ok;
      return v;
    });
    // Vazio = folga; valores inválidos seguem como estão para o servidor recusar com a mensagem.
    oculto.value = valores.map((v) => (v ? v.replace(',', '.') : 'F')).join(',');
    resumo.textContent = !valores.length
      ? 'Sem série: o pincel Série não funciona nesta torre.'
      : valido
        ? `Série: ${descreverSerie(oculto.value)}`
        : 'Use horas entre 0,5 e 24, ou deixe vazio para folga.';
  };
  const montar = () => {
    const n = Math.max(0, Math.min(62, Math.floor(Number(qtd.value)) || 0));
    valores = Array.from({ length: n }, (_, i) => valores[i] ?? '');
    grade.innerHTML = valores
      .map(
        (v, i) =>
          `<label class="serie-dia"><span>Dia ${i + 1}</span><input inputmode="decimal" value="${esc(v)}" placeholder="folga"></label>`
      )
      .join('');
    sincronizar();
  };
  qtd.oninput = montar;
  grade.oninput = sincronizar;
  montar();
}

// Configura a série do pincel Sobreaviso: quantidade de dias e horas de cada dia (fica salva no navegador).
function dialogSerieSA() {
  abrirDialog({
    titulo: 'Série do pincel Sobreaviso',
    confirmar: 'Usar esta série',
    corpo: `${editorSerieHtml(state.serieSA)}
      <p class="hint">Com 1 dia o pincel é pontual (clique ou arraste). Com mais dias, a série aparece esmaecida ao passar
        o mouse numa linha de sobreaviso e é aplicada no clique. As séries fixas (N3/ESPEC, N2) ficam no pincel "Série fixa".</p>`,
    aoAbrir: ligarEditorSerie,
    async onSubmit(form) {
      const tokens = valor(form, 'padrao_sobreaviso').split(',').filter(Boolean);
      if (!tokens.length) throw new Error('A série precisa ter ao menos 1 dia.');
      const normal = tokens.map((t) => {
        if (t === 'F') return 'F';
        const h = Number(t);
        if (!(h > 0 && h <= 24)) throw new Error('Use horas entre 0,5 e 24, ou deixe vazio para folga.');
        return String(Math.round(h * 2) / 2);
      });
      state.serieSA = normal.join(',');
      salvarPreferencia('serieSA', state.serieSA);
      state.pincel = 'SA';
      limparPrevia();
      renderLegenda();
    },
  });
}

// ----- prévia da série: esmaece na linha os dias que o clique vai preencher -----
let celulaPrevia = null;

function limparPrevia() {
  document.querySelectorAll('td.sa-cell.previa').forEach((td) => {
    td.classList.remove('previa', 'previa-folga');
    delete td.dataset.previa;
  });
  celulaPrevia = null;
}

function mostrarPrevia(td, padrao) {
  if (td === celulaPrevia) return;
  limparPrevia();
  const serie = lerSerie(padrao);
  if (!serie.length) return;
  celulaPrevia = td;
  const linha = td.closest('tr');
  serie.forEach((h, i) => {
    const alvo = linha.querySelector(`td.sa-cell[data-d="${somarDias(td.dataset.d, i)}"]`);
    if (!alvo) return; // dia fora do mês exibido (a série continua no mês seguinte)
    alvo.classList.add('previa');
    alvo.classList.toggle('previa-folga', h === null);
    alvo.dataset.previa = h === null ? 'folga' : fmtHoras(h);
  });
}

// Aplica a série a partir do dia clicado. `fixa` = série da torre (o servidor usa a cadastrada);
// senão envia a série configurável do pincel.
async function aplicarSerie(td, padrao, { fixa = false } = {}) {
  const torreId = Number(td.dataset.t);
  const colaboradorId = Number(td.dataset.c);
  const inicio = td.dataset.d;
  // Atualização otimista; o servidor aplica a série inteira (inclusive dias do mês seguinte).
  const lista = state.escala.sobreaviso;
  lerSerie(padrao).forEach((h, i) => {
    const data = somarDias(inicio, i);
    const j = lista.findIndex((s) => s.torre_id === torreId && s.data === data && s.colaborador_id === colaboradorId);
    if (j >= 0) lista.splice(j, 1);
    if (h !== null) lista.push({ torre_id: torreId, data, colaborador_id: colaboradorId, horas: h });
  });
  limparPrevia();
  renderGrade();
  try {
    await api('POST', '/sobreaviso/serie', {
      torre_id: torreId,
      colaborador_id: colaboradorId,
      inicio,
      ...(fixa ? {} : { padrao }),
    });
  } catch (e) {
    toast(e.message, true);
    carregarEscala();
  }
}

// Lança/atualiza as horas de um colaborador no sobreaviso da torre/dia, ou remove (remover: true).
async function aplicarSobreaviso(torreId, data, colaboradorId, { horas = null, remover = false } = {}) {
  const lista = state.escala.sobreaviso;
  const i = lista.findIndex((s) => s.torre_id === torreId && s.data === data && s.colaborador_id === colaboradorId);
  if (remover) {
    if (i < 0) return;
    lista.splice(i, 1);
  } else {
    if (i >= 0 && lista[i].horas === horas) return;
    if (i >= 0) lista[i].horas = horas;
    else lista.push({ torre_id: torreId, data, colaborador_id: colaboradorId, horas });
  }
  renderGrade();
  try {
    await api('PUT', '/sobreaviso', { torre_id: torreId, data, colaborador_id: colaboradorId, horas, remover });
  } catch (e) {
    toast(e.message, true);
    carregarEscala();
  }
}

let pintando = false;
document.addEventListener('mouseup', () => (pintando = false));

// Série que o pincel ativo aplicaria nessa célula de sobreaviso ('' = nenhuma).
function serieDoPincel(td) {
  if (state.pincel === 'SERIE') return porId(state.torres, Number(td.dataset.t))?.padrao_sobreaviso || '';
  if (state.pincel === 'SA') return state.serieSA;
  return '';
}
const pincelSAPontual = () => state.pincel === 'SA' && lerSerie(state.serieSA).length === 1;
const horasPontuais = () => lerSerie(state.serieSA).find((h) => h !== null) ?? 8;

// Aplica o pincel ativo numa célula (clique ou arraste): turnos/folga nas linhas de escala;
// Sobreaviso de 1 dia nas linhas de sobreaviso. "Limpar" vale para as duas.
function pintar(td) {
  if (td.matches('td.cell')) {
    if (state.pincel !== 'SA') aplicarCelula(Number(td.dataset.c), td.dataset.d, state.pincel);
    return;
  }
  const args = [Number(td.dataset.t), td.dataset.d, Number(td.dataset.c)];
  if (pincelSAPontual()) {
    const h = lerSerie(state.serieSA)[0];
    aplicarSobreaviso(...args, h === null ? { remover: true } : { horas: h });
  } else if (state.pincel === '') aplicarSobreaviso(...args, { remover: true });
}

function ligarEventosGrade() {
  const wrap = $('#grid');
  const alvo = (e) => e.target.closest('td.cell, td.sa-cell');
  // Séries (fixa, ou Sobreaviso com mais de 1 dia) são aplicadas no clique, não no arraste.
  const aplicaNoClique = () => state.pincel === 'SERIE' || (state.pincel === 'SA' && !pincelSAPontual());

  wrap.addEventListener('mousedown', (e) => {
    const td = alvo(e);
    if (!td || state.pincel === null || aplicaNoClique() || e.button !== 0) return;
    e.preventDefault();
    pintando = true;
    pintar(td);
  });
  wrap.addEventListener('mouseover', (e) => {
    if (pintando) {
      const td = alvo(e);
      if (td) pintar(td);
      return;
    }
    // Prévia esmaecida da série a partir do dia sob o mouse.
    const sa = e.target.closest('td.sa-cell');
    const padrao = sa && aplicaNoClique() ? serieDoPincel(sa) : '';
    if (padrao) mostrarPrevia(sa, padrao);
    else if (celulaPrevia) limparPrevia();
  });
  wrap.addEventListener('mouseleave', limparPrevia);

  wrap.addEventListener('click', (e) => {
    if (aplicaNoClique()) {
      const td = e.target.closest('td.sa-cell');
      if (!td) return;
      const padrao = serieDoPincel(td);
      if (padrao) aplicarSerie(td, padrao, { fixa: state.pincel === 'SERIE' });
      else toast('Esta torre não tem série fixa. Defina em Cadastros → Torres.', true);
      return;
    }
    if (state.pincel !== null) return;
    const td = e.target.closest('td.cell');
    if (td) {
      const c = porId(state.colaboradores, Number(td.dataset.c));
      const data = td.dataset.d;
      const titulo = `<div class="hd">${esc(c.nome)} · ${data.split('-').reverse().join('/')}</div>`;
      abrirPopover(td, titulo + opcoesCelula(), (v) => aplicarCelula(c.id, data, v));
      return;
    }
    const sa = e.target.closest('td.sa-cell');
    if (sa) {
      // Sem pincel: clique alterna o dia (lança com as horas do pincel Sobreaviso / remove).
      const torreId = Number(sa.dataset.t);
      const colaboradorId = Number(sa.dataset.c);
      const data = sa.dataset.d;
      const existe = state.escala.sobreaviso.some(
        (x) => x.torre_id === torreId && x.data === data && x.colaborador_id === colaboradorId
      );
      aplicarSobreaviso(torreId, data, colaboradorId, existe ? { remover: true } : { horas: horasPontuais() });
    }
  });
}

// =====================================================================
// COLABORADORES
// =====================================================================

function viewColaboradores() {
  const f = state.filtroColab;
  const torresSA = state.torres.filter((t) => t.permite_sobreaviso);
  main.innerHTML = `
    <div class="page-head">
      <div><h1>Colaboradores</h1><p>Clique em Editar para alterar a tabela inteira; nada é gravado até Salvar alterações. Marque linhas para editar em massa.</p></div>
      <div class="head-actions" id="acoes-tabela"></div>
    </div>
    <div class="toolbar">
      <input id="busca" type="search" placeholder="Buscar por nome, e-mail ou telefone…" value="${esc(f.busca)}" style="min-width:260px">
      <select id="ft"><option value="">Torre: todas</option>${state.torres
        .map((t) => `<option value="${t.id}" ${String(t.id) === f.torre ? 'selected' : ''}>${esc(t.codigo)}</option>`)
        .join('')}</select>
      <select id="fu"><option value="">Turno: todos</option>${state.turnos
        .map((t) => `<option value="${t.id}" ${String(t.id) === f.turno ? 'selected' : ''}>${esc(t.codigo)}</option>`)
        .join('')}</select>
      <select id="fm"><option value="">Mesa: todas</option><option value="nenhuma" ${
        f.mesa === 'nenhuma' ? 'selected' : ''
      }>Sem mesa</option>${state.mesas
        .map((m) => `<option value="${m.id}" ${String(m.id) === f.mesa ? 'selected' : ''}>${esc(m.codigo)}</option>`)
        .join('')}</select>
      <select id="fs"><option value="">Sobreaviso: todos</option><option value="nenhum" ${
        f.sa === 'nenhum' ? 'selected' : ''
      }>Sem sobreaviso</option>${torresSA
        .map((t) => `<option value="${t.id}" ${String(t.id) === f.sa ? 'selected' : ''}>${esc(t.codigo)}</option>`)
        .join('')}</select>
    </div>
    <div class="lote-bar" id="lote" hidden></div>
    <div class="card list-wrap" id="lista"></div>`;

  renderAcoesTabela();
  $('#busca').oninput = (e) => ((f.busca = e.target.value), renderColaboradores());
  $('#ft').onchange = (e) => ((f.torre = e.target.value), renderColaboradores());
  $('#fu').onchange = (e) => ((f.turno = e.target.value), renderColaboradores());
  $('#fs').onchange = (e) => ((f.sa = e.target.value), renderColaboradores());
  $('#fm').onchange = (e) => ((f.mesa = e.target.value), renderColaboradores());
  renderColaboradores();
}

function colaboradoresFiltrados() {
  const f = state.filtroColab;
  const b = f.busca.trim().toLowerCase();
  const lista = state.colaboradores.filter(
    (c) =>
      (!b || [c.nome, c.email, c.telefone].some((v) => v.toLowerCase().includes(b))) &&
      (!f.torre || String(c.torre_id) === f.torre) &&
      (!f.turno || String(c.turno_id) === f.turno) &&
      (!f.sa || (f.sa === 'nenhum' ? !c.sobreaviso_torre_id : String(c.sobreaviso_torre_id) === f.sa)) &&
      (!f.mesa || (f.mesa === 'nenhuma' ? !c.mesa_id : String(c.mesa_id) === f.mesa))
  );
  const { campo, dir } = state.ordemColab;
  if (!campo) return lista;
  // Ordena pelo código da tag (valor salvo, para as linhas não pularem durante a edição); empate por nome.
  const codigo = (c) => porId(CAMPOS_SELECT[campo](), c[campo])?.codigo || '';
  return lista.sort(
    (a, b) => dir * codigo(a).localeCompare(codigo(b), 'pt-BR', { numeric: true }) || a.nome.localeCompare(b.nome, 'pt-BR')
  );
}

// Cabeçalho clicável: crescente → decrescente → sem ordenação.
function thOrdenavel(campo, rotulo) {
  const { campo: atual, dir } = state.ordemColab;
  const seta = atual === campo ? (dir === 1 ? ' ▲' : ' ▼') : '';
  return `<th class="ordenavel ${atual === campo ? 'ativo' : ''}" data-ordem="${campo}" title="Ordenar por ${rotulo}">${rotulo}${seta}</th>`;
}

function alternarOrdem(campo) {
  const o = state.ordemColab;
  if (o.campo !== campo) Object.assign(o, { campo, dir: 1 });
  else if (o.dir === 1) o.dir = -1;
  else Object.assign(o, { campo: '', dir: 1 });
}

// ----- Tabela de colaboradores: leitura por padrão; "Editar" libera a tabela inteira -----
// No modo edição as mudanças ficam em state.rascunho (id → campos alterados) até "Salvar alterações".

const CAMPOS_SELECT = {
  torre_id: () => state.torres,
  turno_id: () => state.turnos,
  sobreaviso_torre_id: () => state.torres,
  mesa_id: () => state.mesas,
};

const normalizar = (v) => (v === null || v === undefined ? '' : typeof v === 'boolean' ? (v ? '1' : '0') : String(v).trim());

function valorAtual(c, campo) {
  const r = state.rascunho.get(c.id);
  return r && campo in r ? r[campo] : c[campo];
}

function alterado(c, campo) {
  return !!state.rascunho.get(c.id) && campo in state.rascunho.get(c.id);
}

function registrarRascunho(c, campo, valor) {
  const r = state.rascunho.get(c.id) || {};
  if (normalizar(valor) === normalizar(c[campo])) delete r[campo];
  else r[campo] = valor;
  if (Object.keys(r).length) state.rascunho.set(c.id, r);
  else state.rascunho.delete(c.id);
}

const totalAlteracoes = () => [...state.rascunho.values()].reduce((n, r) => n + Object.keys(r).length, 0);

function renderAcoesTabela() {
  const el = $('#acoes-tabela');
  if (!el) return;
  if (!state.editando) {
    el.innerHTML = `<button id="btn-editar">✎ Editar</button><button class="primary" id="novo">+ Novo colaborador</button>`;
    $('#btn-editar').onclick = () => {
      state.editando = true;
      renderAcoesTabela();
      renderColaboradores();
    };
    $('#novo').onclick = () => formColaborador();
    return;
  }
  const n = totalAlteracoes();
  el.innerHTML = `
    <span class="muted">${n ? `${n} alteraç${n > 1 ? 'ões' : 'ão'} não salva${n > 1 ? 's' : ''}` : 'Modo edição'}</span>
    <button id="btn-cancelar">Cancelar</button>
    <button class="primary" id="btn-salvar" ${n ? '' : 'disabled'}>Salvar alterações</button>`;
  $('#btn-cancelar').onclick = () => {
    if (totalAlteracoes() && !confirm('Descartar as alterações não salvas?')) return;
    sairDaEdicao();
  };
  $('#btn-salvar').onclick = salvarRascunho;
}

function sairDaEdicao() {
  state.editando = false;
  state.rascunho.clear();
  renderAcoesTabela();
  renderColaboradores();
}

async function salvarRascunho() {
  const linhas = [...state.rascunho].map(([id, campos]) => ({ id, ...campos }));
  if (!linhas.length) return;
  const btn = $('#btn-salvar');
  btn.disabled = true;
  try {
    const r = await api('PUT', '/colaboradores/lote', { linhas });
    await carregarBase();
    sairDaEdicao();
    toast(`${r.alterados} colaborador(es) atualizado(s).`);
  } catch (err) {
    // Nada foi gravado: mantém o rascunho para corrigir.
    toast(err.message, true);
    btn.disabled = false;
  }
}

function celulaSelect(c, campo, lista, rotulo, vazio, travado = false) {
  const v = valorAtual(c, campo);
  const atual = v === '' || v === null || v === undefined ? null : Number(v);
  const item = porId(lista, atual);
  return `<td class="ed ${alterado(c, campo) ? 'alterado' : ''}"><select data-f="${campo}" class="tag-sel" ${
    travado ? 'disabled' : ''
  } style="--c:${esc(item?.cor || 'transparent')}">${opcoes(lista, atual, rotulo, vazio)}</select></td>`;
}

function celulaTexto(c, campo, classe, tipo, travado = false) {
  return `<td class="ed ${alterado(c, campo) ? 'alterado' : ''}"><input data-f="${campo}" class="${classe}" type="${tipo}" maxlength="120" value="${esc(
    valorAtual(c, campo)
  )}" placeholder="—" ${travado ? 'disabled' : ''}></td>`;
}

// Mesma linha nos dois modos; fora do modo edição os campos ficam travados (disabled).
function linhaColaborador(c, torresSA, travado) {
  const ativo = normalizar(valorAtual(c, 'ativo')) === '1';
  return `
    ${celulaTexto(c, 'nome', 'w-nome', 'text', travado)}
    ${celulaTexto(c, 'email', 'w-email', 'email', travado)}
    ${celulaTexto(c, 'telefone', 'w-tel', 'tel', travado)}
    ${celulaSelect(c, 'torre_id', state.torres, (t) => t.codigo, undefined, travado)}
    ${celulaSelect(c, 'turno_id', state.turnos, (t) => `${t.codigo} · ${t.inicio}–${t.fim}`, undefined, travado)}
    ${celulaSelect(c, 'mesa_id', state.mesas, (m) => m.codigo, '—', travado)}
    ${celulaSelect(c, 'sobreaviso_torre_id', torresSA, (t) => t.codigo, '—', travado)}
    <td class="ed center ${alterado(c, 'ativo') ? 'alterado' : ''}"><input type="checkbox" data-f="ativo" ${ativo ? 'checked' : ''} ${
      travado ? 'disabled' : ''
    }></td>
    <td class="actions">${travado ? `<button class="ghost danger icon" data-del="${c.id}" title="Excluir">✕</button>` : ''}</td>`;
}

function renderColaboradores() {
  const lista = colaboradoresFiltrados();
  const sel = state.selecionados;
  // Remove da seleção quem não existe mais (ex.: excluído).
  for (const id of sel) if (!porId(state.colaboradores, id)) sel.delete(id);
  renderBarraLote();

  const el = $('#lista');
  if (!lista.length) {
    el.innerHTML = `<div class="empty">${state.colaboradores.length ? 'Nenhum colaborador encontrado.' : 'Nenhum colaborador cadastrado ainda.'}</div>`;
    return;
  }
  const editando = state.editando;
  const torresSA = state.torres.filter((t) => t.permite_sobreaviso);
  const marcadosVisiveis = lista.filter((c) => sel.has(c.id)).length;
  el.innerHTML = `<table class="list colab editavel ${editando ? '' : 'travada'}"><thead><tr>
      <th class="sel"><input type="checkbox" id="sel-todos" title="Selecionar todos os exibidos" ${
        marcadosVisiveis === lista.length ? 'checked' : ''
      }></th>
      <th>Nome</th><th>E-mail</th><th>Telefone</th>${thOrdenavel('torre_id', 'Torre')}${thOrdenavel('turno_id', 'Turno')}${thOrdenavel('mesa_id', 'Mesa')}<th>Sobreaviso</th><th>Ativo</th><th></th>
    </tr></thead><tbody>${lista
      .map((c) => {
        const inativo = normalizar(valorAtual(c, 'ativo')) !== '1';
        return `<tr class="${inativo ? 'inativo' : ''} ${sel.has(c.id) ? 'selecionado' : ''}" data-id="${c.id}">
          <td class="sel"><input type="checkbox" data-sel="${c.id}" ${sel.has(c.id) ? 'checked' : ''}></td>
          ${linhaColaborador(c, torresSA, !editando)}</tr>`;
      })
      .join('')}</tbody></table>`;

  el.querySelectorAll('th[data-ordem]').forEach((th) => {
    th.onclick = () => {
      alternarOrdem(th.dataset.ordem);
      renderColaboradores();
    };
  });

  const todos = $('#sel-todos');
  todos.indeterminate = marcadosVisiveis > 0 && marcadosVisiveis < lista.length;
  todos.onchange = () => {
    lista.forEach((c) => (todos.checked ? sel.add(c.id) : sel.delete(c.id)));
    renderColaboradores();
  };

  // Edição: registra no rascunho e destaca a célula, sem ir ao servidor.
  const registrar = (inp) => {
    const c = porId(state.colaboradores, Number(inp.closest('tr').dataset.id));
    const campo = inp.dataset.f;
    registrarRascunho(c, campo, inp.type === 'checkbox' ? inp.checked : inp.value);
    inp.closest('td').classList.toggle('alterado', alterado(c, campo));
    if (inp.tagName === 'SELECT') {
      inp.style.setProperty('--c', porId(CAMPOS_SELECT[campo](), Number(inp.value))?.cor || 'transparent');
    }
    if (campo === 'ativo') inp.closest('tr').classList.toggle('inativo', !inp.checked);
    renderAcoesTabela();
  };
  el.onchange = (e) => {
    const inp = e.target.closest('[data-f]');
    if (inp) registrar(inp);
  };
  el.oninput = (e) => {
    const inp = e.target.closest('input[data-f]:not([type=checkbox])');
    if (inp) registrar(inp);
  };

  el.onkeydown = (e) => {
    const inp = e.target.closest('input[data-f]:not([type=checkbox])');
    if (!inp) return;
    if (e.key === 'Escape') {
      // Volta ao valor salvo.
      const c = porId(state.colaboradores, Number(inp.closest('tr').dataset.id));
      inp.value = c[inp.dataset.f] ?? '';
      registrar(inp);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const tr = inp.closest('tr');
      const alvo = (e.shiftKey ? tr.previousElementSibling : tr.nextElementSibling)?.querySelector(`[data-f="${inp.dataset.f}"]`);
      if (alvo) alvo.focus(), alvo.select();
    }
  };

  el.onclick = async (e) => {
    const chk = e.target.closest('[data-sel]');
    if (chk) {
      const id = Number(chk.dataset.sel);
      // Shift + clique marca/desmarca o intervalo desde o último clicado.
      const ids = lista.map((c) => c.id);
      if (e.shiftKey && ids.includes(state.ultimoSelecionado)) {
        const [a, b] = [ids.indexOf(state.ultimoSelecionado), ids.indexOf(id)].sort((x, y) => x - y);
        ids.slice(a, b + 1).forEach((x) => (chk.checked ? sel.add(x) : sel.delete(x)));
      } else if (chk.checked) sel.add(id);
      else sel.delete(id);
      state.ultimoSelecionado = id;
      return renderColaboradores();
    }
    const del = e.target.closest('[data-del]');
    if (del) {
      const c = porId(state.colaboradores, Number(del.dataset.del));
      if (!confirm(`Excluir ${c.nome}? A escala e os sobreavisos dele também serão apagados.`)) return;
      try {
        await api('DELETE', `/colaboradores/${c.id}`);
        await carregarBase();
        renderColaboradores();
        toast('Colaborador excluído.');
      } catch (err) {
        toast(err.message, true);
      }
    }
  };
}

function renderBarraLote() {
  const el = $('#lote');
  const n = state.selecionados.size;
  el.hidden = !n;
  if (!n) return;
  el.innerHTML = `
    <strong>${n} selecionado${n > 1 ? 's' : ''}</strong>
    <button class="primary" data-a="editar">Editar em massa</button>
    <button class="danger" data-a="excluir">Excluir</button>
    <button class="ghost" data-a="limpar">Limpar seleção</button>`;
  el.onclick = async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'limpar') {
      state.selecionados.clear();
      renderColaboradores();
    } else if (a === 'editar') {
      formLote();
    } else if (a === 'excluir') {
      if (!confirm(`Excluir ${n} colaborador(es)? A escala e os sobreavisos deles também serão apagados.`)) return;
      try {
        await api('POST', '/colaboradores/lote/excluir', { ids: [...state.selecionados] });
        state.selecionados.clear();
        await carregarBase();
        renderColaboradores();
        toast(`${n} colaborador(es) excluído(s).`);
      } catch (err) {
        toast(err.message, true);
      }
    }
  };
}

// Cada campo começa em "manter": só o que for alterado é enviado.
function formLote() {
  const ids = [...state.selecionados];
  const nomes = ids.map((id) => porId(state.colaboradores, id)?.nome).filter(Boolean);
  const manter = '<option value="__manter" selected>— manter como está —</option>';
  const sel = (nome, lista, rotulo, vazio) =>
    `<select name="${nome}">${manter}${vazio ? `<option value="">${esc(vazio)}</option>` : ''}${lista
      .filter((x) => x.ativo)
      .map((x) => `<option value="${x.id}">${esc(rotulo(x))}</option>`)
      .join('')}</select>`;
  abrirDialog({
    titulo: `Editar ${ids.length} colaborador${ids.length > 1 ? 'es' : ''}`,
    confirmar: 'Aplicar',
    corpo: `
      <p class="hint">${esc(nomes.slice(0, 6).join(', '))}${nomes.length > 6 ? ` e mais ${nomes.length - 6}` : ''}.
        Só os campos alterados serão aplicados.</p>
      <div class="row">
        <label class="field"><span>Torre</span>${sel('torre_id', state.torres, (t) => `${t.codigo} — ${t.nome}`)}</label>
        <label class="field"><span>Turno</span>${sel('turno_id', state.turnos, (t) => `${t.codigo} — ${t.inicio} às ${t.fim}`)}</label>
      </div>
      <div class="row">
        <label class="field"><span>Mesa</span>${sel('mesa_id', state.mesas, (m) => `${m.codigo} — ${m.nome}`, 'Sem mesa')}</label>
        <label class="field"><span>Sobreaviso</span>${sel(
          'sobreaviso_torre_id',
          state.torres.filter((t) => t.permite_sobreaviso),
          (t) => `${t.codigo} — ${t.nome}`,
          'Nenhum'
        )}</label>
      </div>
      <label class="field"><span>Status</span><select name="ativo">${manter}<option value="1">Ativo</option><option value="0">Inativo</option></select></label>`,
    async onSubmit(form) {
      const campos = {};
      for (const k of ['torre_id', 'turno_id', 'mesa_id', 'sobreaviso_torre_id']) {
        if (valor(form, k) !== '__manter') campos[k] = valor(form, k);
      }
      if (valor(form, 'ativo') !== '__manter') campos.ativo = valor(form, 'ativo') === '1';
      if (!Object.keys(campos).length) throw new Error('Altere ao menos um campo.');
      if (state.editando) {
        // No modo edição o lote entra no rascunho e é salvo junto com o resto.
        for (const id of ids) {
          const c = porId(state.colaboradores, id);
          if (c) Object.entries(campos).forEach(([k, v]) => registrarRascunho(c, k, v));
        }
        renderAcoesTabela();
        renderColaboradores();
        return;
      }
      const r = await api('PUT', '/colaboradores/lote', { ids, campos });
      await carregarBase();
      renderColaboradores();
      toast(`${r.alterados} colaborador(es) atualizado(s).`);
    },
  });
}

function formColaborador(c = null) {
  const torresSA = state.torres.filter((t) => t.permite_sobreaviso);
  abrirDialog({
    titulo: c ? 'Editar colaborador' : 'Novo colaborador',
    corpo: `
      <label class="field"><span>Nome *</span><input name="nome" required maxlength="120" value="${esc(c?.nome)}"></label>
      <div class="row">
        <label class="field"><span>E-mail</span><input name="email" type="email" maxlength="120" value="${esc(c?.email)}"></label>
        <label class="field"><span>Telefone</span><input name="telefone" type="tel" maxlength="30" placeholder="(11) 99999-9999" value="${esc(c?.telefone)}"></label>
      </div>
      <div class="row">
        <label class="field"><span>Torre *</span><select name="torre_id" required>${opcoes(
          state.torres,
          c?.torre_id,
          (t) => `${t.codigo} — ${t.nome}`,
          'Selecione…'
        )}</select></label>
        <label class="field"><span>Turno *</span><select name="turno_id" required>${opcoes(
          state.turnos,
          c?.turno_id,
          (t) => `${t.codigo} — ${t.inicio} às ${t.fim}`,
          'Selecione…'
        )}</select></label>
      </div>
      <div class="row">
        <label class="field"><span>Mesa</span><select name="mesa_id">${opcoes(
          state.mesas,
          c?.mesa_id,
          (m) => `${m.codigo} — ${m.nome}`,
          'Sem mesa'
        )}</select></label>
        <label class="field"><span>Sobreaviso</span><select name="sobreaviso_torre_id">${opcoes(
          torresSA,
          c?.sobreaviso_torre_id,
          (t) => `${t.codigo} — ${t.nome}`,
          'Nenhum'
        )}</select></label>
      </div>
      <label class="check"><input type="checkbox" name="ativo" ${!c || c.ativo ? 'checked' : ''}> Ativo</label>`,
    async onSubmit(form) {
      const body = {
        nome: valor(form, 'nome'),
        email: valor(form, 'email'),
        telefone: valor(form, 'telefone'),
        torre_id: valor(form, 'torre_id'),
        turno_id: valor(form, 'turno_id'),
        sobreaviso_torre_id: valor(form, 'sobreaviso_torre_id'),
        mesa_id: valor(form, 'mesa_id'),
        ativo: marcado(form, 'ativo'),
      };
      await api(c ? 'PUT' : 'POST', c ? `/colaboradores/${c.id}` : '/colaboradores', body);
      await carregarBase();
      renderColaboradores();
      toast(c ? 'Colaborador atualizado.' : 'Colaborador cadastrado.');
    },
  });
}

// =====================================================================
// CADASTROS: TORRES E TURNOS
// =====================================================================

// Tela de cadastro genérica: lista + formulário em dialog.
function telaCadastro({ titulo, subtitulo, recurso, novo, colunas, linha, form, corpo, emUso, ordenar, aoAbrir }) {
  main.innerHTML = `
    <div class="page-head">
      <div><h1>${esc(titulo)}</h1><p>${esc(subtitulo)}</p></div>
      <button class="primary" id="novo">+ ${esc(novo)}</button>
    </div>
    <div class="card list-wrap" id="lista"></div>`;

  const lista = () => (ordenar ? [...state[recurso]].sort(ordenar) : state[recurso]);
  const render = () => {
    const el = $('#lista');
    if (!lista().length) {
      el.innerHTML = '<div class="empty">Nada cadastrado ainda.</div>';
      return;
    }
    el.innerHTML = `<table class="list"><thead><tr>${colunas.map((c) => `<th>${c}</th>`).join('')}<th></th></tr></thead>
      <tbody>${lista()
        .map(
          (x) => `<tr class="${x.ativo ? '' : 'inativo'}">${linha(x)
            .map((v) => `<td>${v}</td>`)
            .join('')}<td class="actions">
            <button class="ghost" data-edit="${x.id}">Editar</button>
            <button class="ghost danger" data-del="${x.id}">Excluir</button></td></tr>`
        )
        .join('')}</tbody></table>`;
  };

  const abrir = (x = null) =>
    abrirDialog({
      titulo: x ? `Editar ${novo.toLowerCase()}` : novo,
      corpo: corpo(x),
      aoAbrir,
      async onSubmit(f) {
        await api(x ? 'PUT' : 'POST', x ? `/${recurso}/${x.id}` : `/${recurso}`, form(f));
        await carregarBase();
        render();
        toast('Salvo.');
      },
    });

  $('#novo').onclick = () => abrir();
  $('#lista').onclick = async (e) => {
    const ed = e.target.closest('[data-edit]');
    if (ed) return abrir(porId(lista(), Number(ed.dataset.edit)));
    const del = e.target.closest('[data-del]');
    if (!del) return;
    const x = porId(lista(), Number(del.dataset.del));
    if (emUso(x)) return toast(`${x.codigo} está em uso por colaboradores. Desative em vez de excluir.`, true);
    if (!confirm(`Excluir ${x.codigo}?`)) return;
    try {
      await api('DELETE', `/${recurso}/${x.id}`);
      await carregarBase();
      render();
      toast('Excluído.');
    } catch (err) {
      toast(err.message, true);
    }
  };
  render();
}

const camposComuns = (x, corPadrao) => `
  <div class="row">
    <label class="field"><span>Código *</span><input name="codigo" required maxlength="10" value="${esc(x?.codigo)}" style="text-transform:uppercase"></label>
    <label class="field"><span>Nome</span><input name="nome" maxlength="80" value="${esc(x?.nome)}"></label>
  </div>
  <label class="field"><span>Cor da tag</span><input type="color" name="cor" value="${esc(x?.cor || corPadrao)}"></label>`;

function viewTorres() {
  const contar = (t) => state.colaboradores.filter((c) => c.torre_id === t.id).length;
  const contarSA = (t) => state.colaboradores.filter((c) => c.sobreaviso_torre_id === t.id).length;
  telaCadastro({
    titulo: 'Torres',
    subtitulo: 'Times de atendimento. Marque as que possuem sobreaviso para habilitar a tag de sobreaviso.',
    recurso: 'torres',
    novo: 'Nova torre',
    colunas: ['Ordem', 'Tag', 'Nome', 'Sobreaviso', 'Colaboradores', 'Status'],
    linha: (t) => [
      t.ordem,
      tagTorre(t),
      esc(t.nome),
      t.permite_sobreaviso
        ? `Sim <span class="muted">(${contarSA(t)} habilitados)</span>${
            t.padrao_sobreaviso ? `<div class="muted serie-txt">Série: ${esc(descreverSerie(t.padrao_sobreaviso))}</div>` : ''
          }`
        : '<span class="muted">Não</span>',
      contar(t),
      t.ativo ? 'Ativa' : 'Inativa',
    ],
    emUso: (t) => contar(t) + contarSA(t) > 0,
    aoAbrir: ligarEditorSerie,
    corpo: (t) => `${camposComuns(t, '#2563eb')}
      <label class="field"><span>Ordem de exibição</span><input type="number" name="ordem" min="0" step="1" value="${esc(t?.ordem ?? state.torres.length + 1)}"></label>
      <label class="check"><input type="checkbox" name="permite_sobreaviso" ${t?.permite_sobreaviso ? 'checked' : ''}> Possui sobreaviso</label>
      ${editorSerieHtml(t?.padrao_sobreaviso)}
      <label class="check"><input type="checkbox" name="ativo" ${!t || t.ativo ? 'checked' : ''}> Ativa</label>
      ${t?.permite_sobreaviso ? '<p class="hint">Desmarcar o sobreaviso remove a tag dos colaboradores e apaga os plantões desta torre.</p>' : ''}`,
    form: (f) => ({
      codigo: valor(f, 'codigo'),
      nome: valor(f, 'nome'),
      cor: valor(f, 'cor'),
      permite_sobreaviso: marcado(f, 'permite_sobreaviso'),
      padrao_sobreaviso: valor(f, 'padrao_sobreaviso'),
      ordem: valor(f, 'ordem'),
      ativo: marcado(f, 'ativo'),
    }),
  });
}

function viewTurnos() {
  const contar = (t) => state.colaboradores.filter((c) => c.turno_id === t.id).length;
  telaCadastro({
    titulo: 'Turnos',
    subtitulo: 'Horários de trabalho. O padrão define como a escala é gerada automaticamente.',
    recurso: 'turnos',
    // Agrupa pelo padrão da escala (5x2, 6x1, 12x36, livre) e, dentro dele, pelo horário de início.
    ordenar: (a, b) => ORDEM_PADRAO.indexOf(a.padrao) - ORDEM_PADRAO.indexOf(b.padrao) || a.inicio.localeCompare(b.inicio),
    novo: 'Novo turno',
    colunas: ['Tag', 'Nome', 'Horário', 'Duração', 'Padrão', 'Colaboradores', 'Status'],
    linha: (t) => [
      tagTurno(t),
      esc(t.nome),
      `${t.inicio} às ${t.fim}`,
      duracao(t.inicio, t.fim),
      esc(PADROES[t.padrao]),
      contar(t),
      t.ativo ? 'Ativo' : 'Inativo',
    ],
    emUso: (t) => contar(t) > 0,
    corpo: (t) => `${camposComuns(t, '#0ea5e9')}
      <div class="row">
        <label class="field"><span>Início *</span><input type="time" name="inicio" required value="${esc(t?.inicio)}"></label>
        <label class="field"><span>Fim *</span><input type="time" name="fim" required value="${esc(t?.fim)}"></label>
      </div>
      <label class="field"><span>Padrão de escala</span><select name="padrao">${Object.entries(PADROES)
        .map(([k, v]) => `<option value="${k}" ${(t?.padrao || '5x2') === k ? 'selected' : ''}>${v}</option>`)
        .join('')}</select></label>
      <label class="check"><input type="checkbox" name="ativo" ${!t || t.ativo ? 'checked' : ''}> Ativo</label>`,
    form: (f) => ({
      codigo: valor(f, 'codigo'),
      nome: valor(f, 'nome'),
      inicio: valor(f, 'inicio'),
      fim: valor(f, 'fim'),
      cor: valor(f, 'cor'),
      padrao: valor(f, 'padrao'),
      ativo: marcado(f, 'ativo'),
    }),
  });
}

// ---------- início ----------

function viewMesas() {
  const contar = (m) => state.colaboradores.filter((c) => c.mesa_id === m.id).length;
  telaCadastro({
    titulo: 'Mesas',
    subtitulo: 'Mesas de trabalho. Cada colaborador pode ter uma mesa, exibida como tag.',
    recurso: 'mesas',
    novo: 'Nova mesa',
    colunas: ['Ordem', 'Tag', 'Nome', 'Colaboradores', 'Status'],
    linha: (m) => [m.ordem, tagMesa(m), esc(m.nome), contar(m), m.ativo ? 'Ativa' : 'Inativa'],
    emUso: (m) => contar(m) > 0,
    corpo: (m) => `${camposComuns(m, '#0f766e')}
      <label class="field"><span>Ordem de exibição</span><input type="number" name="ordem" min="0" step="1" value="${esc(
        m?.ordem ?? state.mesas.length + 1
      )}"></label>
      <label class="check"><input type="checkbox" name="ativo" ${!m || m.ativo ? 'checked' : ''}> Ativa</label>`,
    form: (f) => ({
      codigo: valor(f, 'codigo'),
      nome: valor(f, 'nome'),
      cor: valor(f, 'cor'),
      ordem: valor(f, 'ordem'),
      ativo: marcado(f, 'ativo'),
    }),
  });
}

// ---------- login e sessão ----------

function telaLogin() {
  state.usuario = null;
  document.body.classList.add('deslogado');
  $('#usuario').hidden = true;
  main.innerHTML = `
    <div class="login">
      <form class="card login-card" id="form-login">
        <div class="brand"><span class="brand-logo">▦</span><span>Escala</span></div>
        <h1>Entrar</h1>
        <p class="muted">Use o seu e-mail cadastrado na escala.</p>
        <label class="field"><span>E-mail</span><input name="email" type="email" autocomplete="username" required></label>
        <label class="field"><span>Senha</span><input name="senha" type="password" autocomplete="current-password" required></label>
        <p class="form-error"></p>
        <button class="primary" type="submit">Entrar</button>
      </form>
    </div>`;
  const form = $('#form-login');
  form.elements.email.focus();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      const sessao = await api('POST', '/login', { email: valor(form, 'email'), senha: valor(form, 'senha') });
      await iniciarApp(sessao);
    } catch (err) {
      $('.form-error', form).textContent = err.message;
      btn.disabled = false;
    }
  };
}

function renderUsuario() {
  const el = $('#usuario');
  const u = state.usuario;
  el.hidden = !u;
  if (!u) return;
  el.innerHTML = `
    <div class="usuario-nome" title="${esc(u.email)}">${esc(u.nome)}</div>
    <button class="ghost" id="btn-senha">Trocar senha</button>
    <button class="ghost" id="btn-sair">Sair</button>`;
  $('#btn-senha').onclick = dialogTrocarSenha;
  $('#btn-sair').onclick = async () => {
    await api('POST', '/logout').catch(() => {});
    telaLogin();
  };
}

function dialogTrocarSenha() {
  abrirDialog({
    titulo: 'Trocar senha',
    confirmar: 'Salvar senha',
    corpo: `
      <label class="field"><span>Senha atual</span><input name="atual" type="password" autocomplete="current-password" required></label>
      <label class="field"><span>Nova senha (mínimo 8 caracteres)</span><input name="nova" type="password" autocomplete="new-password" minlength="8" required></label>
      <label class="field"><span>Repita a nova senha</span><input name="repetir" type="password" autocomplete="new-password" required></label>`,
    async onSubmit(form) {
      if (valor(form, 'nova') !== valor(form, 'repetir')) throw new Error('As novas senhas não conferem.');
      await api('POST', '/senha', { atual: valor(form, 'atual'), nova: valor(form, 'nova') });
      state.usuario.senhaPadrao = false;
      toast('Senha alterada.');
    },
  });
}

async function iniciarApp(sessao) {
  state.usuario = sessao;
  document.body.classList.remove('deslogado');
  renderUsuario();
  await carregarBase();
  rota();
  if (sessao.senhaPadrao) toast('Você está usando a senha padrão. Troque em "Trocar senha", no menu.');
}

fetch('/api/sessao')
  .then(async (r) => {
    if (r.status === 401) return telaLogin();
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).erro || `HTTP ${r.status}`);
    await iniciarApp(await r.json());
  })
  .catch((e) => {
    main.innerHTML = `<div class="empty">Não foi possível conectar ao servidor: ${esc(e.message)}</div>`;
  });
