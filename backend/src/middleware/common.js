const { v4: uuidv4 } = require('uuid');
const logger = require('../logger');

/**
 * Attaches a unique requestId to every request for tracing.
 */
function requestId(req, res, next) {
  req.requestId = req.headers['x-request-id'] || uuidv4();
  res.setHeader('X-Request-Id', req.requestId);
  next();
}

/**
 * Logs each request.
 */
function requestLogger(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    logger.info({
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      durationMs: Date.now() - start,
      requestId: req.requestId,
      user: req.user ? req.user.username : 'anonymous',
    });
  });
  next();
}

/**
 * Global error handler.
 */
function errorHandler(err, req, res, _next) {
  logger.error(err.message || String(err), { stack: err.stack, requestId: req.requestId });
  const status = err.status || 500;
  res.status(status).json({
    error: status === 500 ? 'Internal server error' : err.message,
    requestId: req.requestId,
  });
}

module.exports = { requestId, requestLogger, errorHandler };
