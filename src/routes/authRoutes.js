import { Router } from 'express';
import argon2 from 'argon2';
import prisma from '../config/database.js';
import { generateAccessToken, generateRefreshToken, verifyRefreshToken } from '../utils/jwt.js';
import { registerSchema, loginSchema } from '../utils/validators.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

// Register
router.post('/register', async (req, res, next) => {
    try {
        const data = registerSchema.parse(req.body);

        // Hash password
        const passwordHash = await argon2.hash(data.password);

        // Create user
        const user = await prisma.user.create({
            data: {
                name: data.name,
                email: data.email,
                phone: data.phone,
                passwordHash
            },
            select: {
                id: true,
                name: true,
                email: true,
                status: true,
                createdAt: true
            }
        });

        res.status(201).json({
            message: 'Registration successful. Please wait for admin approval.',
            user
        });
    } catch (error) {
        next(error);
    }
});

// Login
router.post('/login', async (req, res, next) => {
    try {
        const data = loginSchema.parse(req.body);

        const user = await prisma.user.findUnique({
            where: { email: data.email }
        });

        if (!user) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        if (user.status === 'SUSPENDED') {
            return res.status(403).json({ error: 'Account suspended' });
        }

        const validPassword = await argon2.verify(user.passwordHash, data.password);
        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        // Generate tokens
        const tokenPayload = { userId: user.id, role: user.role };
        const accessToken = await generateAccessToken(tokenPayload);
        const refreshToken = await generateRefreshToken(tokenPayload);

        // Store refresh token
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 7);

        await prisma.refreshToken.create({
            data: {
                userId: user.id,
                token: refreshToken,
                expiresAt
            }
        });

        // Update last login
        await prisma.user.update({
            where: { id: user.id },
            data: { lastLogin: new Date() }
        });

        res.json({
            accessToken,
            refreshToken,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                role: user.role,
                status: user.status,
                mediaPermission: user.mediaPermission
            }
        });
    } catch (error) {
        next(error);
    }
});

// Refresh token
router.post('/refresh-token', async (req, res, next) => {
    try {
        const { refreshToken } = req.body;

        if (!refreshToken) {
            return res.status(400).json({ error: 'Refresh token required' });
        }

        // Verify token
        const payload = await verifyRefreshToken(refreshToken);

        // Check if token exists in database
        const storedToken = await prisma.refreshToken.findUnique({
            where: { token: refreshToken }
        });

        if (!storedToken || storedToken.expiresAt < new Date()) {
            return res.status(401).json({ error: 'Invalid or expired refresh token' });
        }

        // Generate new access token
        const accessToken = await generateAccessToken({
            userId: payload.userId,
            role: payload.role
        });

        res.json({ accessToken });
    } catch (error) {
        next(error);
    }
});

// Logout
router.post('/logout', authenticate, async (req, res, next) => {
    try {
        const { refreshToken } = req.body;

        if (refreshToken) {
            await prisma.refreshToken.deleteMany({
                where: { token: refreshToken }
            });
        }

        res.json({ message: 'Logged out successfully' });
    } catch (error) {
        next(error);
    }
});

// Get current user
router.get('/me', authenticate, async (req, res) => {
    res.json({ user: req.user });
});

export default router;
