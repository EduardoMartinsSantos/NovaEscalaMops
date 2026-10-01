// API da escala: regras de negócio, login e roteamento.
// handler(req, res) atende /api/* — usado pelo servidor local (server.js) e pela função da Vercel (api/index.js).
const { q, um, exec, transacao, preparar } = require('./db');
const { HttpError } = require('./erros');
const auth = require('./auth');

// ---------- utilitários ----------

const TIPOS = ['TURNO', 'FOLGA', 'FERIAS', 'ATESTADO'];
const PADROES = ['5x2', '6x1', '12x36', 'livre'];
const RE_MES = /^\d{4}-(0[1-9]|1[0-2])$/;
const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;
const RE_HORA = /^([01]\d|2[0-3]):[0-5]\d$/;
const RE_COR = /^#[0-9a-fA-F]{6}$/;
const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Colunas públicas do colaborador (nunca expõe senha_hash).
const COLS_COLAB =
  'id, nome, email, telefone, torre_id, turno_id, turno_fds_id, sobreaviso_torre_id, mesa_id, contrato_id, ativo, na_escala, admin, ' +
  'criado_em';
// O que quem não é admin recebe da lista de colaboradores (o necessário para a escala).
const COLS_ESCALA = 'id, nome, torre_id, turno_id, turno_fds_id, sobreaviso_torre_id, mesa_id, contrato_id, ativo, na_escala';

function diasDoMes(mes) {
  if (!RE_MES.test(mes || '')) throw new HttpError(400, 'Mês inválido (use YYYY-MM).');
  const [a, m] = mes.split('-').map(Number);
  const total = new Date(Date.UTC(a, m, 0)).getUTCDate();
  return Array.from({ length: total }, (_, i) => `${mes}-${String(i + 1).padStart(2, '0')}`);
}

function texto(v, max = 200) {
  return String(v ?? '').trim().slice(0, max);
}

function idOuNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'Identificador inválido.');
  return n;
}

async function existe(tabela, id) {
  return id === null || !!(await um(`SELECT 1 FROM ${tabela} WHERE id = ?`, [id]));
}

// Corpo JSON da requisição. Na Vercel o corpo já vem lido em req.body; localmente é lido do stream.
function lerCorpo(req) {
  if ('body' in req) {
    try {
      const b = req.body;
      if (b && typeof b === 'object' && !Buffer.isBuffer(b)) return Promise.resolve(b);
      const txt = Buffer.isBuffer(b) ? b.toString() : b;
      return Promise.resolve(txt ? JSON.parse(txt) : {});
    } catch {
      return Promise.reject(new HttpError(400, 'JSON inválido.'));
    }
  }
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) reject(new HttpError(413, 'Requisição muito grande.'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, 'JSON inválido.'));
      }
    });
    req.on('error', reject);
  });
}

function json(res, status, body, cabecalhos = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cabecalhos });
  res.end(JSON.stringify(body));
}

// ---------- Torres ----------

// Padrão de sobreaviso: horas de cada dia a partir do dia escolhido, separadas por vírgula; F = folga.
// Ex.: "12,F,5,5,5,5,5,F,12". Normalizado para esse formato.
function validarPadraoSobreaviso(v) {
  const txt = texto(v, 300);
  if (!txt) return '';
  const tokens = txt
    .split(/[,;\s]+/)
    .filter(Boolean)
    .map((t) => {
      const u = t.toUpperCase();
      if (u === 'F' || u === 'FOLGA' || u === '-') return 'F';
      const h = Number(u.replace(/H$/, ''));
      if (!(h > 0 && h <= 24)) {
        throw new HttpError(400, `Padrão de sobreaviso inválido em "${t}". Use horas (ex.: 5 ou 7.5) ou F para folga, separados por vírgula.`);
      }
      return String(Math.round(h * 2) / 2);
    });
  if (tokens.length > 62) throw new HttpError(400, 'O padrão de sobreaviso pode ter no máximo 62 dias.');
  return tokens.join(',');
}

function validarTorre(b) {
  const t = {
    codigo: texto(b.codigo, 10).toUpperCase(),
    nome: texto(b.nome, 80),
    cor: RE_COR.test(b.cor || '') ? b.cor : '#64748b',
    permite_sobreaviso: b.permite_sobreaviso ? 1 : 0,
    sobreaviso_visivel: b.sobreaviso_visivel === undefined || b.sobreaviso_visivel ? 1 : 0,
    ordem: Number.isInteger(Number(b.ordem)) && b.ordem !== '' && b.ordem !== undefined ? Number(b.ordem) : 99,
    padrao_sobreaviso: validarPadraoSobreaviso(b.padrao_sobreaviso),
    sobreaviso_inicio: texto(b.sobreaviso_inicio, 5),
    sobreaviso_fim: texto(b.sobreaviso_fim, 5),
    ativo: b.ativo === undefined || b.ativo ? 1 : 0,
  };
  if (!t.codigo) throw new HttpError(400, 'Informe o código da torre.');
  const horario = [t.sobreaviso_inicio, t.sobreaviso_fim];
  if (horario.some(Boolean) && !horario.every((h) => RE_HORA.test(h))) {
    throw new HttpError(400, 'Informe início e fim do horário de sobreaviso (HH:MM), ou deixe os dois vazios.');
  }
  return t;
}

const torres = {
  listar: () => q('SELECT * FROM torres ORDER BY ordem, codigo'),
  async criar(b) {
    const t = validarTorre(b);
    return um(
      `INSERT INTO torres (codigo, nome, cor, permite_sobreaviso, sobreaviso_visivel, ordem, padrao_sobreaviso,
         sobreaviso_inicio, sobreaviso_fim, ativo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      [
        t.codigo, t.nome, t.cor, t.permite_sobreaviso, t.sobreaviso_visivel, t.ordem, t.padrao_sobreaviso,
        t.sobreaviso_inicio, t.sobreaviso_fim, t.ativo,
      ]
    );
  },
  async atualizar(id, b) {
    return transacao(async () => {
      // Campos não enviados mantêm o valor atual (ex.: o formulário de Torres não envia o horário do sobreaviso).
      const atual = await um('SELECT * FROM torres WHERE id = ?', [id]);
      if (!atual) throw new HttpError(404, 'Torre não encontrada.');
      const enviados = Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined));
      const t = validarTorre({ ...atual, ...enviados });
      const r = await um(
        `UPDATE torres SET codigo = ?, nome = ?, cor = ?, permite_sobreaviso = ?, sobreaviso_visivel = ?, ordem = ?,
         padrao_sobreaviso = ?, sobreaviso_inicio = ?, sobreaviso_fim = ?, ativo = ? WHERE id = ? RETURNING *`,
        [
          t.codigo, t.nome, t.cor, t.permite_sobreaviso, t.sobreaviso_visivel, t.ordem, t.padrao_sobreaviso,
          t.sobreaviso_inicio, t.sobreaviso_fim, t.ativo, id,
        ]
      );
      if (!r) throw new HttpError(404, 'Torre não encontrada.');
      if (!t.permite_sobreaviso) {
        await exec('UPDATE colaboradores SET sobreaviso_torre_id = NULL WHERE sobreaviso_torre_id = ?', [id]);
        await exec('DELETE FROM sobreaviso WHERE torre_id = ?', [id]);
      }
      return r;
    });
  },
  async excluir(id) {
    const { n: uso } = await um(
      'SELECT COUNT(*)::int n FROM colaboradores WHERE torre_id = ? OR sobreaviso_torre_id = ?',
      [id, id]
    );
    if (uso) throw new HttpError(409, `Torre em uso por ${uso} colaborador(es). Desative-a ou altere os colaboradores.`);
    if (!(await exec('DELETE FROM torres WHERE id = ?', [id]))) throw new HttpError(404, 'Torre não encontrada.');
  },
};

// ---------- Turnos ----------

function validarTurno(b) {
  const t = {
    codigo: texto(b.codigo, 10).toUpperCase(),
    nome: texto(b.nome, 80),
    inicio: texto(b.inicio, 5),
    fim: texto(b.fim, 5),
    cor: RE_COR.test(b.cor || '') ? b.cor : '#64748b',
    padrao: PADROES.includes(b.padrao) ? b.padrao : '5x2',
    ativo: b.ativo === undefined || b.ativo ? 1 : 0,
  };
  if (!t.codigo) throw new HttpError(400, 'Informe o código do turno.');
  if (!RE_HORA.test(t.inicio) || !RE_HORA.test(t.fim)) throw new HttpError(400, 'Horários devem estar no formato HH:MM.');
  return t;
}

const turnos = {
  listar: () => q('SELECT * FROM turnos ORDER BY inicio, codigo'),
  async criar(b) {
    const t = validarTurno(b);
    return um(
      'INSERT INTO turnos (codigo, nome, inicio, fim, cor, padrao, ativo) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *',
      [t.codigo, t.nome, t.inicio, t.fim, t.cor, t.padrao, t.ativo]
    );
  },
  async atualizar(id, b) {
    const t = validarTurno(b);
    const r = await um(
      'UPDATE turnos SET codigo = ?, nome = ?, inicio = ?, fim = ?, cor = ?, padrao = ?, ativo = ? WHERE id = ? RETURNING *',
      [t.codigo, t.nome, t.inicio, t.fim, t.cor, t.padrao, t.ativo, id]
    );
    if (!r) throw new HttpError(404, 'Turno não encontrado.');
    return r;
  },
  async excluir(id) {
    const { n: uso } = await um(
      `SELECT (SELECT COUNT(*) FROM colaboradores WHERE turno_id = ? OR turno_fds_id = ?)
            + (SELECT COUNT(*) FROM escala WHERE turno_id = ?) AS n`,
      [id, id, id]
    );
    if (Number(uso)) throw new HttpError(409, 'Turno em uso por colaboradores ou na escala. Desative-o em vez de excluir.');
    if (!(await exec('DELETE FROM turnos WHERE id = ?', [id]))) throw new HttpError(404, 'Turno não encontrado.');
  },
};

// ---------- Mesas e Contratos ----------
// Cadastros simples (código, nome, cor, ordem, ativo) usados como tag opcional do colaborador.

function cadastroSimples({ tabela, coluna, rotulo, artigo }) {
  const validar = (b) => {
    const x = {
      codigo: texto(b.codigo, 20).toUpperCase(),
      nome: texto(b.nome, 80),
      cor: RE_COR.test(b.cor || '') ? b.cor : '#64748b',
      ordem: Number.isInteger(Number(b.ordem)) && b.ordem !== '' && b.ordem !== undefined ? Number(b.ordem) : 99,
      ativo: b.ativo === undefined || b.ativo ? 1 : 0,
    };
    if (!x.codigo) throw new HttpError(400, `Informe o código d${artigo} ${rotulo}.`);
    return x;
  };
  const naoEncontrado = () => new HttpError(404, `${rotulo[0].toUpperCase()}${rotulo.slice(1)} não encontrad${artigo}.`);
  return {
    listar: () => q(`SELECT * FROM ${tabela} ORDER BY ordem, codigo`),
    async criar(b) {
      const x = validar(b);
      return um(`INSERT INTO ${tabela} (codigo, nome, cor, ordem, ativo) VALUES (?, ?, ?, ?, ?) RETURNING *`, [
        x.codigo, x.nome, x.cor, x.ordem, x.ativo,
      ]);
    },
    async atualizar(id, b) {
      const x = validar(b);
      const r = await um(`UPDATE ${tabela} SET codigo = ?, nome = ?, cor = ?, ordem = ?, ativo = ? WHERE id = ? RETURNING *`, [
        x.codigo, x.nome, x.cor, x.ordem, x.ativo, id,
      ]);
      if (!r) throw naoEncontrado();
      return r;
    },
    async excluir(id) {
      const { n: uso } = await um(`SELECT COUNT(*)::int n FROM colaboradores WHERE ${coluna} = ?`, [id]);
      if (uso) {
        throw new HttpError(409, `${rotulo[0].toUpperCase()}${rotulo.slice(1)} em uso por ${uso} colaborador(es). Desative ou altere os colaboradores.`);
      }
      if (!(await exec(`DELETE FROM ${tabela} WHERE id = ?`, [id]))) throw naoEncontrado();
    },
  };
}

const mesas = cadastroSimples({ tabela: 'mesas', coluna: 'mesa_id', rotulo: 'mesa', artigo: 'a' });
const contratos = cadastroSimples({ tabela: 'contratos', coluna: 'contrato_id', rotulo: 'contrato', artigo: 'o' });

// ---------- Colaboradores ----------

async function validarColaborador(b) {
  const c = {
    nome: texto(b.nome, 120),
    email: texto(b.email, 120).toLowerCase(),
    telefone: texto(b.telefone, 30),
    torre_id: idOuNull(b.torre_id),
    turno_id: idOuNull(b.turno_id),
    turno_fds_id: idOuNull(b.turno_fds_id),
    sobreaviso_torre_id: idOuNull(b.sobreaviso_torre_id),
    mesa_id: idOuNull(b.mesa_id),
    contrato_id: idOuNull(b.contrato_id),
    ativo: b.ativo === undefined || b.ativo ? 1 : 0,
    na_escala: b.na_escala === undefined || b.na_escala ? 1 : 0,
  };
  if (!c.nome) throw new HttpError(400, 'Informe o nome.');
  if (c.email && !RE_EMAIL.test(c.email)) throw new HttpError(400, 'E-mail inválido.');
  if (!c.torre_id || !(await existe('torres', c.torre_id))) throw new HttpError(400, 'Selecione uma torre válida.');
  if (!c.turno_id || !(await existe('turnos', c.turno_id))) throw new HttpError(400, 'Selecione um turno válido.');
  if (!(await existe('turnos', c.turno_fds_id))) throw new HttpError(400, 'Turno de fim de semana inválido.');
  if (!(await existe('mesas', c.mesa_id))) throw new HttpError(400, 'Mesa inválida.');
  if (!(await existe('contratos', c.contrato_id))) throw new HttpError(400, 'Contrato inválido.');
  if (c.sobreaviso_torre_id) {
    const t = await um('SELECT permite_sobreaviso FROM torres WHERE id = ?', [c.sobreaviso_torre_id]);
    if (!t || !t.permite_sobreaviso) throw new HttpError(400, 'A torre de sobreaviso escolhida não aceita sobreaviso.');
  }
  return c;
}

const colaboradores = {
  listar: () => q(`SELECT ${COLS_COLAB} FROM colaboradores ORDER BY lower(nome)`),
  async criar(b) {
    const c = await validarColaborador(b);
    return um(
      `INSERT INTO colaboradores
         (nome, email, telefone, torre_id, turno_id, turno_fds_id, sobreaviso_torre_id, mesa_id, contrato_id, ativo, na_escala)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${COLS_COLAB}`,
      [
        c.nome, c.email, c.telefone, c.torre_id, c.turno_id, c.turno_fds_id, c.sobreaviso_torre_id, c.mesa_id, c.contrato_id,
        c.ativo, c.na_escala,
      ]
    );
  },
  async atualizar(id, b) {
    const c = await validarColaborador(b);
    return transacao(async () => {
      const antes = await um('SELECT sobreaviso_torre_id FROM colaboradores WHERE id = ?', [id]);
      if (!antes) throw new HttpError(404, 'Colaborador não encontrado.');
      const r = await um(
        `UPDATE colaboradores SET nome = ?, email = ?, telefone = ?, torre_id = ?, turno_id = ?, turno_fds_id = ?,
         sobreaviso_torre_id = ?, mesa_id = ?, contrato_id = ?, ativo = ?, na_escala = ? WHERE id = ? RETURNING ${COLS_COLAB}`,
        [
          c.nome, c.email, c.telefone, c.torre_id, c.turno_id, c.turno_fds_id, c.sobreaviso_torre_id, c.mesa_id, c.contrato_id,
          c.ativo, c.na_escala, id,
        ]
      );
      // Saiu do sobreaviso daquela torre: libera os dias atribuídos a ele lá.
      if (antes.sobreaviso_torre_id && antes.sobreaviso_torre_id !== c.sobreaviso_torre_id) {
        await exec('DELETE FROM sobreaviso WHERE colaborador_id = ? AND torre_id = ?', [id, antes.sobreaviso_torre_id]);
      }
      return r;
    });
  },
  async excluir(id) {
    if (!(await exec('DELETE FROM colaboradores WHERE id = ?', [id]))) throw new HttpError(404, 'Colaborador não encontrado.');
  },
};

// Aplica os mesmos campos (só as tags e o status) a vários colaboradores, tudo ou nada.
const CAMPOS_LOTE = ['torre_id', 'turno_id', 'turno_fds_id', 'sobreaviso_torre_id', 'mesa_id', 'contrato_id', 'ativo', 'na_escala'];
const CAMPOS_LINHA = ['nome', 'email', 'telefone', ...CAMPOS_LOTE];

function idsDoLote(b) {
  const ids = Array.isArray(b.ids) ? [...new Set(b.ids.map((v) => idOuNull(v)).filter(Boolean))] : [];
  if (!ids.length) throw new HttpError(400, 'Selecione ao menos um colaborador.');
  return ids;
}

async function aplicarEmColaborador(id, campos) {
  const atual = await um(`SELECT ${COLS_COLAB} FROM colaboradores WHERE id = ?`, [id]);
  if (!atual) throw new HttpError(404, `Colaborador ${id} não encontrado.`);
  try {
    await colaboradores.atualizar(id, { ...atual, ...campos });
  } catch (e) {
    if (e.status) e.message = `${atual.nome}: ${e.message}`;
    throw e;
  }
}

const filtrarCampos = (obj, permitidos) =>
  Object.fromEntries(Object.entries(obj || {}).filter(([k]) => permitidos.includes(k)));

async function editarColaboradoresEmLote(b) {
  // Modo tabela: cada linha traz seus próprios valores.
  if (Array.isArray(b.linhas)) {
    if (!b.linhas.length) throw new HttpError(400, 'Nenhuma alteração para salvar.');
    await transacao(async () => {
      for (const l of b.linhas) await aplicarEmColaborador(idOuNull(l.id), filtrarCampos(l, CAMPOS_LINHA));
    });
    return { alterados: b.linhas.length };
  }
  const ids = idsDoLote(b);
  const campos = filtrarCampos(b.campos, CAMPOS_LOTE);
  if (!Object.keys(campos).length) throw new HttpError(400, 'Escolha ao menos um campo para alterar.');
  await transacao(async () => {
    for (const id of ids) await aplicarEmColaborador(id, campos);
  });
  return { alterados: ids.length };
}

async function excluirColaboradoresEmLote(b) {
  const ids = idsDoLote(b);
  await exec('DELETE FROM colaboradores WHERE id = ANY(?::int[])', [ids]);
  return { excluidos: ids.length };
}

// ---------- Escala ----------

async function obterEscala(mes) {
  const dias = diasDoMes(mes);
  const ini = dias[0];
  const fim = dias[dias.length - 1];
  const [celulas, sobreaviso] = await Promise.all([
    q('SELECT colaborador_id, data, tipo, turno_id FROM escala WHERE data BETWEEN ? AND ?', [ini, fim]),
    q('SELECT torre_id, data, colaborador_id, horas FROM sobreaviso WHERE data BETWEEN ? AND ?', [ini, fim]),
  ]);
  return { mes, dias, celulas, sobreaviso };
}

async function definirCelula(b) {
  const colaboradorId = idOuNull(b.colaborador_id);
  const data = texto(b.data, 10);
  if (!colaboradorId || !(await existe('colaboradores', colaboradorId))) throw new HttpError(400, 'Colaborador inválido.');
  if (!RE_DATA.test(data)) throw new HttpError(400, 'Data inválida.');

  if (!b.tipo) {
    await exec('DELETE FROM escala WHERE colaborador_id = ? AND data = ?', [colaboradorId, data]);
    return null;
  }
  if (!TIPOS.includes(b.tipo)) throw new HttpError(400, 'Tipo inválido.');
  const turnoId = b.tipo === 'TURNO' ? idOuNull(b.turno_id) : null;
  if (b.tipo === 'TURNO' && (!turnoId || !(await existe('turnos', turnoId)))) throw new HttpError(400, 'Turno inválido.');

  await exec(
    `INSERT INTO escala (colaborador_id, data, tipo, turno_id) VALUES (?, ?, ?, ?)
     ON CONFLICT (colaborador_id, data) DO UPDATE SET tipo = excluded.tipo, turno_id = excluded.turno_id`,
    [colaboradorId, data, b.tipo, turnoId]
  );
  return { colaborador_id: colaboradorId, data, tipo: b.tipo, turno_id: turnoId };
}

// Horas de sobreaviso: vazio = sem horas definidas; senão entre 0,5 e 24 (em passos de meia hora).
function horasOuNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const h = Number(String(v).replace(',', '.'));
  if (!Number.isFinite(h) || h <= 0 || h > 24) throw new HttpError(400, 'Horas de sobreaviso devem estar entre 0,5 e 24.');
  return Math.round(h * 2) / 2;
}

// Lança (ou atualiza as horas de) um colaborador no sobreaviso de uma torre/dia; remover=true apaga.
// Mais de uma pessoa pode estar de sobreaviso na mesma torre e dia.
async function definirSobreaviso(b) {
  const torreId = idOuNull(b.torre_id);
  const data = texto(b.data, 10);
  const colaboradorId = idOuNull(b.colaborador_id);
  if (!RE_DATA.test(data)) throw new HttpError(400, 'Data inválida.');
  const torre = torreId && (await um('SELECT permite_sobreaviso FROM torres WHERE id = ?', [torreId]));
  if (!torre || !torre.permite_sobreaviso) throw new HttpError(400, 'Torre não aceita sobreaviso.');
  if (!colaboradorId) throw new HttpError(400, 'Colaborador inválido.');

  if (b.remover) {
    await exec('DELETE FROM sobreaviso WHERE torre_id = ? AND data = ? AND colaborador_id = ?', [torreId, data, colaboradorId]);
    return null;
  }
  const c = await um('SELECT sobreaviso_torre_id FROM colaboradores WHERE id = ?', [colaboradorId]);
  if (!c || c.sobreaviso_torre_id !== torreId) throw new HttpError(400, 'Colaborador não está habilitado para sobreaviso nesta torre.');

  const horas = horasOuNull(b.horas);
  await exec(
    `INSERT INTO sobreaviso (torre_id, data, colaborador_id, horas) VALUES (?, ?, ?, ?)
     ON CONFLICT (torre_id, data, colaborador_id) DO UPDATE SET horas = excluded.horas`,
    [torreId, data, colaboradorId, horas]
  );
  return { torre_id: torreId, data, colaborador_id: colaboradorId, horas };
}

// Aplica uma série de sobreaviso a um colaborador a partir de uma data (pode atravessar o mês).
// Dias "F" removem o sobreaviso dele naquele dia. Tudo ou nada.
async function aplicarSerieSobreaviso(b) {
  const torreId = idOuNull(b.torre_id);
  const colaboradorId = idOuNull(b.colaborador_id);
  const inicio = texto(b.inicio, 10);
  if (!RE_DATA.test(inicio)) throw new HttpError(400, 'Data inválida.');
  // Série enviada (pincel configurável) ou, sem ela, o padrão fixo da torre.
  const torre = torreId && (await um('SELECT padrao_sobreaviso FROM torres WHERE id = ?', [torreId]));
  const padrao = b.padrao ? validarPadraoSobreaviso(b.padrao) : torre?.padrao_sobreaviso;
  if (!torre || !padrao) throw new HttpError(400, 'Esta torre não tem padrão de sobreaviso.');

  const base = Date.parse(`${inicio}T00:00:00Z`);
  const aplicados = [];
  await transacao(async () => {
    for (const [i, t] of padrao.split(',').entries()) {
      const data = new Date(base + i * 86400000).toISOString().slice(0, 10);
      const corpo = { torre_id: torreId, data, colaborador_id: colaboradorId };
      await definirSobreaviso(t === 'F' ? { ...corpo, remover: true } : { ...corpo, horas: t });
      aplicados.push({ data, horas: t === 'F' ? null : Number(t), folga: t === 'F' });
    }
  });
  return { aplicados };
}

async function exportarCsv(mes) {
  const [{ dias, celulas, sobreaviso }, listaTorres, listaTurnos, listaMesas, listaContratos, todos] = await Promise.all([
    obterEscala(mes),
    torres.listar(),
    turnos.listar(),
    mesas.listar(),
    contratos.listar(),
    colaboradores.listar(),
  ]);
  const mMap = new Map(listaMesas.map((m) => [m.id, m]));
  const ctMap = new Map(listaContratos.map((x) => [x.id, x]));
  const tMap = new Map(listaTorres.map((t) => [t.id, t]));
  const trMap = new Map(listaTurnos.map((t) => [t.id, t]));
  const cols = todos.filter((c) => c.ativo && c.na_escala);
  const cel = new Map(celulas.map((c) => [`${c.colaborador_id}|${c.data}`, c]));
  const siglas = { FOLGA: 'F', FERIAS: 'FE', ATESTADO: 'AT' };
  const esc = (v) => (/[;"\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : v);

  const linhas = [['Colaborador', 'Torre', 'Turno', 'Turno FDS', 'Mesa', 'Contrato', 'Sobreaviso', ...dias.map((d) => d.slice(8))]];
  for (const c of cols) {
    linhas.push([
      c.nome,
      tMap.get(c.torre_id)?.codigo || '',
      trMap.get(c.turno_id)?.codigo || '',
      trMap.get(c.turno_fds_id)?.codigo || '',
      mMap.get(c.mesa_id)?.codigo || '',
      ctMap.get(c.contrato_id)?.codigo || '',
      tMap.get(c.sobreaviso_torre_id)?.codigo || '',
      ...dias.map((d) => {
        const x = cel.get(`${c.id}|${d}`);
        if (!x) return '';
        return x.tipo === 'TURNO' ? trMap.get(x.turno_id)?.codigo || '' : siglas[x.tipo];
      }),
    ]);
  }
  // Sobreaviso: uma linha por colaborador habilitado, com as horas de cada dia e o total na coluna Sobreaviso.
  const fmtH = (h) => String(h).replace('.', ',');
  for (const t of tMap.values()) {
    if (!t.permite_sobreaviso) continue;
    const lanc = sobreaviso.filter((s) => s.torre_id === t.id);
    const ids = [...new Set([...cols.filter((c) => c.sobreaviso_torre_id === t.id).map((c) => c.id), ...lanc.map((s) => s.colaborador_id)])];
    for (const id of ids) {
      const meus = new Map(lanc.filter((s) => s.colaborador_id === id).map((s) => [s.data, s]));
      const total = [...meus.values()].reduce((n, s) => n + (s.horas || 0), 0);
      const nome = todos.find((c) => c.id === id)?.nome || '';
      linhas.push([
        `Sobreaviso ${t.codigo} - ${nome}`,
        t.codigo,
        '',
        '',
        '',
        '',
        total ? `${fmtH(total)}h` : '',
        ...dias.map((d) => {
          const s = meus.get(d);
          return !s ? '' : s.horas ? `${fmtH(s.horas)}h` : 'SA';
        }),
      ]);
    }
  }
  return '﻿' + linhas.map((l) => l.map(esc).join(';')).join('\r\n');
}

// ---------- Login e sessão ----------

// Colaborador da sessão (ativo); lança 401 se não houver.
async function usuarioDaSessao(req) {
  const token = auth.tokenDaRequisicao(req);
  const u =
    token &&
    (await um('SELECT id, nome, email, ativo, admin, (senha_hash IS NULL) AS senha_padrao FROM colaboradores WHERE id = ?', [
      token.id,
    ]));
  if (!u || !u.ativo) throw new HttpError(401, 'Faça login para continuar.');
  return u;
}

const sessaoPublica = (u) => ({ id: u.id, nome: u.nome, email: u.email, senhaPadrao: u.senha_padrao, admin: !!u.admin });

function exigirAdmin(usuario) {
  if (!usuario.admin) throw new HttpError(403, 'Apenas administradores podem fazer isso.');
}

// Admin: a senha do colaborador volta a ser a padrão (SENHA_PADRAO).
async function resetarSenha(usuario, id) {
  exigirAdmin(usuario);
  const c = await um('UPDATE colaboradores SET senha_hash = NULL WHERE id = ? RETURNING nome', [id]);
  if (!c) throw new HttpError(404, 'Colaborador não encontrado.');
  return { ok: true, nome: c.nome };
}

// Admin: marca/desmarca outro colaborador como admin (sem deixar o sistema sem nenhum).
async function definirAdmin(usuario, id, b) {
  exigirAdmin(usuario);
  const admin = b.admin ? 1 : 0;
  return transacao(async () => {
    if (!admin) {
      const { n } = await um('SELECT COUNT(*)::int n FROM colaboradores WHERE admin = 1 AND ativo = 1 AND id <> ?', [id]);
      if (!n) throw new HttpError(400, 'O sistema precisa de pelo menos um administrador ativo.');
    }
    const c = await um(`UPDATE colaboradores SET admin = ? WHERE id = ? RETURNING ${COLS_COLAB}`, [admin, id]);
    if (!c) throw new HttpError(404, 'Colaborador não encontrado.');
    return c;
  });
}

async function login(req, res) {
  const b = await lerCorpo(req);
  const email = texto(b.email, 120).toLowerCase();
  const senha = String(b.senha || '');
  const c =
    email && (await um(`SELECT id, nome, email, ativo, senha_hash FROM colaboradores WHERE lower(email) = ? AND email <> ''`, [email]));
  // Mesma mensagem para e-mail inexistente, inativo ou senha errada.
  if (!c || !c.ativo || !senha || !auth.senhaConfere(senha, c.senha_hash)) {
    throw new HttpError(401, 'E-mail ou senha inválidos.');
  }
  const sessao = { id: c.id, nome: c.nome, email: c.email, senhaPadrao: !c.senha_hash };
  json(res, 200, sessao, { 'Set-Cookie': auth.cookieSessao(req, auth.criarToken(c.id)) });
}

async function trocarSenha(req, usuario) {
  const b = await lerCorpo(req);
  const c = await um('SELECT senha_hash FROM colaboradores WHERE id = ?', [usuario.id]);
  if (!auth.senhaConfere(String(b.atual || ''), c.senha_hash)) throw new HttpError(400, 'Senha atual incorreta.');
  auth.validarNovaSenha(b.nova);
  await exec('UPDATE colaboradores SET senha_hash = ? WHERE id = ?', [auth.hashSenha(b.nova), usuario.id]);
  return { ok: true };
}

// ---------- roteamento ----------

const crud = { torres, turnos, mesas, contratos, colaboradores };

// Caminho da API. Na Vercel todas as rotas /api/* são reescritas para /api/index; o caminho original
// vem em req.url ou, se o ambiente entregar o caminho reescrito, no parâmetro "rota".
function caminho(url) {
  if (url.pathname.replace(/\/$/, '') === '/api/index') return `/api/${url.searchParams.get('rota') || ''}`;
  return url.pathname;
}

async function rotear(req, res, url) {
  const partes = caminho(url).split('/').filter(Boolean).slice(1); // remove "api"
  const [recurso, idTxt] = partes;
  const m = req.method;
  const rota = `${m} /${partes.join('/')}`;

  // Rotas públicas
  if (rota === 'POST /login') return login(req, res);
  if (rota === 'POST /logout') return json(res, 200, { ok: true }, { 'Set-Cookie': auth.cookieSessao(req, null) });

  // Daqui em diante, só com sessão válida.
  const usuario = await usuarioDaSessao(req);
  if (rota === 'GET /sessao') return json(res, 200, sessaoPublica(usuario));
  if (rota === 'POST /senha') return json(res, 200, await trocarSenha(req, usuario));

  // Lista de colaboradores: admins veem tudo (e quem ainda usa a senha padrão); os demais recebem só o que a
  // escala precisa, sem e-mail e telefone.
  if (rota === 'GET /colaboradores') {
    if (usuario.admin) {
      return json(res, 200, await q(`SELECT ${COLS_COLAB}, (senha_hash IS NULL) AS senha_padrao FROM colaboradores ORDER BY lower(nome)`));
    }
    return json(res, 200, await q(`SELECT ${COLS_ESCALA} FROM colaboradores ORDER BY lower(nome)`));
  }
  // Qualquer alteração em colaboradores é só para admins.
  if (recurso === 'colaboradores') exigirAdmin(usuario);
  if (recurso === 'colaboradores' && partes.length === 3 && m === 'POST' && partes[2] === 'resetar-senha') {
    return json(res, 200, await resetarSenha(usuario, idOuNull(idTxt)));
  }
  if (recurso === 'colaboradores' && partes.length === 3 && m === 'PUT' && partes[2] === 'admin') {
    return json(res, 200, await definirAdmin(usuario, idOuNull(idTxt), await lerCorpo(req)));
  }

  if (recurso === 'colaboradores' && idTxt === 'lote') {
    if (m === 'PUT' && partes.length === 2) return json(res, 200, await editarColaboradoresEmLote(await lerCorpo(req)));
    if (m === 'POST' && partes[2] === 'excluir') return json(res, 200, await excluirColaboradoresEmLote(await lerCorpo(req)));
  }

  if (crud[recurso] && partes.length <= 2) {
    const svc = crud[recurso];
    if (!idTxt) {
      if (m === 'GET') return json(res, 200, await svc.listar());
      if (m === 'POST') return json(res, 201, await svc.criar(await lerCorpo(req)));
    } else {
      const id = idOuNull(idTxt);
      if (m === 'PUT') return json(res, 200, await svc.atualizar(id, await lerCorpo(req)));
      if (m === 'DELETE') {
        await svc.excluir(id);
        return json(res, 200, { ok: true });
      }
    }
  }

  switch (rota) {
    case 'GET /escala':
      return json(res, 200, await obterEscala(url.searchParams.get('mes')));
    // Lançamentos na escala e no sobreaviso: só admins.
    case 'PUT /escala/celula':
      exigirAdmin(usuario);
      return json(res, 200, await definirCelula(await lerCorpo(req)));
    case 'PUT /sobreaviso':
      exigirAdmin(usuario);
      return json(res, 200, await definirSobreaviso(await lerCorpo(req)));
    case 'POST /sobreaviso/serie':
      exigirAdmin(usuario);
      return json(res, 200, await aplicarSerieSobreaviso(await lerCorpo(req)));
    case 'GET /escala/exportar': {
      const mes = url.searchParams.get('mes');
      const csv = await exportarCsv(mes);
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="escala-${mes}.csv"`,
        'Cache-Control': 'no-store',
      });
      return res.end(csv);
    }
  }
  throw new HttpError(404, 'Rota não encontrada.');
}

// Traduz erros do Postgres para mensagens ao usuário.
function erroParaResposta(e) {
  if (e.status) return [e.status, e.message];
  if (e.code === '23505') {
    return [409, /email/.test(e.constraint || '') ? 'Já existe um colaborador com esse e-mail.' : 'Já existe um registro com esse código.'];
  }
  if (e.code === '23503') return [409, 'Registro em uso por outros dados.'];
  console.error(e);
  return [500, 'Erro interno.'];
}

async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  try {
    await preparar();
    await rotear(req, res, url);
  } catch (e) {
    const [status, erro] = erroParaResposta(e);
    if (!res.headersSent) json(res, status, { erro });
    else res.end();
  }
}

module.exports = { handler };
