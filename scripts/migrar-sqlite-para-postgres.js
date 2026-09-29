// Copia os dados do banco SQLite antigo (data/escala.db) para o Postgres de DATABASE_URL.
// Uso: npm run migrar -- [arquivo.db] [--substituir]
// Sem --substituir, só roda se o Postgres ainda não tiver colaboradores.
// Mantém os mesmos IDs; as senhas começam vazias (todos entram com a senha padrão).
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { pool, q, um, exec, transacao, preparar } = require('../lib/db');

const args = process.argv.slice(2);
const substituir = args.includes('--substituir');
const arquivo = args.find((a) => !a.startsWith('--')) || path.join(__dirname, '..', 'data', 'escala.db');

async function main() {
  const origem = new DatabaseSync(arquivo, { readOnly: true });
  const ler = (sql) => origem.prepare(sql).all();
  const colunas = (tabela) => new Set(ler(`PRAGMA table_info(${tabela})`).map((c) => c.name));

  await preparar();
  const { n } = await um('SELECT COUNT(*)::int n FROM colaboradores');
  if (n && !substituir) {
    throw new Error(`O Postgres já tem ${n} colaborador(es). Use --substituir para apagar tudo e copiar de novo.`);
  }

  const torres = ler('SELECT * FROM torres');
  const turnos = ler('SELECT * FROM turnos');
  const colaboradores = ler('SELECT * FROM colaboradores');
  const escala = ler('SELECT colaborador_id, data, tipo, turno_id FROM escala');
  const temHoras = colunas('sobreaviso').has('horas');
  const sobreaviso = ler(`SELECT torre_id, data, colaborador_id, ${temHoras ? 'horas' : 'NULL AS horas'} FROM sobreaviso`);
  const colTorres = colunas('torres');
  const colTurnos = colunas('turnos');

  await transacao(async () => {
    await exec('TRUNCATE sobreaviso, escala, colaboradores, mesas, turnos, torres RESTART IDENTITY CASCADE');

    for (const t of torres) {
      await exec(
        `INSERT INTO torres (id, codigo, nome, cor, permite_sobreaviso, ordem, padrao_sobreaviso, ativo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          t.id, t.codigo, t.nome, t.cor, t.permite_sobreaviso,
          colTorres.has('ordem') ? t.ordem : 99,
          colTorres.has('padrao_sobreaviso') ? t.padrao_sobreaviso : '',
          t.ativo,
        ]
      );
    }
    for (const t of turnos) {
      await exec(
        'INSERT INTO turnos (id, codigo, nome, inicio, fim, cor, padrao, grupo, ativo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [t.id, t.codigo, t.nome, t.inicio, t.fim, t.cor, t.padrao, colTurnos.has('grupo') ? t.grupo : 1, t.ativo]
      );
    }
    for (const c of colaboradores) {
      await exec(
        `INSERT INTO colaboradores (id, nome, email, telefone, torre_id, turno_id, sobreaviso_torre_id, ativo, criado_em)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          c.id, c.nome, (c.email || '').toLowerCase(), c.telefone || '', c.torre_id, c.turno_id, c.sobreaviso_torre_id, c.ativo,
          c.criado_em ? `${c.criado_em}+00` : new Date(),
        ]
      );
    }
    // Em lotes, para não fazer milhares de idas e vindas ao banco.
    for (let i = 0; i < escala.length; i += 500) {
      const lote = escala.slice(i, i + 500);
      await exec(
        `INSERT INTO escala (colaborador_id, data, tipo, turno_id)
         SELECT * FROM unnest(?::int[], ?::text[], ?::text[], ?::int[])`,
        [lote.map((e) => e.colaborador_id), lote.map((e) => e.data), lote.map((e) => e.tipo), lote.map((e) => e.turno_id)]
      );
    }
    for (let i = 0; i < sobreaviso.length; i += 500) {
      const lote = sobreaviso.slice(i, i + 500);
      await exec(
        `INSERT INTO sobreaviso (torre_id, data, colaborador_id, horas)
         SELECT * FROM unnest(?::int[], ?::text[], ?::int[], ?::float8[])`,
        [lote.map((s) => s.torre_id), lote.map((s) => s.data), lote.map((s) => s.colaborador_id), lote.map((s) => s.horas)]
      );
    }
    // Continua a numeração depois dos IDs copiados.
    for (const tabela of ['torres', 'turnos', 'colaboradores']) {
      await q(`SELECT setval(pg_get_serial_sequence('${tabela}', 'id'), GREATEST((SELECT MAX(id) FROM ${tabela}), 1))`);
    }
  });

  const contagem = await um(`SELECT
    (SELECT COUNT(*)::int FROM torres) torres, (SELECT COUNT(*)::int FROM turnos) turnos,
    (SELECT COUNT(*)::int FROM colaboradores) colaboradores, (SELECT COUNT(*)::int FROM escala) escala,
    (SELECT COUNT(*)::int FROM sobreaviso) sobreaviso`);
  console.log('Copiado para o Postgres:', contagem);
}

main()
  .catch((e) => {
    console.error('Erro:', e.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
