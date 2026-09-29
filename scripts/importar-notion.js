// Importa colaboradores exportados da base "EQUIPE MESA" do Notion para o Postgres de DATABASE_URL.
// Uso: npm run importar-notion -- [arquivo.json]
// Cada linha: [nome, email, telefone, torre, turno, status]. Reexecutar atualiza pelo nome.
const fs = require('node:fs');
const path = require('node:path');
const { pool, um, exec, transacao, preparar } = require('../lib/db');

const arquivo = process.argv[2] || path.join(__dirname, '..', 'data', 'equipe-mesa-notion.json');
const linhas = JSON.parse(fs.readFileSync(arquivo, 'utf8'));

// Torres que existem no Notion mas não no cadastro inicial.
const NOVAS_TORRES = { ESPEC: ['Especialista', '#9333ea'], LT: ['Liderança Técnica', '#dc2626'] };

async function torreId(codigo) {
  const t = await um('SELECT id FROM torres WHERE lower(codigo) = lower(?)', [codigo]);
  if (t) return t.id;
  const [nome, cor] = NOVAS_TORRES[codigo] || [codigo, '#64748b'];
  console.log(`Torre criada: ${codigo}`);
  return (await um('INSERT INTO torres (codigo, nome, cor) VALUES (?, ?, ?) RETURNING id', [codigo, nome, cor])).id;
}

async function turnoId(codigo) {
  const t = await um('SELECT id FROM turnos WHERE lower(codigo) = lower(?)', [codigo]);
  if (!t) throw new Error(`Turno ${codigo} não cadastrado.`);
  return t.id;
}

async function main() {
  await preparar();
  let criados = 0;
  let atualizados = 0;
  await transacao(async () => {
    for (const [nome, email, telefone, torre, turno, status] of linhas) {
      const dados = [email.trim().toLowerCase(), telefone.trim(), await torreId(torre), await turnoId(turno), status === 'DESLIGADO' ? 0 : 1];
      const existente = await um('SELECT id FROM colaboradores WHERE lower(nome) = lower(?)', [nome]);
      if (existente) {
        await exec('UPDATE colaboradores SET email = ?, telefone = ?, torre_id = ?, turno_id = ?, ativo = ? WHERE id = ?', [
          ...dados,
          existente.id,
        ]);
        atualizados++;
      } else {
        await exec('INSERT INTO colaboradores (email, telefone, torre_id, turno_id, ativo, nome) VALUES (?, ?, ?, ?, ?, ?)', [
          ...dados,
          nome,
        ]);
        criados++;
      }
    }
  });
  console.log(`${criados} criados, ${atualizados} atualizados.`);
}

main()
  .catch((e) => {
    console.error('Erro:', e.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
