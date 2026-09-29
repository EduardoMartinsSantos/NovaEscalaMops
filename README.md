# Nova Escala

Escala de trabalho modular: cada colaborador carrega **tags** (colunas no banco) de **Torre**, **Turno** e **Sobreaviso**.
Torres e turnos são cadastráveis pelo menu **Cadastros**.

## Rodar

Requer Node.js 22.13+ (usa o SQLite embutido `node:sqlite`, sem dependências).

```bash
npm start        # http://localhost:3000
npm run dev      # reinicia ao salvar
```

O banco fica em `data/escala.db` e é criado com as torres (N1, N2, N3, LJ) e turnos (TC, T1, T2, T3, TP1, TP2) iniciais.
Variáveis opcionais: `PORT`, `DB_PATH`.

## Modelo

| Tabela | Colunas principais |
|---|---|
| `torres` | codigo, nome, cor, permite_sobreaviso, ativo |
| `turnos` | codigo, nome, inicio, fim, cor, padrao (`5x2`, `6x1`, `12x36`, `livre`), ativo |
| `colaboradores` | nome, email, telefone, **torre_id**, **turno_id**, **sobreaviso_torre_id**, ativo |
| `escala` | colaborador_id, data, tipo (`TURNO`, `FOLGA`, `FERIAS`, `ATESTADO`), turno_id |
| `sobreaviso` | torre_id, data, colaborador_id |

Só torres marcadas com "Possui sobreaviso" (N2 e N3 por padrão) aparecem como opção de sobreaviso.

## Escala

- Clique numa célula para editar, ou escolha um **pincel** na legenda e arraste sobre as células.
- **Exportar CSV** (separado por `;`, abre direto no Excel).
