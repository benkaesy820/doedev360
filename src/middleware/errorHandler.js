import logger from '../utils/logger.js';

export function errorHandler(err, req, res, next) {
    logger.error({
        error: err.message,
        stack: err.stack,
        path: req.path,
        method: req.method
    }, 'Error occurred');

    // Validation errors (Zod)
    if (err.name === 'ZodError') {
        return res.status(400).json({
            error: 'Validation error',
            details: err.errors
        });
    }

    // Prisma errors
    if (err.code && err.code.startsWith('P')) {
        if (err.code === 'P2002') {
            return res.status(409).json({
                error: 'A record with this value already exists'
            });
        }
        if (err.code === 'P2025') {
            return res.status(404).json({
                error: 'Record not found'
            });
        }
    }

    // JWT errors
    if (err.name === 'JWTExpired') {
        return res.status(401).json({
            error: 'Token expired'
        });
    }

    if (err.name === 'JWTInvalid') {
        return res.status(401).json({
            error: 'Invalid token'
        });
    }

    // Default error
    const statusCode = err.statusCode || 500;
    res.status(statusCode).json({
        error: process.env.NODE_ENV === 'production'
            ? 'Internal server error'
            : err.message
    });
}
