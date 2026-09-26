/**
 * Unified Centralized Error Handling Middleware
 * Ensures all errors return consistent RFC-compliant JSON responses
 * without leaking raw system stack traces or secrets to clients in production.
 */

function errorHandler(err, req, res, next) {
    if (res.headersSent) {
        return next(err);
    }

    const isProduction = process.env.NODE_ENV === 'production';
    const statusCode = err.status || err.statusCode || 500;
    const errorType = err.name || 'InternalServerError';

    console.error(`💥 [API Error] ${req.method} ${req.originalUrl}:`, err.message);
    if (!isProduction && err.stack) {
        console.error(err.stack);
    }

    const responsePayload = {
        error: errorType,
        message: err.userMessage || (isProduction && statusCode === 500 ? 'An unexpected server error occurred' : err.message)
    };

    if (!isProduction && err.details) {
        responsePayload.details = err.details;
    }

    res.status(statusCode).json(responsePayload);
}

module.exports = {
    errorHandler
};
