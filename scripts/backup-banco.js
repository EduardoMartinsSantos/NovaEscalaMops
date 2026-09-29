// Salva todos os dados de um Postgres num arquivo JSON local (em data/, que não vai para o GitHub).
// Uso: BACKUP_URL=... node scripts/backup-banco.js [nome-do-arquivo.json]
// Para restaurar: copiar-banco.js aceita o arquivo como origem (ORIGEM_ARQUIVO=data/<arquivo>.json).
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const TABELAS = ['torres', 'turnos', 'mesas', 'colaboradores', 'escala', 'sobreaviso'];

async function main() {
  if (!process.env.BACKUP_URL) throw new Error('Defina BACKUP_URL.');
  const pool = new Pool({ connectionString: process.env.BACKUP_URL, max: 1 });
  try {
    const dados = { geradoEm: new Date().toISOString(), tabelas: {} };
    for (const t of TABELAS) {
      try {
        dados.tabelas[t] = (await pool.query(`SELECT * FROM ${t}`)).rows;
      } catch {
        dados.tabelas[t] = []; // tabela ainda não existe nessa versão do banco
      }
    }
    const carimbo = dados.geradoEm.replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
    const arquivo = path.join(__dirname, '..', 'data', process.argv[2] || `backup-${carimbo}.json`);
    fs.mkdirSync(path.dirname(arquivo), { recursive: true });
    fs.writeFileSync(arquivo, JSON.stringify(dados));
    const contagem = Object.fromEntries(Object.entries(dados.tabelas).map(([t, l]) => [t, l.length]));
    console.log(`Backup salvo em ${path.relative(process.cwd(), arquivo)}:`, contagem);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error('Erro:', e.message);
  process.exitCode = 1;
});
