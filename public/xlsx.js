'use strict';

// Gerador mínimo de .xlsx (uma aba com estilos, mesclagens e painel congelado), sem dependências.
// O arquivo é um ZIP sem compressão contendo o XML do SpreadsheetML.
//
// criarXlsx({
//   aba: 'Escala',
//   colunas: [{ largura: 30 }, ...],
//   linhas: [{ altura: 30, celulas: [{ v: 'texto' | 123, e: { bold, italic, color, bg, align, wrap, size } }] }],
//   mesclar: [{ linha: 0, de: 0, ate: 3 }],        // índices a partir de 0
//   congelar: { linhas: 1, colunas: 4 },
// }) → Blob
(function () {
  const enc = new TextEncoder();
  const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

  const escXml = (v) =>
    String(v)
      .replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c])
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

  // Letra da coluna a partir do índice 0 (0 → A, 26 → AA).
  function coluna(i) {
    let s = '';
    for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    return s;
  }

  const argb = (hex) => `FF${hex.replace('#', '').toUpperCase()}`;

  // ---------- estilos: cada combinação vira um xf, reaproveitado por cache ----------
  function registroEstilos() {
    const fonts = ['<font><sz val="10"/><name val="Calibri"/></font>'];
    const fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
    const lados = ['left', 'right', 'top', 'bottom'].map((l) => `<${l} style="thin"><color rgb="FFD0D7DE"/></${l}>`).join('');
    const borders = ['<border><left/><right/><top/><bottom/><diagonal/></border>', `<border>${lados}<diagonal/></border>`];
    const xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
    const cache = new Map();
    const indice = (lista, item) => {
      let i = lista.indexOf(item);
      if (i < 0) i = lista.push(item) - 1;
      return i;
    };

    function estilo(e = {}) {
      const chave = JSON.stringify(e);
      if (cache.has(chave)) return cache.get(chave);
      const font = indice(
        fonts,
        `<font>${e.bold ? '<b/>' : ''}${e.italic ? '<i/>' : ''}<sz val="${e.size || 10}"/>${
          e.color ? `<color rgb="${argb(e.color)}"/>` : ''
        }<name val="Calibri"/></font>`
      );
      const fill = e.bg
        ? indice(fills, `<fill><patternFill patternType="solid"><fgColor rgb="${argb(e.bg)}"/><bgColor indexed="64"/></patternFill></fill>`)
        : 0;
      const alinhamento = `<alignment horizontal="${e.align || 'center'}" vertical="center"${e.wrap ? ' wrapText="1"' : ''}/>`;
      const i =
        xfs.push(
          `<xf numFmtId="0" fontId="${font}" fillId="${fill}" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">${alinhamento}</xf>`
        ) - 1;
      cache.set(chave, i);
      return i;
    }

    const xml = () =>
      `${XML}<styleSheet xmlns="${NS}"><fonts count="${fonts.length}">${fonts.join('')}</fonts>` +
      `<fills count="${fills.length}">${fills.join('')}</fills><borders count="${borders.length}">${borders.join('')}</borders>` +
      `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
      `<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>` +
      `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
    return { estilo, xml };
  }

  // ---------- ZIP (método "store", sem compressão) ----------
  const TABELA_CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = TABELA_CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function zip(arquivos) {
    const agora = new Date();
    const hora = (agora.getHours() << 11) | (agora.getMinutes() << 5) | (agora.getSeconds() >> 1);
    const data = ((agora.getFullYear() - 1980) << 9) | ((agora.getMonth() + 1) << 5) | agora.getDate();
    const locais = [];
    const central = [];
    let offset = 0;
    for (const { nome, conteudo } of arquivos) {
      const n = enc.encode(nome);
      const dados = enc.encode(conteudo);
      const crc = crc32(dados);

      const l = new DataView(new ArrayBuffer(30));
      l.setUint32(0, 0x04034b50, true);
      l.setUint16(4, 20, true);
      l.setUint16(6, 0x0800, true); // nomes em UTF-8
      l.setUint16(10, hora, true);
      l.setUint16(12, data, true);
      l.setUint32(14, crc, true);
      l.setUint32(18, dados.length, true);
      l.setUint32(22, dados.length, true);
      l.setUint16(26, n.length, true);
      locais.push(new Uint8Array(l.buffer), n, dados);

      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true);
      c.setUint16(4, 20, true);
      c.setUint16(6, 20, true);
      c.setUint16(8, 0x0800, true);
      c.setUint16(12, hora, true);
      c.setUint16(14, data, true);
      c.setUint32(16, crc, true);
      c.setUint32(20, dados.length, true);
      c.setUint32(24, dados.length, true);
      c.setUint16(28, n.length, true);
      c.setUint32(42, offset, true);
      central.push(new Uint8Array(c.buffer), n);

      offset += 30 + n.length + dados.length;
    }
    const tamanhoCentral = central.reduce((s, p) => s + p.length, 0);
    const fim = new DataView(new ArrayBuffer(22));
    fim.setUint32(0, 0x06054b50, true);
    fim.setUint16(8, arquivos.length, true);
    fim.setUint16(10, arquivos.length, true);
    fim.setUint32(12, tamanhoCentral, true);
    fim.setUint32(16, offset, true);
    return new Blob([...locais, ...central, new Uint8Array(fim.buffer)], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
  }

  // ---------- planilha ----------
  window.criarXlsx = function ({ aba = 'Planilha', colunas = [], linhas = [], mesclar = [], congelar }) {
    const estilos = registroEstilos();
    const nomeAba = escXml(aba.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31));

    const sheetData = linhas
      .map((linha, r) => {
        const celulas = (linha.celulas || [])
          .map((c, j) => {
            if (!c) return '';
            const ref = `${coluna(j)}${r + 1}`;
            const s = estilos.estilo(c.e);
            if (c.v === '' || c.v === null || c.v === undefined) return `<c r="${ref}" s="${s}"/>`;
            if (typeof c.v === 'number') return `<c r="${ref}" s="${s}"><v>${c.v}</v></c>`;
            return `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${escXml(c.v)}</t></is></c>`;
          })
          .join('');
        const altura = linha.altura ? ` ht="${linha.altura}" customHeight="1"` : '';
        return `<row r="${r + 1}"${altura}>${celulas}</row>`;
      })
      .join('');

    const painel = congelar
      ? `<sheetViews><sheetView workbookViewId="0"><pane xSplit="${congelar.colunas}" ySplit="${congelar.linhas}" topLeftCell="${coluna(
          congelar.colunas
        )}${congelar.linhas + 1}" activePane="bottomRight" state="frozen"/></sheetView></sheetViews>`
      : '';
    const cols = colunas.length
      ? `<cols>${colunas.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.largura}" customWidth="1"/>`).join('')}</cols>`
      : '';
    const merges = mesclar.length
      ? `<mergeCells count="${mesclar.length}">${mesclar
          .map((m) => `<mergeCell ref="${coluna(m.de)}${m.linha + 1}:${coluna(m.ate)}${m.linha + 1}"/>`)
          .join('')}</mergeCells>`
      : '';

    const planilha = `${XML}<worksheet xmlns="${NS}" xmlns:r="${NS_R}">${painel}<sheetFormatPr defaultRowHeight="18"/>${cols}<sheetData>${sheetData}</sheetData>${merges}</worksheet>`;

    return zip([
      {
        nome: '[Content_Types].xml',
        conteudo:
          `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
          '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
          '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
          '</Types>',
      },
      {
        nome: '_rels/.rels',
        conteudo:
          `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          `<Relationship Id="rId1" Type="${NS_R}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      },
      {
        nome: 'xl/workbook.xml',
        conteudo: `${XML}<workbook xmlns="${NS}" xmlns:r="${NS_R}"><sheets><sheet name="${nomeAba}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      },
      {
        nome: 'xl/_rels/workbook.xml.rels',
        conteudo:
          `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          `<Relationship Id="rId1" Type="${NS_R}/worksheet" Target="worksheets/sheet1.xml"/>` +
          `<Relationship Id="rId2" Type="${NS_R}/styles" Target="styles.xml"/></Relationships>`,
      },
      { nome: 'xl/styles.xml', conteudo: estilos.xml() },
      { nome: 'xl/worksheets/sheet1.xml', conteudo: planilha },
    ]);
  };
})();
