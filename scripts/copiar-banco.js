// Copia todos os dados de um Postgres para outro (ex.: produção → banco de testes da branch dev).
// Uso: ORIGEM_URL=... DESTINO_URL=... node scripts/copiar-banco.js
// Apaga tudo no destino antes de copiar. Mantém os mesmos IDs e senhas.
const { Pool } = require('pg');

const { ORIGEM_URL, DESTINO_URL } = process.env;
if (!ORIGEM_URL || !DESTINO_URL) {
  console.error('Defina ORIGEM_URL e DESTINO_URL.');
  process.exit(1);
}
if (ORIGEM_URL === DESTINO_URL) {
  console.error('Origem e destino são o mesmo banco.');
  process.exit(1);
}

// O esquema do destino é criado pelo próprio app (lib/db) apontando para ele.
process.env.DATABASE_URL = DESTINO_URL;
const destino = require('../lib/db');
const origem = new Pool({ connectionString: ORIGEM_URL, max: 1 });

// Ordem respeita as chaves estrangeiras.
const TABELAS = {
  torres: ['id', 'codigo', 'nome', 'cor', 'permite_sobreaviso', 'ordem', 'padrao_sobreaviso', 'ativo'],
  turnos: ['id', 'codigo', 'nome', 'inicio', 'fim', 'cor', 'padrao', 'grupo', 'ativo'],
  mesas: ['id', 'codigo', 'nome', 'cor', 'ordem', 'ativo'],
  colaboradores: [
    'id', 'nome', 'email', 'telefone', 'torre_id', 'turno_id', 'sobreaviso_torre_id', 'mesa_id', 'ativo', 'senha_hash', 'criado_em',
  ],
  escala: ['colaborador_id', 'data', 'tipo', 'turno_id'],
  sobreaviso: ['torre_id', 'data', 'colaborador_id', 'horas'],
};

async function main() {
  await destino.preparar();
  // A origem pode estar numa versão anterior do esquema: copia só as colunas/tabelas que existirem nela.
  const { rows: existentes } = await origem.query(
    "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'"
  );
  const temColuna = (t, c) => existentes.some((e) => e.table_name === t && e.column_name === c);
  const dados = {};
  const colunas = {};
  for (const [tabela, cols] of Object.entries(TABELAS)) {
    colunas[tabela] = cols.filter((c) => temColuna(tabela, c));
    dados[tabela] = colunas[tabela].length
      ? (await origem.query(`SELECT ${colunas[tabela].join(', ')} FROM ${tabela}`)).rows
      : [];
  }

  await destino.transacao(async () => {
    await destino.exec('TRUNCATE sobreaviso, escala, colaboradores, mesas, turnos, torres RESTART IDENTITY CASCADE');
    for (const [tabela, cols] of Object.entries(colunas)) {
      const marcadores = cols.map(() => '?').join(', ');
      for (const linha of dados[tabela]) {
        await destino.exec(`INSERT INTO ${tabela} (${cols.join(', ')}) VALUES (${marcadores})`, cols.map((c) => linha[c]));
      }
    }
    for (const tabela of ['torres', 'turnos', 'mesas', 'colaboradores']) {
      await destino.q(`SELECT setval(pg_get_serial_sequence('${tabela}', 'id'), GREATEST((SELECT MAX(id) FROM ${tabela}), 1))`);
    }
  });

  const contagem = Object.fromEntries(Object.entries(dados).map(([t, linhas]) => [t, linhas.length]));
  console.log('Copiado:', contagem);
}

main()
  .catch((e) => {
    console.error('Erro:', e.message);
    process.exitCode = 1;
  })
  .finally(() => Promise.all([origem.end(), destino.pool.end()]));
