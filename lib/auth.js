// Login por e-mail do colaborador. Quem nunca trocou a senha entra com a senha padrão (SENHA_PADRAO).
// A sessão é um cookie assinado com SESSION_SECRET (sem estado no servidor, funciona nas funções da Vercel).
const crypto = require('node:crypto');
const { HttpError } = require('./erros');

const DURACAO_SESSAO_S = 7 * 24 * 60 * 60;
const COOKIE = 'sessao';

function segredo() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) throw new Error('Defina SESSION_SECRET com pelo menos 16 caracteres (veja .env.example).');
  return s;
}

const assinar = (txt) => crypto.createHmac('sha256', segredo()).update(txt).digest('base64url');

// Compara em tempo constante, mesmo com tamanhos diferentes.
function iguais(a, b) {
  const h = (v) => crypto.createHash('sha256').update(String(v)).digest();
  return crypto.timingSafeEqual(h(a), h(b));
}

function criarToken(colaboradorId) {
  const payload = Buffer.from(JSON.stringify({ id: colaboradorId, exp: Date.now() + DURACAO_SESSAO_S * 1000 })).toString('base64url');
  return `${payload}.${assinar(payload)}`;
}

function lerToken(token) {
  const [payload, assinatura] = String(token || '').split('.');
  if (!payload || !assinatura || !iguais(assinatura, assinar(payload))) return null;
  try {
    const dados = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return dados.exp > Date.now() && Number.isInteger(dados.id) ? dados : null;
  } catch {
    return null;
  }
}

function lerCookie(req, nome) {
  for (const parte of String(req.headers.cookie || '').split(';')) {
    const [k, ...v] = parte.trim().split('=');
    if (k === nome) return decodeURIComponent(v.join('='));
  }
  return null;
}

function cookieSessao(req, token) {
  const https = String(req.headers['x-forwarded-proto'] || '').includes('https') || !!process.env.VERCEL;
  const maxAge = token ? DURACAO_SESSAO_S : 0;
  return `${COOKIE}=${token || ''}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${https ? '; Secure' : ''}`;
}

const tokenDaRequisicao = (req) => lerToken(lerCookie(req, COOKIE));

// ---------- senhas ----------

function hashSenha(senha) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(senha, salt, 32);
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

function conferirHash(senha, armazenado) {
  const [alg, salt, hash] = String(armazenado || '').split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const calculado = crypto.scryptSync(senha, Buffer.from(salt, 'base64url'), 32);
  const esperado = Buffer.from(hash, 'base64url');
  return esperado.length === calculado.length && crypto.timingSafeEqual(calculado, esperado);
}

// Senha própria (se já trocou) ou a senha padrão da equipe.
function senhaConfere(senha, senhaHash) {
  if (senhaHash) return conferirHash(senha, senhaHash);
  const padrao = process.env.SENHA_PADRAO;
  if (!padrao) throw new HttpError(500, 'SENHA_PADRAO não configurada no servidor.');
  return iguais(senha, padrao);
}

function validarNovaSenha(nova) {
  if (String(nova || '').length < 8) throw new HttpError(400, 'A nova senha precisa ter pelo menos 8 caracteres.');
  if (process.env.SENHA_PADRAO && nova === process.env.SENHA_PADRAO) {
    throw new HttpError(400, 'Escolha uma senha diferente da senha padrão.');
  }
}

module.exports = { criarToken, tokenDaRequisicao, cookieSessao, hashSenha, senhaConfere, validarNovaSenha };
