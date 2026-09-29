const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(process.env.DB_PATH || path.join(DATA_DIR, 'escala.db'));
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');

db.exec(`
CREATE TABLE IF NOT EXISTS torres (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo             TEXT NOT NULL UNIQUE COLLATE NOCASE,
  nome               TEXT NOT NULL DEFAULT '',
  cor                TEXT NOT NULL DEFAULT '#64748b',
  permite_sobreaviso INTEGER NOT NULL DEFAULT 0,
  ativo              INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS turnos (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo  TEXT NOT NULL UNIQUE COLLATE NOCASE,
  nome    TEXT NOT NULL DEFAULT '',
  inicio  TEXT NOT NULL,            -- HH:MM
  fim     TEXT NOT NULL,            -- HH:MM (pode virar o dia)
  cor     TEXT NOT NULL DEFAULT '#64748b',
  padrao  TEXT NOT NULL DEFAULT '5x2' CHECK (padrao IN ('5x2','6x1','12x36','livre')),
  ativo   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS colaboradores (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  nome                TEXT NOT NULL,
  email               TEXT NOT NULL DEFAULT '',
  telefone            TEXT NOT NULL DEFAULT '',
  torre_id            INTEGER REFERENCES torres(id),
  turno_id            INTEGER REFERENCES turnos(id),
  sobreaviso_torre_id INTEGER REFERENCES torres(id),
  ativo               INTEGER NOT NULL DEFAULT 1,
  criado_em           TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Uma linha por colaborador/dia. tipo TURNO usa turno_id; os demais são ausências.
CREATE TABLE IF NOT EXISTS escala (
  colaborador_id INTEGER NOT NULL REFERENCES colaboradores(id) ON DELETE CASCADE,
  data           TEXT NOT NULL,     -- YYYY-MM-DD
  tipo           TEXT NOT NULL CHECK (tipo IN ('TURNO','FOLGA','FERIAS','ATESTADO')),
  turno_id       INTEGER REFERENCES turnos(id),
  PRIMARY KEY (colaborador_id, data)
);

-- Quem está de sobreaviso por torre/dia.
CREATE TABLE IF NOT EXISTS sobreaviso (
  torre_id       INTEGER NOT NULL REFERENCES torres(id) ON DELETE CASCADE,
  data           TEXT NOT NULL,
  colaborador_id INTEGER NOT NULL REFERENCES colaboradores(id) ON DELETE CASCADE,
  PRIMARY KEY (torre_id, data)
);
`);

// Migração: ordem de exibição das torres.
if (!db.prepare('PRAGMA table_info(torres)').all().some((c) => c.name === 'ordem')) {
  db.exec('ALTER TABLE torres ADD COLUMN ordem INTEGER NOT NULL DEFAULT 99');
  const ordem = db.prepare('UPDATE torres SET ordem = ? WHERE codigo = ?');
  ['N1', 'N2', 'N3', 'LJ', 'ESPEC', 'LT'].forEach((codigo, i) => ordem.run(i + 1, codigo));
}

// Migração: grupo de revezamento 12x36 no turno (turnos do mesmo grupo trabalham nos mesmos dias).
if (!db.prepare('PRAGMA table_info(turnos)').all().some((c) => c.name === 'grupo')) {
  db.exec('ALTER TABLE turnos ADD COLUMN grupo INTEGER NOT NULL DEFAULT 1 CHECK (grupo IN (1, 2))');
  const temEquipes = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'equipes'").get();
  const grupoDasEquipes = db.prepare(
    `SELECT MAX(e.grupo) g FROM colaboradores c JOIN equipes e ON e.id = c.equipe_id WHERE c.turno_id = ?`
  );
  for (const t of db.prepare("SELECT id, codigo FROM turnos WHERE padrao = '12x36'").all()) {
    // Herda o grupo das equipes dos colaboradores; sem essa informação, TP*A/B → 1 e TP*C/D → 2.
    const g = (temEquipes && grupoDasEquipes.get(t.id)?.g) || (/[CD]$/i.test(t.codigo) ? 2 : 1);
    db.prepare('UPDATE turnos SET grupo = ? WHERE id = ?').run(g, t.id);
  }
}

// Migração: equipes removidas (coluna equipe_id e tabela equipes).
// SQLite não remove coluna com chave estrangeira, então a tabela de colaboradores é recriada.
if (db.prepare('PRAGMA table_info(colaboradores)').all().some((c) => c.name === 'equipe_id')) {
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(`
    BEGIN;
    CREATE TABLE colaboradores_novo (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      nome                TEXT NOT NULL,
      email               TEXT NOT NULL DEFAULT '',
      telefone            TEXT NOT NULL DEFAULT '',
      torre_id            INTEGER REFERENCES torres(id),
      turno_id            INTEGER REFERENCES turnos(id),
      sobreaviso_torre_id INTEGER REFERENCES torres(id),
      ativo               INTEGER NOT NULL DEFAULT 1,
      criado_em           TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO colaboradores_novo (id, nome, email, telefone, torre_id, turno_id, sobreaviso_torre_id, ativo, criado_em)
      SELECT id, nome, email, telefone, torre_id, turno_id, sobreaviso_torre_id, ativo, criado_em FROM colaboradores;
    DROP TABLE colaboradores;
    ALTER TABLE colaboradores_novo RENAME TO colaboradores;
    DROP TABLE IF EXISTS equipes;
    COMMIT;
  `);
  db.exec('PRAGMA foreign_keys = ON');
  const quebradas = db.prepare('PRAGMA foreign_key_check').all();
  if (quebradas.length) console.warn('Atenção: referências inválidas após remover equipes:', quebradas);
}

// Migração: sobreaviso com horas e várias pessoas por torre/dia (a chave passa a incluir o colaborador).
if (!db.prepare('PRAGMA table_info(sobreaviso)').all().some((c) => c.name === 'horas')) {
  db.exec(`
    BEGIN;
    CREATE TABLE sobreaviso_novo (
      torre_id       INTEGER NOT NULL REFERENCES torres(id) ON DELETE CASCADE,
      data           TEXT NOT NULL,
      colaborador_id INTEGER NOT NULL REFERENCES colaboradores(id) ON DELETE CASCADE,
      horas          REAL,             -- NULL = sobreaviso sem horas definidas
      PRIMARY KEY (torre_id, data, colaborador_id)
    );
    INSERT INTO sobreaviso_novo (torre_id, data, colaborador_id) SELECT torre_id, data, colaborador_id FROM sobreaviso;
    DROP TABLE sobreaviso;
    ALTER TABLE sobreaviso_novo RENAME TO sobreaviso;
    COMMIT;
  `);
}

// Migração: padrão de sobreaviso da torre (horas por dia a partir do dia escolhido; F = folga).
if (!db.prepare('PRAGMA table_info(torres)').all().some((c) => c.name === 'padrao_sobreaviso')) {
  db.exec("ALTER TABLE torres ADD COLUMN padrao_sobreaviso TEXT NOT NULL DEFAULT ''");
  db.prepare("UPDATE torres SET padrao_sobreaviso = ? WHERE codigo = 'N3'").run('12,F,5,5,5,5,5,F,12');
}

function seed() {
  const hasTorres = db.prepare('SELECT COUNT(*) n FROM torres').get().n > 0;
  if (!hasTorres) {
    const ins = db.prepare('INSERT INTO torres (codigo, nome, cor, permite_sobreaviso, ordem) VALUES (?, ?, ?, ?, ?)');
    ins.run('N1', 'Nível 1', '#2563eb', 0, 1);
    ins.run('N2', 'Nível 2', '#7c3aed', 1, 2);
    ins.run('N3', 'Nível 3', '#db2777', 1, 3);
    ins.run('LJ', 'Loja', '#059669', 0, 4);
  }
  const hasTurnos = db.prepare('SELECT COUNT(*) n FROM turnos').get().n > 0;
  if (!hasTurnos) {
    const ins = db.prepare('INSERT INTO turnos (codigo, nome, inicio, fim, cor, padrao, grupo) VALUES (?, ?, ?, ?, ?, ?, ?)');
    ins.run('TC', 'Comercial', '09:00', '18:00', '#0ea5e9', '5x2', 1);
    ins.run('T1', 'Manhã', '07:00', '16:00', '#f59e0b', '5x2', 1);
    ins.run('T2', 'Tarde', '14:30', '23:00', '#f97316', '5x2', 1);
    ins.run('T3', 'Madrugada', '22:00', '07:00', '#6366f1', '5x2', 1);
    ins.run('TP1', 'Plantão 1', '00:00', '12:00', '#14b8a6', '12x36', 1);
    ins.run('TP2', 'Plantão 2', '12:00', '00:00', '#e11d48', '12x36', 1);
  }
}
seed();

module.exports = db;
