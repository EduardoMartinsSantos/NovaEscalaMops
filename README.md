# Nova Escala

Escala de trabalho modular: cada colaborador carrega **tags** (colunas no banco) de **Torre**, **Turno** e **Sobreaviso**.
Torres e turnos são cadastráveis pelo menu **Cadastros**.

## Acesso

Login com o **e-mail do colaborador** (só colaboradores ativos). Quem nunca trocou a senha entra com a senha padrão
definida em `SENHA_PADRAO`; depois pode trocar em **Trocar senha**, no menu.

## Rodar localmente

Requer Node.js 22+ e um Postgres (o mesmo Neon da Vercel ou outro).

```bash
cp .env.example .env   # preencha DATABASE_URL, SESSION_SECRET e SENHA_PADRAO
npm install
npm start              # http://localhost:3000
npm run dev            # reinicia ao salvar
```

As tabelas são criadas sozinhas na primeira requisição.

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
- **Exportar Excel** no mesmo formato da exibição Planilha; **CSV** separado por `;`.
