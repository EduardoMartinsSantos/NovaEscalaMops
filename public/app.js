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
  contratos: [],
  colaboradores: [],
  mes: mesAtual(),
  filtro: { busca: '' },
  filtrosEscala: {}, // filtros por coluna da escala, estilo Excel (chave → Set de valores permitidos)
  agrupar: lerPreferencia('agrupar', 'torre'), // 'torre' | 'turno'
  detalhesRecolhidos: lerPreferencia('detalhesRecolhidos', '0') === '1', // colunas Torre…Escala recolhidas na escala
  // Série do pincel Sobreaviso (configurável, guardada no navegador). 1 dia = lançamento pontual.
  serieSA: lerPreferencia('serieSA', lerPreferencia('horasSA', '8')),
  filtroColab: { busca: '' },
  filtrosColab: {}, // filtros por coluna da tela de colaboradores (chave → Set de valores permitidos)
  selecionados: new Set(), // ids marcados na lista de colaboradores
  editando: false, // tabela de colaboradores em modo edição
  rascunho: new Map(), // id → campos alterados ainda não salvos
  ultimoSelecionado: null,
  ordemColab: { campo: '', dir: 1 }, // ordenação da tabela de colaboradores (chave de COLUNAS_COLAB; '' = por nome)
  escala: null,
  pincel: null, // valor aplicado direto ao clicar/arrastar nas células
};

const porId = (lista, id) => lista.find((x) => x.id === id);

async function carregarBase() {
  [state.torres, state.turnos, state.mesas, state.contratos, state.colaboradores] = await Promise.all([
    api('GET', '/torres'),
    api('GET', '/turnos'),
    api('GET', '/mesas'),
    api('GET', '/contratos'),
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
const tagContrato = (x) => (x ? tagTorre(x, 'contrato') : '');

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
  fecharFiltro();
  fecharPopover();
  if (state.pincel !== null) {
    state.pincel = null;
    limparPrevia();
    renderLegenda();
  }
});
addEventListener('resize', fecharPopover);

// ---------- roteamento ----------

const VIEWS = {
  escala: viewEscala,
  colaboradores: viewColaboradores,
  cadastros: () => viewCadastros(),
  // Endereços antigos de cada cadastro: abrem a tela Cadastros já no bloco.
  torres: () => viewCadastros('torres'),
  turnos: () => viewCadastros('turnos'),
  mesas: () => viewCadastros('mesas'),
  contratos: () => viewCadastros('contratos'),
  sobreaviso: () => viewCadastros('sobreaviso'),
};
const NAV_DA_VIEW = { torres: 'cadastros', turnos: 'cadastros', mesas: 'cadastros', contratos: 'cadastros', sobreaviso: 'cadastros' };

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
  let view = VIEWS[nome] ? nome : 'escala';
  // A tela de colaboradores é só para admins.
  if (view === 'colaboradores' && !state.usuario.admin) {
    view = 'escala';
    history.replaceState(null, '', '#escala');
  }
  const nav = NAV_DA_VIEW[view] || view;
  document.querySelectorAll('nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === nav));
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
      <div><h1>Escala</h1><p>${
        podeEditarEscala()
          ? 'Clique numa célula para definir o turno, ou escolha um pincel na legenda e arraste.'
          : 'Somente leitura: apenas administradores editam a escala.'
      }</p></div>
      <div class="month-nav">
        <button class="icon" id="mes-ant" title="Mês anterior">‹</button>
        <strong id="mes-label">${esc(rotuloMes(state.mes))}</strong>
        <button class="icon" id="mes-prox" title="Próximo mês">›</button>
        <button id="mes-hoje">Hoje</button>
      </div>
    </div>
    <div class="toolbar">
      <input id="f-busca" type="search" placeholder="Buscar colaborador…" value="${esc(f.busca)}">
      <button class="ghost" id="limpar-filtros-escala" title="Remover os filtros das colunas" hidden>✕ Limpar filtros</button>
      <button class="ghost" id="ordem-padrao" title="Voltar as linhas para a ordem automática (torre/turno e nome)" hidden>↺ Ordem padrão</button>
      <div class="segmented" id="agrupar" role="group" aria-label="Agrupar por">
        <span>Agrupar por</span>
        <button data-g="torre" class="${state.agrupar === 'torre' ? 'active' : ''}">Torre</button>
        <button data-g="turno" class="${state.agrupar === 'turno' ? 'active' : ''}">Turno</button>
        <button data-g="fds" class="${state.agrupar === 'fds' ? 'active' : ''}" title="Agrupa pelo turno de fim de semana">Fim de semana</button>
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
  $('#ordem-padrao').onclick = async () => {
    if (!confirm('Voltar todas as linhas da escala para a ordem automática? A ordem definida arrastando será perdida.')) return;
    try {
      await api('DELETE', '/escala/ordem');
      state.colaboradores.forEach((c) => (c.ordem_escala = null));
      renderGrade();
      toast('Ordem padrão restaurada.');
    } catch (err) {
      toast(err.message, true);
    }
  };
  $('#limpar-filtros-escala').onclick = () => {
    state.filtrosEscala = {};
    renderGrade();
  };
  $('#f-busca').oninput = (e) => ((f.busca = e.target.value), renderGrade());
  $('#agrupar').onclick = (e) => {
    const b = e.target.closest('button[data-g]');
    if (!b || b.dataset.g === state.agrupar) return;
    state.agrupar = b.dataset.g;
    salvarPreferencia('agrupar', state.agrupar);
    $('#agrupar').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
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

// Busca por nome + filtros por coluna (vale para as três tabelas da escala e para o Excel).
function passaFiltroEscala(c, ignorar) {
  const busca = state.filtro.busca.trim().toLowerCase();
  return (!busca || c.nome.toLowerCase().includes(busca)) && passaFiltros(c, COLUNAS_ESCALA, state.filtrosEscala, ignorar);
}

function colaboradoresVisiveis() {
  return state.colaboradores.filter((c) => c.ativo && c.na_escala && passaFiltroEscala(c));
}

// ----- Exportar Excel: mesma visualização da tela (grupos, filtros, cores, 12x36 e sobreaviso) -----

// Mistura a cor com branco: pct = quanto da cor original fica (0 a 1).
function misturarComBranco(hex, pct) {
  const n = parseInt(hex.replace('#', ''), 16);
  const canal = (v) => Math.round(v * pct + 255 * (1 - pct)).toString(16).padStart(2, '0');
  return `#${canal((n >> 16) & 255)}${canal((n >> 8) & 255)}${canal(n & 255)}`;
}

// Mesmas cores da grade da escala (tema claro).
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
  const INFO = 8; // Nome, Torre, Turno, Mesa, Contrato, Horário, Horário FDS, Escala
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
  const infoColaborador = (c, escala, horario) => {
    const torre = porId(state.torres, c.torre_id);
    const turno = porId(state.turnos, c.turno_id);
    const mesa = porId(state.mesas, c.mesa_id);
    const contrato = porId(state.contratos, c.contrato_id);
    return [
      { v: c.nome.toUpperCase(), e: { bold: true, align: 'left' } },
      { v: torre?.codigo || '' },
      { v: turno?.codigo || '' },
      { v: mesa?.codigo || '' },
      { v: contrato?.codigo || '' },
      { v: horario ?? horarioDoTurno(turno) },
      { v: textoFds(c) },
      escala || { v: (turno?.padrao || '').toUpperCase() },
    ];
  };
  const celulaDia = (x, d, c) => {
    if (!x) return vazioDoDia(d);
    if (x.tipo === 'TURNO') return { v: textoPlanilha(x, c), e: XL.trabalho };
    if (x.tipo === 'FOLGA') return { v: '', e: XL.folga };
    return { v: AUSENCIAS[x.tipo].nome.toUpperCase(), e: x.tipo === 'FERIAS' ? XL.ferias : XL.atestado };
  };

  const cabecalho = (ultima) =>
    linhas.push({
      altura: 30,
      celulas: [
        ...['NOME', 'TORRE', 'TURNO', 'MESA', 'CONTRATO', 'HORÁRIO', 'HORÁRIO FDS', ultima].map((v, i) => ({ v, e: { ...XL.cabecalho, align: i ? 'center' : 'left' } })),
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
        linhas.push({ celulas: [...infoColaborador(c), ...dias.map((d) => celulaDia(cel.get(`${c.id}|${d}`), d, c))] });
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
  const gruposPrincipais = gruposDaGrade(principais);
  blocoEscala(gruposPrincipais, gruposPrincipais.flatMap((g) => g.grupo));
  if (revezamento.length) {
    tituloBloco('12X36');
    cabecalho('ESCALA');
    const grupos12 = grupos12x36(revezamento);
    blocoEscala(grupos12, grupos12.flatMap((g) => g.grupo));
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
          ...infoColaborador(c, { v: fmtHoras(totalDe(c.id)), e: XL.total }, horarioSobreaviso(t)),
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
    colunas: [
      { largura: 38 }, { largura: 8 }, { largura: 8 }, { largura: 10 }, { largura: 11 }, { largura: 15 }, { largura: 15 }, { largura: 9 },
      ...dias.map(() => ({ largura: 8 })),
    ],
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

// ----- grade da escala: horário por extenso, trabalho em verde e folga em vermelho -----

const SEMANA_ABREV = ['DOM', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SÁB'];

function nomePlanilha(c, { escala, horario, arrastavel } = {}) {
  const torre = porId(state.torres, c.torre_id);
  const turno = porId(state.turnos, c.turno_id);
  const mesa = porId(state.mesas, c.mesa_id);
  const contrato = porId(state.contratos, c.contrato_id);
  return `<div class="pl">
    <span class="n" title="${esc(c.nome)}">${
      arrastavel ? '<span class="arrastar" draggable="true" title="Arraste para mudar a ordem dentro do grupo">⠿</span>' : ''
    }${esc(c.nome)}</span>
    <span>${esc(torre?.codigo || '')}</span>
    <span>${esc(turno?.codigo || '')}</span>
    <span>${esc(mesa?.codigo || '')}</span>
    <span>${esc(contrato?.codigo || '')}</span>
    <span>${esc(horario ?? horarioDoTurno(turno))}</span>
    <span title="Turno de fim de semana">${esc(textoFds(c))}</span>
    <span>${escala ?? esc((turno?.padrao || '').toUpperCase())}</span>
  </div>`;
}

function classePlanilha(cel) {
  if (!cel) return '';
  return { TURNO: 'p-trab', FOLGA: 'p-folga', FERIAS: 'p-ferias', ATESTADO: 'p-atestado' }[cel.tipo];
}

const horarioDoTurno = (t) => (t ? `${t.inicio} às ${t.fim}` : '');
const ehFimDeSemana = (data) => [0, 6].includes(new Date(`${data}T12:00:00`).getDay());
// Turno de fim de semana: um turno, nenhum (usa o normal) ou "Não participa" (fds_participa = 0, enviado como 'NP').
const naoParticipaFds = (c) => c?.fds_participa === 0;
const valorFds = (c) => (naoParticipaFds(c) ? 'NP' : c?.turno_fds_id ?? null);
const textoFds = (c) => (naoParticipaFds(c) ? 'Não participa' : horarioDoTurno(porId(state.turnos, c.turno_fds_id)));
// Turno esperado do colaborador no dia: sábado/domingo usam o turno de fim de semana, se houver
// (null = não trabalha no fim de semana).
function turnoDoDia(c, data) {
  // 12x36 trabalha pelo revezamento, inclusive no fim de semana: usa sempre o próprio turno.
  if (!ehFimDeSemana(data) || porId(state.turnos, c?.turno_id)?.padrao === '12x36') return c?.turno_id ?? null;
  if (naoParticipaFds(c)) return null;
  return c?.turno_fds_id || c?.turno_id || null;
}

// Opções do select de turno de fim de semana: vazio, "Não participa" e os turnos.
function opcoesFds(atual, rotulo, vazio) {
  return (
    `<option value="" ${atual === null || atual === '' ? 'selected' : ''}>${esc(vazio)}</option>` +
    `<option value="NP" ${atual === 'NP' ? 'selected' : ''}>Não participa</option>` +
    opcoes(state.turnos, typeof atual === 'number' ? atual : null, rotulo)
  );
}
// Horário do sobreaviso da torre (Cadastros → Sobreaviso); '—' se não definido.
const horarioSobreaviso = (t) => (t?.sobreaviso_inicio ? `${t.sobreaviso_inicio} às ${t.sobreaviso_fim}` : '—');

// Texto do quadrado do dia: vazio no turno esperado da pessoa naquele dia (normal ou de fim de semana — o horário
// fica nas colunas); o código do turno quando é outro; férias e atestado por extenso.
function textoPlanilha(cel, c) {
  if (!cel || cel.tipo === 'FOLGA') return '';
  if (cel.tipo === 'TURNO') {
    return cel.turno_id !== turnoDoDia(c, cel.data) ? porId(state.turnos, cel.turno_id)?.codigo || '' : '';
  }
  return AUSENCIAS[cel.tipo].nome.toUpperCase();
}

function tituloCelula(cel) {
  if (!cel) return '';
  if (cel.tipo === 'TURNO') {
    const t = porId(state.turnos, cel.turno_id);
    return t ? `${t.codigo} · ${horarioDoTurno(t)}` : '';
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
// Ordem manual (arrastar e soltar) vem primeiro; quem não tem ordem manual vai depois, na ordem automática.
const comOrdemManual = (automatica) => (a, b) => {
  const oa = a.ordem_escala ?? null;
  const ob = b.ordem_escala ?? null;
  if (oa !== null && ob !== null && oa !== ob) return oa - ob;
  if (oa !== null && ob === null) return -1;
  if (oa === null && ob !== null) return 1;
  return automatica(a, b);
};

const eh12x36 = (c) => porId(state.turnos, c.turno_id)?.padrao === '12x36';

// Tabela 12x36: um grupo por torre (12x36 N1, 12x36 N2…), na ordem das torres; dentro, por turno (TPA, TPB…) e nome.
function grupos12x36(colabs) {
  const porCodigo = (a, b) => a.codigo.localeCompare(b.codigo, 'pt-BR', { numeric: true });
  const codigoTurno = (c) => porId(state.turnos, c.turno_id)?.codigo || '';
  return state.torres
    .map((torre) => {
      const membros = colabs
        .filter((c) => c.torre_id === torre.id)
        .sort(comOrdemManual((a, b) => codigoTurno(a).localeCompare(codigoTurno(b), 'pt-BR', { numeric: true }) || a.nome.localeCompare(b.nome)));
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
  // Fim de semana: um grupo por turno de fim de semana (na ordem dos turnos) e, por último, quem não tem.
  // Quem não participa dos fins de semana fica de fora desta visão.
  if (state.agrupar === 'fds') {
    const ordemTorre = new Map(state.torres.map((t, i) => [t.id, i]));
    const porTorre = (a, b) =>
      (ordemTorre.get(a.torre_id) ?? 999) - (ordemTorre.get(b.torre_id) ?? 999) || a.nome.localeCompare(b.nome);
    const turnos = [...state.turnos].sort(
      (a, b) => ORDEM_PADRAO.indexOf(a.padrao) - ORDEM_PADRAO.indexOf(b.padrao) || a.inicio.localeCompare(b.inicio)
    );
    return [
      ...turnos.map((t) => ({
        titulo: `Fim de semana: ${t.codigo} — ${t.nome} (${t.inicio} às ${t.fim})`,
        cabecalho: `<strong>FDS</strong> ${tagTurno(t)} ${esc(t.nome)} <span class="muted">${t.inicio} às ${t.fim}</span>`,
        grupo: colabs.filter((c) => !naoParticipaFds(c) && c.turno_fds_id === t.id).sort(comOrdemManual(porTorre)),
      })),
      {
        titulo: 'Sem turno de fim de semana',
        cabecalho: '<strong>FDS</strong> <span class="muted">Sem turno de fim de semana (usa o turno normal)</span>',
        grupo: colabs.filter((c) => !naoParticipaFds(c) && !c.turno_fds_id).sort(comOrdemManual(porTorre)),
      },
    ].filter((g) => g.grupo.length);
  }
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
        grupo: colabs.filter((c) => c.turno_id === t.id).sort(comOrdemManual(porTorre)),
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
      grupo: colabs.filter((c) => c.torre_id === t.id).sort(comOrdemManual(porTurno)),
    }))
    .filter((g) => g.grupo.length);
}

// Dados de cada seção de sobreaviso do mês (usados pela grade e pelo Excel).
// Cada colaborador habilitado tem uma linha; várias pessoas podem cobrir a mesma torre no mesmo dia.
function secoesSobreaviso() {
  const { dias, sobreaviso } = state.escala;
  return state.torres
    .filter((t) => t.permite_sobreaviso && t.ativo && t.sobreaviso_visivel)
    .map((t) => {
      const lanc = sobreaviso.filter((s) => s.torre_id === t.id);
      const cobertos = new Set(lanc.map((s) => s.data));
      return {
        torre: t,
        porPessoa: new Map(lanc.map((s) => [`${s.colaborador_id}|${s.data}`, s])),
        cobertos,
        habilitados: state.colaboradores
          .filter(
            (c) =>
              c.na_escala &&
              passaFiltroEscala(c) &&
              ((c.ativo && c.sobreaviso_torre_id === t.id) || lanc.some((s) => s.colaborador_id === c.id))
          )
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

  const botaoDetalhes = `<button class="recolher" data-recolher title="${
    state.detalhesRecolhidos ? 'Mostrar' : 'Recolher'
  } as colunas Torre, Turno, Mesa, Contrato, Horário e Escala">${state.detalhesRecolhidos ? '▸' : '◂'}</button>`;
  const bf = (chave) => botaoFiltro(chave, state.filtrosEscala);
  const cabNome = `<div class="pl"><span>Nome ${bf('nome')} ${botaoDetalhes}</span>`
    + `<span>Torre ${bf('torre')}</span><span>Turno ${bf('turno')}</span><span>Mesa ${bf('mesa')}</span>`
    + `<span>Contrato ${bf('contrato')}</span><span>Horário ${bf('horario')}</span><span>Horário FDS ${bf('horario_fds')}</span><span>Escala ${bf('escala')}</span></div>`;
  const cabDias = dias
    .map((d) => `<th class="${clsDia(d)}">${SEMANA_ABREV[diaSemana(d)]}<small>${d.slice(8)}/${d.slice(5, 7)}</small></th>`)
    .join('');
  // Uma tabela de escala (cabeçalho, grupos e a linha "Em serviço" dos seus colaboradores).
  const tabelaEscala = (chave, grupos, membros, vazio) => {
    const arrastavel = podeEditarEscala();
    let t = `<table class="grid planilha"><thead><tr><th class="name">${cabNome}</th>${cabDias}</tr></thead><tbody>`;
    if (vazio) t += `<tr><td class="name muted">${vazio}</td><td colspan="${dias.length}"></td></tr>`;
    for (const [gi, { cabecalho, grupo }] of grupos.entries()) {
      t += `<tr class="group"><td class="name">${cabecalho} <span class="muted">(${grupo.length})</span></td><td colspan="${dias.length}"></td></tr>`;
      for (const c of grupo) {
        t += `<tr data-colab="${c.id}" data-grupo="${chave}-${gi}"><td class="name">${nomePlanilha(c, { arrastavel })}</td>`;
        for (const d of dias) {
          const x = cel.get(`${c.id}|${d}`);
          t += `<td class="cell ${clsDia(d)} ${classePlanilha(x)}" data-c="${c.id}" data-d="${d}" title="${esc(tituloCelula(x))}">${textoPlanilha(x, c)}</td>`;
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
  // "Em serviço" conta só quem aparece em cada tabela (ex.: a visão Fim de semana oculta quem não participa).
  const exibidos = (grupos) => grupos.flatMap((g) => g.grupo);
  const gruposPrincipais = gruposDaGrade(principais);
  let html = tabelaEscala('p', gruposPrincipais, exibidos(gruposPrincipais), colabs.length ? '' : 'Nenhum colaborador.');
  if (revezamento.length) {
    html += `<div class="tabela-titulo">12x36</div>${tabelaEscala('12', grupos12x36(revezamento), exibidos(grupos12x36(revezamento)))}`;
  }

  // Sobreaviso: tabela própria abaixo da escala, com o mesmo cabeçalho de dias (as colunas ficam alinhadas).
  // Cada colaborador habilitado tem uma linha, com as horas de cada dia e o total do mês.
  const secoes = secoesSobreaviso();
  if (secoes.length) {
    const cabSA = `<div class="pl"><span>Nome ${bf('nome')} ${botaoDetalhes}</span>`
      + `<span>Torre ${bf('torre')}</span><span>Turno ${bf('turno')}</span><span>Mesa ${bf('mesa')}</span>`
      + `<span>Contrato ${bf('contrato')}</span><span>Horário</span><span>Horário FDS</span><span>Horas</span></div>`;
    html += `<div class="tabela-titulo">Sobreaviso</div>
      <table class="grid sa-tabela planilha"><thead><tr><th class="name">${cabSA}</th>${cabDias}</tr></thead><tbody>`;
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
      html += `<tr class="sa-row"><td class="name">${nomePlanilha(c, { escala: totalTxt, horario: horarioSobreaviso(t) })}</td>${dias
        .map((d) => {
          const s = porPessoa.get(`${c.id}|${d}`);
          const aus = ausencia(c.id, d);
          const conteudo = s ? (s.horas != null ? fmtHoras(s.horas) : 'SOBREAVISO') : '';
          const titulo = s ? `Sobreaviso ${t.codigo}${s.horas != null ? ` · ${fmtHoras(s.horas)}` : ''}` : aus ? 'Ausente (férias/atestado)' : '';
          return `<td class="sa-cell ${clsDia(d)} ${s ? 'sa-on' : ''} ${aus ? 'sa-aus' : ''}" style="--c:${esc(
            t.cor
          )}" data-t="${t.id}" data-c="${c.id}" data-d="${d}" title="${esc(titulo)}">${conteudo}</td>`;
        })
        .join('')}</tr>`;
    }
  }
  if (secoes.length) html += '</tbody></table>';
  wrap.innerHTML = html;
  wrap.classList.toggle('recolhido', state.detalhesRecolhidos);
  const limpar = $('#limpar-filtros-escala');
  if (limpar) limpar.hidden = !Object.keys(state.filtrosEscala).length;
  const ordemPadrao = $('#ordem-padrao');
  if (ordemPadrao) ordemPadrao.hidden = !podeEditarEscala() || !state.colaboradores.some((c) => c.ordem_escala != null);
  wrap.classList.toggle('somente-leitura', !podeEditarEscala());
}

// Só admins lançam na escala e no sobreaviso; os demais veem em modo leitura.
const podeEditarEscala = () => !!state.usuario?.admin;

function renderLegenda() {
  const el = $('#legenda');
  if (!el) return;
  if (!podeEditarEscala()) {
    state.pincel = null;
    el.innerHTML = '';
    return;
  }
  const item = (v, chip, rotulo, titulo = '') =>
    `<button data-pincel="${v}" class="${state.pincel === v ? 'active' : ''}" title="${esc(titulo)}">${chip}${esc(rotulo)}</button>`;
  const serie = lerSerie(state.serieSA);
  const resumoSA = serie.length === 1 ? (serie[0] === null ? 'folga' : fmtHoras(serie[0])) : `${serie.length} dias`;
  const fixas =
    state.torres
      .filter((t) => t.permite_sobreaviso && t.padrao_sobreaviso)
      .map((t) => `${t.codigo}: ${descreverSerie(t.padrao_sobreaviso)}`)
      .join('\n') || 'Nenhuma torre com série fixa (Cadastros → Torres)';
  // "Trabalho" aplica o turno cadastrado de cada colaborador; atestado fica no clique da célula.
  // "Folga" e "Limpar" também valem nas linhas de sobreaviso (folga = sem sobreaviso no dia).
  // "Sobreaviso" usa a série configurável (⚙): com 1 dia é pontual e pinta arrastando; com mais, prévia + clique.
  // "Série" aplica a série fixa da torre (N3/ESPEC, N2…) a partir do dia clicado, com prévia ao passar o mouse.
  el.innerHTML =
    `<span class="label">Pincel:</span>` +
    item('TRABALHO', '<span class="chip trabalho">T</span>', 'Trabalho') +
    item('FOLGA', `<span class="chip folga">${AUSENCIAS.FOLGA.sigla}</span>`, AUSENCIAS.FOLGA.nome, 'Folga na escala; no sobreaviso, tira o sobreaviso do dia') +
    item('FERIAS', `<span class="chip ferias">${AUSENCIAS.FERIAS.sigla}</span>`, AUSENCIAS.FERIAS.nome) +
    item('', '<span class="chip">⌫</span>', 'Limpar') +
    (state.torres.some((t) => t.permite_sobreaviso && t.ativo && t.sobreaviso_visivel)
      ? `<span class="legend-sep"></span>` +
        item('SA', '<span class="chip sa-chip">☎</span>', 'Sobreaviso', `Série configurável: ${descreverSerie(state.serieSA)}`) +
        `<button class="serie-resumo" id="cfg-serie-sa" title="Configurar a série do pincel Sobreaviso">${esc(resumoSA)} ⚙</button>` +
        item('SERIE', '<span class="chip sa-chip">⇶</span>', 'Série fixa', fixas)
      : '') +
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
// "Trabalho" usa o turno do cadastro — no sábado/domingo, o turno de fim de semana (se a pessoa tiver).
function decodificar(v, colaboradorId, data) {
  if (!v) return { tipo: null, turno_id: null };
  if (v === 'TRABALHO') {
    // Quem não participa dos fins de semana recebe folga no sábado e no domingo.
    const turno = turnoDoDia(porId(state.colaboradores, colaboradorId), data);
    return turno ? { tipo: 'TURNO', turno_id: turno } : { tipo: 'FOLGA', turno_id: null };
  }
  if (v.startsWith('T:')) return { tipo: 'TURNO', turno_id: Number(v.slice(2)) };
  return { tipo: v, turno_id: null };
}

async function aplicarCelula(colaboradorId, data, v) {
  const { tipo, turno_id } = decodificar(v, colaboradorId, data);
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

// Aplica o pincel ativo numa célula (clique ou arraste): trabalho/folga/férias nas linhas de escala;
// Sobreaviso de 1 dia nas linhas de sobreaviso. "Folga" e "Limpar" valem para as duas (no sobreaviso, removem o dia).
function pintar(td) {
  if (td.matches('td.cell')) {
    if (state.pincel !== 'SA') aplicarCelula(Number(td.dataset.c), td.dataset.d, state.pincel);
    return;
  }
  const args = [Number(td.dataset.t), td.dataset.d, Number(td.dataset.c)];
  if (pincelSAPontual()) {
    const h = lerSerie(state.serieSA)[0];
    aplicarSobreaviso(...args, h === null ? { remover: true } : { horas: h });
  } else if (state.pincel === '' || state.pincel === 'FOLGA') aplicarSobreaviso(...args, { remover: true });
}

// Grava a nova ordem de um grupo (ids na ordem desejada). Atualiza a tela na hora; em caso de erro, recarrega.
const semAnimacao = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// Posição vertical de cada linha da escala (por colaborador), para animar a troca de lugar.
function posicoesLinhas() {
  const pos = new Map();
  document.querySelectorAll('#grid tr[data-colab]').forEach((tr) => pos.set(tr.dataset.colab + '|' + tr.dataset.grupo, tr.getBoundingClientRect().top));
  return pos;
}

// As linhas deslizam da posição antiga para a nova; a linha movida pisca em destaque.
function animarLinhas(antes, movido) {
  const linhas = [...document.querySelectorAll('#grid tr[data-colab]')];
  const destaque = linhas.find((tr) => Number(tr.dataset.colab) === movido);
  if (destaque) {
    destaque.classList.add('recem-movida');
    setTimeout(() => destaque.classList.remove('recem-movida'), 1200);
  }
  if (semAnimacao()) return;
  for (const tr of linhas) {
    const de = antes.get(tr.dataset.colab + '|' + tr.dataset.grupo);
    const delta = de === undefined ? 0 : de - tr.getBoundingClientRect().top;
    if (!delta) continue;
    tr.style.transition = 'none';
    tr.style.transform = `translateY(${delta}px)`;
    requestAnimationFrame(() => {
      tr.style.transition = 'transform .28s cubic-bezier(.2, .8, .2, 1)';
      tr.style.transform = '';
    });
    tr.addEventListener('transitionend', () => (tr.style.transition = ''), { once: true });
  }
}

async function salvarOrdemEscala(ids, movido) {
  const antes = posicoesLinhas();
  ids.forEach((id, i) => {
    const c = porId(state.colaboradores, id);
    if (c) c.ordem_escala = i + 1;
  });
  renderGrade();
  animarLinhas(antes, movido);
  try {
    await api('PUT', '/escala/ordem', { ids });
  } catch (err) {
    toast(err.message, true);
    await carregarBase();
    renderGrade();
  }
}

function ligarEventosGrade() {
  const wrap = $('#grid');
  const alvo = (e) => e.target.closest('td.cell, td.sa-cell');
  // Séries (fixa, ou Sobreaviso com mais de 1 dia) são aplicadas no clique, não no arraste.
  const aplicaNoClique = () => state.pincel === 'SERIE' || (state.pincel === 'SA' && !pincelSAPontual());

  wrap.addEventListener('mousedown', (e) => {
    if (!podeEditarEscala()) return;
    const td = alvo(e);
    if (!td || state.pincel === null || aplicaNoClique() || e.button !== 0) return;
    e.preventDefault();
    pintando = true;
    pintar(td);
  });
  wrap.addEventListener('mouseover', (e) => {
    if (!podeEditarEscala()) return;
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

  // Arrastar pela alça ⠿ muda a ordem da linha dentro do próprio grupo (só admins).
  let arrasto = null;
  const limparMarcas = () => {
    wrap.classList.remove('em-arrasto');
    wrap
      .querySelectorAll('.drop-acima, .drop-abaixo, .arrastando, .mesmo-grupo')
      .forEach((tr) => tr.classList.remove('drop-acima', 'drop-abaixo', 'arrastando', 'mesmo-grupo'));
  };
  wrap.addEventListener('dragstart', (e) => {
    const alca = e.target.closest?.('.arrastar');
    if (!alca || !podeEditarEscala()) return;
    const tr = alca.closest('tr');
    arrasto = { id: Number(tr.dataset.colab), grupo: tr.dataset.grupo };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(arrasto.id));
    // Imagem do arraste: um cartão com o nome, em vez da linha inteira da tabela.
    const cartao = document.createElement('div');
    cartao.className = 'cartao-arrasto';
    cartao.textContent = `⠿ ${porId(state.colaboradores, arrasto.id)?.nome || ''}`;
    document.body.append(cartao);
    e.dataTransfer.setDragImage?.(cartao, 16, 16);
    setTimeout(() => cartao.remove(), 0);
    // Destaca a linha arrastada e o grupo onde ela pode cair; o resto da tabela fica apagado.
    requestAnimationFrame(() => {
      tr.classList.add('arrastando');
      wrap.classList.add('em-arrasto');
      wrap.querySelectorAll(`tr[data-grupo="${arrasto.grupo}"]`).forEach((x) => x.classList.add('mesmo-grupo'));
    });
  });
  const linhaAlvo = (e) => {
    const tr = e.target.closest?.('tr[data-grupo]');
    return arrasto && tr && tr.dataset.grupo === arrasto.grupo && Number(tr.dataset.colab) !== arrasto.id ? tr : null;
  };
  wrap.addEventListener('dragover', (e) => {
    const tr = linhaAlvo(e);
    if (!tr) return;
    e.preventDefault();
    const r = tr.getBoundingClientRect();
    const acima = e.clientY < r.top + r.height / 2;
    wrap.querySelectorAll('.drop-acima, .drop-abaixo').forEach((x) => x !== tr && x.classList.remove('drop-acima', 'drop-abaixo'));
    tr.classList.toggle('drop-acima', acima);
    tr.classList.toggle('drop-abaixo', !acima);
  });
  wrap.addEventListener('drop', (e) => {
    const tr = linhaAlvo(e);
    if (!tr) return;
    e.preventDefault();
    const acima = tr.classList.contains('drop-acima');
    const ids = [...wrap.querySelectorAll(`tr[data-grupo="${arrasto.grupo}"]`)].map((x) => Number(x.dataset.colab)).filter((id) => id !== arrasto.id);
    const pos = ids.indexOf(Number(tr.dataset.colab)) + (acima ? 0 : 1);
    ids.splice(pos, 0, arrasto.id);
    const movido = arrasto.id;
    arrasto = null;
    limparMarcas();
    salvarOrdemEscala(ids, movido);
  });
  wrap.addEventListener('dragend', () => {
    arrasto = null;
    limparMarcas();
  });

  wrap.addEventListener('click', (e) => {
    const bf = e.target.closest('[data-filtro]');
    if (bf) {
      const chave = bf.dataset.filtro;
      const base = state.colaboradores.filter((c) => c.ativo && c.na_escala && passaFiltroEscala(c, chave));
      return abrirFiltro(bf, {
        titulo: COLUNAS_ESCALA[chave].rotulo,
        valores: base.map(COLUNAS_ESCALA[chave].valor),
        selecionados: state.filtrosEscala[chave],
        aoAplicar(sel) {
          if (sel) state.filtrosEscala[chave] = sel;
          else delete state.filtrosEscala[chave];
          renderGrade();
        },
      });
    }
    if (e.target.closest('[data-recolher]')) {
      state.detalhesRecolhidos = !state.detalhesRecolhidos;
      salvarPreferencia('detalhesRecolhidos', state.detalhesRecolhidos ? '1' : '0');
      return renderGrade();
    }
    if (!podeEditarEscala()) return;
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
  main.innerHTML = `
    <div class="page-head">
      <div><h1>Colaboradores</h1><p>Clique em Editar para alterar a tabela inteira; nada é gravado até Salvar alterações. Marque linhas para editar em massa.</p></div>
      <div class="head-actions" id="acoes-tabela"></div>
    </div>
    <div class="toolbar">
      <input id="busca" type="search" placeholder="Buscar por nome, e-mail ou telefone…" value="${esc(f.busca)}" style="min-width:260px">
      <button class="ghost" id="limpar-filtros-colab" title="Remover filtros e ordenação das colunas" hidden>✕ Limpar filtros</button>
    </div>
    <div class="lote-bar" id="lote" hidden></div>
    <div class="card list-wrap" id="lista"></div>`;

  renderAcoesTabela();
  $('#busca').oninput = (e) => ((f.busca = e.target.value), renderColaboradores());
  $('#limpar-filtros-colab').onclick = () => {
    state.filtrosColab = {};
    state.ordemColab = { campo: '', dir: 1 };
    renderColaboradores();
  };
  renderColaboradores();
}

function passaFiltroColab(c, ignorar) {
  const b = state.filtroColab.busca.trim().toLowerCase();
  return (
    (!b || [c.nome, c.email, c.telefone].some((v) => (v || '').toLowerCase().includes(b))) &&
    passaFiltros(c, COLUNAS_COLAB, state.filtrosColab, ignorar)
  );
}

function colaboradoresFiltrados() {
  const lista = state.colaboradores.filter((c) => passaFiltroColab(c));
  const { campo, dir } = state.ordemColab;
  if (!campo) return lista;
  // Ordena pelo valor salvo (as linhas não pulam durante a edição); empate por nome.
  const valor = COLUNAS_COLAB[campo].valor;
  return lista.sort((a, b) => dir * comparar(valor(a), valor(b)) || a.nome.localeCompare(b.nome, 'pt-BR'));
}

// ---------- Filtro por coluna, estilo Excel ----------
// Cada coluna filtrável tem um botão ▾ no cabeçalho que abre um painel com ordenação (opcional), pesquisa e a lista
// de valores existentes (com "(Selecionar tudo)" e "(Vazias)"). Filtro = Set dos valores permitidos; sem filtro = todos.

const comparar = (a, b) => (a === '' ? (b === '' ? 0 : 1) : b === '' ? -1 : a.localeCompare(b, 'pt-BR', { numeric: true }));
const codigoDe = (lista, id) => porId(lista, id)?.codigo || '';

const COLUNAS_ESCALA = {
  nome: { rotulo: 'Nome', valor: (c) => c.nome },
  torre: { rotulo: 'Torre', valor: (c) => codigoDe(state.torres, c.torre_id) },
  turno: { rotulo: 'Turno', valor: (c) => codigoDe(state.turnos, c.turno_id) },
  mesa: { rotulo: 'Mesa', valor: (c) => codigoDe(state.mesas, c.mesa_id) },
  contrato: { rotulo: 'Contrato', valor: (c) => codigoDe(state.contratos, c.contrato_id) },
  horario: { rotulo: 'Horário', valor: (c) => horarioDoTurno(porId(state.turnos, c.turno_id)) },
  horario_fds: { rotulo: 'Horário FDS', valor: (c) => textoFds(c) },
  escala: { rotulo: 'Escala', valor: (c) => (porId(state.turnos, c.turno_id)?.padrao || '').toUpperCase() },
};

const COLUNAS_COLAB = {
  nome: { rotulo: 'Nome', valor: (c) => c.nome },
  email: { rotulo: 'E-mail', valor: (c) => c.email || '' },
  telefone: { rotulo: 'Telefone', valor: (c) => c.telefone || '' },
  torre: COLUNAS_ESCALA.torre,
  turno: COLUNAS_ESCALA.turno,
  turno_fds: {
    rotulo: 'Turno FDS',
    titulo: 'Turno de fim de semana',
    valor: (c) => (naoParticipaFds(c) ? 'Não participa' : codigoDe(state.turnos, c.turno_fds_id)),
  },
  mesa: COLUNAS_ESCALA.mesa,
  contrato: COLUNAS_ESCALA.contrato,
  sobreaviso: { rotulo: 'Sobreaviso', valor: (c) => codigoDe(state.torres, c.sobreaviso_torre_id) },
  ativo: { rotulo: 'Ativo', titulo: 'Acesso ao sistema', valor: (c) => (c.ativo ? 'Sim' : 'Não') },
  na_escala: { rotulo: 'Na escala', titulo: 'Aparece na escala', valor: (c) => (c.na_escala ? 'Sim' : 'Não') },
};

function passaFiltros(item, colunas, filtros, ignorar) {
  return Object.entries(filtros).every(([k, permitidos]) => k === ignorar || permitidos.has(colunas[k].valor(item)));
}

function botaoFiltro(chave, filtros) {
  return `<button class="filtro-btn ${filtros[chave] ? 'ativo' : ''}" data-filtro="${chave}" title="${
    filtros[chave] ? 'Filtrado — clique para alterar' : 'Filtrar'
  }">▾</button>`;
}

function thFiltroColab(chave) {
  const col = COLUNAS_COLAB[chave];
  const { campo, dir } = state.ordemColab;
  const seta = campo === chave ? (dir === 1 ? ' ▲' : ' ▼') : '';
  return `<th class="th-filtro" ${col.titulo ? `title="${col.titulo}"` : ''}>${col.rotulo}${seta} ${botaoFiltro(chave, state.filtrosColab)}</th>`;
}

let painelFiltro = null;
function fecharFiltro() {
  painelFiltro?.remove();
  painelFiltro = null;
}
document.addEventListener('mousedown', (e) => {
  if (painelFiltro && !painelFiltro.contains(e.target) && !e.target.closest('[data-filtro]')) fecharFiltro();
});

function abrirFiltro(ancora, { titulo, valores, selecionados, ordem = 0, aoOrdenar, aoAplicar }) {
  fecharFiltro();
  const contagem = new Map();
  for (const v of valores) contagem.set(v, (contagem.get(v) || 0) + 1);
  // Valores filtrados por outras colunas que já estavam marcados continuam na lista.
  for (const v of selecionados || []) if (!contagem.has(v)) contagem.set(v, 0);
  const distintos = [...contagem.keys()].sort(comparar);
  const marcados = new Set(selecionados ? distintos.filter((v) => selecionados.has(v)) : distintos);

  const p = document.createElement('div');
  p.className = 'filtro-painel';
  p.innerHTML = `
    ${
      aoOrdenar
        ? `<button class="ghost ${ordem === 1 ? 'ativo' : ''}" data-ord="1">↑ Classificar de A a Z</button>
           <button class="ghost ${ordem === -1 ? 'ativo' : ''}" data-ord="-1">↓ Classificar de Z a A</button><hr>`
        : ''
    }
    <button class="ghost" data-limpar ${selecionados ? '' : 'disabled'}>✕ Limpar filtro de "${esc(titulo)}"</button>
    <input type="search" placeholder="Pesquisar" data-busca>
    <div class="filtro-lista" data-lista></div>
    <div class="filtro-acoes"><button class="primary" data-ok>OK</button><button data-cancelar>Cancelar</button></div>`;
  document.body.append(p);
  painelFiltro = p;

  const lista = p.querySelector('[data-lista]');
  const busca = p.querySelector('[data-busca]');
  const ok = p.querySelector('[data-ok]');
  const rotulo = (v) => (v === '' ? '(Vazias)' : v);
  const visiveis = () => {
    const t = busca.value.trim().toLowerCase();
    return distintos.filter((v) => !t || rotulo(v).toLowerCase().includes(t));
  };
  const desenhar = () => {
    const vis = visiveis();
    const todos = vis.length > 0 && vis.every((v) => marcados.has(v));
    const algum = vis.some((v) => marcados.has(v));
    lista.innerHTML = vis.length
      ? `<label class="filtro-item filtro-tudo"><input type="checkbox" data-tudo ${todos ? 'checked' : ''}><span>(Selecionar tudo)</span></label>` +
        vis
          .map(
            (v) => `<label class="filtro-item"><input type="checkbox" data-i="${distintos.indexOf(v)}" ${marcados.has(v) ? 'checked' : ''}>
              <span class="${v === '' ? 'muted' : ''}">${esc(rotulo(v))}</span><small>${contagem.get(v)}</small></label>`
          )
          .join('')
      : '<div class="muted filtro-vazio">Nenhum resultado</div>';
    const tudo = lista.querySelector('[data-tudo]');
    if (tudo) tudo.indeterminate = algum && !todos;
    ok.disabled = !algum; // como no Excel: não dá para aplicar sem nenhum valor marcado
  };
  lista.onchange = (e) => {
    if (e.target.matches('[data-tudo]')) visiveis().forEach((v) => (e.target.checked ? marcados.add(v) : marcados.delete(v)));
    else {
      const v = distintos[Number(e.target.dataset.i)];
      if (e.target.checked) marcados.add(v);
      else marcados.delete(v);
    }
    desenhar();
  };
  busca.oninput = desenhar;
  busca.onkeydown = (e) => {
    if (e.key === 'Enter' && !ok.disabled) ok.click();
  };
  p.onclick = (e) => {
    if (e.target.closest('[data-cancelar]')) return fecharFiltro();
    if (e.target.closest('[data-limpar]')) {
      fecharFiltro();
      return aoAplicar(null);
    }
    const ord = e.target.closest('[data-ord]');
    if (ord) {
      fecharFiltro();
      return aoOrdenar(Number(ord.dataset.ord));
    }
    if (e.target.closest('[data-ok]')) {
      // Com pesquisa, vale só o que está visível e marcado (como no Excel).
      const escolhidos = new Set(busca.value.trim() ? visiveis().filter((v) => marcados.has(v)) : marcados);
      fecharFiltro();
      aoAplicar(escolhidos.size === distintos.length ? null : escolhidos);
    }
  };
  desenhar();

  // Posição: logo abaixo do botão, sem sair da janela.
  const r = ancora.getBoundingClientRect();
  const largura = p.offsetWidth || 260;
  const altura = p.offsetHeight || 360;
  p.style.left = `${Math.max(8, Math.min(r.left, innerWidth - largura - 8))}px`;
  p.style.top = `${r.bottom + altura + 8 > innerHeight ? Math.max(8, r.top - altura - 4) : r.bottom + 4}px`;
  busca.focus();
}

// ----- Tabela de colaboradores: leitura por padrão; "Editar" libera a tabela inteira -----
// No modo edição as mudanças ficam em state.rascunho (id → campos alterados) até "Salvar alterações".

const CAMPOS_SELECT = {
  torre_id: () => state.torres,
  turno_id: () => state.turnos,
  turno_fds_id: () => state.turnos,
  sobreaviso_torre_id: () => state.torres,
  mesa_id: () => state.mesas,
  contrato_id: () => state.contratos,
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
  const original = campo === 'turno_fds_id' ? valorFds(c) : c[campo];
  if (normalizar(valor) === normalizar(original)) delete r[campo];
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
// Coluna "Acesso" (visível só para admins): funciona nos dois modos, fora do rascunho de edição.
function celulaAcesso(c) {
  return `<td class="acesso nowrap"><div>
    <span class="${c.senha_padrao ? 'muted' : ''}" title="${c.senha_padrao ? 'Ainda usa a senha padrão' : 'Já trocou a senha'}">${
      c.senha_padrao ? 'Senha padrão' : 'Senha própria'
    }</span>
    <button class="ghost icon" data-reset="${c.id}" title="Voltar a senha de ${esc(c.nome)} para a padrão">🔑</button>
    <label class="interruptor" title="Administrador"><input type="checkbox" data-admin="${c.id}" ${c.admin ? 'checked' : ''}><span></span>Admin</label>
  </div></td>`;
}

// Turno de fim de semana na tabela (inclui "Não participa").
function celulaFds(c, travado) {
  const r = state.rascunho.get(c.id);
  const v = r && 'turno_fds_id' in r ? r.turno_fds_id : valorFds(c);
  const atual = v === 'NP' ? 'NP' : v === '' || v === null || v === undefined ? null : Number(v);
  const item = typeof atual === 'number' ? porId(state.turnos, atual) : null;
  return `<td class="ed ${alterado(c, 'turno_fds_id') ? 'alterado' : ''}"><select data-f="turno_fds_id" class="tag-sel" ${
    travado ? 'disabled' : ''
  } style="--c:${esc(item?.cor || 'transparent')}">${opcoesFds(atual, (t) => `${t.codigo} · ${t.inicio}–${t.fim}`, '—')}</select></td>`;
}

function linhaColaborador(c, torresSA, travado) {
  const ativo = normalizar(valorAtual(c, 'ativo')) === '1';
  return `
    ${celulaTexto(c, 'nome', 'w-nome', 'text', travado)}
    ${celulaTexto(c, 'email', 'w-email', 'email', travado)}
    ${celulaTexto(c, 'telefone', 'w-tel', 'tel', travado)}
    ${celulaSelect(c, 'torre_id', state.torres, (t) => t.codigo, undefined, travado)}
    ${celulaSelect(c, 'turno_id', state.turnos, (t) => `${t.codigo} · ${t.inicio}–${t.fim}`, undefined, travado)}
    ${celulaFds(c, travado)}
    ${celulaSelect(c, 'mesa_id', state.mesas, (m) => m.codigo, '—', travado)}
    ${celulaSelect(c, 'contrato_id', state.contratos, (x) => x.codigo, '—', travado)}
    ${celulaSelect(c, 'sobreaviso_torre_id', torresSA, (t) => t.codigo, '—', travado)}
    <td class="ed center ${alterado(c, 'ativo') ? 'alterado' : ''}"><input type="checkbox" data-f="ativo" ${ativo ? 'checked' : ''} ${
      travado ? 'disabled' : ''
    }></td>
    <td class="ed center ${alterado(c, 'na_escala') ? 'alterado' : ''}"><input type="checkbox" data-f="na_escala" ${
      normalizar(valorAtual(c, 'na_escala')) === '1' ? 'checked' : ''
    } ${travado ? 'disabled' : ''} title="Aparece na escala"></td>
    ${state.usuario?.admin ? celulaAcesso(c) : ''}
    <td class="actions">${travado ? `<button class="ghost danger icon" data-del="${c.id}" title="Excluir">✕</button>` : ''}</td>`;
}

function renderColaboradores() {
  const lista = colaboradoresFiltrados();
  const limpar = $('#limpar-filtros-colab');
  if (limpar) limpar.hidden = !Object.keys(state.filtrosColab).length && !state.ordemColab.campo;
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
      ${['nome', 'email', 'telefone', 'torre', 'turno', 'turno_fds', 'mesa', 'contrato', 'sobreaviso', 'ativo', 'na_escala']
        .map(thFiltroColab)
        .join('')}${state.usuario?.admin ? '<th>Acesso</th>' : ''}<th></th>
    </tr></thead><tbody>${lista
      .map((c) => {
        const inativo = normalizar(valorAtual(c, 'ativo')) !== '1';
        return `<tr class="${inativo ? 'inativo' : ''} ${sel.has(c.id) ? 'selecionado' : ''}" data-id="${c.id}">
          <td class="sel"><input type="checkbox" data-sel="${c.id}" ${sel.has(c.id) ? 'checked' : ''}></td>
          ${linhaColaborador(c, torresSA, !editando)}</tr>`;
      })
      .join('')}</tbody></table>`;


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
  el.onchange = async (e) => {
    const adm = e.target.closest('[data-admin]');
    if (adm) {
      const c = porId(state.colaboradores, Number(adm.dataset.admin));
      adm.disabled = true;
      try {
        await api('PUT', `/colaboradores/${c.id}/admin`, { admin: adm.checked });
        toast(`${c.nome} ${adm.checked ? 'agora é administrador' : 'deixou de ser administrador'}.`);
        if (c.id === state.usuario.id && !adm.checked) {
          state.usuario.admin = false;
          renderUsuario();
          location.hash = '#escala';
          return;
        }
      } catch (err) {
        toast(err.message, true);
      }
      await carregarBase();
      return renderColaboradores();
    }
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
    const bf = e.target.closest('[data-filtro]');
    if (bf) {
      const chave = bf.dataset.filtro;
      const col = COLUNAS_COLAB[chave];
      return abrirFiltro(bf, {
        titulo: col.rotulo,
        valores: state.colaboradores.filter((c) => passaFiltroColab(c, chave)).map(col.valor),
        selecionados: state.filtrosColab[chave],
        ordem: state.ordemColab.campo === chave ? state.ordemColab.dir : 0,
        aoOrdenar(dir) {
          state.ordemColab = { campo: chave, dir };
          renderColaboradores();
        },
        aoAplicar(sel) {
          if (sel) state.filtrosColab[chave] = sel;
          else delete state.filtrosColab[chave];
          renderColaboradores();
        },
      });
    }
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
    const reset = e.target.closest('[data-reset]');
    if (reset) {
      const c = porId(state.colaboradores, Number(reset.dataset.reset));
      if (!confirm(`Voltar a senha de ${c.nome} para a senha padrão?`)) return;
      try {
        await api('POST', `/colaboradores/${c.id}/resetar-senha`);
        toast(`Senha de ${c.nome} voltou para a padrão.`);
        await carregarBase();
        renderColaboradores();
      } catch (err) {
        toast(err.message, true);
      }
      return;
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
        <label class="field"><span>Turno de fim de semana</span><select name="turno_fds_id">${manter}${opcoesFds(
          '__nenhum',
          (t) => `${t.codigo} — ${t.inicio} às ${t.fim}`,
          'Sem turno de fim de semana'
        )}</select></label>
      </div>
      <div class="row">
        <label class="field"><span>Mesa</span>${sel('mesa_id', state.mesas, (m) => `${m.codigo} — ${m.nome}`, 'Sem mesa')}</label>
        <label class="field"><span>Contrato</span>${sel('contrato_id', state.contratos, (x) => `${x.codigo} — ${x.nome}`, 'Sem contrato')}</label>
      </div>
      <div class="row">
        <label class="field"><span>Sobreaviso</span>${sel(
          'sobreaviso_torre_id',
          state.torres.filter((t) => t.permite_sobreaviso),
          (t) => `${t.codigo} — ${t.nome}`,
          'Nenhum'
        )}</label>
      </div>
      <div class="row">
        <label class="field"><span>Status (acesso)</span><select name="ativo">${manter}<option value="1">Ativo</option><option value="0">Inativo</option></select></label>
        <label class="field"><span>Na escala</span><select name="na_escala">${manter}<option value="1">Aparece</option><option value="0">Não aparece</option></select></label>
      </div>`,
    async onSubmit(form) {
      const campos = {};
      for (const k of ['torre_id', 'turno_id', 'turno_fds_id', 'mesa_id', 'contrato_id', 'sobreaviso_torre_id']) {
        if (valor(form, k) !== '__manter') campos[k] = valor(form, k);
      }
      if (valor(form, 'ativo') !== '__manter') campos.ativo = valor(form, 'ativo') === '1';
      if (valor(form, 'na_escala') !== '__manter') campos.na_escala = valor(form, 'na_escala') === '1';
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
        <label class="field"><span>Turno de fim de semana</span><select name="turno_fds_id">${opcoesFds(
          c ? valorFds(c) : null,
          (t) => `${t.codigo} — ${t.inicio} às ${t.fim}`,
          'Sem turno de fim de semana'
        )}</select></label>
      </div>
      <div class="row">
        <label class="field"><span>Mesa</span><select name="mesa_id">${opcoes(
          state.mesas,
          c?.mesa_id,
          (m) => `${m.codigo} — ${m.nome}`,
          'Sem mesa'
        )}</select></label>
        <label class="field"><span>Contrato</span><select name="contrato_id">${opcoes(
          state.contratos,
          c?.contrato_id,
          (x) => `${x.codigo} — ${x.nome}`,
          'Sem contrato'
        )}</select></label>
      </div>
      <div class="row">
        <label class="field"><span>Sobreaviso</span><select name="sobreaviso_torre_id">${opcoes(
          torresSA,
          c?.sobreaviso_torre_id,
          (t) => `${t.codigo} — ${t.nome}`,
          'Nenhum'
        )}</select></label>
      </div>
      <label class="check"><input type="checkbox" name="ativo" ${!c || c.ativo ? 'checked' : ''}> Ativo (acesso ao sistema)</label>
      <label class="check"><input type="checkbox" name="na_escala" ${!c || c.na_escala ? 'checked' : ''}> Aparece na escala</label>`,
    async onSubmit(form) {
      const body = {
        nome: valor(form, 'nome'),
        email: valor(form, 'email'),
        telefone: valor(form, 'telefone'),
        torre_id: valor(form, 'torre_id'),
        turno_id: valor(form, 'turno_id'),
        turno_fds_id: valor(form, 'turno_fds_id'),
        sobreaviso_torre_id: valor(form, 'sobreaviso_torre_id'),
        mesa_id: valor(form, 'mesa_id'),
        contrato_id: valor(form, 'contrato_id'),
        ativo: marcado(form, 'ativo'),
        na_escala: marcado(form, 'na_escala'),
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
// Um bloco de cadastro (título, botão "+ Novo" e tabela) desenhado dentro de `alvo`.
function telaCadastro({ titulo, subtitulo, recurso, novo, colunas, linha, form, corpo, emUso, ordenar, aoAbrir }, alvo = main) {
  alvo.innerHTML = `
    <div class="bloco-head">
      <div><h2>${esc(titulo)}</h2><p class="muted">${esc(subtitulo)}</p></div>
      <button class="primary" data-novo>+ ${esc(novo)}</button>
    </div>
    <div class="card list-wrap" data-lista></div>`;
  const listaEl = $('[data-lista]', alvo);

  const lista = () => (ordenar ? [...state[recurso]].sort(ordenar) : state[recurso]);
  const render = () => {
    const el = listaEl;
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
        atualizarCadastros();
        toast('Salvo.');
      },
    });

  $('[data-novo]', alvo).onclick = () => abrir();
  listaEl.onclick = async (e) => {
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
      atualizarCadastros();
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

function viewTorres(alvo) {
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
      <label class="check"><input type="checkbox" name="sobreaviso_visivel" ${!t || t.sobreaviso_visivel ? 'checked' : ''}> Mostrar o sobreaviso na escala</label>
      ${editorSerieHtml(t?.padrao_sobreaviso)}
      <label class="check"><input type="checkbox" name="ativo" ${!t || t.ativo ? 'checked' : ''}> Ativa</label>
      ${t?.permite_sobreaviso ? '<p class="hint">Desmarcar o sobreaviso remove a tag dos colaboradores e apaga os plantões desta torre.</p>' : ''}`,
    form: (f) => ({
      codigo: valor(f, 'codigo'),
      nome: valor(f, 'nome'),
      cor: valor(f, 'cor'),
      permite_sobreaviso: marcado(f, 'permite_sobreaviso'),
      sobreaviso_visivel: marcado(f, 'sobreaviso_visivel'),
      padrao_sobreaviso: valor(f, 'padrao_sobreaviso'),
      ordem: valor(f, 'ordem'),
      ativo: marcado(f, 'ativo'),
    }),
  }, alvo);
}

function viewTurnos(alvo) {
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
  }, alvo);
}

// ---------- início ----------

// Cadastros simples (código, nome, cor, ordem, ativo) usados como tag do colaborador: Mesas e Contratos.
function telaCadastroSimples({ titulo, subtitulo, recurso, campo, novo, feminino, cor, tag }, alvo) {
  const contar = (x) => state.colaboradores.filter((c) => c[campo] === x.id).length;
  const ativo = feminino ? ['Ativa', 'Inativa'] : ['Ativo', 'Inativo'];
  telaCadastro({
    titulo,
    subtitulo,
    recurso,
    novo,
    colunas: ['Ordem', 'Tag', 'Nome', 'Colaboradores', 'Status'],
    linha: (x) => [x.ordem, tag(x), esc(x.nome), contar(x), x.ativo ? ativo[0] : ativo[1]],
    emUso: (x) => contar(x) > 0,
    corpo: (x) => `${camposComuns(x, cor)}
      <label class="field"><span>Ordem de exibição</span><input type="number" name="ordem" min="0" step="1" value="${esc(
        x?.ordem ?? state[recurso].length + 1
      )}"></label>
      <label class="check"><input type="checkbox" name="ativo" ${!x || x.ativo ? 'checked' : ''}> ${ativo[0]}</label>`,
    form: (f) => ({
      codigo: valor(f, 'codigo'),
      nome: valor(f, 'nome'),
      cor: valor(f, 'cor'),
      ordem: valor(f, 'ordem'),
      ativo: marcado(f, 'ativo'),
    }),
  }, alvo);
}

function viewMesas(alvo) {
  telaCadastroSimples({
    titulo: 'Mesas',
    subtitulo: 'Mesas de trabalho. Cada colaborador pode ter uma mesa, exibida como tag.',
    recurso: 'mesas',
    campo: 'mesa_id',
    novo: 'Nova mesa',
    feminino: true,
    cor: '#0f766e',
    tag: tagMesa,
  }, alvo);
}

function viewContratos(alvo) {
  telaCadastroSimples({
    titulo: 'Contratos',
    subtitulo: 'Contratos dos colaboradores. Cada colaborador pode ter um contrato, exibido como tag.',
    recurso: 'contratos',
    campo: 'contrato_id',
    novo: 'Novo contrato',
    feminino: false,
    cor: '#b45309',
    tag: tagContrato,
  }, alvo);
}

// Cadastros → Sobreaviso: uma linha por torre com sobreaviso, com o interruptor que mostra/oculta
// a seção dela na escala e no Excel (grava na hora; os lançamentos não são apagados).
function viewSobreaviso(alvo = main) {
  const torresSA = state.torres.filter((t) => t.permite_sobreaviso);
  const habilitados = (t) => state.colaboradores.filter((c) => c.ativo && c.sobreaviso_torre_id === t.id).length;
  alvo.innerHTML = `
    <div class="bloco-head">
      <div><h2>Sobreaviso</h2><p class="muted">Horário e visibilidade do sobreaviso de cada torre. Oculto, ele some da escala e do Excel, sem apagar os lançamentos.</p></div>
    </div>
    <div class="card list-wrap" data-lista>${
      torresSA.length
        ? `<table class="list"><thead><tr><th>Torre</th><th>Nome</th><th>Horário</th><th>Série fixa</th><th>Habilitados</th><th>Na escala</th></tr></thead>
          <tbody>${torresSA
            .map(
              (t) => `<tr class="${t.ativo ? '' : 'inativo'}">
                <td>${tagSobreaviso(t)}</td>
                <td>${esc(t.nome)}</td>
                <td class="nowrap">${
                  t.sobreaviso_inicio ? esc(horarioSobreaviso(t)) : '<span class="muted">não definido</span>'
                } <button class="ghost icon" data-horario="${t.id}" title="Editar o horário do sobreaviso ${esc(t.codigo)}">✎</button></td>
                <td>${t.padrao_sobreaviso ? esc(descreverSerie(t.padrao_sobreaviso)) : '<span class="muted">—</span>'}</td>
                <td>${habilitados(t)}</td>
                <td><label class="interruptor" title="Mostrar ou ocultar o sobreaviso ${esc(t.codigo)} na escala">
                  <input type="checkbox" data-sa-visivel="${t.id}" ${t.sobreaviso_visivel ? 'checked' : ''}><span></span>${
                    t.sobreaviso_visivel ? 'Visível' : 'Oculto'
                  }</label></td>
              </tr>`
            )
            .join('')}</tbody></table>`
        : '<div class="empty">Nenhuma torre com sobreaviso. Marque "Possui sobreaviso" no bloco Torres.</div>'
    }</div>`;
  const listaEl = $('[data-lista]', alvo);

  listaEl.onclick = (e) => {
    const b = e.target.closest('[data-horario]');
    if (b) dialogHorarioSobreaviso(porId(state.torres, Number(b.dataset.horario)));
  };
  listaEl.onchange = async (e) => {
    const inp = e.target.closest('[data-sa-visivel]');
    if (!inp) return;
    const t = porId(state.torres, Number(inp.dataset.saVisivel));
    inp.disabled = true;
    try {
      await api('PUT', `/torres/${t.id}`, { ...t, sobreaviso_visivel: inp.checked });
      await carregarBase();
      toast(`Sobreaviso ${t.codigo} ${inp.checked ? 'visível' : 'oculto'} na escala.`);
    } catch (err) {
      toast(err.message, true);
    }
    atualizarCadastros();
  };
}

function dialogHorarioSobreaviso(t) {
  abrirDialog({
    titulo: `Horário do sobreaviso ${t.codigo}`,
    corpo: `
      <div class="row">
        <label class="field"><span>Início</span><input type="time" name="inicio" value="${esc(t.sobreaviso_inicio)}"></label>
        <label class="field"><span>Fim</span><input type="time" name="fim" value="${esc(t.sobreaviso_fim)}"></label>
      </div>
      <p class="hint">Aparece na coluna Horário da tabela de sobreaviso, na escala e no Excel. Deixe os dois vazios para não exibir.</p>`,
    async onSubmit(form) {
      await api('PUT', `/torres/${t.id}`, { ...t, sobreaviso_inicio: valor(form, 'inicio'), sobreaviso_fim: valor(form, 'fim') });
      await carregarBase();
      atualizarCadastros();
      toast(`Horário do sobreaviso ${t.codigo} salvo.`);
    },
  });
}

// ---------- Cadastros: todos os blocos numa tela só ----------

const BLOCOS_CADASTRO = [
  ['torres', 'Torres', viewTorres],
  ['turnos', 'Turnos', viewTurnos],
  ['mesas', 'Mesas', viewMesas],
  ['contratos', 'Contratos', viewContratos],
  ['sobreaviso', 'Sobreaviso', viewSobreaviso],
];

function viewCadastros(foco) {
  main.innerHTML = `
    <div class="page-head">
      <div><h1>Cadastros</h1><p>Torres, turnos, mesas, contratos e sobreaviso num só lugar.</p></div>
    </div>
    <nav class="atalhos">${BLOCOS_CADASTRO.map(([id, nome]) => `<a href="#${id}" data-bloco="${id}">${nome}</a>`).join('')}</nav>
    ${BLOCOS_CADASTRO.map(([id]) => `<section class="bloco-cadastro" id="bloco-${id}"></section>`).join('')}`;
  for (const [id, , desenhar] of BLOCOS_CADASTRO) desenhar($(`#bloco-${id}`));
  $('.atalhos').onclick = (e) => {
    const a = e.target.closest('[data-bloco]');
    if (!a) return;
    e.preventDefault();
    $(`#bloco-${a.dataset.bloco}`).scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  if (foco) $(`#bloco-${foco}`)?.scrollIntoView({ block: 'start' });
}

// Depois de salvar em qualquer bloco, redesenha todos (um afeta o outro, ex.: torre ↔ sobreaviso) sem perder a rolagem.
function atualizarCadastros() {
  const y = window.scrollY;
  viewCadastros();
  window.scrollTo(0, y);
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
  // Item "Colaboradores" do menu só para admins.
  const menuColab = document.querySelector('nav a[data-view="colaboradores"]');
  if (menuColab) menuColab.hidden = !u?.admin;
  el.hidden = !u;
  if (!u) return;
  el.innerHTML = `
    <div class="usuario-nome" title="${esc(u.email)}">${esc(u.nome)}${u.admin ? ' <span class="muted">· admin</span>' : ''}</div>
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
