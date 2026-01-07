import { verifyAccessToken } from '../utils/jwt.js';
import prisma from '../config/database.js';

export async function authenticate(req, res, next) {
    try {
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'No token provided' });
        }

        const token = authHeader.substring(7);
        const payload = await verifyAccessToken(token);

        // Get user from database
        const user = await prisma.user.findUnique({
            where: { id: payload.userId },
            select: {
                id: true,
                name: true,
                email: true,
                role: true,
                status: true,
                mediaPermission: true
            }
        });

        if (!user) {
            return res.status(401).json({ error: 'User not found' });
        }

        if (user.status === 'SUSPENDED') {
            return res.status(403).json({ error: 'Account suspended' });
        }

        req.user = user;
        next();
    } catch (error) {
        if (error.code === 'ERR_JWT_EXPIRED') {
            return res.status(401).json({ error: 'Token expired' });
        }
        return res.status(401).json({ error: 'Invalid token' });
    }
}

export function requireApproved(req, res, next) {
    if (req.user.status !== 'APPROVED') {
        return res.status(403).json({ error: 'Account not approved' });
    }
    next();
}

export function requireAdmin(req, res, next) {
    if (req.user.role !== 'ADMIN') {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
}
