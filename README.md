# Nova Escala

Escala de trabalho modular: cada colaborador carrega **tags** (colunas no banco) de **Torre**, **Turno** e **Sobreaviso**.
Torres e turnos são cadastráveis pelo menu **Cadastros**.

## Acesso

Login com o **e-mail do colaborador** (só colaboradores ativos). Quem nunca trocou a senha entra com a senha padrão
definida em `SENHA_PADRAO`; depois pode trocar em **Trocar senha**, no menu.

**Administradores** veem a coluna **Acesso** em Colaboradores: se a pessoa ainda usa a senha padrão, o botão 🔑 que
volta a senha dela para a padrão e o interruptor **Admin**. O primeiro admin é o colaborador do e-mail em `ADMIN_EMAIL`
(enquanto não existir nenhum); o sistema não deixa ficar sem administrador ativo.

## Rodar localmente

Requer Node.js 22+ e um Postgres (o mesmo Neon da Vercel ou outro).

```bash
vercel env pull .env.local   # ou: cp .env.example .env e preencha à mão
npm install
npm start              # http://localhost:3000
npm run dev            # reinicia ao salvar
```

As tabelas são criadas sozinhas na primeira requisição.

## Ambientes

| Branch | Onde roda | Banco |
|---|---|---|
| `main` | Produção — https://nova-escala-mops.vercel.app | Neon `nova-escala-db` |
| `dev` | Preview da branch dev (deploy a cada push) | Neon `nova-escala-dev` (testes) |
| local | `npm start` | o do `.env` (testes); o `.env` prevalece sobre o `.env.local` |

Na Vercel, a `DATABASE_URL` da branch `dev` é uma variável de Preview restrita a essa branch, que substitui a de produção.

Copiar os dados de um banco para outro (apaga tudo no destino) — ex.: produção → testes, ou testes → produção:

```bash
ORIGEM_URL="<url de origem>" DESTINO_URL="<url de destino>" node scripts/copiar-banco.js
```

Backup antes de sobrescrever (salvo em `data/`, fora do GitHub) e restauração a partir dele:

```bash
BACKUP_URL="<url do banco>" node scripts/backup-banco.js [arquivo.json]
ORIGEM_ARQUIVO="data/<arquivo>.json" DESTINO_URL="<url do banco>" node scripts/copiar-banco.js
```

## Publicar na Vercel

1. Importe o repositório em https://vercel.com/new (Framework Preset: **Other**, sem build).
2. Em **Storage**, crie/conecte um banco **Neon (Postgres)** ao projeto — isso cria a variável `DATABASE_URL`.
3. Em **Settings → Environment Variables**, cadastre `SESSION_SECRET` e `SENHA_PADRAO` e faça um novo deploy.

Cada `git push` na `main` publica de novo. A API roda em `api/index.js` (todas as rotas `/api/*`, ver `vercel.json`)
e os arquivos de `public/` são servidos direto.

## Copiar os dados do SQLite antigo

A versão anterior guardava tudo em `data/escala.db`. Para levar para o Postgres (com o `DATABASE_URL` no `.env`):

```bash
npm run migrar                  # só roda se o Postgres ainda não tiver colaboradores
npm run migrar -- --substituir  # apaga o que houver no Postgres e copia de novo
```

## Modelo

| Tabela | Colunas principais |
|---|---|
| `torres` | codigo, nome, cor, permite_sobreaviso, ordem, padrao_sobreaviso, ativo |
| `turnos` | codigo, nome, inicio, fim, cor, padrao (`5x2`, `6x1`, `12x36`, `livre`), ativo |
| `colaboradores` | nome, email (login), telefone, **torre_id**, **turno_id**, **sobreaviso_torre_id**, ativo, senha_hash |
| `escala` | colaborador_id, data, tipo (`TURNO`, `FOLGA`, `FERIAS`, `ATESTADO`), turno_id |
| `sobreaviso` | torre_id, data, colaborador_id, horas |

## Escala

- Clique numa célula para editar, ou escolha um **pincel** na legenda e arraste sobre as células.
- **Sobreaviso**: pincel configurável (horas por dia) e **Série fixa** da torre, com prévia ao passar o mouse.
- **Exportar Excel** no mesmo formato da tela; **CSV** separado por `;`.
