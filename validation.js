// Regras de validação usadas pelas rotas da API.

const GENDERS = ['Mulher Cis', 'Mulher Trans', 'Homem Cis', 'Homem Trans', 'Pessoa Não-Binária', 'Prefiro não informar'];
const RACES = ['Parda', 'Preta', 'Branca', 'Amarela', 'Indígena', 'Prefiro não informar'];
const FORUM_CATEGORIES = ['Campeonatos', 'Comunidade', 'Dicas & Gameplay', 'Perguntas da ADM'];
const MINIMUM_AGE = 16;
const TERMS_VERSION = '2026-10-31';
const MAX_AVATAR_LENGTH = 200 * 1024;
// Senhas que qualquer tentativa automática testa primeiro.
const COMMON_PASSWORDS = new Set([
  '12345678', '123456789', '1234567890', '87654321', '11111111', '00000000', '12341234', '123123123',
  'password', 'password1', 'password123', 'qwerty123', 'qwertyuiop', 'abc12345', 'abcd1234', 'iloveyou',
  'senha123', 'senha1234', 'senhasenha', 'mudar123', 'admin123', 'brasil123', 'gamer123', 'ctrlgirl', 'ctrlgirl123',
]);

class ValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.field = field;
  }
}

function parseDateOnly(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const exists = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  return exists ? { year, month, day, date } : null;
}

// A idade é contada pelo calendário de São Paulo, para o aniversário valer no dia certo.
function calculateAge(birthDate, now = new Date()) {
  const birth = parseDateOnly(birthDate);
  if (!birth) return null;
  const today = parseDateOnly(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(now));
  let age = today.year - birth.year;
  if (today.month < birth.month || (today.month === birth.month && today.day < birth.day)) age -= 1;
  return age;
}

function requireText(value, field, label, { min = 1, max = 255 } = {}) {
  if (typeof value !== 'string') throw new ValidationError(`Informe ${label}.`, field);
  const text = value.trim();
  if (text.length < min) throw new ValidationError(`Informe ${label}.`, field);
  if (text.length > max) throw new ValidationError(`O campo ${label} aceita até ${max} caracteres.`, field);
  return text;
}

function optionalText(value, field, label, { max = 255 } = {}) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' && !value.trim()) return null;
  return requireText(value, field, label, { max });
}

function validateEmail(value, field = 'email') {
  const email = requireText(value, field, 'o e-mail', { max: 254 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new ValidationError('Informe um e-mail válido.', field);
  return email;
}

function validateNickname(value, field = 'nickname') {
  const nickname = requireText(value, field, 'o nickname', { max: 24 });
  if (!/^[\p{L}\p{N}_.-]{3,24}$/u.test(nickname)) {
    throw new ValidationError('O nickname precisa de 3 a 24 letras, números, ponto, hífen ou sublinhado.', field);
  }
  return nickname;
}

// O bcrypt só considera os primeiros 72 bytes, então senhas maiores são recusadas.
function validatePassword(value, field = 'password') {
  if (typeof value !== 'string' || value.length < 8) throw new ValidationError('A senha precisa ter pelo menos 8 caracteres.', field);
  if (Buffer.byteLength(value, 'utf8') > 72) throw new ValidationError('A senha aceita até 72 bytes.', field);
  if (COMMON_PASSWORDS.has(value.toLowerCase())) throw new ValidationError('Essa senha é muito comum. Escolha outra.', field);
  return value;
}

function validateChoice(value, options, field, label) {
  if (value === undefined || value === null || value === '') return null;
  if (!options.includes(value)) throw new ValidationError(`Escolha uma opção válida para ${label}.`, field);
  return value;
}

function validateBirthDate(value, now = new Date()) {
  const field = 'birthDate';
  const parsed = typeof value === 'string' ? parseDateOnly(value) : null;
  if (!parsed) throw new ValidationError('Informe a data de nascimento.', field);
  const age = calculateAge(value, now);
  if (age < 0) throw new ValidationError('A data de nascimento não pode estar no futuro.', field);
  if (age < MINIMUM_AGE) throw new ValidationError(`O CTRL GIRL exige idade mínima de ${MINIMUM_AGE} anos.`, field);
  return parsed.date;
}

// Só imagens em mapa de bits: SVG pode carregar script, e URL externa rastrearia quem vê o perfil.
function validateAvatar(value, field = 'avatarUrl') {
  if (value === null) return null;
  const valid = typeof value === 'string'
    && value.length <= MAX_AVATAR_LENGTH
    && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value);
  if (!valid) throw new ValidationError('Envie uma imagem JPG, PNG ou WebP de até 150 KB.', field);
  return value;
}

function validateArticleId(value) {
  if (!/^\d{1,4}$/.test(value)) throw new ValidationError('Matéria inválida.', 'articleId');
  return Number(value);
}

module.exports = {
  GENDERS,
  RACES,
  FORUM_CATEGORIES,
  TERMS_VERSION,
  ValidationError,
  calculateAge,
  requireText,
  optionalText,
  validateEmail,
  validateNickname,
  validatePassword,
  validateChoice,
  validateBirthDate,
  validateAvatar,
  validateArticleId,
};
