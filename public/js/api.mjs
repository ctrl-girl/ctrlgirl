// Acesso à API e guarda do token da sessão.

const TOKEN_KEY = 'ctrlgirl_token';

export class ApiError extends Error {
  constructor(message, status, field) {
    super(message);
    this.status = status;
    this.field = field;
  }
}

export const session = {
  get token() {
    return localStorage.getItem(TOKEN_KEY);
  },
  set token(value) {
    localStorage.setItem(TOKEN_KEY, value);
  },
  clear() {
    localStorage.removeItem(TOKEN_KEY);
    // Chaves da versão antiga do app.
    localStorage.removeItem('token');
    localStorage.removeItem('userRole');
  },
};

export async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (session.token) headers.Authorization = `Bearer ${session.token}`;

  let response;
  try {
    response = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError('Sem conexão com o servidor. Verifique a internet e tente de novo.', 0);
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(data.error ?? 'Algo deu errado. Tente de novo.', response.status, data.field);
  return data;
}
