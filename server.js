const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- utilitários ----------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const TIPOS = ['TURNO', 'FOLGA', 'FERIAS', 'ATESTADO'];
const PADROES = ['5x2', '6x1', '12x36', 'livre'];
const RE_MES = /^\d{4}-(0[1-9]|1[0-2])$/;
const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;
const RE_HORA = /^([01]\d|2[0-3]):[0-5]\d$/;
const RE_COR = /^#[0-9a-fA-F]{6}$/;
const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

function existe(tabela, id) {
  return id === null || !!db.prepare(`SELECT 1 FROM ${tabela} WHERE id = ?`).get(id);
}

function transacao(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function lerCorpo(req) {
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

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
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
    ordem: Number.isInteger(Number(b.ordem)) && b.ordem !== '' && b.ordem !== undefined ? Number(b.ordem) : 99,
    padrao_sobreaviso: validarPadraoSobreaviso(b.padrao_sobreaviso),
    ativo: b.ativo === undefined || b.ativo ? 1 : 0,
  };
  if (!t.codigo) throw new HttpError(400, 'Informe o código da torre.');
  return t;
}

const torres = {
  listar: () => db.prepare('SELECT * FROM torres ORDER BY ordem, codigo').all(),
  criar(b) {
    const t = validarTorre(b);
    const r = db
      .prepare('INSERT INTO torres (codigo, nome, cor, permite_sobreaviso, ordem, padrao_sobreaviso, ativo) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(t.codigo, t.nome, t.cor, t.permite_sobreaviso, t.ordem, t.padrao_sobreaviso, t.ativo);
    return db.prepare('SELECT * FROM torres WHERE id = ?').get(r.lastInsertRowid);
  },
  atualizar(id, b) {
    const t = validarTorre(b);
    const r = db
      .prepare(
        'UPDATE torres SET codigo = ?, nome = ?, cor = ?, permite_sobreaviso = ?, ordem = ?, padrao_sobreaviso = ?, ativo = ? WHERE id = ?'
      )
      .run(t.codigo, t.nome, t.cor, t.permite_sobreaviso, t.ordem, t.padrao_sobreaviso, t.ativo, id);
    if (!r.changes) throw new HttpError(404, 'Torre não encontrada.');
    if (!t.permite_sobreaviso) {
      db.prepare('UPDATE colaboradores SET sobreaviso_torre_id = NULL WHERE sobreaviso_torre_id = ?').run(id);
      db.prepare('DELETE FROM sobreaviso WHERE torre_id = ?').run(id);
    }
    return db.prepare('SELECT * FROM torres WHERE id = ?').get(id);
  },
  excluir(id) {
    const uso = db
      .prepare('SELECT COUNT(*) n FROM colaboradores WHERE torre_id = ? OR sobreaviso_torre_id = ?')
      .get(id, id).n;
    if (uso) throw new HttpError(409, `Torre em uso por ${uso} colaborador(es). Desative-a ou altere os colaboradores.`);
    const r = db.prepare('DELETE FROM torres WHERE id = ?').run(id);
    if (!r.changes) throw new HttpError(404, 'Torre não encontrada.');
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
  listar: () => db.prepare('SELECT * FROM turnos ORDER BY inicio, codigo').all(),
  criar(b) {
    const t = validarTurno(b);
    const r = db
      .prepare('INSERT INTO turnos (codigo, nome, inicio, fim, cor, padrao, ativo) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(t.codigo, t.nome, t.inicio, t.fim, t.cor, t.padrao, t.ativo);
    return db.prepare('SELECT * FROM turnos WHERE id = ?').get(r.lastInsertRowid);
  },
  atualizar(id, b) {
    const t = validarTurno(b);
    const r = db
      .prepare('UPDATE turnos SET codigo = ?, nome = ?, inicio = ?, fim = ?, cor = ?, padrao = ?, ativo = ? WHERE id = ?')
      .run(t.codigo, t.nome, t.inicio, t.fim, t.cor, t.padrao, t.ativo, id);
    if (!r.changes) throw new HttpError(404, 'Turno não encontrado.');
    return db.prepare('SELECT * FROM turnos WHERE id = ?').get(id);
  },
  excluir(id) {
    const uso =
      db.prepare('SELECT COUNT(*) n FROM colaboradores WHERE turno_id = ?').get(id).n +
      db.prepare('SELECT COUNT(*) n FROM escala WHERE turno_id = ?').get(id).n;
    if (uso) throw new HttpError(409, 'Turno em uso por colaboradores ou na escala. Desative-o em vez de excluir.');
    const r = db.prepare('DELETE FROM turnos WHERE id = ?').run(id);
    if (!r.changes) throw new HttpError(404, 'Turno não encontrado.');
  },
};

// ---------- Colaboradores ----------

function validarColaborador(b) {
  const c = {
    nome: texto(b.nome, 120),
    email: texto(b.email, 120).toLowerCase(),
    telefone: texto(b.telefone, 30),
    torre_id: idOuNull(b.torre_id),
    turno_id: idOuNull(b.turno_id),
    sobreaviso_torre_id: idOuNull(b.sobreaviso_torre_id),
    ativo: b.ativo === undefined || b.ativo ? 1 : 0,
  };
  if (!c.nome) throw new HttpError(400, 'Informe o nome.');
  if (c.email && !RE_EMAIL.test(c.email)) throw new HttpError(400, 'E-mail inválido.');
  if (!c.torre_id || !existe('torres', c.torre_id)) throw new HttpError(400, 'Selecione uma torre válida.');
  if (!c.turno_id || !existe('turnos', c.turno_id)) throw new HttpError(400, 'Selecione um turno válido.');
  if (c.sobreaviso_torre_id) {
    const t = db.prepare('SELECT permite_sobreaviso FROM torres WHERE id = ?').get(c.sobreaviso_torre_id);
    if (!t || !t.permite_sobreaviso) throw new HttpError(400, 'A torre de sobreaviso escolhida não aceita sobreaviso.');
  }
  return c;
}

const colaboradores = {
  listar: () => db.prepare('SELECT * FROM colaboradores ORDER BY nome COLLATE NOCASE').all(),
  criar(b) {
    const c = validarColaborador(b);
    const r = db
      .prepare(
        `INSERT INTO colaboradores (nome, email, telefone, torre_id, turno_id, sobreaviso_torre_id, ativo)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(c.nome, c.email, c.telefone, c.torre_id, c.turno_id, c.sobreaviso_torre_id, c.ativo);
    return db.prepare('SELECT * FROM colaboradores WHERE id = ?').get(r.lastInsertRowid);
  },
  atualizar(id, b) {
    const c = validarColaborador(b);
    const antes = db.prepare('SELECT sobreaviso_torre_id FROM colaboradores WHERE id = ?').get(id);
    if (!antes) throw new HttpError(404, 'Colaborador não encontrado.');
    db.prepare(
      `UPDATE colaboradores SET nome = ?, email = ?, telefone = ?, torre_id = ?, turno_id = ?,
       sobreaviso_torre_id = ?, ativo = ? WHERE id = ?`
    ).run(c.nome, c.email, c.telefone, c.torre_id, c.turno_id, c.sobreaviso_torre_id, c.ativo, id);
    // Saiu do sobreaviso daquela torre: libera os dias atribuídos a ele lá.
    if (antes.sobreaviso_torre_id && antes.sobreaviso_torre_id !== c.sobreaviso_torre_id) {
      db.prepare('DELETE FROM sobreaviso WHERE colaborador_id = ? AND torre_id = ?').run(id, antes.sobreaviso_torre_id);
    }
    return db.prepare('SELECT * FROM colaboradores WHERE id = ?').get(id);
  },
  excluir(id) {
    const r = db.prepare('DELETE FROM colaboradores WHERE id = ?').run(id);
    if (!r.changes) throw new HttpError(404, 'Colaborador não encontrado.');
  },
};

// Aplica os mesmos campos (só as tags e o status) a vários colaboradores, tudo ou nada.
const CAMPOS_LOTE = ['torre_id', 'turno_id', 'sobreaviso_torre_id', 'ativo'];

function idsDoLote(b) {
  const ids = Array.isArray(b.ids) ? [...new Set(b.ids.map((v) => idOuNull(v)).filter(Boolean))] : [];
  if (!ids.length) throw new HttpError(400, 'Selecione ao menos um colaborador.');
  return ids;
}

const CAMPOS_LINHA = ['nome', 'email', 'telefone', ...CAMPOS_LOTE];

function aplicarEmColaborador(id, campos) {
  const atual = db.prepare('SELECT * FROM colaboradores WHERE id = ?').get(id);
  if (!atual) throw new HttpError(404, `Colaborador ${id} não encontrado.`);
  try {
    colaboradores.atualizar(id, { ...atual, ...campos });
  } catch (e) {
    if (e.status) e.message = `${atual.nome}: ${e.message}`;
    throw e;
  }
}

const filtrarCampos = (obj, permitidos) =>
  Object.fromEntries(Object.entries(obj || {}).filter(([k]) => permitidos.includes(k)));

function editarColaboradoresEmLote(b) {
  // Modo tabela: cada linha traz seus próprios valores.
  if (Array.isArray(b.linhas)) {
    if (!b.linhas.length) throw new HttpError(400, 'Nenhuma alteração para salvar.');
    transacao(() => b.linhas.forEach((l) => aplicarEmColaborador(idOuNull(l.id), filtrarCampos(l, CAMPOS_LINHA))));
    return { alterados: b.linhas.length };
  }
  const ids = idsDoLote(b);
  const campos = filtrarCampos(b.campos, CAMPOS_LOTE);
  if (!Object.keys(campos).length) throw new HttpError(400, 'Escolha ao menos um campo para alterar.');
  transacao(() => ids.forEach((id) => aplicarEmColaborador(id, campos)));
  return { alterados: ids.length };
}

function excluirColaboradoresEmLote(b) {
  const ids = idsDoLote(b);
  transacao(() => ids.forEach((id) => db.prepare('DELETE FROM colaboradores WHERE id = ?').run(id)));
  return { excluidos: ids.length };
}

// ---------- Escala ----------

function obterEscala(mes) {
  const dias = diasDoMes(mes);
  const ini = dias[0];
  const fim = dias[dias.length - 1];
  return {
    mes,
    dias,
    celulas: db.prepare('SELECT colaborador_id, data, tipo, turno_id FROM escala WHERE data BETWEEN ? AND ?').all(ini, fim),
    sobreaviso: db
      .prepare('SELECT torre_id, data, colaborador_id, horas FROM sobreaviso WHERE data BETWEEN ? AND ?')
      .all(ini, fim),
  };
}

function definirCelula(b) {
  const colaboradorId = idOuNull(b.colaborador_id);
  const data = texto(b.data, 10);
  if (!colaboradorId || !existe('colaboradores', colaboradorId)) throw new HttpError(400, 'Colaborador inválido.');
  if (!RE_DATA.test(data)) throw new HttpError(400, 'Data inválida.');

  if (!b.tipo) {
    db.prepare('DELETE FROM escala WHERE colaborador_id = ? AND data = ?').run(colaboradorId, data);
    return null;
  }
  if (!TIPOS.includes(b.tipo)) throw new HttpError(400, 'Tipo inválido.');
  const turnoId = b.tipo === 'TURNO' ? idOuNull(b.turno_id) : null;
  if (b.tipo === 'TURNO' && (!turnoId || !existe('turnos', turnoId))) throw new HttpError(400, 'Turno inválido.');

  db.prepare(
    `INSERT INTO escala (colaborador_id, data, tipo, turno_id) VALUES (?, ?, ?, ?)
     ON CONFLICT (colaborador_id, data) DO UPDATE SET tipo = excluded.tipo, turno_id = excluded.turno_id`
  ).run(colaboradorId, data, b.tipo, turnoId);
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
function definirSobreaviso(b) {
  const torreId = idOuNull(b.torre_id);
  const data = texto(b.data, 10);
  const colaboradorId = idOuNull(b.colaborador_id);
  if (!RE_DATA.test(data)) throw new HttpError(400, 'Data inválida.');
  const torre = torreId && db.prepare('SELECT permite_sobreaviso FROM torres WHERE id = ?').get(torreId);
  if (!torre || !torre.permite_sobreaviso) throw new HttpError(400, 'Torre não aceita sobreaviso.');
  if (!colaboradorId) throw new HttpError(400, 'Colaborador inválido.');

  if (b.remover) {
    db.prepare('DELETE FROM sobreaviso WHERE torre_id = ? AND data = ? AND colaborador_id = ?').run(torreId, data, colaboradorId);
    return null;
  }
  const c = db.prepare('SELECT sobreaviso_torre_id FROM colaboradores WHERE id = ?').get(colaboradorId);
  if (!c || c.sobreaviso_torre_id !== torreId) throw new HttpError(400, 'Colaborador não está habilitado para sobreaviso nesta torre.');

  const horas = horasOuNull(b.horas);
  db.prepare(
    `INSERT INTO sobreaviso (torre_id, data, colaborador_id, horas) VALUES (?, ?, ?, ?)
     ON CONFLICT (torre_id, data, colaborador_id) DO UPDATE SET horas = excluded.horas`
  ).run(torreId, data, colaboradorId, horas);
  return { torre_id: torreId, data, colaborador_id: colaboradorId, horas };
}

// Aplica uma série de sobreaviso a um colaborador a partir de uma data (pode atravessar o mês).
// Dias "F" removem o sobreaviso dele naquele dia. Tudo ou nada.
function aplicarSerieSobreaviso(b) {
  const torreId = idOuNull(b.torre_id);
  const colaboradorId = idOuNull(b.colaborador_id);
  const inicio = texto(b.inicio, 10);
  if (!RE_DATA.test(inicio)) throw new HttpError(400, 'Data inválida.');
  // Série enviada (pincel configurável) ou, sem ela, o padrão fixo da torre.
  const torre = torreId && db.prepare('SELECT padrao_sobreaviso FROM torres WHERE id = ?').get(torreId);
  const padrao = b.padrao ? validarPadraoSobreaviso(b.padrao) : torre?.padrao_sobreaviso;
  if (!torre || !padrao) throw new HttpError(400, 'Esta torre não tem padrão de sobreaviso.');

  const tokens = padrao.split(',');
  const base = Date.parse(`${inicio}T00:00:00Z`);
  const aplicados = [];
  transacao(() =>
    tokens.forEach((t, i) => {
      const data = new Date(base + i * 86400000).toISOString().slice(0, 10);
      const corpo = { torre_id: torreId, data, colaborador_id: colaboradorId };
      definirSobreaviso(t === 'F' ? { ...corpo, remover: true } : { ...corpo, horas: t });
      aplicados.push({ data, horas: t === 'F' ? null : Number(t), folga: t === 'F' });
    })
  );
  return { aplicados };
}

function exportarCsv(mes) {
  const { dias, celulas, sobreaviso } = obterEscala(mes);
  const tMap = new Map(torres.listar().map((t) => [t.id, t]));
  const trMap = new Map(turnos.listar().map((t) => [t.id, t]));
  const cols = colaboradores.listar().filter((c) => c.ativo);
  const cel = new Map(celulas.map((c) => [`${c.colaborador_id}|${c.data}`, c]));
  const siglas = { FOLGA: 'F', FERIAS: 'FE', ATESTADO: 'AT' };
  const esc = (v) => (/[;"\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : v);

  const linhas = [['Colaborador', 'Torre', 'Turno', 'Sobreaviso', ...dias.map((d) => d.slice(8))]];
  for (const c of cols) {
    linhas.push([
      c.nome,
      tMap.get(c.torre_id)?.codigo || '',
      trMap.get(c.turno_id)?.codigo || '',
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
      const nome = cols.find((c) => c.id === id)?.nome || colaboradores.listar().find((c) => c.id === id)?.nome || '';
      linhas.push([
        `Sobreaviso ${t.codigo} - ${nome}`,
        t.codigo,
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

// ---------- roteamento ----------

const crud = { torres, turnos, colaboradores };

async function api(req, res, url) {
  const partes = url.pathname.split('/').filter(Boolean).slice(1); // remove "api"
  const [recurso, idTxt] = partes;
  const m = req.method;

  if (recurso === 'colaboradores' && idTxt === 'lote') {
    if (m === 'PUT' && partes.length === 2) return json(res, 200, editarColaboradoresEmLote(await lerCorpo(req)));
    if (m === 'POST' && partes[2] === 'excluir') return json(res, 200, excluirColaboradoresEmLote(await lerCorpo(req)));
  }

  if (crud[recurso]) {
    const svc = crud[recurso];
    if (!idTxt) {
      if (m === 'GET') return json(res, 200, svc.listar());
      if (m === 'POST') return json(res, 201, svc.criar(await lerCorpo(req)));
    } else {
      const id = idOuNull(idTxt);
      if (m === 'PUT') return json(res, 200, svc.atualizar(id, await lerCorpo(req)));
      if (m === 'DELETE') {
        svc.excluir(id);
        return json(res, 200, { ok: true });
      }
    }
  }

  const rota = `${m} /${partes.join('/')}`;
  switch (rota) {
    case 'GET /escala':
      return json(res, 200, obterEscala(url.searchParams.get('mes')));
    case 'PUT /escala/celula':
      return json(res, 200, definirCelula(await lerCorpo(req)));
    case 'PUT /sobreaviso':
      return json(res, 200, definirSobreaviso(await lerCorpo(req)));
    case 'POST /sobreaviso/serie':
      return json(res, 200, aplicarSerieSobreaviso(await lerCorpo(req)));
    case 'GET /escala/exportar': {
      const mes = url.searchParams.get('mes');
      const csv = exportarCsv(mes);
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="escala-${mes}.csv"`,
      });
      return res.end(csv);
    }
  }
  throw new HttpError(404, 'Rota não encontrada.');
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function estatico(res, url) {
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const arq = path.join(PUBLIC_DIR, rel);
  if (!arq.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(403, 'Acesso negado.');
  fs.readFile(arq, (err, conteudo) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Não encontrado');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(arq)] || 'application/octet-stream' });
    res.end(conteudo);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    estatico(res, url);
  } catch (e) {
    let status = e.status || 500;
    let msg = e.message;
    if (!e.status && /UNIQUE constraint/.test(e.message)) {
      status = 409;
      msg = 'Já existe um registro com esse código.';
    } else if (!e.status) {
      console.error(e);
      msg = 'Erro interno.';
    }
    json(res, status, { erro: msg });
  }
});

server.listen(PORT, () => console.log(`Escala rodando em http://localhost:${PORT}`));
