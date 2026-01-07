import * as jose from 'jose';
import config from '../config/index.js';

const secret = new TextEncoder().encode(config.jwt.secret);
const refreshSecret = new TextEncoder().encode(config.jwt.refreshSecret);

export async function generateAccessToken(payload) {
    return await new jose.SignJWT(payload)
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime(config.jwt.expiresIn)
        .sign(secret);
}

export async function generateRefreshToken(payload) {
    return await new jose.SignJWT(payload)
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime(config.jwt.refreshExpiresIn)
        .sign(refreshSecret);
}

export async function verifyAccessToken(token) {
    try {
        const { payload } = await jose.jwtVerify(token, secret);
        return payload;
    } catch (error) {
        throw error;
    }
}

export async function verifyRefreshToken(token) {
    try {
        const { payload } = await jose.jwtVerify(token, refreshSecret);
        return payload;
    } catch (error) {
        throw error;
    }
}
