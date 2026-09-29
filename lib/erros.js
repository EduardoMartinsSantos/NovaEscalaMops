// Erro com status HTTP: a mensagem vai para o usuário como está.
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

module.exports = { HttpError };
