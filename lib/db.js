// Acesso ao Postgres (Neon na Vercel). As consultas usam "?" como marcador, convertido para $1, $2…
// Dentro de transacao(fn), todas as consultas usam automaticamente a mesma conexão.
const { Pool } = require('pg');
const { AsyncLocalStorage } = require('node:async_hooks');

if (!process.env.DATABASE_URL) {
  throw new Error('Defina DATABASE_URL com a conexão do Postgres (veja .env.example).');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Poucas conexões por instância: na Vercel cada função é uma instância própria.
  max: Number(process.env.PG_POOL_MAX) || 3,
});

const contexto = new AsyncLocalStorage();
const conexao = () => contexto.getStore() || pool;

function converter(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

async function q(sql, params = []) {
  return (await conexao().query(converter(sql), params)).rows;
}

async function um(sql, params = []) {
  return (await q(sql, params))[0];
}

// Executa e devolve quantas linhas foram afetadas.
async function exec(sql, params = []) {
  return (await conexao().query(converter(sql), params)).rowCount;
}

async function transacao(fn) {
  if (contexto.getStore()) return fn(); // já está dentro de uma transação
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await contexto.run(c, fn);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

// ---------- esquema ----------
// Criado na primeira requisição de cada instância. A trava evita que duas instâncias criem ao mesmo tempo.
const ESQUEMA = `
CREATE TABLE IF NOT EXISTS torres (
  id                 SERIAL PRIMARY KEY,
  codigo             TEXT NOT NULL,
  nome               TEXT NOT NULL DEFAULT '',
  cor                TEXT NOT NULL DEFAULT '#64748b',
  permite_sobreaviso SMALLINT NOT NULL DEFAULT 0,
  ordem              INTEGER NOT NULL DEFAULT 99,
  padrao_sobreaviso  TEXT NOT NULL DEFAULT '',   -- ex.: 12,F,5,5 (horas por dia; F = folga)
  ativo              SMALLINT NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS torres_codigo_unico ON torres (lower(codigo));
-- 0 = a seção de sobreaviso desta torre fica oculta na escala (os lançamentos continuam gravados).
ALTER TABLE torres ADD COLUMN IF NOT EXISTS sobreaviso_visivel SMALLINT NOT NULL DEFAULT 1;
-- Horário do sobreaviso da torre (HH:MM), exibido na tabela de sobreaviso; vazio = não definido.
ALTER TABLE torres ADD COLUMN IF NOT EXISTS sobreaviso_inicio TEXT NOT NULL DEFAULT '';
ALTER TABLE torres ADD COLUMN IF NOT EXISTS sobreaviso_fim TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS turnos (
  id      SERIAL PRIMARY KEY,
  codigo  TEXT NOT NULL,
  nome    TEXT NOT NULL DEFAULT '',
  inicio  TEXT NOT NULL,                          -- HH:MM
  fim     TEXT NOT NULL,                          -- HH:MM (pode virar o dia)
  cor     TEXT NOT NULL DEFAULT '#64748b',
  padrao  TEXT NOT NULL DEFAULT '5x2' CHECK (padrao IN ('5x2', '6x1', '12x36', 'livre')),
  grupo   SMALLINT NOT NULL DEFAULT 1 CHECK (grupo IN (1, 2)),
  ativo   SMALLINT NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS turnos_codigo_unico ON turnos (lower(codigo));

CREATE TABLE IF NOT EXISTS colaboradores (
  id                  SERIAL PRIMARY KEY,
  nome                TEXT NOT NULL,
  email               TEXT NOT NULL DEFAULT '',
  telefone            TEXT NOT NULL DEFAULT '',
  torre_id            INTEGER REFERENCES torres(id),
  turno_id            INTEGER REFERENCES turnos(id),
  sobreaviso_torre_id INTEGER REFERENCES torres(id),
  ativo               SMALLINT NOT NULL DEFAULT 1,
  senha_hash          TEXT,                       -- NULL = ainda usa a senha padrão
  criado_em           TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Mesa: tag opcional do colaborador, com cadastro próprio.
CREATE TABLE IF NOT EXISTS mesas (
  id     SERIAL PRIMARY KEY,
  codigo TEXT NOT NULL,
  nome   TEXT NOT NULL DEFAULT '',
  cor    TEXT NOT NULL DEFAULT '#64748b',
  ordem  INTEGER NOT NULL DEFAULT 99,
  ativo  SMALLINT NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS mesas_codigo_unico ON mesas (lower(codigo));
ALTER TABLE colaboradores ADD COLUMN IF NOT EXISTS mesa_id INTEGER REFERENCES mesas(id);

-- Contrato: tag opcional do colaborador, com cadastro próprio (mesmo formato da mesa).
CREATE TABLE IF NOT EXISTS contratos (
  id     SERIAL PRIMARY KEY,
  codigo TEXT NOT NULL,
  nome   TEXT NOT NULL DEFAULT '',
  cor    TEXT NOT NULL DEFAULT '#64748b',
  ordem  INTEGER NOT NULL DEFAULT 99,
  ativo  SMALLINT NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS contratos_codigo_unico ON contratos (lower(codigo));
ALTER TABLE colaboradores ADD COLUMN IF NOT EXISTS contrato_id INTEGER REFERENCES contratos(id);

-- O e-mail é o login: único quando preenchido.
CREATE UNIQUE INDEX IF NOT EXISTS colaboradores_email_unico ON colaboradores (lower(email)) WHERE email <> '';
-- Administradores: podem resetar senhas e definir outros admins.
ALTER TABLE colaboradores ADD COLUMN IF NOT EXISTS admin SMALLINT NOT NULL DEFAULT 0;
-- Aparece na escala (1) ou não (0). Independente de "ativo", que controla o acesso ao sistema.
ALTER TABLE colaboradores ADD COLUMN IF NOT EXISTS na_escala SMALLINT NOT NULL DEFAULT 1;
-- Turno de fim de semana (sábado e domingo); vazio = usa o turno normal.
ALTER TABLE colaboradores ADD COLUMN IF NOT EXISTS turno_fds_id INTEGER REFERENCES turnos(id);
-- 0 = não participa dos fins de semana (o pincel Trabalho lança folga no sábado e no domingo).
ALTER TABLE colaboradores ADD COLUMN IF NOT EXISTS fds_participa SMALLINT NOT NULL DEFAULT 1;

-- Uma linha por colaborador/dia. tipo TURNO usa turno_id; os demais são ausências.
CREATE TABLE IF NOT EXISTS escala (
  colaborador_id INTEGER NOT NULL REFERENCES colaboradores(id) ON DELETE CASCADE,
  data           TEXT NOT NULL,                   -- YYYY-MM-DD
  tipo           TEXT NOT NULL CHECK (tipo IN ('TURNO', 'FOLGA', 'FERIAS', 'ATESTADO')),
  turno_id       INTEGER REFERENCES turnos(id),
  PRIMARY KEY (colaborador_id, data)
);
CREATE INDEX IF NOT EXISTS escala_data ON escala (data);

-- Sobreaviso por torre/dia/colaborador (várias pessoas podem cobrir o mesmo dia).
CREATE TABLE IF NOT EXISTS sobreaviso (
  torre_id       INTEGER NOT NULL REFERENCES torres(id) ON DELETE CASCADE,
  data           TEXT NOT NULL,
  colaborador_id INTEGER NOT NULL REFERENCES colaboradores(id) ON DELETE CASCADE,
  horas          DOUBLE PRECISION,                -- NULL = sem horas definidas
  PRIMARY KEY (torre_id, data, colaborador_id)
);
CREATE INDEX IF NOT EXISTS sobreaviso_data ON sobreaviso (data);
`;

async function criarEsquema() {
  await transacao(async () => {
    await q('SELECT pg_advisory_xact_lock(7461001)');
    await conexao().query(ESQUEMA);
    // Primeiro admin: enquanto não houver nenhum, o colaborador do e-mail em ADMIN_EMAIL vira admin.
    if (process.env.ADMIN_EMAIL) {
      await exec(
        `UPDATE colaboradores SET admin = 1
         WHERE lower(email) = lower(?) AND NOT EXISTS (SELECT 1 FROM colaboradores WHERE admin = 1)`,
        [process.env.ADMIN_EMAIL.trim()]
      );
    }
    if (!(await um('SELECT COUNT(*)::int n FROM torres')).n) {
      for (const t of [
        ['N1', 'Nível 1', '#2563eb', 0, 1],
        ['N2', 'Nível 2', '#7c3aed', 1, 2],
        ['N3', 'Nível 3', '#db2777', 1, 3],
      ]) {
        await exec('INSERT INTO torres (codigo, nome, cor, permite_sobreaviso, ordem) VALUES (?, ?, ?, ?, ?)', t);
      }
    }
    if (!(await um('SELECT COUNT(*)::int n FROM turnos')).n) {
      for (const t of [
        ['TC', 'Comercial', '09:00', '18:00', '#0ea5e9', '5x2'],
        ['T1', 'Manhã', '07:00', '16:00', '#f59e0b', '5x2'],
        ['T2', 'Tarde', '14:30', '23:00', '#f97316', '5x2'],
        ['T3', 'Madrugada', '22:00', '07:00', '#6366f1', '5x2'],
      ]) {
        await exec('INSERT INTO turnos (codigo, nome, inicio, fim, cor, padrao) VALUES (?, ?, ?, ?, ?, ?)', t);
      }
    }
  });
}

let pronto = null;
function preparar() {
  pronto ??= criarEsquema().catch((e) => {
    pronto = null; // tenta de novo na próxima requisição
    throw e;
  });
  return pronto;
}

module.exports = { pool, q, um, exec, transacao, preparar };
