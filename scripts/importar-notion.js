// Importa colaboradores exportados da base "EQUIPE MESA" do Notion.
// Uso: node scripts/importar-notion.js [arquivo.json]
// Cada linha: [nome, email, telefone, torre, turno, status]. Reexecutar atualiza pelo nome.
const fs = require('node:fs');
const path = require('node:path');
const db = require('../db');

const arquivo = process.argv[2] || path.join(__dirname, '..', 'data', 'equipe-mesa-notion.json');
const linhas = JSON.parse(fs.readFileSync(arquivo, 'utf8'));

// Torres que existem no Notion mas não no cadastro inicial.
const NOVAS_TORRES = { ESPEC: ['Especialista', '#9333ea'], LT: ['Liderança Técnica', '#dc2626'] };

const torreId = (codigo) => {
  let t = db.prepare('SELECT id FROM torres WHERE codigo = ?').get(codigo);
  if (!t) {
    const [nome, cor] = NOVAS_TORRES[codigo] || [codigo, '#64748b'];
    db.prepare('INSERT INTO torres (codigo, nome, cor) VALUES (?, ?, ?)').run(codigo, nome, cor);
    console.log(`Torre criada: ${codigo}`);
    t = db.prepare('SELECT id FROM torres WHERE codigo = ?').get(codigo);
  }
  return t.id;
};
const turnoId = (codigo) => {
  const t = db.prepare('SELECT id FROM turnos WHERE codigo = ?').get(codigo);
  if (!t) throw new Error(`Turno ${codigo} não cadastrado.`);
  return t.id;
};

let criados = 0;
let atualizados = 0;
db.exec('BEGIN');
try {
  for (const [nome, email, telefone, torre, turno, status] of linhas) {
    const dados = [email.trim().toLowerCase(), telefone.trim(), torreId(torre), turnoId(turno), status === 'DESLIGADO' ? 0 : 1];
    const existente = db.prepare('SELECT id FROM colaboradores WHERE nome = ? COLLATE NOCASE').get(nome);
    if (existente) {
      db.prepare('UPDATE colaboradores SET email = ?, telefone = ?, torre_id = ?, turno_id = ?, ativo = ? WHERE id = ?')
        .run(...dados, existente.id);
      atualizados++;
    } else {
      db.prepare('INSERT INTO colaboradores (email, telefone, torre_id, turno_id, ativo, nome) VALUES (?, ?, ?, ?, ?, ?)')
        .run(...dados, nome);
      criados++;
    }
  }
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  throw e;
}
console.log(`${criados} criados, ${atualizados} atualizados.`);
